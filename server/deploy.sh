#!/bin/bash
# =============================================================================
# Project Tracker — Deploy Update Script
# =============================================================================
#
# Run this on the server whenever you push a new version from your PC.
#
# Usage:
#   sudo bash deploy.sh
#
# =============================================================================

set -euo pipefail

APP_DIR="/opt/project-tracker"
APP_USER="ptapp"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[✓]${NC} $1"; }
step() { echo -e "\n${GREEN}━━━${NC} $1"; }

[ "$EUID" -eq 0 ] || { echo "Run with: sudo bash deploy.sh"; exit 1; }

step "Pulling latest code"
cd ${APP_DIR}/repo
git pull
info "Code updated"

step "Installing any new dependencies"
${APP_DIR}/venv/bin/pip install -r requirements.txt -q
info "Dependencies up to date"

step "Running database migrations"
PYTHONPATH=${APP_DIR}/repo ${APP_DIR}/venv/bin/python - << PYEOF
import json, sys
from pathlib import Path
sys.path.insert(0, '${APP_DIR}/repo')
cfg = json.loads(Path('${APP_DIR}/data/config.json').read_text())
pg = cfg['pg_connection']
from app.database import set_postgres_config, init_db
set_postgres_config(
    host=pg['host'], port=int(pg.get('port', 5432)),
    dbname=pg['dbname'], user=pg['user'],
    password=pg['password'], ssl=pg.get('ssl', False)
)
init_db()
print("Migrations applied.")
PYEOF
info "Migrations complete"

step "Restarting app"
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}
systemctl restart projecttracker
sleep 2

if systemctl is-active --quiet projecttracker; then
    info "Project Tracker restarted successfully"
    echo ""
    echo "  Deployed. View logs with: journalctl -u projecttracker -f"
else
    echo "Service failed to start — check: journalctl -u projecttracker -n 50"
    exit 1
fi
