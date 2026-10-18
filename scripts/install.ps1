<#
.SYNOPSIS
    Install (or remove) the dsh-session-bus plugin in a DSH profile.

.DESCRIPTION
    The plugin is a plain Cordis bundle. This script does two things:

      1. makes the package reachable from the profile
         - copy : copy the package into <profile>/node_modules/dsh-session-bus
         - link : create a directory junction to this source tree (edit and re-enable)
         - path : install nothing, point the entry straight at this source tree
      2. inserts one `- insert:` row into the profile's cordis.patch.yml between
         managed markers, so the Host loads the plugin and a later uninstall can
         remove exactly that row.

    The profile patch file is hot-reloaded by DSH, so a running Host picks the
    plugin up without a restart. The entry is referenced by absolute path, which
    the Cordis loader accepts and which avoids depending on package-name
    resolution inside the profile.

.PARAMETER ProfileDir
    Profile directory to install into. Defaults to $env:DSH_PROFILE_DIR, then to
    <DSH_HOME>/profiles/<DSH_PROFILE>, then to ~/.dsh-harness-next/profiles/desktop.

.PARAMETER Mode
    copy (default), link, path, or bundle. See the description. `bundle` is the
    only mode that makes the plugin appear on the DSH Plugins page, because that
    page renders the rows a *bundle* declares; it edits the profile manifest and
    therefore needs one DSH restart to take effect.

.PARAMETER Uninstall
    Remove the managed row, the profile bundle selection, and the installed
    package directory.

.PARAMETER Suffix
    Development aid. Installs as <PackageName>-<Suffix> and points the entry
    there. Node caches an ES module by its resolved path, so a Host only ever
    executes the first version it imported from a given directory: while
    iterating on plugin code, install with a new suffix to force a fresh
    import instead of restarting DSH. Not available with `bundle`.

.EXAMPLE
    pwsh -NoProfile -File scripts/install.ps1
    pwsh -NoProfile -File scripts/install.ps1 -Mode bundle   # shown on the Plugins page (restart)
    pwsh -NoProfile -File scripts/install.ps1 -Mode link
    pwsh -NoProfile -File scripts/install.ps1 -Mode copy -Suffix 2
    pwsh -NoProfile -File scripts/install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$ProfileDir,
    [ValidateSet('copy', 'link', 'path', 'bundle')]
    [string]$Mode = 'copy',
    [string]$EntryId = 'session-bus',
    [string]$PackageName = 'dsh-session-bus',
    [string]$Suffix = '',
    [switch]$Uninstall,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$requestedMode = $Mode
$bundleMode = $Mode -eq 'bundle'
if ($bundleMode -and $Suffix) { throw 'dsh-session-bus: bundle mode installs under the package name itself; drop -Suffix' }
if ($bundleMode) {
    if ($EntryId -ne 'session-bus') { throw 'dsh-session-bus: bundle mode mounts through the bundle''s own cordis.patch.yml (id session-bus); -EntryId is not used' }
    $Mode = 'copy'
}
if ($Suffix) { $PackageName = "$PackageName-$Suffix" }

$sourceDir = Split-Path -Parent $PSScriptRoot
$entryFile = Join-Path $sourceDir 'lib/index.js'
if (-not (Test-Path -LiteralPath $entryFile)) {
    throw "dsh-session-bus: $entryFile is missing; run this script from the package root"
}

if (-not $ProfileDir) {
    if ($env:DSH_PROFILE_DIR) { $ProfileDir = $env:DSH_PROFILE_DIR }
    elseif ($env:DSH_HOME) {
        $profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
        $ProfileDir = Join-Path $env:DSH_HOME "profiles/$profileName"
    }
    else { $ProfileDir = Join-Path $HOME '.dsh-harness-next/profiles/desktop' }
}
$ProfileDir = (Resolve-Path -LiteralPath $ProfileDir).Path
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$targetDir = Join-Path $ProfileDir "node_modules/$PackageName"

function Get-ToPosixPath([string]$Path) {
    return ($Path -replace '\\', '/')
}

function Read-PatchLines {
    if (Test-Path -LiteralPath $patchFile) { return @(Get-Content -LiteralPath $patchFile) }
    return @()
}

function Remove-ManagedBlock([string[]]$Lines) {
    if ($Lines.Count -eq 0) { return @() }
    $start = -1; $end = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^#\s*>>>\s*dsh-session-bus') { $start = $i }
        if ($Lines[$i] -match '^#\s*<<<\s*dsh-session-bus') { $end = $i }
    }
    if ($start -lt 0 -or $end -lt $start) { return $Lines }
    $head = if ($start -gt 0) { @($Lines[0..($start - 1)]) } else { @() }
    $tail = if (($end + 1) -lt $Lines.Count) { @($Lines[($end + 1)..($Lines.Count - 1)]) } else { @() }
    return @($head + $tail)
}

