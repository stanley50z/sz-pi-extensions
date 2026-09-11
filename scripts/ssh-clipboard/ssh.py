"""Open remote Pi or a Mac shell with clipboard forwarding. Run inside Windows Terminal."""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
from uuid import uuid4
from start import start
from stop import stop


# SSH keeps the terminal; only the clipboard helper runs without a console window.
def main():
    argv = sys.argv[1:]
    split = argv.index('--') if '--' in argv else len(argv)
    pi_args = argv[split + 1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('host', help='SSH destination or host alias from ~/.ssh/config')
    parser.add_argument('--cwd', help='Working directory on the Mac')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--pi', default='pi', help='Pi executable on the Mac')
    mode.add_argument('--shell', action='store_true', help='Open a normal Mac login shell; run Pi yourself')
    args = parser.parse_args(argv[:split])
    if args.shell and pi_args:
        parser.error('--shell does not accept Pi arguments')
    if args.host.startswith('-') or not args.host.strip():
        parser.error('host must be an SSH destination, not an option')
    with tempfile.TemporaryDirectory(prefix='pi-clipboard-') as directory:
        state_path = Path(directory) / 'connection.json'
        state, helper = start(state_path, parent=os.getpid())
        socket_path = f'/tmp/pi-clipboard-{uuid4().hex}.sock'
        script = (
            f'export PI_SSH_CLIPBOARD_SOCKET={shlex.quote(socket_path)}; '
            f'export PI_SSH_CLIPBOARD_TOKEN={shlex.quote(state["token"])}; '
            'trap \'rm -f -- "$PI_SSH_CLIPBOARD_SOCKET"\' EXIT; '
        )
        if args.cwd:
            script += f'cd -- {shlex.quote(args.cwd)} || exit; '
        # Keep the parent shell alive to remove the socket when the login shell exits.
        script += '/bin/zsh -il' if args.shell else shlex.join([args.pi, *pi_args])
        command = [
            'ssh', '-tt', '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
            '-R', f'{socket_path}:127.0.0.1:{state["port"]}',
            args.host, shlex.join(['/bin/zsh', '-c' if args.shell else '-lic', script]),
        ]
        try:
            return subprocess.call(command)
        finally:
            try:
                if helper.poll() is None:
                    stop(state_path)
                helper.wait(timeout=12)
            finally:
                if helper.poll() is None:
                    helper.terminate()
                    helper.wait(timeout=12)


if __name__ == '__main__':
    sys.exit(main())
