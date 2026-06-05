"""
routes/people.py — REST endpoints for people management.
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import rows_to_list, row_to_dict

bp = Blueprint("people", __name__, url_prefix="/api")


def _validate_person(data: dict, require_all: bool = True) -> dict:
    """Validate and sanitise a person payload."""
    cleaned = {}
    name = data.get("name", "").strip()
    if require_all or "name" in data:
        if not name:
            abort(400, "Person name is required.")
        if len(name) > 200:
            abort(400, "Name must be 200 characters or fewer.")
        cleaned["name"] = name
    if "role" in data:
        cleaned["role"] = data["role"] or None
    if "email" in data:
        cleaned["email"] = data["email"] or None
    if "colour" in data:
        colour = (data["colour"] or "").strip()
        if colour and not colour.startswith("#"):
            abort(400, "Colour must be a hex string starting with '#'.")
        cleaned["colour"] = colour or "#8892a4"
    return cleaned


@bp.route("/people", methods=["GET"])
def list_people():
    """Return all people ordered by name."""
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM people ORDER BY name ASC").fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/people", methods=["POST"])
def create_person():
    """Create a new person."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_person(data)
    conn = get_connection()
    try:
        cursor = conn.execute(
            "INSERT INTO people (name, role, email, colour) VALUES (:name, :role, :email, :colour)",
            {
                "name": cleaned["name"],
                "role": cleaned.get("role"),
                "email": cleaned.get("email"),
                "colour": cleaned.get("colour", "#8892a4"),
            }
        )
        conn.commit()
        row = conn.execute("SELECT * FROM people WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return jsonify(row_to_dict(row)), 201
    finally:
        conn.close()


@bp.route("/people/<int:person_id>", methods=["PUT"])
def update_person(person_id: int):
    """Update a person's details."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_person(data, require_all=False)
    if not cleaned:
        abort(400, "No valid fields to update.")
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone():
            abort(404, f"Person {person_id} not found.")
        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = person_id
        conn.execute(f"UPDATE people SET {set_clause} WHERE id = :_id", cleaned)
        conn.commit()
        row = conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        return jsonify(row_to_dict(row))
    finally:
        conn.close()


@bp.route("/people/<int:person_id>", methods=["DELETE"])
def delete_person(person_id: int):
    """Delete a person (removes all task assignments too)."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone():
            abort(404, f"Person {person_id} not found.")
        conn.execute("DELETE FROM people WHERE id = ?", (person_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>/people/<int:person_id>", methods=["POST"])
def assign_person(task_id: int, person_id: int):
    """Assign a person to a task."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            abort(404, f"Task {task_id} not found.")
        if not conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone():
            abort(404, f"Person {person_id} not found.")
        # INSERT OR IGNORE avoids an error if already assigned
        conn.execute(
            "INSERT OR IGNORE INTO task_people (task_id, person_id) VALUES (?, ?)",
            (task_id, person_id)
        )
        conn.commit()
        return jsonify({"ok": True}), 201
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>/people/<int:person_id>", methods=["DELETE"])
def unassign_person(task_id: int, person_id: int):
    """Remove a person from a task."""
    conn = get_connection()
    try:
        conn.execute(
            "DELETE FROM task_people WHERE task_id = ? AND person_id = ?",
            (task_id, person_id)
        )
        conn.commit()
        return "", 204
    finally:
        conn.close()
