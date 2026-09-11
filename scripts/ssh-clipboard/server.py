"""Loopback-only clipboard service, reached through an authenticated SSH forward."""
import argparse
import base64
import hmac
import json
import os
from pathlib import Path
import subprocess
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_IMAGE_BYTES = 20 * 1024 * 1024


class EmptyClipboardError(Exception):
    pass


# Capture runs in a Windows STA process only when an authenticated paste is requested.
def read_windows_clipboard():
    if os.name != 'nt':
        raise RuntimeError('Windows clipboard capture requires Windows')
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy',
         'Bypass', '-File', str(Path(__file__).with_name('capture.ps1'))],
        capture_output=True, timeout=8, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    if result.returncode == 3:
        raise EmptyClipboardError('No image on the Windows clipboard')
    if result.returncode:
        raise RuntimeError('Windows clipboard capture failed: ' + result.stderr.decode('utf-8', errors='replace').strip())
    return base64.b64decode(result.stdout.strip(), validate=True)


# The callable is the OS clipboard boundary, allowing transport tests without a desktop.
def create_server(token, capture=read_windows_clipboard, request_timeout=10):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(request_timeout)
            self.expired = threading.Event()
            self.deadline = threading.Timer(request_timeout, self.expire)
            self.deadline.daemon = True
            self.deadline.start()

        # Bound elapsed request time even when a client keeps trickling header bytes.
        def expire(self):
            self.expired.set()
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # The peer may already have closed the connection.
            self.connection.close()

        def finish(self):
            self.deadline.cancel()
            super().finish()

        def log_message(self, _format, *_args):
            pass  # Never log clipboard requests or credentials.

        def reply(self, status, body, content_type='text/plain; charset=utf-8'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            if self.expired.is_set():
                return False
            value = self.headers.get('Authorization', '')
            if not hmac.compare_digest(value.encode(), ('Bearer ' + token).encode()):
                self.reply(403, b'Forbidden')
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path != '/image':
                self.reply(404, b'Not found')
                return
            try:
                image = capture()
                if len(image) > MAX_IMAGE_BYTES:
                    self.reply(413, b'Screenshot exceeds the 20 MiB limit')
                    return
            except EmptyClipboardError:
                self.reply(409, b'No image on the Windows clipboard')
                return
            except Exception as error:
                self.reply(500, str(error).encode('utf-8'))
                return
            self.reply(200, image, 'image/png')

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != '/stop':
                self.reply(404, b'Not found')
                return
            self.server.stopping = True
            self.reply(200, b'Stopping')

    # Parent monitoring and authenticated shutdown remain available during slow requests.
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = False  # Shutdown joins bounded requests and their capture processes.
    server.stopping = False
    server.timeout = 0.5
    return server


# Detect an exited launcher so a killed SSH window does not leave the helper running.
def parent_alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--parent', type=int)
    args = parser.parse_args()
    state = json.loads(args.state.read_text(encoding='utf-8'))
    server = create_server(state['token'])
    try:
        state.update(port=server.server_port, pid=os.getpid())
        # Publish readiness only after closing the state file. Windows readers never race a replace.
        args.state.write_text(json.dumps(state), encoding='utf-8')
        args.state.with_suffix('.ready').touch(exist_ok=False)
        while not server.stopping and (args.parent is None or parent_alive(args.parent)):
            server.handle_request()
    finally:
        server.server_close()
        args.state.with_suffix('.ready').unlink(missing_ok=True)
        args.state.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
