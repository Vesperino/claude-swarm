# Installs the swarm skills into ~/.claude/skills so they are available as
# plain /swarm, /swarm-init and /swarm-role commands in every project.
$src = Join-Path $PSScriptRoot 'skills'
$dest = Join-Path $env:USERPROFILE '.claude\skills'
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($s in 'swarm', 'swarm-init', 'swarm-role') {
  $target = Join-Path $dest $s
  if (Test-Path $target) {
    Write-Host "~/.claude/skills/$s already exists - updating in place"
    Remove-Item -Recurse -Force $target
  }
  Copy-Item -Recurse (Join-Path $src $s) $target
  Write-Host "installed $s -> $target"
}
# Codex CLI: same skill, poll-driven adapter (see the Codex section of SKILL.md)
$codexHome = Join-Path $env:USERPROFILE '.codex'
if (Test-Path $codexHome) {
  $codexSkills = Join-Path $codexHome 'skills'
  New-Item -ItemType Directory -Force $codexSkills | Out-Null
  $codexTarget = Join-Path $codexSkills 'swarm'
  if (Test-Path $codexTarget) { Remove-Item -Recurse -Force $codexTarget }
  Copy-Item -Recurse (Join-Path $src 'swarm') $codexTarget
  Write-Host 'installed swarm -> ~/.codex/skills/swarm (Codex CLI: invoke with $swarm)'
}
try { node --version | Out-Null } catch { Write-Host 'WARNING: node not found on PATH - the board server needs Node >= 20.11' }
Write-Host 'Done. Open any project in Claude Code and run: /swarm <your goal>'