function Write-PatchLines([string[]]$Lines) {
    $kept = @($Lines | Where-Object { $_.Trim().Length -gt 0 })
    # The profile patch must stay a YAML sequence, including when it becomes empty.
    $text = if ($kept.Count -eq 0) { "[]`n" } else { (($Lines -join "`n").TrimEnd() + "`n") }
    Set-Content -LiteralPath $patchFile -Value $text -Encoding utf8 -NoNewline
}

# --- profile manifest helpers (bundle mode) ---------------------------------
$manifestFile = Join-Path $ProfileDir 'package.json'

<#
.SYNOPSIS
    Select one package in the profile manifest's `dsh.profile.bundles`.
.DESCRIPTION
    Edits the manifest line by line instead of re-serializing it, so the rest of
    the file keeps its exact shape, then re-parses the result and restores the
    backup if the edit broke JSON.
#>
function Add-ProfileBundle([string]$Name) {
    $manifest = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json
    if (@($manifest.dsh.profile.bundles) -contains $Name) { return $false }
    Copy-Item -LiteralPath $manifestFile -Destination "$manifestFile.bak-session-bus" -Force
    $arr = @(Get-Content -LiteralPath $manifestFile)
    $start = -1
    for ($i = 0; $i -lt $arr.Count; $i++) { if ($arr[$i] -match '"bundles"\s*:\s*\[') { $start = $i; break } }
    if ($start -lt 0) { throw "dsh-session-bus: could not find dsh.profile.bundles in $manifestFile" }
    $end = -1
    for ($i = $start + 1; $i -lt $arr.Count; $i++) { if ($arr[$i].TrimStart().StartsWith(']')) { $end = $i; break } }
    if ($end -lt 0) { throw "dsh-session-bus: could not find the end of dsh.profile.bundles in $manifestFile" }
    $indent = [regex]::Match($arr[$end - 1], '^\s*').Value
    if (-not $arr[$end - 1].TrimEnd().EndsWith(',')) { $arr[$end - 1] = $arr[$end - 1].TrimEnd() + ',' }
    $edited = @($arr[0..($end - 1)]) + @("$indent`"$Name`"") + @($arr[$end..($arr.Count - 1)])
    Set-Content -LiteralPath $manifestFile -Value (($edited -join "`n").TrimEnd() + "`n") -Encoding utf8 -NoNewline
    try { $null = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json }
    catch {
        Copy-Item -LiteralPath "$manifestFile.bak-session-bus" -Destination $manifestFile -Force
        throw 'dsh-session-bus: the edited profile package.json was not valid JSON; the original was restored'
    }
    return $true
}

<#
.SYNOPSIS
    Declare one local package in the profile manifest's `dependencies`.
.DESCRIPTION
    `pluginManager.listBundles` derives a bundle's `installed` flag from exactly
    this list, and the Plugins page drops any package that is neither
    `installed`, `optional`, nor broken. A bundle selected only in
    `dsh.profile.bundles` therefore never appears on that page, even though it
    loads correctly. The spec is a `file:` path to the source package so a later
    `pnpm install` resolves it locally instead of asking a registry for a
    package that does not exist there.
#>
function Add-ProfileDependency([string]$Name, [string]$Spec) {
    $manifest = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json
    if ($null -ne $manifest.dependencies.PSObject.Properties[$Name]) { return $false }
    Copy-Item -LiteralPath $manifestFile -Destination "$manifestFile.bak-session-bus" -Force
    $arr = @(Get-Content -LiteralPath $manifestFile)
    $start = -1
    for ($i = 0; $i -lt $arr.Count; $i++) { if ($arr[$i] -match '"dependencies"\s*:\s*\{') { $start = $i; break } }
    if ($start -lt 0) { throw "dsh-session-bus: could not find dependencies in $manifestFile" }
    $end = -1
    for ($i = $start + 1; $i -lt $arr.Count; $i++) { if ($arr[$i].TrimStart().StartsWith('}')) { $end = $i; break } }
    if ($end -lt 0) { throw "dsh-session-bus: could not find the end of dependencies in $manifestFile" }
    $indent = [regex]::Match($arr[$end - 1], '^\s*').Value
    if (-not $arr[$end - 1].TrimEnd().EndsWith(',')) { $arr[$end - 1] = $arr[$end - 1].TrimEnd() + ',' }
    $line = "$indent`"$Name`": `"$Spec`""
    $edited = @($arr[0..($end - 1)]) + @($line) + @($arr[$end..($arr.Count - 1)])
    Set-Content -LiteralPath $manifestFile -Value (($edited -join "`n").TrimEnd() + "`n") -Encoding utf8 -NoNewline
    try { $null = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json }
    catch {
        Copy-Item -LiteralPath "$manifestFile.bak-session-bus" -Destination $manifestFile -Force
        throw 'dsh-session-bus: the edited profile package.json was not valid JSON; the original was restored'
    }
    return $true
}

<#
.SYNOPSIS
    Drop one package from the profile manifest's `dependencies`.
#>
function Remove-ProfileDependency([string]$Name) {
    if (-not (Test-Path -LiteralPath $manifestFile)) { return $false }
    $manifest = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json
    if ($null -eq $manifest.dependencies.PSObject.Properties[$Name]) { return $false }
    Copy-Item -LiteralPath $manifestFile -Destination "$manifestFile.bak-session-bus" -Force
    $arr = @(Get-Content -LiteralPath $manifestFile)
    $idx = -1
    for ($i = 0; $i -lt $arr.Count; $i++) {
        if ($arr[$i].TrimStart() -match "^`"$([regex]::Escape($Name))`"\s*:") { $idx = $i; break }
    }
    if ($idx -lt 0) { return $false }
    $head = if ($idx -gt 0) { @($arr[0..($idx - 1)]) } else { @() }
    $tail = if (($idx + 1) -lt $arr.Count) { @($arr[($idx + 1)..($arr.Count - 1)]) } else { @() }
    $nextIsClose = ($tail | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1) -like '}*'
    if ($nextIsClose) {
        for ($i = $head.Count - 1; $i -ge 0; $i--) {
            if ($head[$i].Trim().Length -eq 0) { continue }
            $head[$i] = $head[$i].TrimEnd() -replace ',$', ''
            break
        }
    }
    Set-Content -LiteralPath $manifestFile -Value ((@($head + $tail) -join "`n").TrimEnd() + "`n") -Encoding utf8 -NoNewline
    try { $null = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json }
    catch {
        Copy-Item -LiteralPath "$manifestFile.bak-session-bus" -Destination $manifestFile -Force
        throw 'dsh-session-bus: the edited profile package.json was not valid JSON; the original was restored'
    }
    return $true
}

<#
.SYNOPSIS
    Drop one package from the profile manifest's `dsh.profile.bundles`.
#>
function Remove-ProfileBundle([string]$Name) {    if (-not (Test-Path -LiteralPath $manifestFile)) { return $false }
    $manifest = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json
    if (@($manifest.dsh.profile.bundles) -notcontains $Name) { return $false }
    Copy-Item -LiteralPath $manifestFile -Destination "$manifestFile.bak-session-bus" -Force
    $arr = @(Get-Content -LiteralPath $manifestFile)
    $idx = -1
    for ($i = 0; $i -lt $arr.Count; $i++) {
        $t = $arr[$i].Trim()
        if ($t -eq "`"$Name`"" -or $t -eq "`"$Name`",") { $idx = $i; break }
    }
    if ($idx -lt 0) { return $false }
    $head = if ($idx -gt 0) { @($arr[0..($idx - 1)]) } else { @() }
    $tail = if (($idx + 1) -lt $arr.Count) { @($arr[($idx + 1)..($arr.Count - 1)]) } else { @() }
    $nextIsClose = ($tail | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1) -like ']*'
    if ($nextIsClose) {
        for ($i = $head.Count - 1; $i -ge 0; $i--) {
            if ($head[$i].Trim().Length -eq 0) { continue }
            $head[$i] = $head[$i].TrimEnd() -replace ',$', ''
            break
        }
    }
    Set-Content -LiteralPath $manifestFile -Value ((@($head + $tail) -join "`n").TrimEnd() + "`n") -Encoding utf8 -NoNewline
    try { $null = (Get-Content -LiteralPath $manifestFile -Raw) | ConvertFrom-Json }
    catch {
        Copy-Item -LiteralPath "$manifestFile.bak-session-bus" -Destination $manifestFile -Force
        throw 'dsh-session-bus: the edited profile package.json was not valid JSON; the original was restored'
    }
    return $true
}

if ($Uninstall) {
    $lines = Remove-ManagedBlock (Read-PatchLines)
    Write-PatchLines $lines
    $unselected = Remove-ProfileBundle $PackageName
    $undeclared = Remove-ProfileDependency $PackageName
    $removed = $false
    if (Test-Path -LiteralPath $targetDir) {
        $item = Get-Item -LiteralPath $targetDir -Force
        if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $targetDir -Recurse -Force }
        $removed = $true
    }
    Write-Host "dsh-session-bus: removed the managed row from $patchFile"
    Write-Host ("dsh-session-bus: profile bundle selection {0}" -f $(if ($unselected) { 'removed' } else { 'was not selected' }))
    Write-Host ("dsh-session-bus: profile dependency {0}" -f $(if ($undeclared) { 'removed' } else { 'was not declared' }))
    Write-Host ("dsh-session-bus: package directory {0}" -f $(if ($removed) { 'deleted' } else { 'was not installed' }))
    return
}

