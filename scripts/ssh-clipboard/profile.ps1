# Dot-source from your PowerShell profile to enable clipboard forwarding for bare `ssh mac`.
function ssh {
    if ($args.Count -eq 1 -and $args[0] -eq 'mac') {
        & python (Join-Path $PSScriptRoot 'ssh.py') --shell mac
    } else {
        & ssh.exe @args
    }
}
