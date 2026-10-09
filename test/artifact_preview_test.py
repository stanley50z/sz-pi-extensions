"""Exercise artifact publication, file serving, and shutdown through the real CLI/HTTP boundary."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'scripts' / 'artifact-preview'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class ArtifactPreviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='artifact-preview-test-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.state = self.folder / 'agent' / 'artifact-preview' / 'server.json'
        self.project = self.folder / 'project'
        self.previews = self.project / 'data' / 'previews'
        self.previews.mkdir(parents=True)
        (self.previews / '方案 one.html').write_text('<img src="assets/pixel.svg">', encoding='utf-8')
        (self.previews / 'assets').mkdir()
        (self.previews / 'assets' / 'pixel.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding='utf-8')
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(self.state), '--port', '0'],
                             capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.metadata = json.loads(self.state.read_text(encoding='utf-8'))
        self.addCleanup(self.stop_server)
        self.base = 'http://127.0.0.1:' + str(self.metadata['port'])

    def stop_server(self):
        if self.state.exists():
            run = subprocess.run([sys.executable, '-B', str(ROOT / 'stop.py'), '--state', str(self.state)],
                                 capture_output=True, text=True, encoding='utf-8', timeout=15)
            self.assertEqual(run.returncode, 0, run.stderr)
        with socket.socket() as probe:
            probe.settimeout(0.2)
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', self.metadata['port'])), 0)

    def publish(self, path='data/previews/方案 one.html', token=None):
        request = urllib.request.Request(self.base + '/publish', method='POST',
            data=json.dumps({'cwd': str(self.project), 'path': path}).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + (token or self.metadata['token']), 'Content-Type': 'application/json'})
        with OPENER.open(request, timeout=3) as response:
            return json.load(response)

    def test_published_html_and_relative_assets_open_with_browser_urls(self):
        result = self.publish()
        self.assertTrue(result['url'].startswith(self.base + '/'))
        self.assertIn('%E6%96%B9%E6%A1%88%20one.html', result['url'])
        with OPENER.open(result['url'], timeout=3) as response:
            self.assertEqual(response.headers['Content-Type'], 'text/html; charset=utf-8')
            self.assertEqual(response.read(), b'<img src="assets/pixel.svg">')
        with OPENER.open(urllib.parse.urljoin(result['url'], 'assets/pixel.svg'), timeout=3) as response:
            self.assertEqual(response.headers['Content-Type'], 'image/svg+xml')
            self.assertEqual(response.read(), b'<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.assertEqual(self.publish()['url'], result['url'])
        self.stop_server()
        self.assertFalse(self.state.exists())
        self.assertTrue(self.state.with_suffix('.log').exists(), 'diagnostics must survive shutdown')

    def assert_http_error(self, request, status):
        with self.assertRaises(urllib.error.HTTPError) as error:
            OPENER.open(request, timeout=3)
        self.assertEqual(error.exception.code, status)
        error.exception.close()

    def test_controls_require_authentication_and_urls_require_a_capability(self):
        self.assert_http_error(self.base + '/health', 403)
        self.assert_http_error(urllib.request.Request(self.base + '/stop', method='POST'), 403)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.publish(token='f' * 64)
        self.assertEqual(error.exception.code, 403)
        error.exception.close()
        result = self.publish()
        self.assert_http_error(self.base + '/' + 'f' * 64 + '/%E6%96%B9%E6%A1%88%20one.html', 404)
        with OPENER.open(result['url'], timeout=3) as response:
            self.assertEqual(response.status, 200)

    def test_publication_rejects_project_files_and_hidden_files(self):
        (self.project / '.env').write_text('SECRET=value', encoding='utf-8')
        (self.previews / '.env').write_text('SECRET=value', encoding='utf-8')
        for path in ('.env', 'data/previews/.env', 'data/previews/../../.env', 'data/previews/missing.html'):
            with self.subTest(path=path):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.publish(path)
                self.assertEqual(error.exception.code, 400)
                error.exception.close()

    def test_browser_requests_reject_traversal_hidden_files_and_directory_listing(self):
        result = self.publish()
        prefix = result['url'].rsplit('/', 1)[0]
        (self.previews / '.env').write_text('SECRET=value', encoding='utf-8')
        for path in ('/%2e%2e/%2e%2e/.env', '/.env', '/assets/', '/assets%5c..%5c.env', '/assets/C:secret'):
            self.assert_http_error(prefix + path, 404)
        self.assert_http_error(prefix, 404)
        request = urllib.request.Request(result['url'], method='HEAD')
        with OPENER.open(request, timeout=3) as response:
            self.assertEqual(response.headers['Content-Length'], '28')
            self.assertEqual(response.read(), b'')

    @unittest.skipIf(os.name == 'nt', 'Symlink behavior is also run on the real Mac')
    def test_symlinks_cannot_expose_files_outside_the_root_or_hidden_files(self):
        (self.project / 'secret.txt').write_text('PRIVATE', encoding='utf-8')
        (self.previews / 'escape.txt').symlink_to(self.project / 'secret.txt')
        (self.previews / '.secret').write_text('PRIVATE', encoding='utf-8')
        (self.previews / 'hidden.txt').symlink_to(self.previews / '.secret')
        for path in ('data/previews/escape.txt', 'data/previews/hidden.txt'):
            with self.subTest(path=path):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    self.publish(path)
                self.assertEqual(error.exception.code, 400)
                error.exception.close()
        prefix = self.publish()['url'].rsplit('/', 1)[0]
        self.assert_http_error(prefix + '/escape.txt', 403)
        self.assert_http_error(prefix + '/hidden.txt', 403)

    @unittest.skipIf(os.name == 'nt', 'Symlink behavior is also run on the real Mac')
    def test_absolute_artifact_paths_work_when_project_cwd_is_a_symlink(self):
        alias = self.folder / 'project-alias'
        alias.symlink_to(self.project, target_is_directory=True)
        request = urllib.request.Request(self.base + '/publish', method='POST',
            data=json.dumps({'cwd': str(alias), 'path': str(alias / 'data' / 'previews' / '方案 one.html')}).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + self.metadata['token']})
        with OPENER.open(request, timeout=3) as response:
            url = json.load(response)['url']
        with OPENER.open(url, timeout=3) as response:
            self.assertEqual(response.read(), b'<img src="assets/pixel.svg">')

    def test_restart_command_reuses_service_and_published_links(self):
        result = self.publish()
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(self.state), '--port', str(self.metadata['port'])],
                             capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['pid'], self.metadata['pid'])
        with OPENER.open(result['url'], timeout=3) as response:
            self.assertEqual(response.status, 200)
        log = self.state.with_suffix('.log').read_text(encoding='utf-8')
        self.assertNotIn(self.metadata['token'], log)
        self.assertNotIn(result['url'].split('/')[-2], log)

    def crash_service(self):
        import signal
        import time
        # This PID belongs to the isolated service created by this test, never an existing app.
        os.kill(self.metadata['pid'], signal.SIGTERM if os.name == 'nt' else signal.SIGKILL)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                probe.settimeout(0.2)
                if probe.connect_ex(('127.0.0.1', self.metadata['port'])) != 0:
                    return
            time.sleep(0.05)
        self.fail('Crashed test service did not release its listener')

    def test_start_recovers_after_service_crash_without_manual_state_deletion(self):
        self.crash_service()
        run = subprocess.run([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(self.state), '--port', str(self.metadata['port'])],
                             capture_output=True, text=True, encoding='utf-8', timeout=15)
        self.assertEqual(run.returncode, 0, run.stderr)
        recovered = json.loads(self.state.read_text(encoding='utf-8'))
        self.assertNotEqual(recovered['token'], self.metadata['token'])
        self.metadata = recovered
        with OPENER.open(self.publish()['url'], timeout=3) as response:
            self.assertEqual(response.status, 200)

    def test_simultaneous_starts_share_one_service(self):
        self.stop_server()
        commands = [subprocess.Popen([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(self.state), '--port', '0'],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        records = []
        try:
            for process in commands:
                output, error = process.communicate(timeout=15)
                self.assertEqual(process.returncode, 0, error.decode('utf-8'))
                records.append(json.loads(output))
            self.metadata = json.loads(self.state.read_text(encoding='utf-8'))
            self.base = 'http://127.0.0.1:' + str(self.metadata['port'])
            self.assertEqual(records[0]['pid'], records[1]['pid'])
            with OPENER.open(self.publish()['url'], timeout=3) as response:
                self.assertEqual(response.status, 200)
        finally:
            for process in commands:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_stop_cleans_crashed_service_state_and_preserves_logs(self):
        self.crash_service()
        self.stop_server()
        self.assertFalse(self.state.exists())
        self.assertFalse(self.state.with_suffix('.ready').exists())
        self.assertTrue(self.state.with_suffix('.log').exists())

    def test_multiple_projects_have_separate_roots_and_pi_artifacts_work(self):
        other = self.folder / 'other' / '.pi' / 'artifacts'
        other.mkdir(parents=True)
        (other / 'report.html').write_text('OTHER PROJECT', encoding='utf-8')
        request = urllib.request.Request(self.base + '/publish', method='POST',
            data=json.dumps({'cwd': str(other.parents[1]), 'path': '.pi/artifacts/report.html'}).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + self.metadata['token']})
        with OPENER.open(request, timeout=3) as response:
            url = json.load(response)['url']
        with OPENER.open(url, timeout=3) as response:
            self.assertEqual(response.read(), b'OTHER PROJECT')
        self.assertNotEqual(url.split('/')[-2], self.publish()['url'].split('/')[-2])


class UnrelatedListenerTest(unittest.TestCase):
    def test_start_rejects_wrong_health_status_and_does_not_follow_redirects(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        for status in (200, 302):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                requests = []
                class Handler(BaseHTTPRequestHandler):
                    def log_message(self, *_args):
                        pass
                    def do_GET(self):
                        requests.append(self.path)
                        self.send_response(status if self.path == '/health' else 204)
                        if status == 302:
                            self.send_header('Location', 'http://127.0.0.1:' + str(self.server.server_port) + '/leak')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    state = Path(directory) / 'server.json'
                    content = json.dumps({'port': server.server_port, 'pid': os.getpid(), 'token': 'a' * 64})
                    state.write_text(content, encoding='utf-8')
                    state.chmod(0o600)
                    run = subprocess.run([sys.executable, '-B', str(ROOT / 'start.py'), '--state', str(state), '--port', str(server.server_port)],
                                         capture_output=True, text=True, encoding='utf-8', timeout=15)
                    self.assertNotEqual(run.returncode, 0, 'A foreign listener must not count as a healthy service')
                    self.assertNotIn('/leak', requests, 'Control credentials must not follow redirects')
                    self.assertEqual(state.read_text(encoding='utf-8'), content)
                finally:
                    server.shutdown()
                    thread.join(timeout=3)
                    server.server_close()


if __name__ == '__main__':
    unittest.main()
