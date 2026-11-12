#!/usr/bin/env bash
# LaTeX Local — arranca a plataforma em http://127.0.0.1:8000
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"

if [ ! -x .venv/bin/python ]; then
  echo "» A criar ambiente Python (.venv)…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r backend/requirements.txt
fi

if [ ! -d frontend/node_modules ]; then
  echo "» A instalar dependências do frontend…"
  (cd frontend && npm install --silent)
fi

# Recompila o frontend se algum ficheiro fonte for mais recente que o build
if [ ! -f frontend/dist/index.html ] || [ -n "$(find frontend/src frontend/index.html -newer frontend/dist/index.html -print -quit)" ]; then
  echo "» A compilar o frontend…"
  (cd frontend && npx --no-install vite build --logLevel warn)
fi

for t in latexmk xelatex biber; do
  command -v "$t" >/dev/null || echo "ⓘ  '$t' não encontrado (recomendado: sudo apt install latexmk texlive-xetex biber)"
done

echo "» LaTeX Local em http://127.0.0.1:${PORT}"
cd backend
exec ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT" "$@"
