"""Serve explicitly published preview directories on loopback, independently of Pi."""
import argparse
import hmac
import json
import mimetypes
import os
from pathlib import Path
import secrets
import shutil
import signal
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlsplit
from common import DEFAULT_PORT, remove_owned_state, state_lock

PREVIEW_DIRS = (('data', 'previews'), ('.pi', 'artifacts'))


# Resolve a requested file only within a designated, non-symlinked preview root.
def locate_artifact(cwd, path):
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or not isinstance(path, str):
        raise ValueError('cwd must be absolute and path must be a file path')
    requested_project = Path(os.path.abspath(cwd))
    project = requested_project.resolve(strict=True)
    candidate = Path(path)
    candidate = candidate if candidate.is_absolute() else requested_project / candidate
    candidate = Path(os.path.abspath(candidate))
    if candidate.is_relative_to(requested_project):
        candidate = project / candidate.relative_to(requested_project)
    for parts in PREVIEW_DIRS:
        root = project.joinpath(*parts)
        if candidate.is_relative_to(root):
            if root.resolve(strict=True) != root:
                raise ValueError('Preview directory must not be a symlink')
            relative = candidate.relative_to(root)
            if any(part.startswith('.') for part in relative.parts):
                raise ValueError('Hidden files cannot be published')
            real = candidate.resolve(strict=True)
            if (not real.is_relative_to(root) or not real.is_file()
                    or any(part.startswith('.') for part in real.relative_to(root).parts)):
                raise ValueError('Artifact must be a regular file inside the preview directory')
            return root, relative
    raise ValueError('Place artifacts and their assets in data/previews or .pi/artifacts')


# Capability URLs permit browser navigation; the private token controls publication and shutdown.
def create_server(token, port=DEFAULT_PORT):
    roots = {}
    root_ids = {}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        # Do not persist capability URLs or authorization headers in request logs.
        def log_message(self, format, *args):
            print('artifact-preview HTTP request completed', flush=True)

        def reply(self, status, body=b'', content_type='text/plain; charset=utf-8'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.reply(403, b'Forbidden')
                return False
            return True

        def do_GET(self):
            if self.path == '/health':
                if self.authorized():
                    if self.server.stopping:
                        self.reply(503, b'Preview service is stopping')
                    else:
                        self.reply(204)
                return
            try:
                parts = unquote(urlsplit(self.path).path, errors='strict').split('/')
                if (len(parts) < 3 or parts[0] or any(not part or part.startswith('.') or '\\' in part or ':' in part for part in parts[2:])):
                    self.reply(404, b'Not found')
                    return
                with lock:
                    root = roots.get(parts[1])
                if root is None:
                    self.reply(404, b'Not found')
                    return
                # Recheck on every request: files and symlinks may change after publication.
                if root.resolve(strict=True) != root:
                    self.reply(403, b'Preview directory changed')
                    return
                path = root.joinpath(*parts[2:]).resolve(strict=True)
                if (not path.is_relative_to(root) or not path.is_file()
                        or any(part.startswith('.') for part in path.relative_to(root).parts)):
                    self.reply(403, b'Forbidden')
                    return
                content_type = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
                if content_type.startswith('text/'):
                    content_type += '; charset=utf-8'
                with path.open('rb') as source:
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(os.fstat(source.fileno()).st_size))
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Referrer-Policy', 'no-referrer')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.end_headers()
                    if self.command != 'HEAD':
                        shutil.copyfileobj(source, self.wfile)
            except (FileNotFoundError, NotADirectoryError):
                self.reply(404, b'Not found')
            except (ValueError, UnicodeError):
                self.reply(400, b'Invalid path')
            except Exception:
                traceback.print_exc()
                if not self.wfile.closed:
                    self.reply(500, b'Artifact request failed; see server.log')

        do_HEAD = do_GET

        def do_POST(self):
            if not self.authorized():
                return
            if self.path == '/stop':
                self.server.stopping = True
                self.reply(200, b'Stopping')
                return
            if self.path != '/publish':
                self.reply(404, b'Not found')
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise ValueError('Publication request must be at most 16 KiB')
                value = json.loads(self.rfile.read(size))
                if not isinstance(value, dict):
                    raise ValueError('Publication request must be an object')
                root, relative = locate_artifact(value.get('cwd'), value.get('path'))
                with lock:
                    if root not in root_ids:
                        root_ids[root] = secrets.token_hex(32)
                        roots[root_ids[root]] = root
                    root_id = root_ids[root]
                url = ('http://127.0.0.1:' + str(self.server.server_port) + '/' + root_id + '/'
                       + '/'.join(quote(part, safe='') for part in relative.parts))
                self.reply(200, json.dumps({'url': url}).encode('utf-8'), 'application/json')
            except (ValueError, UnicodeError, FileNotFoundError, NotADirectoryError) as error:
                self.reply(400, str(error).encode('utf-8'))
            except Exception:
                traceback.print_exc()
                self.reply(500, b'Artifact publication failed; see server.log')

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = False
    server.timeout = 0.25
    server.stopping = False
    return server


# Readiness and shutdown state belong to this process; SIGTERM follows the same cleanup path.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    args = parser.parse_args()
    state = json.loads(args.state.read_text(encoding='utf-8'))
    server = create_server(state['token'], args.port)
    try:
        state.update(port=server.server_port, pid=os.getpid())
        temporary = args.state.with_suffix('.tmp')
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as stream:
            json.dump(state, stream)
        temporary.replace(args.state)
        args.state.with_suffix('.ready').touch(mode=0o600, exist_ok=False)
        signal.signal(signal.SIGTERM, lambda *_: setattr(server, 'stopping', True))
        print('artifact-preview listening on 127.0.0.1:' + str(server.server_port), flush=True)
        while not server.stopping:
            server.handle_request()
    finally:
        server.server_close()
        with state_lock(args.state):
            remove_owned_state(args.state, state['token'])
        print('artifact-preview stopped', flush=True)


if __name__ == '__main__':
    main()
