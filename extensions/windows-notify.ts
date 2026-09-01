import { execFile, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TerminalTarget {
  windowHandle: number;
  tabRuntimeId?: number[];
}

interface WindowsNotification extends TerminalTarget {
  title: string;
  body: string;
}

interface WindowsNotifyDependencies {
  platform: NodeJS.Platform;
  captureTerminalWindow: () => Promise<TerminalTarget>;
  notifyAndFocus: (notification: WindowsNotification, onError?: (error: Error) => void) => void;
}

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Captures the terminal window and, for Windows Terminal, its selected tab. */
function captureTerminalWindow(): Promise<TerminalTarget> {
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$processId = ${process.pid}
$terminalProcess = $null
while ($processId -gt 0) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
    $terminalProcess = $process
    break
  }

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo -or $processInfo.ParentProcessId -eq $processId) { break }
  $processId = $processInfo.ParentProcessId
}

if ($null -eq $terminalProcess) { throw "Could not find the terminal window" }
$window = $terminalProcess.MainWindowHandle
$target = @{ windowHandle = $window.ToInt64() }

if ($terminalProcess.ProcessName -eq "WindowsTerminal") {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
  )
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $selectedTab = $null
  foreach ($tab in $tabs) {
    $selection = $null
    if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection) -and $selection.Current.IsSelected) {
      $selectedTab = $tab
      break
    }
  }
  if ($null -eq $selectedTab) { throw "Could not find the active Windows Terminal tab" }
  $target.tabRuntimeId = @($selectedTab.GetRuntimeId())
}

[Console]::Out.Write(($target | ConvertTo-Json -Compress))
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(script)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not find the terminal target: ${error.message}`));
          return;
        }

        try {
          const target = JSON.parse(stdout.trim()) as Partial<TerminalTarget>;
          if (!Number.isSafeInteger(target.windowHandle) || (target.windowHandle ?? 0) <= 0) {
            throw new Error("invalid window handle");
          }
          if (target.tabRuntimeId !== undefined && (
            !Array.isArray(target.tabRuntimeId)
            || target.tabRuntimeId.length === 0
            || target.tabRuntimeId.some((part) => !Number.isSafeInteger(part))
          )) {
            throw new Error("invalid tab identifier");
          }
          resolve(target as TerminalTarget);
        } catch (parseError) {
          const detail = parseError instanceof Error ? parseError.message : String(parseError);
          reject(new Error(`Could not read the terminal target: ${detail}`));
        }
      },
    );
  });
}

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** Posts a native Windows toast, restores the captured tab, and foregrounds its window. */
function notifyAndFocus(notification: WindowsNotification, onError?: (error: Error) => void): void {
  const title = base64Utf8(notification.title);
  const body = base64Utf8(notification.body);
  const tabRuntimeId = notification.tabRuntimeId?.join(", ");
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiTerminalWindow {
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
}
"@

$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${title}"))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${body}"))
$xmlTitle = [Security.SecurityElement]::Escape($title)
$xmlBody = [Security.SecurityElement]::Escape($body)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$xmlTitle</text><text>$xmlBody</text></binding></visual></toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")
if ($notifier.Setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) {
  throw "Windows Terminal notifications are $($notifier.Setting)"
}
$notifier.Show($toast)

$window = [IntPtr]::new(${notification.windowHandle})
if (-not [PiTerminalWindow]::IsWindow($window)) { throw "The terminal window no longer exists" }
${tabRuntimeId === undefined ? "" : `
$targetRuntimeId = @(${tabRuntimeId})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$targetTab = $null
foreach ($tab in $tabs) {
  $runtimeId = @($tab.GetRuntimeId())
  if ($runtimeId.Count -ne $targetRuntimeId.Count) { continue }
  $matches = $true
  for ($index = 0; $index -lt $runtimeId.Count; $index++) {
    if ($runtimeId[$index] -ne $targetRuntimeId[$index]) {
      $matches = $false
      break
    }
  }
  if ($matches) {
    $targetTab = $tab
    break
  }
}
if ($null -eq $targetTab) { throw "The Pi terminal tab no longer exists" }
$selection = $null
if (-not $targetTab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
  throw "The Pi terminal tab cannot be selected"
}
$selection.Select()
$targetTab.SetFocus()
`}
if ([PiTerminalWindow]::IsIconic($window)) {
  [PiTerminalWindow]::ShowWindowAsync($window, 9) | Out-Null
}
$noMoveOrResize = 0x0001 -bor 0x0002
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-1), 0, 0, 0, 0, $noMoveOrResize)
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-2), 0, 0, 0, 0, $noMoveOrResize) -and $broughtToFront
$focused = [PiTerminalWindow]::SetForegroundWindow($window)
if (-not $broughtToFront -or -not $focused) {
  throw "Windows refused to focus the terminal window"
}
`;

  const child = spawn(
    "powershell.exe",
    [...POWERSHELL_ARGS, encodedPowerShell(script)],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => onError?.(error));
  child.once("exit", (code) => {
    if (code === 0 || code === null) return;
    const detail = stderr.trim();
    onError?.(new Error(detail || `PowerShell exited with code ${code}`));
  });
}

const defaultDependencies: WindowsNotifyDependencies = {
  platform: process.platform,
  captureTerminalWindow,
  notifyAndFocus,
};

export function createWindowsNotifyExtension(
  deps: WindowsNotifyDependencies = defaultDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    if (deps.platform !== "win32") return;

    let terminalTarget: TerminalTarget | undefined;
    let agentRunning = false;
    let reportedError = false;

    function reportError(ctx: ExtensionContext, error: unknown): void {
      if (reportedError) return;
      reportedError = true;
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Windows notification failed: ${detail}`, "error");
    }

    function dispatch(ctx: ExtensionContext, body: string): void {
      if (ctx.mode !== "tui" || terminalTarget === undefined) return;
      deps.notifyAndFocus({
        title: `Pi - ${pi.getSessionName()?.trim() || "Untitled session"}`,
        body,
        ...terminalTarget,
      }, (error) => reportError(ctx, error));
    }

    pi.on("session_start", async (_event, ctx) => {
      terminalTarget = undefined;
      agentRunning = false;
      reportedError = false;
      if (ctx.mode !== "tui") return;

      try {
        terminalTarget = await deps.captureTerminalWindow();
      } catch (error) {
        reportError(ctx, error);
      }
    });

    pi.on("agent_start", () => {
      agentRunning = true;
    });

    pi.on("agent_settled", (_event, ctx) => {
      if (!agentRunning) return;
      agentRunning = false;
      dispatch(ctx, "Response finished");
    });

    pi.on("ui_prompt_start", (event, ctx) => {
      const prompt = event.title?.trim();
      dispatch(ctx, prompt ? `Input needed: ${prompt}` : "Input needed");
    });

    pi.on("session_shutdown", () => {
      terminalTarget = undefined;
      agentRunning = false;
    });
  };
}

export default createWindowsNotifyExtension();
