"""
wsgi.py — WSGI entry point for cloud/server deployment.

Runs the Flask API without pywebview. Used by gunicorn on the server:
    gunicorn -w 2 -b 127.0.0.1:5000 wsgi:app

PostgreSQL connection is configured from data/config.json, which is written
by the server setup script and is never committed to git.
"""

import json
import logging
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Load PostgreSQL connection config and initialise the database
# ---------------------------------------------------------------------------

cfg_path = Path(__file__).parent / "data" / "config.json"

if not cfg_path.exists():
    logger.error("data/config.json not found. Run the server setup script first.")
    sys.exit(1)

try:
    cfg = json.loads(cfg_path.read_text("utf-8"))
except Exception as exc:
    logger.error("Failed to read data/config.json: %s", exc)
    sys.exit(1)

pg = cfg.get("pg_connection")
if not pg:
    logger.error("No pg_connection in data/config.json. Configure PostgreSQL first.")
    sys.exit(1)

try:
    from app.database import set_postgres_config, init_db
    set_postgres_config(
        host=pg["host"],
        port=int(pg.get("port", 5432)),
        dbname=pg["dbname"],
        user=pg["user"],
        password=pg["password"],
        ssl=pg.get("ssl", True),
    )
    init_db()
    logger.info("PostgreSQL connected and migrations applied.")
except Exception as exc:
    logger.error("Database initialisation failed: %s", exc)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Create the Flask app
# ---------------------------------------------------------------------------

from app import create_app
app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000)
