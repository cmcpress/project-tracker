#!/bin/bash
# =============================================================================
# Project Tracker — Server Setup Script
# =============================================================================
#
# Target:  Ubuntu 22.04 x86_64 on Oracle Cloud Free Tier (1GB RAM)
#
# What this script does:
#   1. Opens firewall ports (80, 443)
#   2. Installs system packages (nginx, PostgreSQL, Python, Certbot)
#   3. Creates the PostgreSQL database and user
#   4. Creates the app user and directory
#   5. Writes the app configuration (data/config.json)
#   6. Installs Python dependencies
#   7. Runs database migrations
#   8. Configures nginx as a reverse proxy
#   9. Gets a free SSL certificate from Let's Encrypt
#  10. Sets up DuckDNS IP auto-renewal
#  11. Creates a systemd service to keep the app running
#
# Usage:
#   chmod +x setup.sh
#   sudo bash setup.sh
#
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

# Must run as root
[ "$EUID" -eq 0 ] || error "Run with: sudo bash setup.sh"

# ---------------------------------------------------------------------------
# Collect configuration interactively — no personal data in this file
# ---------------------------------------------------------------------------

echo ""
echo "Project Tracker — Server Setup"
echo "================================"
echo "You will be asked for a few values before setup begins."
echo ""

read -rp "Your DuckDNS subdomain (e.g. myapp for myapp.duckdns.org): " SUBDOMAIN
[ -n "$SUBDOMAIN" ] || error "Subdomain cannot be empty."
DOMAIN="${SUBDOMAIN}.duckdns.org"

read -rsp "Your DuckDNS token (from duckdns.org dashboard): " DUCKDNS_TOKEN
echo ""
[ -n "$DUCKDNS_TOKEN" ] || error "DuckDNS token cannot be empty."

read -rp "Your email address (for SSL certificate renewal notices): " CERTBOT_EMAIL
[ -n "$CERTBOT_EMAIL" ] || error "Email cannot be empty."

read -rp "GitHub repo URL (e.g. https://github.com/username/project-tracker.git): " GITHUB_REPO
[ -n "$GITHUB_REPO" ] || error "GitHub repo URL cannot be empty."

# Fixed values
DB_NAME="projecttracker"
DB_USER="ptuser"
APP_DIR="/opt/project-tracker"
APP_USER="ptapp"

# Generate a random database password
DB_PASS=$(openssl rand -base64 24 | tr -d '/+=')

echo ""
echo "Setup will use:"
echo "  Domain   : ${DOMAIN}"
echo "  App dir  : ${APP_DIR}"
echo "  DB name  : ${DB_NAME}"
echo ""
read -rp "Proceed? (y/n): " CONFIRM
[ "$CONFIRM" = "y" ] || error "Aborted."

# ---------------------------------------------------------------------------
# Step 1 — System update and package installation
# ---------------------------------------------------------------------------
step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq

apt-get install -y -qq \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    postgresql \
    postgresql-contrib \
    libpq-dev \
    nginx \
    certbot \
    python3-certbot-nginx \
    git \
    curl \
    openssl \
    ufw

info "System packages installed"

# ---------------------------------------------------------------------------
# Step 2 — Open OS firewall ports (ufw now installed)
# ---------------------------------------------------------------------------
step "Configuring firewall"

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
info "Firewall configured (ports 22, 80, 443 open)"

warn "If the site is unreachable after setup, also open ports 80 and 443 in:"
warn "Oracle Cloud Console → Networking → Virtual Cloud Networks"
warn "→ your VCN → Security Lists → Default Security List → Add Ingress Rules"

# ---------------------------------------------------------------------------
# Step 3 — PostgreSQL setup
# ---------------------------------------------------------------------------
step "Configuring PostgreSQL"

systemctl enable postgresql
systemctl start postgresql

sudo -u postgres psql -v ON_ERROR_STOP=1 << SQL
CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

# Tune PostgreSQL for 1GB RAM
PG_CONF=$(sudo -u postgres psql -t -c "SHOW config_file;" | tr -d ' ')
cat >> "${PG_CONF}" << PGCONF

# Project Tracker tuning for 1GB RAM instance
shared_buffers = 128MB
effective_cache_size = 512MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 20
PGCONF

systemctl restart postgresql
info "PostgreSQL configured"

# ---------------------------------------------------------------------------
# Step 4 — Create app user and directory
# ---------------------------------------------------------------------------
step "Creating app user and directory"

useradd --system --no-create-home --shell /sbin/nologin ${APP_USER} 2>/dev/null || true
mkdir -p ${APP_DIR}
mkdir -p ${APP_DIR}/data

# ---------------------------------------------------------------------------
# Step 5 — Clone the application
# ---------------------------------------------------------------------------
step "Cloning application from GitHub"

warn "If the repo is private, enter your GitHub username and personal access token when prompted."
git clone ${GITHUB_REPO} ${APP_DIR}/repo
info "Application cloned"

# ---------------------------------------------------------------------------
# Step 6 — Python virtual environment and dependencies
# ---------------------------------------------------------------------------
step "Installing Python dependencies"

python3 -m venv ${APP_DIR}/venv
${APP_DIR}/venv/bin/pip install --upgrade pip -q
${APP_DIR}/venv/bin/pip install -r ${APP_DIR}/repo/requirements.txt -q
${APP_DIR}/venv/bin/pip install gunicorn -q
info "Python dependencies installed"

# ---------------------------------------------------------------------------
# Step 7 — Write app configuration
# ---------------------------------------------------------------------------
step "Writing app configuration"

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
info "config.json written (readable by root only)"

# ---------------------------------------------------------------------------
# Step 8 — Run database migrations
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
# Step 9 — Set ownership
# ---------------------------------------------------------------------------
step "Setting file permissions"

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
# Step 11 — Nginx configuration
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
# Step 13 — DuckDNS auto-renewal
# ---------------------------------------------------------------------------
step "Setting up DuckDNS IP auto-renewal"

mkdir -p /opt/duckdns
cat > /opt/duckdns/update.sh << DUCK
#!/bin/bash
curl -sk "https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${DUCKDNS_TOKEN}&ip=" > /opt/duckdns/duck.log
DUCK

chmod +x /opt/duckdns/update.sh
chmod 700 /opt/duckdns/update.sh

(crontab -l 2>/dev/null; echo "*/5 * * * * /opt/duckdns/update.sh") | crontab -

/opt/duckdns/update.sh
DUCK_RESULT=$(cat /opt/duckdns/duck.log)
if [ "${DUCK_RESULT}" = "OK" ]; then
    info "DuckDNS auto-renewal configured and working"
else
    warn "DuckDNS update returned: ${DUCK_RESULT} — check token and subdomain"
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
echo "  URL         : https://${DOMAIN}"
echo "  App dir     : ${APP_DIR}"
echo "  DB name     : ${DB_NAME}"
echo "  DB user     : ${DB_USER}"
echo "  DB password : ${DB_PASS}"
echo ""
echo -e "${YELLOW}  IMPORTANT: Save the database password — it will not be shown again.${NC}"
echo ""
echo "  Useful commands:"
echo "    View logs    : journalctl -u projecttracker -f"
echo "    Restart app  : sudo systemctl restart projecttracker"
echo "    App status   : sudo systemctl status projecttracker"
echo "    Nginx logs   : sudo tail -f /var/log/nginx/error.log"
echo ""
