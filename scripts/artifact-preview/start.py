"""Start or verify the shared preview service in the background, without a terminal window."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import traceback
from common import DEFAULT_PORT, control, default_state, read_state, remove_owned_state, state_lock


# Recover only a confirmed closed listener; authentication and timeout failures remain explicit.
def start(state_path, port=DEFAULT_PORT):
    state_path = Path(state_path).expanduser().resolve()
    with state_lock(state_path):
        if state_path.exists():
            state = read_state(state_path)
            status = control(state, '/health')
            if status is not None:
                if status != 204:
                    raise RuntimeError('Existing preview service failed its authenticated health check')
                if port and state['port'] != port:
                    raise RuntimeError('Existing preview service uses a different port')
                return state
            remove_owned_state(state_path, state['token'])
            with state_path.with_suffix('.log').open('a', encoding='utf-8') as log:
                log.write('Recovered inactive preview service state after listener refusal\n')
        with os.fdopen(os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as stream:
            json.dump({'token': secrets.token_hex(32)}, stream)
        log_path = state_path.with_suffix('.log')
        process = None
        try:
            with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'ab') as log:
                process = subprocess.Popen(
                    [sys.executable, '-B', str(Path(__file__).with_name('server.py')), '--state', str(state_path), '--port', str(port)],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                    start_new_session=os.name != 'nt')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError('Preview service failed to start; see ' + str(log_path))
                if state_path.with_suffix('.ready').exists():
                    state = read_state(state_path)
                    if control(state, '/health') != 204:
                        raise RuntimeError('Preview service failed its readiness check')
                    return state
                time.sleep(0.05)
            raise TimeoutError('Preview service did not become ready; see ' + str(log_path))
        except BaseException:
            if process is not None and process.poll() is None:
                # Parent holds the startup lock; killing its own failed child avoids a cleanup-lock deadlock.
                process.kill()
                process.wait(timeout=12)
            state_path.with_suffix('.ready').unlink(missing_ok=True)
            state_path.with_suffix('.tmp').unlink(missing_ok=True)
            state_path.unlink(missing_ok=True)
            raise


# Expose state/port selection without printing private control credentials.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=default_state())
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('port must be between 0 and 65535')
    try:
        state = start(args.state, args.port)
    except Exception:
        args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with args.state.with_suffix('.log').open('a', encoding='utf-8') as log:
            log.write(traceback.format_exc())
        raise
    print(json.dumps({'port': state['port'], 'pid': state['pid']}))


if __name__ == '__main__':
    main()
