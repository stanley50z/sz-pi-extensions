"""Exercise the helper's public HTTP boundary; clipboard capture is OS-specific."""
import importlib.util
import pathlib
import threading
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'ssh-clipboard'
spec = importlib.util.spec_from_file_location('clipboard_server', ROOT / 'server.py')
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)
PNG = bytes.fromhex('89504e470d0a1a0a') + b'clipboard fixture'


class ClipboardServerTest(unittest.TestCase):
    def test_authenticated_image_request_reads_clipboard_on_demand(self):
        reads = []
        def capture():
            reads.append(True)
            return PNG
        server = server_module.create_server('a' * 64, capture)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            self.assertEqual(reads, [])
            url = f'http://127.0.0.1:{server.server_port}/image'
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(url, timeout=2)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
            self.assertEqual(reads, [])
            request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + 'a' * 64})
            with urllib.request.urlopen(request, timeout=2) as response:
                self.assertEqual(response.headers['Content-Type'], 'image/png')
                self.assertEqual(response.read(), PNG)
            self.assertEqual(reads, [True])
        finally:
            server.shutdown()
            thread.join(timeout=3)
            server.server_close()


class RequestBoundsTest(unittest.TestCase):
    # Keep sending until closure so an idle timeout cannot impersonate a total deadline.
    def test_slow_unauthenticated_request_has_a_total_deadline(self):
        import select
        import socket
        import time
        server = server_module.create_server('a' * 64, lambda: PNG, request_timeout=0.3)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with socket.create_connection(('127.0.0.1', server.server_port), timeout=2) as client:
                client.sendall(b'GET /image HTTP/1.1\r\n')
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    try:
                        client.sendall(b'X')
                        readable, _, _ = select.select([client], [], [], 0.05)
                        if readable:
                            self.assertEqual(client.recv(1024), b'')
                            break
                    except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                        break  # A closed connection can surface as EOF, reset, abort, or broken pipe.
                else:
                    self.fail('Total request deadline did not close a continuously trickling connection')
        finally:
            server.shutdown()
            thread.join(timeout=3)
            server.server_close()

    def test_connections_require_their_own_token(self):
        first = server_module.create_server('a' * 64, lambda: b'first')
        second = server_module.create_server('b' * 64, lambda: b'second')
        threads = [threading.Thread(target=server.serve_forever) for server in (first, second)]
        for thread in threads:
            thread.start()
        try:
            url = f'http://127.0.0.1:{second.server_port}/image'
            wrong = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + 'a' * 64})
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(wrong, timeout=2)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
            right = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + 'b' * 64})
            with urllib.request.urlopen(right, timeout=2) as response:
                self.assertEqual(response.read(), b'second')
        finally:
            for server, thread in zip((first, second), threads):
                server.shutdown()
                thread.join(timeout=3)
                server.server_close()


@unittest.skipUnless(__import__('os').name == 'nt', 'Windows PowerShell profile integration')
class ShellAliasTest(unittest.TestCase):
    def test_only_bare_ssh_mac_uses_the_clipboard_launcher(self):
        import json
        import subprocess
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            script = pathlib.Path(directory) / 'profile-test.ps1'
            profile = str(ROOT / 'profile.ps1').replace("'", "''")
            # Stand in for the two native commands, not the profile function under test.
            script.write_text(
                "$ErrorActionPreference = 'Stop'\n. '" + profile + "'\n"
                "function python { @{ command = 'python'; arguments = @($args) } | ConvertTo-Json -Compress; $global:LASTEXITCODE = 7 }\n"
                "function ssh.exe { @{ command = 'ssh.exe'; arguments = @($args) } | ConvertTo-Json -Compress; $global:LASTEXITCODE = 7 }\n"
                "ssh @args\nexit $LASTEXITCODE\n", encoding='utf-8')
            for arguments, command, expected in [
                (['mac'], 'python', [str(ROOT / 'ssh.py'), '--shell', 'mac']),
                (['other-host'], 'ssh.exe', ['other-host']),
                (['mac', 'printf hello'], 'ssh.exe', ['mac', 'printf hello']),
                (['-N', 'mac'], 'ssh.exe', ['-N', 'mac']),
            ]:
                with self.subTest(arguments=arguments):
                    run = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File', str(script), *arguments], capture_output=True, text=True, timeout=10)
                    self.assertEqual(run.returncode, 7, run.stderr)
                    self.assertEqual(json.loads(run.stdout), {'command': command, 'arguments': expected})


