"""Stop only the clipboard helper identified by a connection state file."""
import argparse
import json
from pathlib import Path
import socket
import time
import urllib.request


# Authenticate shutdown, then verify the helper removed its state and closed its port.
def stop(state_path):
    state_path = Path(state_path)
    state = json.loads(state_path.read_text(encoding='utf-8'))
    request = urllib.request.Request(f"http://127.0.0.1:{state['port']}/stop", method='POST',
                                     headers={'Authorization': 'Bearer ' + state['token']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=12) as response:
        response.read()
    deadline = time.monotonic() + 12
    while state_path.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    if state_path.exists():
        raise TimeoutError('Clipboard helper did not finish shutdown')
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('127.0.0.1', state['port'])) == 0:
            raise RuntimeError('Clipboard helper port is still accepting connections')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    args = parser.parse_args()
    stop(args.state)


if __name__ == '__main__':
    main()
