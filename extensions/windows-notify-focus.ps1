param([Parameter(Mandatory = $true)][string]$ActivationUri)

$ErrorActionPreference = 'Stop'
$statePath = $null
try {
  $uri = [Uri]$ActivationUri
  $token = $uri.AbsolutePath.Trim('/')
  if ($uri.Scheme -ne 'pi-notify' -or $uri.Host -ne 'focus' -or $token -notmatch '^[0-9a-fA-F-]{36}$') {
    throw 'Invalid Pi notification activation URI'
  }

  $statePath = Join-Path $env:TEMP "pi-notify-$token.json"
  $state = Get-Content $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Remove-Item $statePath -Force
  $statePath = $null

  if ([int64]$state.expiresAt -lt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {
    throw 'Pi notification activation expired'
  }
  $window = [IntPtr]::new([int64]$state.windowHandle)
  $targetRuntimeId = @($state.tabRuntimeId | ForEach-Object { [int]$_ })

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiNotificationFocus {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

  if (-not [PiNotificationFocus]::IsWindow($window)) { throw 'The Pi terminal window no longer exists' }
  if ($targetRuntimeId.Count -gt 0) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::TabItem
    )
    $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $targetTab = $null
    foreach ($tab in $tabs) {
      if ((@($tab.GetRuntimeId()) -join ',') -eq ($targetRuntimeId -join ',')) {
        $targetTab = $tab
        break
      }
    }
    if ($null -eq $targetTab) { throw 'The Pi terminal tab no longer exists' }
    $selection = $null
    if (-not $targetTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
      throw 'The Pi terminal tab cannot be selected'
    }
    $selection.Select()
    $targetTab.SetFocus()
  }

  if ([PiNotificationFocus]::IsIconic($window)) {
    [PiNotificationFocus]::ShowWindowAsync($window, 9) | Out-Null
  }
  $flags = 0x0001 -bor 0x0002
  $front = [PiNotificationFocus]::SetWindowPos($window, [IntPtr]::new(-1), 0, 0, 0, 0, $flags)
  $front = [PiNotificationFocus]::SetWindowPos($window, [IntPtr]::new(-2), 0, 0, 0, 0, $flags) -and $front
  $focused = [PiNotificationFocus]::SetForegroundWindow($window)
  if (-not $front -or -not $focused) { throw 'Windows refused to focus the Pi terminal window' }
} finally {
  if ($null -ne $statePath) { Remove-Item $statePath -Force -ErrorAction SilentlyContinue }
}
