Option Explicit

If WScript.Arguments.Count <> 1 Then WScript.Quit 2

Dim activationUri, expression
activationUri = WScript.Arguments(0)
Set expression = New RegExp
expression.Pattern = "^pi-notify://focus/[0-9a-fA-F-]{36}/?$"
expression.IgnoreCase = True
If Not expression.Test(activationUri) Then WScript.Quit 2

Dim fileSystem, shell, scriptDirectory, helperPath, powerShellPath, command
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
helperPath = fileSystem.BuildPath(scriptDirectory, "windows-notify-focus.ps1")
powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Quote(powerShellPath) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(helperPath) & " " & Quote(activationUri)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
