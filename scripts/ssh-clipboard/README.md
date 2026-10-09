# Windows screenshots over SSH

Copy a screenshot on Windows, then press **Alt+V** in the main Pi prompt on the Mac. The image transfers through SSH and appears as a quoted file reference in your draft. Press Enter to send the draft with the image attached. Remove the reference before submitting to omit that image.

Normal Windows Terminal text paste is unchanged. This does not replace clipboard handling inside `ask_user` or other custom dialogs.

## Setup

Requirements on Windows:

- Python 3.10 or later, available as `python`.
- Windows PowerShell 5.1 and the OpenSSH client, available as `powershell.exe` and `ssh`.
- A checkout of this repository. The helper uses only Python's standard library and Windows components; Windows does not need Pi or npm.

On the Mac, install this Pi package and enable Remote Login. The SSH server must permit remote Unix-socket forwarding, `AllowStreamLocalForwarding`, with private socket permissions. OpenSSH's default `StreamLocalBindMask 0177` permits only the socket owner. Do not use a permissive mask on a shared host.

Run this from PowerShell in Windows Terminal, replacing `my-mac` with your usual SSH destination or SSH config alias:

```powershell
cd "$HOME\sz-pi-extensions"
python scripts\ssh-clipboard\ssh.py my-mac
```

To resume the last session in this project:

```powershell
python scripts\ssh-clipboard\ssh.py --cwd /Users/sidac/sz-pi-extensions my-mac -- --continue
```

SSH config aliases supply the hostname, username, key, port, and jump host as usual. Put Pi arguments after `--`. Use `--pi /absolute/path/to/pi` if Pi is not on the Mac's interactive login-shell PATH. The launcher uses macOS `/bin/zsh -lic`.

### Use `ssh mac` to open a normal shell

To open a Mac login shell with clipboard forwarding ready, instead of launching Pi directly:

```powershell
python "$HOME\sz-pi-extensions\scripts\ssh-clipboard\ssh.py" --shell mac
```

You can then change directories and run `pi` or `pi --continue`, directly or inside Herdr. Pi discovers the live clipboard connection independently of the pane's inherited environment. `--shell` cannot be combined with `--pi` or Pi arguments after `--`.

For the short command, add this line to your PowerShell profile:

```powershell
. "$HOME\sz-pi-extensions\scripts\ssh-clipboard\profile.ps1"
```

Open a new PowerShell tab and run `ssh mac`. The profile defines a shell function, not an SSH config alias. It intercepts only bare `ssh mac`; other hosts and commands with extra arguments, such as `ssh mac uptime` or `ssh -N mac`, still use ordinary SSH. Use `ssh.exe mac` to bypass the function. The Windows clipboard helper stops when you exit the Mac shell. The launcher also forwards preview port `43136` and starts a shared Mac artifact service, which stays running across disconnects. No SSH configuration change is needed. See [artifact preview setup and controls](../artifact-preview/README.md); use `--no-preview` for clipboard-only connections.

### Pi inside Herdr

Keep your usual workflow:

1. On Windows, run `ssh mac` with the profile function above.
2. On the Mac, run `herdr` and launch `pi` in a pane.
3. Copy a Windows screenshot and press Alt+V in Pi's main prompt.

You can disconnect and reconnect through `ssh mac` without restarting Herdr or Pi. Each paste discovers the current authenticated connection instead of reusing the persistent server's old socket and token. This also works in tmux.

When upgrading from the environment-only bridge, reconnect once with the updated Windows launcher, then run `/reload` in each existing Pi process to load the updated Mac extension. Do not stop the Herdr server. Pi processes started before any clipboard connection was published also need one `/reload` to enable discovery.

If several clipboard-enabled SSH connections to the same Mac account are active, Pi reports ambiguity without reading any clipboard. Close the extra connections, leaving the one whose Windows clipboard you want to use. A plain `ssh.exe` connection does not create another clipboard bridge.

### Paste a screenshot

1. Take a screenshot with Win+Shift+S and copy it.
2. Focus the remote Pi prompt and press Alt+V.
3. Wait for the `@"...png"` reference to appear. You can add text or paste another image.
4. Press Enter. Pi receives PNG image content, not Windows-only file paths.

An existing plain `ssh` connection opened without the wrapper has no forwarding configuration. Connect through this launcher. A disconnected or expired bridge produces a visible error without changing the draft.

## Privacy and lifecycle

