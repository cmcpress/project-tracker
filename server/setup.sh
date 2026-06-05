#!/bin/bash
# =============================================================================
# Project Tracker — Server Setup Script
# =============================================================================
#
# Target:  Ubuntu 22.04 x86_64 on Oracle Cloud Free Tier (1GB RAM)
#
# Supports:
#   - DuckDNS subdomain (free, e.g. myapp.duckdns.org)
#   - Own domain name  (e.g. tracker.mydomain.com)
#
# Usage:
#   chmod +x setup.sh
#   sudo bash setup.sh
#
# Safe to re-run — all steps are idempotent.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step()  { echo -e "\n${GREEN}━━━${NC} $1"; }

[ "$EUID" -eq 0 ] || error "Run with: sudo bash setup.sh"

# ---------------------------------------------------------------------------
# Collect configuration
# ---------------------------------------------------------------------------

echo ""
echo "Project Tracker — Server Setup"
echo "================================"
echo ""

# Domain type
echo "Domain type:"
echo "  1) DuckDNS subdomain (free — e.g. myapp.duckdns.org)"
echo "  2) Own domain name   (e.g. tracker.mydomain.com)"
echo ""
read -rp "Choose [1/2]: " DOMAIN_TYPE
[[ "$DOMAIN_TYPE" == "1" || "$DOMAIN_TYPE" == "2" ]] || error "Enter 1 or 2."

if [ "$DOMAIN_TYPE" = "1" ]; then
    read -rp "DuckDNS subdomain (just the name, e.g. myapp): " SUBDOMAIN
    [ -n "$SUBDOMAIN" ] || error "Subdomain cannot be empty."
    DOMAIN="${SUBDOMAIN}.duckdns.org"
    read -rsp "DuckDNS token (from duckdns.org dashboard, hidden): " DUCKDNS_TOKEN
    echo ""
    [ -n "$DUCKDNS_TOKEN" ] || error "DuckDNS token cannot be empty."
    USE_DUCKDNS=true
else
    read -rp "Your domain name (e.g. tracker.mydomain.com): " DOMAIN
    [ -n "$DOMAIN" ] || error "Domain cannot be empty."
    warn "Make sure your domain's DNS A record points to this server's IP before continuing."
    read -rp "Press Enter when DNS is ready, or Ctrl+C to abort: " _
    USE_DUCKDNS=false
fi

read -rp "Email address (for SSL certificate renewal notices): " CERTBOT_EMAIL
[ -n "$CERTBOT_EMAIL" ] || error "Email cannot be empty."

read -rp "GitHub repo URL (e.g. https://github.com/username/project-tracker.git): " GITHUB_REPO
[ -n "$GITHUB_REPO" ] || error "GitHub repo URL cannot be empty."

DB_NAME="projecttracker"
DB_USER="ptuser"
APP_DIR="/opt/project-tracker"
APP_USER="ptapp"
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=')

echo ""
echo "Setup will use:"
echo "  Domain : ${DOMAIN}"
echo "  App dir: ${APP_DIR}"
echo "  DB name: ${DB_NAME}"
echo ""
read -rp "Proceed? (y/n): " CONFIRM
[ "$CONFIRM" = "y" ] || error "Aborted."

# ---------------------------------------------------------------------------
# Step 1 — System update and packages (including ufw)
# ---------------------------------------------------------------------------
step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
    python3 python3-pip python3-venv python3-dev \
    postgresql postgresql-contrib libpq-dev \
    nginx certbot python3-certbot-nginx \
    git curl openssl ufw

info "System packages installed"

# ---------------------------------------------------------------------------
# Step 2 — Firewall
# ---------------------------------------------------------------------------
step "Configuring firewall"

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
info "Firewall configured"

warn "If the site is unreachable, also open ports 80 and 443 in:"
warn "Oracle Cloud Console → Networking → VCN → Security Lists → Add Ingress Rules"

# ---------------------------------------------------------------------------
# Step 3 — PostgreSQL
# ---------------------------------------------------------------------------
step "Configuring PostgreSQL"

systemctl enable postgresql
systemctl start postgresql

# Idempotent — skip if already exists
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" \
    | grep -q 1 || sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" \
    | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

# Tune for 1GB RAM (idempotent — append only adds once)
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" | tr -d ' \n')
if ! grep -q "Project Tracker tuning" "${PG_CONF}"; then
    cat >> "${PG_CONF}" << PGCONF

# Project Tracker tuning for 1GB RAM instance
shared_buffers = 128MB
effective_cache_size = 512MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 20
PGCONF
fi

systemctl restart postgresql
info "PostgreSQL configured"

# ---------------------------------------------------------------------------
# Step 4 — App user and directory
# ---------------------------------------------------------------------------
step "Creating app user and directory"

id -u ${APP_USER} &>/dev/null || useradd --system --no-create-home --shell /sbin/nologin ${APP_USER}
mkdir -p ${APP_DIR}/data

# ---------------------------------------------------------------------------
# Step 5 — Clone application
# ---------------------------------------------------------------------------
step "Cloning application from GitHub"

if [ -d "${APP_DIR}/repo/.git" ]; then
    warn "Repo already exists — pulling latest instead"
    git -C ${APP_DIR}/repo pull