class HelperLifecycleTest(unittest.TestCase):
    @unittest.skipUnless(__import__('sys').platform == 'darwin', 'Requires the Mac login shell')
    def test_shell_mode_inherits_clipboard_connection_and_preserves_exit_status(self):
        import json
        import os
        import shlex
        import socket
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory)
            record = folder / 'forward.json'
            logins = folder / 'logins.txt'
            (folder / '.zprofile').write_text('print login >> ' + shlex.quote(str(logins)) + '\n', encoding='utf-8')
            fake_ssh = folder / 'ssh'
            # Replace only the SSH network boundary; execute the real remote shell command.
            fake_ssh.write_text(
                '#!' + sys.executable + '\nimport json,subprocess,sys\nfrom pathlib import Path\n'
                + 'Path(' + repr(str(record)) + ').write_text(json.dumps(sys.argv[sys.argv.index("-R") + 1]))\n'
                + 'sys.exit(subprocess.call(sys.argv[-1], shell=True))\n', encoding='utf-8')
            fake_ssh.chmod(0o700)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'ZDOTDIR': directory}
            probe = 'import json,os; print(json.dumps({k: os.environ[k] for k in ("PI_SSH_CLIPBOARD_SOCKET", "PI_SSH_CLIPBOARD_TOKEN")}))'
            run = subprocess.run(
                [sys.executable, '-B', str(ROOT / 'ssh.py'), '--shell', 'my-mac'],
                input=shlex.join([sys.executable, '-c', probe]) + '\nexit 7\n',
                env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(run.returncode, 7, run.stderr)
            self.assertEqual(logins.read_text(encoding='utf-8').splitlines(), ['login'])
            metadata = json.loads(next(line for line in run.stdout.splitlines() if line.startswith('{')))
            self.assertRegex(metadata['PI_SSH_CLIPBOARD_TOKEN'], r'^[0-9a-f]{64}$')
            forward = json.loads(record.read_text(encoding='utf-8'))
            self.assertEqual(metadata['PI_SSH_CLIPBOARD_SOCKET'], forward.split(':', 1)[0])
            with socket.socket() as connection:
                self.assertNotEqual(connection.connect_ex(('127.0.0.1', int(forward.rsplit(':', 1)[1]))), 0)

    def test_start_and_stop_cli_leave_no_listener(self):
        import json
        import socket
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            state = pathlib.Path(directory) / 'connection.json'
            started = subprocess.run([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(state)], capture_output=True, text=True, timeout=15)
            self.assertEqual(started.returncode, 0, started.stderr)
            self.assertTrue(state.with_suffix('.ready').exists())
            metadata = json.loads(state.read_text(encoding='utf-8'))
            try:
                with socket.create_connection(('127.0.0.1', metadata['port']), timeout=2):
                    pass
            finally:
                stopped = subprocess.run([sys.executable, '-B', str(ROOT / 'stop.py'), '--state', str(state)], capture_output=True, text=True, timeout=15)
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
            self.assertFalse(state.exists())
            self.assertFalse(state.with_suffix('.ready').exists())
            with socket.socket() as connection:
                self.assertNotEqual(connection.connect_ex(('127.0.0.1', metadata['port'])), 0)

    @unittest.skipIf(__import__('os').name == 'nt', 'POSIX SSH stand-in for CLI argument checks')
    def test_launcher_scopes_forwarding_and_cleans_up_after_ssh_failure(self):
        import json
        import os
        import socket
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            folder = pathlib.Path(directory)
            record = folder / 'args.json'
            fake_ssh = folder / 'ssh'
            fake_ssh.write_text('#!' + sys.executable + '\nimport json,sys\nfrom pathlib import Path\nPath(' + repr(str(record)) + ').write_text(json.dumps(sys.argv[1:]))\nsys.exit(7)\n', encoding='utf-8')
            fake_ssh.chmod(0o700)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH']}
            run = subprocess.run([sys.executable, '-B', str(ROOT / 'ssh.py'), '--cwd', "/Users/me/a b'c", 'my-mac', '--', '--continue'], env=env, capture_output=True, text=True, timeout=20)
            self.assertEqual(run.returncode, 7, run.stderr)
            args = json.loads(record.read_text())
            self.assertIn('ExitOnForwardFailure=yes', args)
            forward = args[args.index('-R') + 1]
            self.assertTrue(forward.startswith('/tmp/pi-clipboard-'))
            self.assertIn(':127.0.0.1:', forward)
            with socket.socket() as probe:
                self.assertNotEqual(probe.connect_ex(('127.0.0.1', int(forward.rsplit(':', 1)[1]))), 0)
            self.assertEqual(args[-2], 'my-mac')
            self.assertIn('PI_SSH_CLIPBOARD_SOCKET=', args[-1])
            self.assertIn('PI_SSH_CLIPBOARD_TOKEN=', args[-1])
            self.assertIn('--continue', args[-1])
            import shlex
            remote = shlex.split(args[-1])
            self.assertEqual(remote[:2], ['/bin/zsh', '-lic'])
            words = shlex.split(remote[2])
            self.assertEqual(words[words.index('cd') + 2], "/Users/me/a b'c")
