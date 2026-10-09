"""Shared private state and authenticated controls for the artifact preview service."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

DEFAULT_PORT = 43136


# Honor the same agent directory used by Pi, including persistent Herdr sessions.
def default_state():
    agent = Path(os.environ.get('PI_CODING_AGENT_DIR') or Path.home() / '.pi' / 'agent').expanduser()
    return agent / 'artifact-preview' / 'server.json'


# Never send credentials from an invalid or non-private state file.
def read_state(path):
    path = Path(path)
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or stat.st_size > 4096:
        raise ValueError('Invalid artifact preview state file')
    if os.name != 'nt' and (stat.st_mode & 0o077 or stat.st_uid != os.getuid()):
        raise ValueError('Artifact preview state file must be private and owned by you')
    state = json.loads(path.read_text(encoding='utf-8'))
    if (not isinstance(state, dict) or not isinstance(state.get('token'), str)
            or not re.fullmatch('[0-9a-f]{64}', state['token'])
            or type(state.get('port')) is not int or not 1 <= state['port'] <= 65535
            or type(state.get('pid')) is not int or state['pid'] <= 0):
        raise ValueError('Invalid artifact preview state; inspect ' + str(path.with_suffix('.log')))
    return state


# Local control credentials must never be forwarded to a redirect destination.
class NoControlRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None  # urllib turns the redirect into an explicit HTTPError.


# Bypass proxies; only an explicitly refused connection denotes an inactive service.
def control(state, endpoint, method='GET'):
    request = urllib.request.Request(
        'http://127.0.0.1:' + str(state['port']) + endpoint, method=method,
        headers={'Authorization': 'Bearer ' + state['token']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoControlRedirects())
    try:
        with opener.open(request, timeout=3) as response:
            return response.status
    except urllib.error.URLError as error:
        if isinstance(error.reason, ConnectionRefusedError):
            return None  # The recorded listener is gone after a crash or reboot.
        raise


# Serialize starts, stale-state recovery, and owned cleanup across processes on both platforms.
@contextmanager
def state_lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path.with_suffix('.lock'), os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    acquired = False
    try:
        if os.fstat(fd).st_size == 0:
            os.write(fd, b'\0')
        deadline = time.monotonic() + 10
        while not acquired:
            try:
                if os.name == 'nt':
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except OSError as error:
                import errno
                if error.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                if time.monotonic() >= deadline:
                    raise TimeoutError('Timed out waiting for preview state lock') from error
                time.sleep(0.05)
        yield
    finally:
        if acquired:
            if os.name == 'nt':
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


# Caller holds the state lock; an old process must never remove a replacement service's state.
def remove_owned_state(path, token):
    path = Path(path)
    try:
        state = read_state(path)
    except FileNotFoundError:
        return  # Shutdown or crash recovery has already removed this service's record.
    if state['token'] == token:
        path.with_suffix('.ready').unlink(missing_ok=True)
        path.with_suffix('.tmp').unlink(missing_ok=True)
        path.unlink()
