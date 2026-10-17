$ErrorActionPreference = 'Stop'
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestData = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $packageRoot 'manifest.json') | ConvertFrom-Json
$archiveName = 'x-media-copy-' + $manifestData.version + '.zip'
$archivePath = Join-Path $packageRoot $archiveName
if (Test-Path -LiteralPath $archivePath) { throw "Release already exists: $archivePath" }
$stagePath = Join-Path ([IO.Path]::GetTempPath()) ('xcopy-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagePath | Out-Null
$files = @('manifest.json','core.js','extractor.js','clipboard.js','content.js','content.css','media.js','media-main.js','media-hook.js','media-bridge.js','background.js','gif.js','offscreen.html','offscreen.js','popup.html','popup.js','README.md','LICENSE','NOTICE.md','PRIVACY.md','CHANGELOG.md','icons','vendor')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $packageRoot $file) -Destination $stagePath -Recurse }
# Publish from an explicit allowlist; existing releases are preserved.
Compress-Archive -Path (Join-Path $stagePath '*') -DestinationPath $archivePath -CompressionLevel Optimal
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\','/') })
  foreach ($required in @('manifest.json','background.js','offscreen.html','offscreen.js','LICENSE','NOTICE.md','PRIVACY.md','vendor/source-manifest.json','vendor/core/ffmpeg-core.wasm','vendor/licenses/GPL-2.0.txt','vendor/licenses/FFMPEG-WASM-MIT.txt')) {
    if ($names -notcontains $required) { throw "Missing release file: $required" }
  }
  if ($names | Where-Object { $_ -match '(^|/)(node_modules|tests|test-results)/' }) { throw 'Release contains development files' }
  # Use .NET directly: npm's child shell may not expose Get-FileHash's module.
  $digestEngine = [Security.Cryptography.SHA256]::Create()
  $archiveStream = [IO.File]::OpenRead($archivePath)
  try { $archiveHash = [BitConverter]::ToString($digestEngine.ComputeHash($archiveStream)).Replace('-','') }
  finally { $archiveStream.Dispose(); $digestEngine.Dispose() }
  [PSCustomObject]@{File=$archivePath;Entries=$names.Count;Bytes=(Get-Item -LiteralPath $archivePath).Length;SHA256=$archiveHash} | Format-List
} finally { $archive.Dispose() }
# Remove only this verified, freshly-created staging directory.
$resolvedStage = [IO.Path]::GetFullPath($stagePath)
$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (!$resolvedStage.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or !(Split-Path -Leaf $resolvedStage).StartsWith('xcopy-package-')) { throw 'Unsafe staging cleanup target' }
Remove-Item -LiteralPath $resolvedStage -Recurse -Force
