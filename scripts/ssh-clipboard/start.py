"""Start a clipboard helper in the background, without opening a terminal window."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time


# Each caller owns a separate state file, token, and ephemeral loopback port.
def start(state_path, parent=None):
    state_path = Path(state_path).resolve()
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as file:
        json.dump({'token': secrets.token_hex(32)}, file)
    command = [sys.executable, '-B', str(Path(__file__).with_name('server.py')), '--state', str(state_path)]
    if parent is not None:
        command += ['--parent', str(parent)]
    log_path = state_path.with_suffix('.log')
    with log_path.open('wb') as log:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
                                   start_new_session=os.name != 'nt')
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Clipboard helper failed to start: ' + log_path.read_text(encoding='utf-8'))
            if state_path.with_suffix('.ready').exists():
                state = json.loads(state_path.read_text(encoding='utf-8'))
                return state, process
            time.sleep(0.05)
        raise TimeoutError('Clipboard helper did not become ready within 10 seconds')
    except BaseException:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=10)
        state_path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    args = parser.parse_args()
    state, _process = start(args.state)
    print(json.dumps({'port': state['port'], 'pid': state['pid']}))


if __name__ == '__main__':
    main()
