import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTerminalTitle } from "./session-title.ts";

interface TerminalTarget {
  windowHandle: number;
  tabRuntimeId?: number[];
}

interface WindowsNotification extends TerminalTarget {
  title: string;
  body: string;
}

type TerminalState = "background" | "foreground-active" | "foreground-inactive";

interface NotificationOptions {
  persistent: boolean;
  activateTarget: boolean;
}

interface WindowsNotifyDependencies {
  platform: NodeJS.Platform;
  createTabMarker: () => string;
  captureTerminalWindow: (tabMarker: string) => Promise<TerminalTarget>;
  getTerminalState: (target: TerminalTarget) => Promise<TerminalState>;
  showNotification: (
    notification: WindowsNotification,
    options: NotificationOptions,
    onError?: (error: Error) => void,
  ) => () => void;
  setTabAttention: (active: boolean) => void;
  watchTabActivation: (
    target: TerminalTarget,
    onActive: () => void,
    onError?: (error: Error) => void,
  ) => () => void;
}

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Finds the tab temporarily tagged by the calling Pi session. */
function captureTerminalWindow(tabMarker: string): Promise<TerminalTarget> {
  const encodedTabMarker = base64Utf8(tabMarker);
  const script = `
$ErrorActionPreference = "Stop"
try {
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PiTerminalWindows {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int count);

  public static long[] GetHostingWindows(int targetProcessId) {
    var windows = new List<long>();
    EnumWindows(delegate(IntPtr window, IntPtr lParam) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (processId == targetProcessId && className.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") {
        windows.Add(window.ToInt64());
      }
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
"@

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
$target = @{ windowHandle = $terminalProcess.MainWindowHandle.ToInt64() }

if ($terminalProcess.ProcessName -eq "WindowsTerminal") {
  $tabMarker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedTabMarker}"))
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem
  )
  $targetTab = $null
  $targetWindow = 0
  for ($attempt = 0; $attempt -lt 80 -and $null -eq $targetTab; $attempt++) {
    foreach ($windowHandle in [PiTerminalWindows]::GetHostingWindows($terminalProcess.Id)) {
      $window = [IntPtr]::new($windowHandle)
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
      $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      foreach ($tab in $tabs) {
        if ($tab.Current.Name -eq $tabMarker) {
          $targetTab = $tab
          $targetWindow = $windowHandle
          break
        }
      }
      if ($null -ne $targetTab) { break }
    }
    if ($null -eq $targetTab) { Start-Sleep -Milliseconds 25 }
  }
  if ($null -eq $targetTab) { throw "Could not find this Pi session's Windows Terminal tab" }
  $target.windowHandle = $targetWindow
  $target.tabRuntimeId = @($targetTab.GetRuntimeId())
}

[Console]::Out.Write(($target | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.Write("ERROR:" + $_.Exception.Message)
  exit 1
}
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(script)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stdout.startsWith("ERROR:") ? stdout.slice(6) : stderr.trim() || error.message;
          reject(new Error(`Could not find the terminal target: ${detail}`));
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

function terminalState(target: TerminalTarget): Promise<TerminalState> {
  const tabRuntimeId = target.tabRuntimeId?.join(", ");
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiTerminalState {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
$window = [IntPtr]::new(${target.windowHandle})
if ([PiTerminalState]::GetForegroundWindow() -ne $window) {
  [Console]::Out.Write("background")
  exit 0
}
${tabRuntimeId === undefined ? '[Console]::Out.Write("foreground-active")' : `
$targetRuntimeId = @(${tabRuntimeId})
$root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
$tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
foreach ($tab in $tabs) {
  $runtimeId = @($tab.GetRuntimeId())
  if (($runtimeId -join ",") -ne ($targetRuntimeId -join ",")) { continue }
  $selection = $null
  if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
    throw "The Pi terminal tab cannot be inspected"
  }
  [Console]::Out.Write($(if ($selection.Current.IsSelected) { "foreground-active" } else { "foreground-inactive" }))
  exit 0
}
throw "The Pi terminal tab no longer exists"
`}
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(script)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        const state = stdout.trim();
        if (state === "background" || state === "foreground-active" || state === "foreground-inactive") {
          resolve(state);
          return;
        }
        reject(new Error(`Unknown terminal state: ${state || "empty output"}`));
      },
    );
  });
}

/** Shows a toast and focuses the captured tab only after explicit activation. */
function showNotification(
  notification: WindowsNotification,
  options: NotificationOptions,
  onError?: (error: Error) => void,
): () => void {
  const title = base64Utf8(notification.title);
  const body = base64Utf8(notification.body);
  const notificationTag = `pi-${randomUUID()}`;
  const tag = base64Utf8(notificationTag);
  const tabRuntimeId = notification.tabRuntimeId?.join(", ");
  const toastScenario = options.persistent ? " scenario='reminder'" : "";
  const toastActions = options.persistent
    ? "<audio silent='true'/><actions><action content='Open Pi' arguments='open' activationType='background'/></actions>"
    : "";
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
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
public static class PiToastSignal {
  public static readonly ManualResetEventSlim Signal = new ManualResetEventSlim(false);
  public static int Result;
  public static void OnActivated(object sender, object args) { Result = 1; Signal.Set(); }
  public static void OnDismissed(object sender, object args) { Result = 2; Signal.Set(); }
  public static void OnFailed(object sender, object args) { Result = 3; Signal.Set(); }
}
"@

$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${title}"))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${body}"))
$tag = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${tag}"))
$xmlTitle = [Security.SecurityElement]::Escape($title)
$xmlBody = [Security.SecurityElement]::Escape($body)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast${toastScenario}><visual><binding template='ToastGeneric'><text>$xmlTitle</text><text>$xmlBody</text></binding></visual>${toastActions}</toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$toast.Tag = $tag
$toast.Group = "pi"
${options.activateTarget ? `
$tokens = @{}
foreach ($eventName in @("Activated", "Dismissed", "Failed")) {
  $eventInfo = $toast.GetType().GetEvent($eventName)
  $callback = [PiToastSignal].GetMethod("On$eventName")
  $handler = [Delegate]::CreateDelegate($eventInfo.EventHandlerType, $callback)
  $tokens[$eventName] = $eventInfo.GetAddMethod().Invoke($toast, @($handler))
}
` : ""}
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")
if ($notifier.Setting -ne [Windows.UI.Notifications.NotificationSetting]::Enabled) {
  throw "Windows Terminal notifications are $($notifier.Setting)"
}
$notifier.Show($toast)
${options.activateTarget ? `
$waitMilliseconds = ${options.persistent ? -1 : 8_000}
[PiToastSignal]::Signal.Wait($waitMilliseconds) | Out-Null
if ([PiToastSignal]::Result -eq 3) { throw "Windows could not display the notification" }
if ([PiToastSignal]::Result -ne 1) { exit 0 }
[Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, "pi", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")

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
  if ((@($tab.GetRuntimeId()) -join ",") -eq ($targetRuntimeId -join ",")) {
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
if ([PiTerminalWindow]::IsIconic($window)) { [PiTerminalWindow]::ShowWindowAsync($window, 9) | Out-Null }
$noMoveOrResize = 0x0001 -bor 0x0002
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-1), 0, 0, 0, 0, $noMoveOrResize)
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-2), 0, 0, 0, 0, $noMoveOrResize) -and $broughtToFront
$focused = [PiTerminalWindow]::SetForegroundWindow($window)
if (-not $broughtToFront -or -not $focused) { throw "Windows refused to focus the terminal window" }
` : ""}
`;

  const child = spawn(
    "powershell.exe",
    [...POWERSHELL_ARGS, encodedPowerShell(script)],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let cancelled = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => {
    if (!cancelled) onError?.(error);
  });
  child.once("exit", (code) => {
    if (cancelled || code === 0 || code === null) return;
    onError?.(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    child.kill();
    const removeScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::History.Remove("${notificationTag}", "pi", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")
`;
    const remover = spawn(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(removeScript)],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    remover.unref();
  };
}

function setTabAttention(active: boolean): void {
  process.stdout.write(active ? "\u001b]9;4;4;100\u0007" : "\u001b]9;4;0;0\u0007");
}

function watchTabActivation(
  target: TerminalTarget,
  onActive: () => void,
  onError?: (error: Error) => void,
): () => void {
  if (target.tabRuntimeId === undefined) {
    throw new Error("Cannot watch a terminal without a tab identifier");
  }
  const tabRuntimeId = target.tabRuntimeId.join(", ");
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$window = [IntPtr]::new(${target.windowHandle})
$targetRuntimeId = @(${tabRuntimeId})
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::TabItem
)
while ($true) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $found = $false
  foreach ($tab in $tabs) {
    if ((@($tab.GetRuntimeId()) -join ",") -ne ($targetRuntimeId -join ",")) { continue }
    $found = $true
    $selection = $null
    if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
      throw "The Pi terminal tab cannot be inspected"
    }
    if ($selection.Current.IsSelected) { exit 0 }
    break
  }
  if (-not $found) { throw "The Pi terminal tab no longer exists" }
  Start-Sleep -Milliseconds 250
}
`;
  const child = spawn(
    "powershell.exe",
    [...POWERSHELL_ARGS, encodedPowerShell(script)],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let cancelled = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => {
    if (!cancelled) onError?.(error);
  });
  child.once("exit", (code) => {
    if (cancelled) return;
    if (code === 0) {
      onActive();
      return;
    }
    if (code !== null) onError?.(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
  });
  return () => {
    cancelled = true;
    child.kill();
  };
}

const defaultDependencies: WindowsNotifyDependencies = {
  platform: process.platform,
  createTabMarker: () => `Pi notification target ${randomUUID()}`,
  captureTerminalWindow,
  getTerminalState: terminalState,
  showNotification,
  setTabAttention,
  watchTabActivation,
};

export function createWindowsNotifyExtension(
  overrides: Partial<WindowsNotifyDependencies> = {},
): (pi: ExtensionAPI) => void {
  const deps = { ...defaultDependencies, ...overrides };
  return (pi) => {
    if (deps.platform !== "win32") return;

    let terminalTarget: TerminalTarget | undefined;
    let cancelNotification: (() => void) | undefined;
    let cancelAttentionWatch: (() => void) | undefined;
    let attentionActive = false;
    let agentRunning = false;
    let reportedError = false;

    function reportError(ctx: ExtensionContext, error: unknown): void {
      if (reportedError) return;
      reportedError = true;
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Windows notification failed: ${detail}`, "error");
    }

    async function dispatch(ctx: ExtensionContext, body: string): Promise<void> {
      if (ctx.mode !== "tui" || terminalTarget === undefined) return;
      try {
        const state = await deps.getTerminalState(terminalTarget);
        if (state === "foreground-inactive" && !attentionActive) {
          attentionActive = true;
          deps.setTabAttention(true);
          cancelAttentionWatch?.();
          cancelAttentionWatch = deps.watchTabActivation(terminalTarget, () => {
            attentionActive = false;
            cancelAttentionWatch = undefined;
            deps.setTabAttention(false);
          }, (error) => reportError(ctx, error));
        }
        cancelNotification?.();
        cancelNotification = deps.showNotification({
          title: `Pi - ${pi.getSessionName()?.trim() || "Untitled session"}`,
          body,
          ...terminalTarget,
        }, {
          persistent: state === "background",
          activateTarget: state !== "foreground-active",
        }, (error) => reportError(ctx, error));
      } catch (error) {
        reportError(ctx, error);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      terminalTarget = undefined;
      agentRunning = false;
      reportedError = false;
      if (ctx.mode !== "tui") return;

      const tabMarker = deps.createTabMarker();
      ctx.ui.setTitle(tabMarker);
      try {
        terminalTarget = await deps.captureTerminalWindow(tabMarker);
      } catch (error) {
        reportError(ctx, error);
      } finally {
        ctx.ui.setTitle(formatTerminalTitle(pi.getSessionName()));
      }
    });

    pi.on("agent_start", () => {
      agentRunning = true;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!agentRunning) return;
      agentRunning = false;
      await dispatch(ctx, "Response finished");
    });

    pi.on("ui_prompt_start", async (event, ctx) => {
      const prompt = event.title?.trim();
      await dispatch(ctx, prompt ? `Input needed: ${prompt}` : "Input needed");
    });

    pi.on("session_shutdown", () => {
      cancelNotification?.();
      cancelNotification = undefined;
      cancelAttentionWatch?.();
      cancelAttentionWatch = undefined;
      if (attentionActive) deps.setTabAttention(false);
      attentionActive = false;
      terminalTarget = undefined;
      agentRunning = false;
    });
  };
}

export default createWindowsNotifyExtension();
