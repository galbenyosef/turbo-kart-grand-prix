# Copies every finished Tripo output (tripo-out/**/<name>-<id8>/model.glb) to assets/models/<name>.glb.
# Job names use underscores in tripo-assets.yaml but Tripo slugs them with dashes, so map back.
# Batch retries are suffixed "-2" and the adopted kart body was generated as "kart_body2": both collapse.
# Usage: powershell -File tools/stage-assets.ps1 [-Only kart_body,driver] [-Optimize]
param([string[]]$Only = @(), [switch]$Optimize)
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'assets\models'
New-Item -ItemType Directory -Force $dest | Out-Null
$dirs = Get-ChildItem (Join-Path $root 'tripo-out') -Recurse -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'model.glb') }
foreach ($d in $dirs) {
  if ($d.Name -notmatch '^(.*)-([0-9a-f]{8})$') { continue }
  $name = ($Matches[1] -replace '-', '_') -replace '_?2$', ''
  if ($Only.Count -and ($Only -notcontains $name)) { continue }
  $src = Join-Path $d.FullName 'model.glb'
  $out = Join-Path $dest "$name.glb"
  if ($Optimize) {
    # hero assets keep 1024² textures, props/items get 512²; unused data is pruned
    $size = if ($name -in 'kart_body', 'driver', 'grandstand', 'finish_arch') { 1024 } else { 512 }
    npx --yes @gltf-transform/cli@4.5.0 resize $src $out --width $size --height $size 2>$null | Out-Null
    npx --yes @gltf-transform/cli@4.5.0 prune $out $out 2>$null | Out-Null
  } else {
    Copy-Item $src $out -Force
  }
  "{0,-18} <- {1,-32} {2,6:N0} KB" -f $name, $d.Name, ((Get-Item $out).Length / 1KB)
}
