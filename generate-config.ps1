# Regenera config.js leyendo YOUTUBE_API_KEY de .env en la carpeta raiz de esta extension.
# Uso: powershell -ExecutionPolicy Bypass -File .\generate-config.ps1   (Windows)
# En Linux/macOS usar bash generate-config.sh
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $here '.env'
if (-not (Test-Path $envFile)) {
  Write-Error ".env no encontrado. Crea $envFile con la linea: YOUTUBE_API_KEY=tu-clave"
}

$raw = Get-Content -Raw $envFile
$match = [regex]::Match($raw, '(?m)^\s*YOUTUBE_API_KEY\s*=\s*[''""]?([A-Za-z0-9\-_]+?)[''""]?\s*(?:#.*)?$')
if (-not $match.Success) {
  Write-Error "YOUTUBE_API_KEY no encontrada en $envFile"
}

$key = $match.Groups[1].Value
$escaped = $key -replace '\\', '\\\\' -replace "'", "\'"
$file = Join-Path $here 'config.js'
$content = @("
// GENERATED FILE - do not edit by hand; run generate-config.ps1 (Windows) or generate-config.sh (Linux/macOS) after changing .env
export const BUNDLED_API_KEY = '$escaped'
") -join "`r`n"
Set-Content -Path $file -Value $content -Encoding ascii
Write-Output "config.js generado desde $envFile"