The helper reads the clipboard only when you paste, not when it changes. Authenticated `/health` requests check connection reachability without capturing an image. The helper sends images, never clipboard text. Each connection has a random authentication token and its own remote socket. The Windows clipboard listener binds only to `127.0.0.1` on an OS-assigned port. Preview forwarding separately uses fixed loopback port `43136`. No Windows inbound firewall rule is needed.

The launcher atomically publishes that socket and token in `~/.pi/agent/ssh-clipboard/connections/<connection-id>.json` on the Mac, or under `PI_CODING_AGENT_DIR` when configured in the launching shell. The records have mode 0600 and the connections directory has mode 0700. Keep these files private; do not include them in bug reports. Pi checks ownership and permissions before reading them, then requires exactly one live authenticated connection. Inherited environment credentials never override discovery.

Only use this with a trusted Mac account. That account and its processes have the token and can request clipboard images for the lifetime of the connection. The token is not an approval boundary against code running as you on either machine.

The launcher stops the helper when SSH exits, including connection failures. The helper also checks whether its launcher has exited. The remote shell removes only its own record and socket on exit. An ungraceful shutdown can leave an inert record or `/tmp/pi-clipboard-*.sock` file; discovery ignores unreachable connections. Each new connection uses a different name.

The Mac stores screenshots under `~/.pi/agent/ssh-images/`, or `ssh-images/` in `PI_CODING_AGENT_DIR`, using private directory and file permissions. Files persist so drafts, reloads, and prompt history can reuse them. They are not automatically deleted; remove unneeded files after their drafts are sent or discarded. Submitted images also persist in Pi session history.

Transfers time out after ten seconds and reject PNGs above 20 MiB. Windows capture also rejects images above 40 megapixels. Empty clipboards and transfer failures show an error without changing the draft. Submitting before a transfer completes cancels the paste with a warning.

## Diagnostic logs

Launcher-managed helpers persist errors and uncaught crash tracebacks on Windows at `~/.pi/agent/logs/ssh-clipboard/<connection-id>.log`. These logs survive connection cleanup. Pi persists paste and attachment failure stacks on the Mac at `~/.pi/agent/logs/ssh-clipboard.log`. Both use the corresponding machine's `PI_CODING_AGENT_DIR` when set. Logs exclude clipboard contents and authentication tokens. No native crash dump is required; failures are recorded as stack traces.

## Standalone helper controls

The launcher normally manages these. For diagnostics, both commands work without opening a terminal window, and `start.py` leaves the helper in the background:

```powershell
python scripts\ssh-clipboard\start.py --state "$HOME\pi-clipboard.json"
python scripts\ssh-clipboard\stop.py --state "$HOME\pi-clipboard.json"
```

Keep the state file private. It contains the shutdown token. The adjacent `.log` file contains helper errors. These controls also run on macOS/Linux for transport diagnostics, but clipboard capture explicitly fails outside Windows.

## Validation

`npm test` includes the extension and helper HTTP/CLI tests. Python must be available as `python` on Windows or `python3` elsewhere. Typecheck the extension with `npm run typecheck:ssh-image-paste`.

The implementation was exercised through a real Pi pseudo-terminal and an isolated OpenSSH server on macOS: type a draft, send Alt+V, transfer a 303,200-byte PNG through Unix-socket forwarding, verify no submission, then press Enter and verify the attached bytes. That run used a macOS system icon converted to PNG.

Windows validation also captured a real 3370×1702 screenshot and transferred its 147,585 PNG bytes to the Mac through SSH with an identical SHA-256 hash. The PowerShell `ssh mac` function was exercised against the real Mac login shell, verifying inherited clipboard configuration, an empty-clipboard response, exit-status propagation, helper shutdown, and socket cleanup. The physical Windows Terminal Alt+V interaction still needs the walkthrough above.

The reconnect fix was exercised with a real Windows clipboard PNG through two launcher-managed SSH connections and one unchanged Pi process inside an isolated Herdr session. Herdr and Pi retained the first connection's environment while the second paste used the replacement connection. Both image hashes matched, the draft was not submitted by paste, Enter attached both images, and Alt+V worked after `/new` completed. Herdr's pane-key API drove the keys; physical Windows Terminal keyboard input remains a manual check.

Regression tests cover reconnect discovery, private atomic publication and cleanup, ambiguity without capture, incorrect tokens, stale and malformed records, FIFO rejection, bounded health checks, cancellation, and persistent error reports. Mac-specific transport tests run on macOS rather than silently relying on Windows skips.

The request-deadline regression keeps trickling header bytes until the server closes the connection, so an idle timeout cannot substitute for the total deadline. It accepts EOF, reset, abort, or broken pipe as platform-specific closure signals. Disabling the total timer makes the test fail.
