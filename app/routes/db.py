"""
app/routes/db.py — Database info endpoint.

Provides a REST endpoint for the frontend to query the current database
path. In the desktop app (pywebview) the path is fetched directly via
window.pywebview.api.get_db_path(); this endpoint is the fallback used
when running in browser / dev mode without pywebview.
"""

from flask import Blueprint, jsonify
from app.database import _db_path

bp = Blueprint("db", __name__)


@bp.route("/api/db/info")
def db_info():
    """Return the path of the currently active database file."""
    return jsonify({"path": str(_db_path) if _db_path else ""})
