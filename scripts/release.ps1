param(
    [string]$DryRun = "0",
    [string]$NextVersion = "",
    [string]$SkipValidation = "0",
    [string]$TestImage = "see-through:tiny"
)

$ErrorActionPreference = "Stop"

function Test-Enabled {
    param([string]$Value)
    return $Value -match '^(1|true|yes|y)$'
}

function Set-Utf8Text {
    param([string]$Path, [string]$Text)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($resolved, $Text, $encoding)
}

function Get-NextMinorSnapshot {
    param([string]$Version)
    if ($Version -notmatch '^(\d+)\.(\d+)\.\d+$') {
        throw "Cannot infer the next snapshot from '$Version'. Pass NEXT_VERSION=..."
    }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2] + 1
    return "$major.$minor.0-snapshot"
}

function Invoke-Native {
    param([string]$Description, [scriptblock]$Action)
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Invoke-Mutation {
    param([string]$Description, [scriptblock]$Action)
    Write-Host "==> $Description"
    if (-not (Test-Enabled $DryRun)) {
        & $Action
    }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host "Release automation creates local commits and an annotated tag, then pushes them atomically."
Write-Host "Docker images are published only by GitHub Actions."

if (-not (Test-Path -LiteralPath "VERSION")) {
    throw "VERSION file is missing from the repository root."
}

$currentVersion = (Get-Content -Raw -LiteralPath "VERSION").Trim()
$versionMatch = [regex]::Match($currentVersion, '^(\d+\.\d+\.\d+)(-snapshot)?$')
if (-not $versionMatch.Success) {
    throw "VERSION must look like 0.1.0 or 0.2.0-snapshot. Current: '$currentVersion'"
}

$releaseVersion = $versionMatch.Groups[1].Value
$releaseTag = "v$releaseVersion"

if ([string]::IsNullOrWhiteSpace($NextVersion)) {
    $nextSnapshotVersion = Get-NextMinorSnapshot $releaseVersion
} else {
    $nextSnapshotVersion = $NextVersion.Trim()
}
$nextMatch = [regex]::Match($nextSnapshotVersion, '^(\d+\.\d+\.\d+)-snapshot$')
if (-not $nextMatch.Success) {
    throw "NEXT_VERSION must look like 0.2.0-snapshot. Current: '$nextSnapshotVersion'"
}
$nextReleaseVersion = $nextMatch.Groups[1].Value
if ([version]$nextReleaseVersion -le [version]$releaseVersion) {
    throw "NEXT_VERSION '$nextSnapshotVersion' must be newer than '$releaseVersion'."
}
$readme = Get-Content -Raw -LiteralPath "README.md"
$stableHeading = "### $releaseTag"
$developmentHeading = "$stableHeading (in development)"
$snapshotHeading = "### v$currentVersion"
$releaseHeadingPattern = '(?m)^' + [regex]::Escape($stableHeading) + '(?:-snapshot| \(in development\))?\s*$'
if (-not [regex]::IsMatch($readme, $releaseHeadingPattern)) {
    throw "README.md must contain '$developmentHeading', '$snapshotHeading', or '$stableHeading' before release."
}

$branch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Could not determine the current Git branch."
}
if ($branch -ne "main") {
    throw "Releases must run from main. Current branch: '$branch'"
}

$status = git status --porcelain --untracked-files=all -- . ":(exclude).ai" ":(exclude).ai/**" ":(exclude)AGENTS.md"
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect the Git working tree."
}
if ($status) {
    if (Test-Enabled $DryRun) {
        Write-Warning "The real release will require a clean working tree outside .ai/ and AGENTS.md."
        $status | ForEach-Object { Write-Host "  $_" }
    } else {
        throw "Working tree outside .ai/ and AGENTS.md must be clean before release. Commit or stash the listed changes first.`n$($status -join "`n")"
    }
}

if (-not (Test-Enabled $DryRun)) {
    Invoke-Native "Fetch origin/main and tags" { git fetch origin main --tags }
    $head = (git rev-parse HEAD).Trim()
    $originMain = (git rev-parse refs/remotes/origin/main).Trim()
    if ($head -ne $originMain) {
        throw "main must be synchronized with origin/main before release. HEAD=$head origin/main=$originMain"
    }
}

if (git tag --list $releaseTag) {
    throw "Tag $releaseTag already exists."
}

Write-Host "Release version: $releaseVersion"
Write-Host "Release tag:     $releaseTag"
Write-Host "Runtime version: $releaseVersion"
Write-Host "Next snapshot:   $nextSnapshotVersion"
Write-Host "Next runtime:    $nextSnapshotVersion"
Write-Host "Test image:      $TestImage"
Write-Host "Validation:      $(if (Test-Enabled $SkipValidation) { 'skipped' } else { 'version, compile, JavaScript, unit tests, Dockerfile' })"

if (-not (Test-Enabled $SkipValidation)) {
    Write-Host "==> Run release validation"
    Invoke-Native "Release validation" { task validate-release "TINY_IMAGE=$TestImage" }
}

Invoke-Mutation "Update release metadata for $releaseTag" {
    Set-Utf8Text "VERSION" "$releaseVersion`n"

    foreach ($doc in @("README.md", "docs/dockerhub.md")) {
        if (-not (Test-Path -LiteralPath $doc)) { continue }
        $content = Get-Content -Raw -LiteralPath $doc
        if ($doc -eq "README.md") {
            $content = [regex]::Replace($content, $releaseHeadingPattern, $stableHeading, 1)
        }
        $content = $content.Replace(":v$currentVersion", ":$releaseTag")
        Set-Utf8Text $doc $content
    }

    $updatedReadme = Get-Content -Raw -LiteralPath "README.md"
    if (-not [regex]::IsMatch($updatedReadme, '(?m)^' + [regex]::Escape($stableHeading) + '\s*$')) {
        throw "README.md does not contain the required '$stableHeading' release-history heading."
    }
}

Invoke-Mutation "Commit release metadata when needed and tag $releaseTag" {
    $releaseFiles = @("VERSION", "README.md", "docs/dockerhub.md")
    $releaseChanges = git status --porcelain -- $releaseFiles
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect release metadata changes."
    }
    if ($releaseChanges) {
        Invoke-Native "Stage release metadata" { git add -- $releaseFiles }
        Invoke-Native "Create release commit" { git commit -m "release: $releaseTag" }
    } else {
        Write-Host "Release metadata is already committed; tagging the current HEAD."
    }
    Invoke-Native "Create annotated release tag" { git tag -a $releaseTag -m "Release $releaseTag" }
}

Invoke-Mutation "Prepare $nextSnapshotVersion" {
    Set-Utf8Text "VERSION" "$nextSnapshotVersion`n"
    Invoke-Native "Stage next snapshot metadata" { git add -- VERSION }
    Invoke-Native "Create next snapshot commit" { git commit -m "chore: start $nextSnapshotVersion" }
}

Invoke-Mutation "Push main and $releaseTag atomically" {
    Invoke-Native "Push release commits and tag" { git push --atomic origin main $releaseTag }
}

if (Test-Enabled $DryRun) {
    Write-Host "Dry run complete. No files, commits, tags, or remote refs were changed."
} else {
    Write-Host "Release workflow complete. main and $releaseTag were pushed atomically."
    Write-Host "GitHub Actions is responsible for publishing full and tiny release images."
}
