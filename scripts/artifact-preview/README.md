# Mac artifact links over SSH

The preview service serves files on the Mac. SSH forwards its loopback port to Windows so browser links work in Windows Terminal, including when Pi runs inside Herdr or tmux.

This implements [issue #7](https://github.com/stanley50z/sz-pi-extensions/issues/7).

## Connect

Install this checkout on both machines at `~/sz-pi-extensions`. The service uses Python's standard library and supports Python 3.9 or newer; no npm dependency or browser integration is needed.

From Windows Terminal:

```powershell
python "$HOME\sz-pi-extensions\scripts\ssh-clipboard\ssh.py" --shell mac
```

If you already dot-source the clipboard helper's PowerShell profile, bare `ssh mac` runs this command. Then open Herdr and Pi normally. Reconnect and run `/reload` in existing Pi panes after installing the new extension.

The launcher:
1. Adds `-L 127.0.0.1:43136:127.0.0.1:43136` alongside clipboard forwarding.
2. Starts or checks `$HOME/sz-pi-extensions/scripts/artifact-preview/start.py` on the Mac.
3. Opens your login shell or Pi.

If the local port is occupied or the remote service fails to start, the connection fails visibly rather than giving you broken links. `--no-preview` retains clipboard-only operation. `--preview-port PORT` changes both ends; stop an existing service before changing its port and register any chosen fixed port in each machine's `~/LOCALHOST_PORTS.md`.

The service is shared by every project under the Mac account. Use one preview-enabled SSH connection at a time on Windows; other connections can use `ssh.exe` or `--no-preview`.

## Agent handoff

Put previews/reports and their relative images, CSS, and JavaScript in either:

- `<current-project>/data/previews/`
- `<current-project>/.pi/artifacts/`

Call the Pi tool:

```text
artifact_link({ path: "data/previews/douyin-navigation-options.html" })
```

It returns a URL shaped like:

```text
http://127.0.0.1:43136/<random-directory-capability>/douyin-navigation-options.html
```

Use that HTTP URL in the final response or before asking the user to choose a preview. When the service is active, the extension adds these instructions at each agent turn, overriding local-file handoff conventions for this workflow. Pi does not rewrite old messages; ask it to relink an existing preview.

Publication makes the designated preview directory available, including its relative assets. It does not copy files or expose the rest of the project. Assets outside that directory must be moved into it and their references updated. Relative links must stay within the published directory; absolute paths such as `/assets/image.png` are not remapped.

Links survive an SSH disconnect/reconnect and repeated `start.py` calls while the shared service stays running. Stopping/restarting the service revokes old links; call `artifact_link` again.

## Standalone controls

On the Mac (use `python` instead of `python3` on Windows):

```bash
python3 ~/sz-pi-extensions/scripts/artifact-preview/start.py
python3 ~/sz-pi-extensions/scripts/artifact-preview/stop.py
```

Both scripts work without opening a terminal window. Start leaves the service in the background. Stop authenticates to the recorded service, waits for cleanup, and checks that its listener is closed; it does not kill processes by name or unrelated PIDs.

The Mac service deliberately remains running after SSH disconnects so persistent Herdr sessions and their links remain valid. It is not installed as a login daemon; the next launcher connection starts it after a reboot. The Windows tunnel exists only while SSH is connected.

For a manual tunnel:

```bash
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:43136:127.0.0.1:43136 mac
```

A plain SSH connection without this forward cannot open the returned URLs on Windows.

## HTTP interface

Other agents can use the service without Pi:

- `GET /health`: requires `Authorization: Bearer <control-token>`.
- `POST /publish`: same authorization, JSON body `{"cwd":"/absolute/project","path":"data/previews/report.html"}`; returns `{"url":"http://127.0.0.1:..." }`.
- `GET` or `HEAD` on the returned URL: serves the file without extra browser headers.
- `POST /stop`: requires the control token.

The private state file contains the control token and actual port. Control requests should connect directly to loopback, bypassing HTTP proxies.

## Security

Both service and SSH forward bind only to `127.0.0.1`. No public listener, firewall rule, or third-party upload is required.

A random, unguessable capability identifies each published directory. Treat its URLs as private: anyone with a URL and access to the local/forwarded service can read non-hidden files in that directory. Put only shareable artifacts there. No directory listing is provided. Traversal, hidden files, symlinked preview roots, and symlink escapes are rejected and checked again on reads.

Publication and shutdown require a separate control token. State has mode 0600 and its directory has mode 0700 on POSIX; Windows relies on the user's profile permissions. These are not protections against programs already running as your user. Preview HTML is active browser content, not a sandbox, and all published directories share one HTTP origin.

## Diagnostics and validation

Default persistent paths on the Mac:

- `~/.pi/agent/artifact-preview/server.log`: service startup/request diagnostics and uncaught crash tracebacks; excludes control tokens, capability URLs, and file contents.
- `~/.pi/agent/logs/artifact-link.log`: tool failure stack traces.
- `~/.pi/agent/logs/artifact-preview-validation/`: regression test output and real SSH/browser validation evidence.

`PI_CODING_AGENT_DIR` changes the `~/.pi/agent` root. `--state PATH` selects an isolated service state, with diagnostics in the adjacent `.log` file. The state `server.json` contains credentials; never attach it to bug reports. Stopping the service removes state/readiness files but keeps logs. Native crash dumps are not configured; Python and tool exceptions persist stack traces.

Start and stop coordinate through a private state lock. If the recorded listener explicitly refuses connections after a crash/reboot, start removes only that service's validated state and starts a fresh service; stop can clean the inactive state too. Neither kills the recorded PID. Timeout, authentication, invalid state, and port conflicts fail visibly rather than being treated as a dead service. Control requests never follow HTTP redirects. Inspect the log for failures; do not kill an arbitrary process. Invalid/incomplete state (for example, an interruption during the first startup) is deliberately not overwritten. After verifying that its service is inactive, move that state and readiness file aside for diagnosis before starting again.

`npm test` includes the tool and real Python CLI/HTTP tests. `npm run typecheck:artifact-link` checks the extension. Tests use isolated state and OS-assigned ports. Symlink tests run on macOS/Linux; the real Mac validation covers them as well as Mac-specific clipboard launcher tests.
