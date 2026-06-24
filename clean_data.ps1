param(
    [switch]$IncludeOriginals
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Targets = @("data", "output")
if ($IncludeOriginals) {
    $Targets += @("processed", "review_files", "inbox")
}

foreach ($Target in $Targets) {
    $Path = Join-Path $ProjectRoot $Target
    if (Test-Path $Path) {
        Get-ChildItem -LiteralPath $Path -Force | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
}

if ($IncludeOriginals) {
    Write-Host "Database, output files, inbox, processed, and review_files were cleared."
} else {
    Write-Host "Database and output files were cleared. Original statement files were not touched."
}
