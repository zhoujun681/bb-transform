param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [string]$MimeType = 'application/octet-stream'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function New-CfHtml([string]$Fragment) {
    $encoding = [System.Text.Encoding]::UTF8
    $before = '<html><body><!--StartFragment-->'
    $after = '<!--EndFragment--></body></html>'
    $headerTemplate = "Version:0.9`r`nStartHTML:{0:D10}`r`nEndHTML:{1:D10}`r`nStartFragment:{2:D10}`r`nEndFragment:{3:D10}`r`n"
    $emptyHeader = $headerTemplate -f 0, 0, 0, 0
    $startHtml = $encoding.GetByteCount($emptyHeader)
    $startFragment = $startHtml + $encoding.GetByteCount($before)
    $endFragment = $startFragment + $encoding.GetByteCount($Fragment)
    $endHtml = $endFragment + $encoding.GetByteCount($after)
    return ($headerTemplate -f $startHtml, $endHtml, $startFragment, $endFragment) +
        $before + $Fragment + $after
}

$resolvedPath = [System.IO.Path]::GetFullPath($FilePath)
if (-not [System.IO.File]::Exists($resolvedPath)) {
    throw "Clipboard file does not exist: $resolvedPath"
}

$data = New-Object System.Windows.Forms.DataObject
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($resolvedPath)
$data.SetFileDropList($files)

# Tell Explorer that a paste should copy, rather than move, the temporary file.
$dropEffect = New-Object System.IO.MemoryStream(, ([byte[]](1, 0, 0, 0)))
$data.SetData('Preferred DropEffect', $false, $dropEffect)

$bitmap = $null
$pngStream = $null
try {
    $extension = [System.IO.Path]::GetExtension($resolvedPath)
    $isImage = $MimeType.StartsWith('image/', [System.StringComparison]::OrdinalIgnoreCase) -or
        $extension -match '^\.(png|jpe?g|gif|bmp|webp|tiff?)$'
    $isText = $MimeType.StartsWith('text/', [System.StringComparison]::OrdinalIgnoreCase) -or
        $MimeType -match '(json|xml|javascript|yaml|csv)' -or
        $extension -match '^\.(txt|md|csv|json|xml|ya?ml|log|js|ts|css|html?)$'

    if ($isImage) {
        $source = [System.Drawing.Image]::FromFile($resolvedPath)
        try {
            $bitmap = New-Object System.Drawing.Bitmap($source)
        } finally {
            $source.Dispose()
        }
        $data.SetImage($bitmap)

        $pngStream = New-Object System.IO.MemoryStream
        $bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngStream.Position = 0
        $data.SetData('PNG', $false, $pngStream)

        $uri = (New-Object System.Uri($resolvedPath)).AbsoluteUri
        $html = New-CfHtml "<img src=`"$uri`">"
        $data.SetData([System.Windows.Forms.DataFormats]::Html, $false, $html)
    } elseif ($isText) {
        $text = [System.IO.File]::ReadAllText($resolvedPath)
        $data.SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
    }

    # Retries handle short clipboard locks from Office, IMEs, and clipboard history.
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 8, 125)
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($pngStream) { $pngStream.Dispose() }
    $dropEffect.Dispose()
}
