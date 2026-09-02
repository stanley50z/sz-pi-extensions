import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  activationUri: string;
}

interface WindowsNotifyDependencies {
  platform: NodeJS.Platform;
  createTabMarker: () => string;
  registerProtocolHandler: () => Promise<void>;
  createActivationUri: (target: TerminalTarget) => string;
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

function registerProtocolHandler(): Promise<void> {
  const helperPath = base64Utf8(fileURLToPath(new URL("./windows-notify-focus.ps1", import.meta.url)));
  const script = `
$helperPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${helperPath}"))
$protocolKey = "HKCU:\\Software\\Classes\\pi-notify"
New-Item $protocolKey -Force | Out-Null
Set-Item $protocolKey "URL:Pi Notification"
New-ItemProperty $protocolKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
$commandKey = New-Item "$protocolKey\\shell\\open\\command" -Force
$command = '"' + (Join-Path $PSHOME "powershell.exe") + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $helperPath + '" "%1"'
Set-Item $commandKey.PSPath $command
Get-ChildItem $env:TEMP -Filter "pi-notify-*.json" -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-1) } |
  Remove-Item -Force -ErrorAction SilentlyContinue
`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(script)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Could not register notification clicks: ${stderr.trim() || error.message}`));
          return;
        }
        resolve();
      },
    );
  });
}

function createActivationUri(target: TerminalTarget): string {
  const token = randomUUID();
  writeFileSync(join(tmpdir(), `pi-notify-${token}.json`), JSON.stringify({
    expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    windowHandle: target.windowHandle,
    tabRuntimeId: target.tabRuntimeId,
  }), "utf8");
  return `pi-notify://focus/${token}`;
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

/** Shows a toast whose clicks route through the registered Pi focus protocol. */
function showNotification(
  notification: WindowsNotification,
  options: NotificationOptions,
  onError?: (error: Error) => void,
): () => void {
  const title = base64Utf8(notification.title);
  const body = base64Utf8(notification.body);
  const activationUri = base64Utf8(options.activationUri);
  const activationToken = new URL(options.activationUri).pathname.slice(1);
  const activationStatePath = join(tmpdir(), `pi-notify-${activationToken}.json`);
  const notificationTag = `pi-${randomUUID()}`;
  const tag = base64Utf8(notificationTag);
  const cancelPath = join(tmpdir(), `${notificationTag}.cancel`);
  const encodedCancelPath = base64Utf8(cancelPath);
  const toastScenario = options.persistent ? " scenario='reminder'" : "";
  const toastActions = options.persistent
    ? "<audio silent='true'/><actions><action content='Open Pi' arguments='$xmlActivationUri' activationType='protocol'/><action content='Dismiss' arguments='dismiss' activationType='background'/></actions>"
    : "";
  const script = `
Add-Type @"
using System;
using System.Threading;
public static class PiToastSignal {
  public static readonly ManualResetEventSlim Signal = new ManualResetEventSlim(false);
  public static int Result;
  public static void OnDismissed(object sender, object args) { Result = 2; Signal.Set(); }
  public static void OnFailed(object sender, object args) { Result = 3; Signal.Set(); }
}
"@
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${title}"))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${body}"))
$tag = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${tag}"))
$activationUri = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${activationUri}"))
$cancelPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encodedCancelPath}"))
$xmlTitle = [Security.SecurityElement]::Escape($title)
$xmlBody = [Security.SecurityElement]::Escape($body)
$xmlActivationUri = [Security.SecurityElement]::Escape($activationUri)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast activationType='protocol' launch='$xmlActivationUri'${toastScenario}><visual><binding template='ToastGeneric'><text>$xmlTitle</text><text>$xmlBody</text></binding></visual>${toastActions}</toast>")
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$toast.Tag = $tag
$toast.Group = "pi"
${options.persistent ? `
$tokens = @{}
foreach ($eventName in @("Dismissed", "Failed")) {
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
${options.persistent ? `
while ([PiToastSignal]::Result -eq 0 -and -not (Test-Path $cancelPath)) {
  [PiToastSignal]::Signal.Wait(100) | Out-Null
}
if (Test-Path $cancelPath) {
  try { $notifier.Hide($toast) } finally { Remove-Item $cancelPath -Force -ErrorAction SilentlyContinue }
  exit 0
}
if ([PiToastSignal]::Result -eq 3) { throw "Windows could not display the notification" }
` : ""}
`;

  const child = spawn(
    "powershell.exe",
    [...POWERSHELL_ARGS, encodedPowerShell(script)],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let cancelled = false;
  let finished = false;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  child.once("error", (error) => {
    if (!cancelled) onError?.(error);
  });
  child.once("exit", (code) => {
    finished = true;
    rmSync(cancelPath, { force: true });
    if (cancelled || code === 0 || code === null) return;
    onError?.(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
  });
  return () => {
    if (cancelled) return;
    cancelled = true;
    rmSync(activationStatePath, { force: true });
    if (finished) return;
    try {
      writeFileSync(cancelPath, "", "utf8");
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
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
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiTerminalActivation {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@
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
    if ($selection.Current.IsSelected -and [PiTerminalActivation]::GetForegroundWindow() -eq $window) { exit 0 }
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
  registerProtocolHandler,
  createActivationUri,
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
    let cancelActivationWatch: (() => void) | undefined;
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
        }
        cancelNotification?.();
        const dismissNotification = deps.showNotification({
          title: `Pi - ${pi.getSessionName()?.trim() || "Untitled session"}`,
          body,
          ...terminalTarget,
        }, {
          persistent: state === "background",
          activationUri: deps.createActivationUri(terminalTarget),
        }, (error) => reportError(ctx, error));
        cancelNotification = dismissNotification;

        cancelActivationWatch?.();
        cancelActivationWatch = undefined;
        if (state !== "foreground-active") {
          cancelActivationWatch = deps.watchTabActivation(terminalTarget, () => {
            cancelActivationWatch = undefined;
            if (state === "background") {
              dismissNotification();
              if (cancelNotification === dismissNotification) cancelNotification = undefined;
            }
            if (attentionActive) {
              attentionActive = false;
              deps.setTabAttention(false);
            }
          }, (error) => reportError(ctx, error));
        }
      } catch (error) {
        reportError(ctx, error);
      }
    }

    pi.on("session_start", async (_event, ctx) => {
      terminalTarget = undefined;
      agentRunning = false;
      reportedError = false;
      if (ctx.mode !== "tui") return;

      try {
        await deps.registerProtocolHandler();
      } catch (error) {
        reportError(ctx, error);
      }

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
      if (!agentRunning) return;
      const prompt = event.title?.trim();
      await dispatch(ctx, prompt ? `Input needed: ${prompt}` : "Input needed");
    });

    pi.on("session_shutdown", () => {
      cancelNotification?.();
      cancelNotification = undefined;
      cancelActivationWatch?.();
      cancelActivationWatch = undefined;
      if (attentionActive) deps.setTabAttention(false);
      attentionActive = false;
      terminalTarget = undefined;
      agentRunning = false;
    });
  };
}

export default createWindowsNotifyExtension();
