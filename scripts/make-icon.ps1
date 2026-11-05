# Generates assets/app.ico: a yen sign on an amber rounded square. Re-run only when the icon changes.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts using the system code page.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\assets\app.ico'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'

  $r = [Math]::Max(2, [int]($size * 0.22))
  $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(224, 160, 60))
  $g.FillPath($brush, $path)

  $font = New-Object System.Drawing.Font('Segoe UI', ($size * 0.62), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'
  $format.LineAlignment = 'Center'
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(35, 24, 3))
  $rect = New-Object System.Drawing.RectangleF 0, ($size * 0.02), $size, $size
  $g.DrawString([string][char]0x00A5, $font, $ink, $rect, $format)

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $brush.Dispose(); $ink.Dispose(); $font.Dispose(); $format.Dispose(); $path.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 20, 24, 32, 48, 64, 256
$images = @(); foreach ($s in $sizes) { $images += ,(New-IconPng $s) }

$fs = [System.IO.File]::Create((Join-Path (Resolve-Path (Split-Path $out)) 'app.ico'))
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$images[$i].Length); $w.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write([byte[]]$img) }
$w.Close(); $fs.Close()
Write-Output "wrote $out ($offset bytes)"
