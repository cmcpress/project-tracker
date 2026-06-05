"""
routes/phases.py — REST endpoints for phase banner management.

Phases are project-level date-range objects rendered as coloured bands
in the Gantt chart header. They are independent of the task hierarchy.

Routes:
    GET    /api/projects/<project_id>/phases   — list phases for a project
    POST   /api/projects/<project_id>/phases   — create a phase
    PUT    /api/phases/<phase_id>              — update a phase
    DELETE /api/phases/<phase_id>              — delete a phase
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import rows_to_list, row_to_dict

bp = Blueprint("phases", __name__, url_prefix="/api")


def _validate_phase(data: dict, require_all: bool = True) -> dict:
    """Validate and clean phase fields. Returns a dict of cleaned values."""
    cleaned = {}

    if require_all or "name" in data:
        name = (data.get("name") or "").strip()
        if not name:
            abort(400, "Phase name is required.")
        if len(name) > 200:
            abort(400, "Name must be 200 characters or fewer.")
        cleaned["name"] = name

    if "start_date" in data or require_all:
        sd = (data.get("start_date") or "").strip() or None
        cleaned["start_date"] = sd

    if "end_date" in data or require_all:
        ed = (data.get("end_date") or "").strip() or None
        cleaned["end_date"] = ed

    if "colour" in data:
        colour = (data.get("colour") or "").strip()
        if colour and not colour.startswith("#"):
            abort(400, "Colour must be a hex string starting with '#'.")
        cleaned["colour"] = colour or "#6366f1"

    if "sort_order" in data:
        try:
            cleaned["sort_order"] = int(data["sort_order"])
        except (TypeError, ValueError):
            abort(400, "sort_order must be an integer.")

    return cleaned


@bp.route("/projects/<int:project_id>/phases", methods=["GET"])
def list_phases(project_id: int):
    """Return all phases for a project, ordered by start_date then sort_order."""
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM projects WHERE id = ?", (project_id,)
        ).fetchone():
            abort(404, f"Project {project_id} not found.")
        rows = conn.execute(
            """SELECT * FROM phases
               WHERE project_id = ?
               ORDER BY start_date ASC NULLS LAST, sort_order ASC, id ASC""",
            (project_id,)
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/phases", methods=["POST"])
def create_phase(project_id: int):
    """Create a new phase for a project."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_phase(data)
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM projects WHERE id = ?", (project_id,)
        ).fetchone():
            abort(404, f"Project {project_id} not found.")

        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM phases WHERE project_id = ?",
            (project_id,)
        ).fetchone()[0]

        cursor = conn.execute(
            """INSERT INTO phases (project_id, name, start_date, end_date, colour, sort_order)
               VALUES (:project_id, :name, :start_date, :end_date, :colour, :sort_order)""",
            {
                "project_id": project_id,
                "name":       cleaned["name"],
                "start_date": cleaned.get("start_date"),
                "end_date":   cleaned.get("end_date"),
                "colour":     cleaned.get("colour", "#6366f1"),
                "sort_order": cleaned.get("sort_order", max_order + 1),
            }
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM phases WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return jsonify(row_to_dict(row)), 201
    finally:
        conn.close()


@bp.route("/phases/<int:phase_id>", methods=["PUT"])
def update_phase(phase_id: int):
    """Update a phase's name, dates, colour, or sort_order."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_phase(data, require_all=False)
    if not cleaned:
        abort(400, "No valid fields to update.")
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM phases WHERE id = ?", (phase_id,)
        ).fetchone():
            abort(404, f"Phase {phase_id} not found.")
        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = phase_id
        conn.execute(
            f"UPDATE phases SET {set_clause} WHERE id = :_id", cleaned
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM phases WHERE id = ?", (phase_id,)
        ).fetchone()
        return jsonify(row_to_dict(row))
    finally:
        conn.close()


@bp.route("/phases/<int:phase_id>", methods=["DELETE"])
def delete_phase(phase_id: int):
    """Delete a phase."""
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM phases WHERE id = ?", (phase_id,)
        ).fetchone():
            abort(404, f"Phase {phase_id} not found.")
        conn.execute("DELETE FROM phases WHERE id = ?", (phase_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()
