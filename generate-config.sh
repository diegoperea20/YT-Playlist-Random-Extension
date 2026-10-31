#!/usr/bin/env bash
# Regenera config.js leyendo YOUTUBE_API_KEY de .env en la carpeta raíz de esta extensión.
# Uso: bash generate-config.sh
# (equivalente a generate-config.ps1 para Windows)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
envFile="$here/.env"

error() { echo "ERROR: $1" >&2; exit 1; }

if [ ! -f "$envFile" ]; then
  error ".env no encontrado. Crea $envFile con la línea: YOUTUBE_API_KEY=tu-clave"
fi

key=""
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}" # tolerar .env con finales de línea de Windows (CRLF)
  if [ -z "$key" ] && [[ "$line" =~ ^[[:space:]]*YOUTUBE_API_KEY[[:space:]]*= ]]; then
    val="${line#*=}"
    # recorta espacios al inicio
    val="${val#"${val%%[![:space:]]*}"}"
    # recorta comentario en línea:  KEY=valor  # comentario
    val="${val%%' #'*}"
    # recorta espacios al final
    val="${val%"${val##*[![:space:]]}"}"
    # quita comillas envolventes opcionales (simples o dobles)
    if [[ "$val" == \'*\' && ${#val} -ge 2 ]]; then
      val="${val#\'}"
      val="${val%\'}"
    elif [[ "$val" == \"*\" && ${#val} -ge 2 ]]; then
      val="${val#\"}"
      val="${val%\"}"
    fi
    key="$val"
  fi
done < "$envFile"

if [ -z "$key" ]; then
  error "YOUTUBE_API_KEY no encontrada en $envFile"
fi
if [[ ! "$key" =~ ^[A-Za-z0-9_-]+$ ]]; then
  error "YOUTUBE_API_KEY inválida en $envFile (solo letras, números, '-' y '_')"
fi

# escapa backslash y comillas simples para la string JS entre comillas simples
escaped="${key//\\/\\\\}"
escaped="${escaped//\'/\'\\\'\'}"

{
  printf '%s\n' "// GENERATED FILE - do not edit by hand; run generate-config.sh (Linux/macOS) or generate-config.ps1 (Windows) after changing .env"
  printf "%s\n" "export const BUNDLED_API_KEY = '$escaped'"
} > "$here/config.js"

echo "config.js generado desde $envFile"
