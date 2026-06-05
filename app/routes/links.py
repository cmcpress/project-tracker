"""
app/routes/links.py — Project link endpoints + OS open-link helper.

Project links are named URL/file-path shortcuts attached to a project.
They are displayed in a modal on the project card and can be opened with
a single click, launching the system browser (web URLs) or Explorer
(local paths and UNC shares).

Endpoints
---------
GET    /api/projects/<project_id>/links
POST   /api/projects/<project_id>/links          body: {name, url}
PUT    /api/links/<id>                            body: {name?, url?}
DELETE /api/links/<id>
POST   /api/open-link                            body: {url}
"""

import os
import webbrowser
import logging
from flask import Blueprint, jsonify, request, abort
from app.database import get_connection

logger = logging.getLogger(__name__)

bp = Blueprint("links", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _link_dict(row) -> dict:
    return {
        "id":         row["id"],
        "project_id": row["project_id"],
        "name":       row["name"],
        "url":        row["url"],
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
    }


def _is_web_url(url: str) -> bool:
    """Return True if the URL should be opened in a browser."""
    lower = url.strip().lower()
    return lower.startswith(("http://", "https://", "ftp://", "ftps://"))


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@bp.route("/projects/<int:project_id>/links", methods=["GET"])
def list_links(project_id: int):
    """List all links for a project, ordered by sort_order then id."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone():
            abort(404, f"Project {project_id} not found.")
        rows = conn.execute(
            "SELECT * FROM project_links WHERE project_id = ? ORDER BY sort_order ASC, id ASC",
            (project_id,)
        ).fetchall()
        return jsonify([_link_dict(r) for r in rows])
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/links", methods=["POST"])
def create_link(project_id: int):
    """Add a new link to a project."""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    url  = (data.get("url")  or "").strip()

    if not name:
        abort(400, "name is required.")
    if not url:
        abort(400, "url is required.")

    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone():
            abort(404, f"Project {project_id} not found.")

        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) FROM project_links WHERE project_id = ?",
            (project_id,)
        ).fetchone()[0]

        cur = conn.execute(
            "INSERT INTO project_links (project_id, name, url, sort_order) VALUES (?, ?, ?, ?)",
            (project_id, name, url, max_order + 1)
        )
        conn.commit()
        row = conn.execute("SELECT * FROM project_links WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(_link_dict(row)), 201
    finally:
        conn.close()


@bp.route("/links/<int:link_id>", methods=["PUT"])
def update_link(link_id: int):
    """Update an existing link's name and/or URL."""
    data = request.get_json(silent=True) or {}
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM project_links WHERE id = ?", (link_id,)).fetchone()
        if not row:
            abort(404, f"Link {link_id} not found.")

        name = (data.get("name") or "").strip() or row["name"]
        url  = (data.get("url")  or "").strip() or row["url"]

        conn.execute(
            "UPDATE project_links SET name = ?, url = ? WHERE id = ?",
            (name, url, link_id)
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM project_links WHERE id = ?", (link_id,)).fetchone()
        return jsonify(_link_dict(updated))
    finally:
        conn.close()


@bp.route("/links/<int:link_id>", methods=["DELETE"])
def delete_link(link_id: int):
    """Delete a link."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM project_links WHERE id = ?", (link_id,)).fetchone():
            abort(404, f"Link {link_id} not found.")
        conn.execute("DELETE FROM project_links WHERE id = ?", (link_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# OS open-link
# ---------------------------------------------------------------------------

@bp.route("/open-link", methods=["POST"])
def open_link():
    """
    Open a URL or file path in the appropriate OS application:
      • http/https/ftp  → system default browser (webbrowser.open)
      • Everything else → os.startfile (Windows Explorer / default app)

    This endpoint is intentionally fire-and-forget — it returns immediately
    and lets the OS handle the rest.  Errors are logged but never fatal.
    """
    data = request.get_json(silent=True) or {}
    url  = (data.get("url") or "").strip()

    if not url:
        abort(400, "url is required.")

    try:
        if _is_web_url(url):
            webbrowser.open(url)
        else:
            # Normalise forward-slashes to backslashes for Windows paths
            path = url.replace("/", os.sep)
            os.startfile(path)  # type: ignore[attr-defined]
        return jsonify({"ok": True})
    except Exception as exc:
        logger.error("open_link error for %r: %s", url, exc)
        return jsonify({"ok": False, "error": str(exc)}), 500
