"""
routes/settings.py — App-level settings stored in the database.

Currently supported keys:
    currency_symbol  — e.g. '£', '$', '€'

Endpoints:
    GET  /api/settings          Return all settings as a flat dict
    PUT  /api/settings/<key>    Update a single setting value
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection

bp = Blueprint("settings", __name__, url_prefix="/api")

ALLOWED_KEYS = {"currency_symbol", "cards_default_expanded", "sidebar_categories_expanded", "show_archived_projects", "dark_mode", "enable_logging"}


@bp.route("/settings", methods=["GET"])
def get_settings():
    """Return all settings as a plain key → value dict."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return jsonify({r["key"]: r["value"] for r in rows})
    finally:
        conn.close()


@bp.route("/settings/<key>", methods=["PUT"])
def update_setting(key: str):
    """Update a single setting by key. Body: {"value": "..."}"""
    if key not in ALLOWED_KEYS:
        abort(400, f"Unknown setting key '{key}'. Allowed: {', '.join(sorted(ALLOWED_KEYS))}.")

    data = request.get_json(silent=True) or {}
    if "value" not in data:
        abort(400, "Field 'value' is required.")

    value = str(data["value"]).strip()
    if key == "currency_symbol" and len(value) > 4:
        abort(400, "currency_symbol must be 4 characters or fewer.")

    conn = get_connection()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, value)
        )
        conn.commit()
        return jsonify({"key": key, "value": value})
    finally:
        conn.close()
