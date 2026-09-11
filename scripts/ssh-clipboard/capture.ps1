# Called on demand by server.py in an STA process. Emits PNG as ASCII base64.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = $null
$stream = $null
try {
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $image) { exit 3 }
    if ([long]$image.Width * [long]$image.Height -gt 40000000) {
        throw 'Screenshot exceeds the 40 megapixel limit'
    }
    $stream = New-Object System.IO.MemoryStream
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -gt 20MB) { throw 'Screenshot exceeds the 20 MiB limit' }
    [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $image) { $image.Dispose() }
}