else
    warn "If the repo is private, enter your GitHub username and personal access token when prompted."
    git clone ${GITHUB_REPO} ${APP_DIR}/repo
fi
info "Application ready"

# ---------------------------------------------------------------------------
# Step 6 — Python environment and dependencies
# ---------------------------------------------------------------------------
step "Installing Python dependencies"

python3 -m venv ${APP_DIR}/venv
${APP_DIR}/venv/bin/pip install --upgrade pip -q
${APP_DIR}/venv/bin/pip install -r ${APP_DIR}/repo/requirements.txt -q
${APP_DIR}/venv/bin/pip install gunicorn -q
info "Python dependencies installed"

# ---------------------------------------------------------------------------
# Step 7 — App configuration
# ---------------------------------------------------------------------------
step "Writing app configuration"

# Only write config if it doesn't already contain a pg_connection
if [ ! -f "${APP_DIR}/data/config.json" ]; then
cat > ${APP_DIR}/data/config.json << JSON
{
  "pg_connection": {
    "host": "127.0.0.1",
    "port": 5432,
    "dbname": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASS}",
    "ssl": false
  }
}
JSON
    chmod 600 ${APP_DIR}/data/config.json
    info "config.json written"
else
    warn "config.json already exists — skipping (delete it to regenerate)"
fi

# ---------------------------------------------------------------------------
# Step 8 — Database migrations
# ---------------------------------------------------------------------------
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
print("Migrations applied successfully.")
PYEOF
info "Database migrations complete"

# ---------------------------------------------------------------------------
# Step 9 — Permissions
# ---------------------------------------------------------------------------
step "Setting permissions"
chown -R ${APP_USER}:${APP_USER} ${APP_DIR}
chmod 750 ${APP_DIR}
info "Permissions set"

# ---------------------------------------------------------------------------
# Step 10 — Systemd service
# ---------------------------------------------------------------------------
step "Creating systemd service"

cat > /etc/systemd/system/projecttracker.service << SERVICE
[Unit]
Description=Project Tracker Flask API
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/repo
Environment="PATH=${APP_DIR}/venv/bin"
ExecStart=${APP_DIR}/venv/bin/gunicorn \\
    --workers 2 \\
    --bind 127.0.0.1:5000 \\
    --timeout 120 \\
    --access-logfile /var/log/projecttracker-access.log \\
    --error-logfile /var/log/projecttracker-error.log \\
    wsgi:app
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

touch /var/log/projecttracker-access.log /var/log/projecttracker-error.log
chown ${APP_USER}:${APP_USER} /var/log/projecttracker-*.log
systemctl daemon-reload
systemctl enable projecttracker
info "Systemd service created"

# ---------------------------------------------------------------------------
# Step 11 — Nginx
# ---------------------------------------------------------------------------
step "Configuring nginx"

cat > /etc/nginx/sites-available/projecttracker << NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/projecttracker /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx
info "Nginx configured"

# ---------------------------------------------------------------------------
# Step 12 — SSL certificate
# ---------------------------------------------------------------------------
step "Obtaining SSL certificate"

certbot --nginx \
    --non-interactive \
    --agree-tos \
    --email "${CERTBOT_EMAIL}" \
    -d "${DOMAIN}"
info "SSL certificate obtained"

# ---------------------------------------------------------------------------
# Step 13 — DuckDNS auto-renewal (only if using DuckDNS)
# ---------------------------------------------------------------------------
if [ "$USE_DUCKDNS" = true ]; then
    step "Setting up DuckDNS IP auto-renewal"
    mkdir -p /opt/duckdns
    cat > /opt/duckdns/update.sh << DUCK
#!/bin/bash
curl -sk "https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" > /opt/duckdns/duck.log
DUCK
    chmod 700 /opt/duckdns/update.sh
    (crontab -l 2>/dev/null | grep -v duckdns; echo "*/5 * * * * /opt/duckdns/update.sh") | crontab -
    /opt/duckdns/update.sh
    DUCK_RESULT=$(cat /opt/duckdns/duck.log)
    if [ "${DUCK_RESULT}" = "OK" ]; then
        info "DuckDNS auto-renewal configured and working"
    else
        warn "DuckDNS update returned: ${DUCK_RESULT} — check token and subdomain"
    fi
fi

# ---------------------------------------------------------------------------
# Step 14 — Start the app
# ---------------------------------------------------------------------------
step "Starting Project Tracker"

systemctl start projecttracker
sleep 3

if systemctl is-active --quiet projecttracker; then
    info "Project Tracker is running"
else
    warn "Service did not start — check: journalctl -u projecttracker -n 50"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Setup complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  URL      : https://${DOMAIN}"
echo "  App dir  : ${APP_DIR}"
echo "  DB name  : ${DB_NAME}"
echo "  DB user  : ${DB_USER}"
if [ ! -f "${APP_DIR}/data/config.json" ]; then
    echo "  DB pass  : ${DB_PASS}"
    echo -e "${YELLOW}  IMPORTANT: Save the DB password — it will not be shown again.${NC}"
fi
echo ""
echo "  Useful commands:"
echo "    View logs   : journalctl -u projecttracker -f"
echo "    Restart app : sudo systemctl restart projecttracker"
echo "    App status  : sudo systemctl status projecttracker"
echo ""
