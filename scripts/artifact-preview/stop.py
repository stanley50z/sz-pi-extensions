"""Stop only the authenticated preview service and verify its listener is released."""
import argparse
from pathlib import Path
import socket
import time
import traceback
from common import control, default_state, read_state, remove_owned_state, state_lock


# Release the lock before waiting so the service can lock and remove its own state during exit.
def stop(state_path):
    state_path = Path(state_path).expanduser()
    with state_lock(state_path):
        state = read_state(state_path)
        status = control(state, '/stop', 'POST')
        if status is None:
            remove_owned_state(state_path, state['token'])
        elif status != 200:
            raise RuntimeError('Preview service rejected authenticated shutdown')
    deadline = time.monotonic() + 12
    while state_path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if state_path.exists():
        raise TimeoutError('Preview service did not finish shutdown; see ' + str(state_path.with_suffix('.log')))
    with socket.socket() as probe:
        probe.settimeout(0.2)
        if probe.connect_ex(('127.0.0.1', state['port'])) == 0:
            raise RuntimeError('Preview service port is still accepting connections')


# The CLI only targets the service identified by its private state file.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=default_state())
    args = parser.parse_args()
    try:
        stop(args.state)
    except Exception:
        args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with args.state.with_suffix('.log').open('a', encoding='utf-8') as log:
            log.write(traceback.format_exc())
        raise


if __name__ == '__main__':
    main()
