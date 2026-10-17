#!/usr/bin/env bash
# One command to run the control panel locally: ./run.sh  → http://localhost:8000
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
[ -f .env ] || cp .env.example .env
export PYTHONPATH=src
echo "LILO control panel → http://localhost:${PORT:-8000}"
exec python -m zozobra.web
