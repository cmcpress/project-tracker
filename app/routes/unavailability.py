"""
routes/unavailability.py — REST endpoints for per-person unavailability ranges.

Each unavailability entry marks a person unavailable for a date range (inclusive).
A single blocked day is stored with start_date == end_date.

Routes:
    GET    /api/people/<person_id>/unavailability          — list for a person
    POST   /api/people/<person_id>/unavailability          — create an entry
    PUT    /api/unavailability/<id>                        — update an entry
    DELETE /api/unavailability/<id>                        — delete an entry
    GET    /api/projects/<project_id>/unavailability       — all entries for
                                                             people assigned to
                                                             tasks in this project
    GET    /api/unavailability/all                         — every entry (for
                                                             calendar/timeline views
                                                             that show all projects)
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import rows_to_list, row_to_dict

bp = Blueprint("unavailability", __name__, url_prefix="/api")


def _validate(data: dict, require_all: bool = True) -> dict:
    cleaned = {}

    if require_all or "label" in data:
        label = (data.get("label") or "").strip() or "Unavailable"
        if len(label) > 200:
            abort(400, "Label must be 200 characters or fewer.")
        cleaned["label"] = label

    for field in ("start_date", "end_date"):
        if require_all or field in data:
            val = (data.get(field) or "").strip()
            if require_all and not val:
                abort(400, f"{field} is required.")
            cleaned[field] = val or None

    if require_all:
        sd = cleaned.get("start_date")
        ed = cleaned.get("end_date")
        if sd and ed and ed < sd:
            abort(400, "end_date must be on or after start_date.")

    return cleaned


@bp.route("/people/<int:person_id>/unavailability", methods=["GET"])
def list_unavailability(person_id: int):
    """Return all unavailability entries for a person, ordered by start_date."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone():
            abort(404, f"Person {person_id} not found.")
        rows = conn.execute(
            """SELECT * FROM unavailability
               WHERE person_id = ?
               ORDER BY start_date ASC, id ASC""",
            (person_id,)
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/people/<int:person_id>/unavailability", methods=["POST"])
def create_unavailability(person_id: int):
    """Create a new unavailability entry for a person."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate(data)
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone():
            abort(404, f"Person {person_id} not found.")
        cursor = conn.execute(
            """INSERT INTO unavailability (person_id, start_date, end_date, label)
               VALUES (?, ?, ?, ?)""",
            (person_id, cleaned["start_date"], cleaned["end_date"], cleaned["label"])
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM unavailability WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return jsonify(row_to_dict(row)), 201
    finally:
        conn.close()


@bp.route("/unavailability/<int:entry_id>", methods=["PUT"])
def update_unavailability(entry_id: int):
    """Update an unavailability entry's dates or label."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate(data, require_all=False)
    if not cleaned:
        abort(400, "No valid fields to update.")
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM unavailability WHERE id = ?", (entry_id,)
        ).fetchone():
            abort(404, f"Unavailability entry {entry_id} not found.")
        # Re-validate date ordering if both dates supplied
        sd = cleaned.get("start_date") or conn.execute(
            "SELECT start_date FROM unavailability WHERE id = ?", (entry_id,)
        ).fetchone()["start_date"]
        ed = cleaned.get("end_date") or conn.execute(
            "SELECT end_date FROM unavailability WHERE id = ?", (entry_id,)
        ).fetchone()["end_date"]
        if sd and ed and ed < sd:
            abort(400, "end_date must be on or after start_date.")
        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = entry_id
        conn.execute(f"UPDATE unavailability SET {set_clause} WHERE id = :_id", cleaned)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM unavailability WHERE id = ?", (entry_id,)
        ).fetchone()
        return jsonify(row_to_dict(row))
    finally:
        conn.close()


@bp.route("/unavailability/<int:entry_id>", methods=["DELETE"])
def delete_unavailability(entry_id: int):
    """Delete an unavailability entry."""
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM unavailability WHERE id = ?", (entry_id,)
        ).fetchone():
            abort(404, f"Unavailability entry {entry_id} not found.")
        conn.execute("DELETE FROM unavailability WHERE id = ?", (entry_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/unavailability", methods=["GET"])
def project_unavailability(project_id: int):
    """
    Return all unavailability entries for people who are assigned to at least
    one task in the given project. Includes person name and colour for display.
    """
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone():
            abort(404, f"Project {project_id} not found.")
        rows = conn.execute(
            """SELECT u.*, p.name AS person_name, p.colour AS person_colour
               FROM unavailability u
               JOIN people p ON p.id = u.person_id
               WHERE u.person_id IN (
                   SELECT DISTINCT tp.person_id
                   FROM task_people tp
                   JOIN tasks t ON t.id = tp.task_id
                   WHERE t.project_id = ?
               )
               ORDER BY u.start_date ASC, u.id ASC""",
            (project_id,)
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/unavailability/all", methods=["GET"])
def all_unavailability():
    """
    Return every unavailability entry across all people.
    Used by Calendar and Timeline views which show all projects at once.
    Includes person name and colour.
    """
    conn = get_connection()
    try:
        rows = conn.execute(
            """SELECT u.*, p.name AS person_name, p.colour AS person_colour
               FROM unavailability u
               JOIN people p ON p.id = u.person_id
               ORDER BY u.start_date ASC, u.id ASC"""
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()