# --- 1. make the package reachable ------------------------------------------
if ($Mode -ne 'path') {
    if (Test-Path -LiteralPath $targetDir) {
        $item = Get-Item -LiteralPath $targetDir -Force
        if ($item.LinkType) { $item.Delete() } else { Remove-Item -LiteralPath $targetDir -Recurse -Force }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetDir) | Out-Null
    if ($Mode -eq 'link') {
        New-Item -ItemType Junction -Path $targetDir -Target $sourceDir | Out-Null
    }
    else {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
        foreach ($name in @('lib', 'test', 'scripts')) {
            $from = Join-Path $sourceDir $name
            if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $targetDir -Recurse -Force }
        }
        foreach ($name in @('package.json', 'cordis.patch.yml', 'README.md')) {
            $from = Join-Path $sourceDir $name
            if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $targetDir -Force }
        }
    }
    $entryPath = Join-Path $targetDir 'lib/index.js'
}
else { $entryPath = $entryFile }

# --- bundle mode: let the package's own patch mount it ----------------------
if ($bundleMode) {
    # The DSH Plugins page renders the rows a selected *bundle* declares, so the
    # mount must come from this package's cordis.patch.yml (name: 'dsh-session-bus')
    # rather than from a row hand-written into the profile patch. Those two would
    # be two rows with one entry id, and the loader rejects a duplicate id — so
    # the managed row goes away at the same time, which means the entry stops
    # until the bundle list is composed again: that happens at startup.
    Write-PatchLines (Remove-ManagedBlock (Read-PatchLines))
    $added = Add-ProfileBundle $PackageName
    $declared = Add-ProfileDependency $PackageName "file:$(Get-ToPosixPath $sourceDir)"
    Write-Host "dsh-session-bus: installed (bundle) into $ProfileDir"
    Write-Host "dsh-session-bus: package -> $(Get-ToPosixPath $targetDir)"
    Write-Host ("dsh-session-bus: profile bundles {0}" -f $(if ($added) { "now include $PackageName" } else { "already included $PackageName" }))
    Write-Host ("dsh-session-bus: profile dependencies {0}" -f $(if ($declared) { "now declare $PackageName" } else { "already declare $PackageName" }))
    Write-Host "dsh-session-bus: the hand-written mount row was removed from $patchFile"
    Write-Host 'dsh-session-bus: RESTART DSH to activate. The bundle list is composed at startup,'
    Write-Host 'dsh-session-bus: so the plugin stays unloaded until then; afterwards it appears on the Plugins page.'
    return
}

# --- 2. mount the row --------------------------------------------------------
$lines = Remove-ManagedBlock (Read-PatchLines)
$block = @(
    '# >>> dsh-session-bus (managed by scripts/install.ps1; keep the markers)',
    '- insert:',
    "    - id: $EntryId",
    "      name: '$(Get-ToPosixPath $entryPath)'",
    '# <<< dsh-session-bus'
)
$out = @()
if ($lines.Count -gt 0 -and ($lines -join '').Trim().Length -gt 0) { $out += $lines }
$out += $block
if (Test-Path -LiteralPath $patchFile) {
    Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-session-bus" -Force
}
Write-PatchLines $out

Write-Host "dsh-session-bus: installed ($Mode) into $ProfileDir"
Write-Host "dsh-session-bus: entry -> $(Get-ToPosixPath $entryPath)"
Write-Host "dsh-session-bus: profile patch updated at $patchFile (backup: $patchFile.bak-session-bus)"
Write-Host 'dsh-session-bus: a running DSH hot-reloads the profile patch; otherwise restart DSH.'
Write-Host 'dsh-session-bus: verify with the bus_list tool inside any Session.'
