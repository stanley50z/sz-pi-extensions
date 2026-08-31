import { execFile, spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface WindowsNotification {
  title: string;
  body: string;
  windowHandle: number;
}

interface WindowsNotifyDependencies {
  platform: NodeJS.Platform;
  captureTerminalWindow: () => Promise<number>;
  notifyAndFocus: (notification: WindowsNotification, onError?: (error: Error) => void) => void;
}

const POWERSHELL_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"];

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function captureTerminalWindow(): Promise<number> {
  const script = `
$processId = ${process.pid}
while ($processId -gt 0) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
    [Console]::Out.Write($process.MainWindowHandle.ToInt64())
    exit 0
  }

  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if ($null -eq $processInfo -or $processInfo.ParentProcessId -eq $processId) { break }
  $processId = $processInfo.ParentProcessId
}
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodedPowerShell(script)],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`Could not find the terminal window: ${error.message}`));
          return;
        }

        const handle = Number.parseInt(stdout.trim(), 10);
        if (!Number.isSafeInteger(handle) || handle <= 0) {
          reject(new Error("Could not find the terminal window"));
          return;
        }
        resolve(handle);
      },
    );
  });
}

function base64Utf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function notifyAndFocus(notification: WindowsNotification, onError?: (error: Error) => void): void {
  const title = base64Utf8(notification.title);
  const body = base64Utf8(notification.body);
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PiTerminalWindow {
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);
}
"@

$window = [IntPtr]::new(${notification.windowHandle})
if ([PiTerminalWindow]::IsIconic($window)) {
  [PiTerminalWindow]::ShowWindowAsync($window, 9) | Out-Null
}
$noMoveOrResize = 0x0001 -bor 0x0002
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-1), 0, 0, 0, 0, $noMoveOrResize)
$broughtToFront = [PiTerminalWindow]::SetWindowPos($window, [IntPtr]::new(-2), 0, 0, 0, 0, $noMoveOrResize) -and $broughtToFront
$focused = [PiTerminalWindow]::SetForegroundWindow($window)

$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${title}"))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${body}"))
$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [Drawing.SystemIcons]::Information
$icon.Text = $title.Substring(0, [Math]::Min(63, $title.Length))
$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$icon.BalloonTipTitle = $title
$icon.BalloonTipText = $body
$icon.Visible = $true
$icon.ShowBalloonTip(5000)
Start-Sleep -Milliseconds 5500
$icon.Dispose()
if (-not $broughtToFront -or -not $focused) {
  throw "Windows refused to focus the terminal window"
}
`;

  const child = spawn(
    "powershell.exe",
    [...POWERSHELL_ARGS, encodedPowerShell(script)],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.once("error", (error) => onError?.(error));
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) onError?.(new Error(`PowerShell exited with code ${code}`));
  });
  child.unref();
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

    let terminalWindow: number | undefined;
    let agentRunning = false;
    let reportedError = false;

    function reportError(ctx: ExtensionContext, error: unknown): void {
      if (reportedError) return;
      reportedError = true;
      const detail = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Windows notification failed: ${detail}`, "error");
    }

    function dispatch(ctx: ExtensionContext, body: string): void {
      if (ctx.mode !== "tui" || terminalWindow === undefined) return;
      deps.notifyAndFocus({
        title: `Pi - ${pi.getSessionName()?.trim() || "Untitled session"}`,
        body,
        windowHandle: terminalWindow,
      }, (error) => reportError(ctx, error));
    }

    pi.on("session_start", async (_event, ctx) => {
      terminalWindow = undefined;
      agentRunning = false;
      reportedError = false;
      if (ctx.mode !== "tui") return;

      try {
        terminalWindow = await deps.captureTerminalWindow();
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
      terminalWindow = undefined;
      agentRunning = false;
    });
  };
}

export default createWindowsNotifyExtension();
