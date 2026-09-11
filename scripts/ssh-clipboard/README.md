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

You can then change directories and run `pi` or `pi --continue`. Pi inherits the clipboard connection from that shell. `--shell` cannot be combined with `--pi` or Pi arguments after `--`.

For the short command, add this line to your PowerShell profile:

```powershell
. "$HOME\sz-pi-extensions\scripts\ssh-clipboard\profile.ps1"
```

Open a new PowerShell tab and run `ssh mac`. The profile defines a shell function, not an SSH config alias. It intercepts only bare `ssh mac`; other hosts and commands with extra arguments, such as `ssh mac uptime` or `ssh -N mac`, still use ordinary SSH. Use `ssh.exe mac` to bypass the function. The helper stops when you exit the Mac shell. No always-running service or SSH configuration change is needed.

### Paste a screenshot

1. Take a screenshot with Win+Shift+S and copy it.
2. Focus the remote Pi prompt and press Alt+V.
3. Wait for the `@"...png"` reference to appear. You can add text or paste another image.
4. Press Enter. Pi receives PNG image content, not Windows-only file paths.

An existing plain `ssh` connection opened without the wrapper has no forwarding configuration. Reconnect through this launcher and resume the session. A Pi process left in tmux keeps its original connection credentials; after reconnecting, restart Pi with `--continue` from the new launcher rather than reattaching that stale process.

## Privacy and lifecycle

The helper reads the clipboard only when requested, not when it changes. It sends images, never clipboard text. Each connection has a random authentication token and its own remote socket. The Windows listener binds only to `127.0.0.1` on an OS-assigned port. No fixed port or Windows inbound firewall rule is needed.

Only use this with a trusted Mac account. That account and its processes have the token and can request clipboard images for the lifetime of the connection. The token is not an approval boundary against code running as you on either machine.

The launcher stops the helper when SSH exits, including connection failures. The helper also checks whether its launcher has exited. The remote shell removes its socket on exit; an ungraceful host shutdown can leave an inert `/tmp/pi-clipboard-*.sock` file. Each new connection uses a different name.

The Mac stores screenshots under `~/.pi/agent/ssh-images/`, or `ssh-images/` in `PI_CODING_AGENT_DIR`, using private directory and file permissions. Files persist so drafts, reloads, and prompt history can reuse them. They are not automatically deleted; remove unneeded files after their drafts are sent or discarded. Submitted images also persist in Pi session history.

Transfers time out after ten seconds and reject PNGs above 20 MiB. Windows capture also rejects images above 40 megapixels. Empty clipboards and transfer failures show an error without changing the draft. Submitting before a transfer completes cancels the paste with a warning.

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

The existing Windows test `test_slow_unauthenticated_request_has_a_total_deadline` still fails because Windows raises `ConnectionAbortedError`, while the test only accepts `ConnectionResetError` or EOF.
