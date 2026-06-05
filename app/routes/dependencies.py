"""
routes/dependencies.py — REST endpoints for task dependencies.
Full implementation in Phase 3.
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import DEPENDENCY_TYPES, rows_to_list, row_to_dict

bp = Blueprint("dependencies", __name__, url_prefix="/api")


@bp.route("/tasks/<int:task_id>/dependencies", methods=["GET"])
def list_task_dependencies(task_id: int):
    """List all dependencies involving a task (as predecessor or successor)."""
    conn = get_connection()
    try:
        task = conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if task is None:
            abort(404, f"Task {task_id} not found.")

        rows = conn.execute(
            """SELECT d.*,
                      pt.name AS predecessor_name,
                      st.name AS successor_name
               FROM dependencies d
               JOIN tasks pt ON pt.id = d.predecessor_id
               JOIN tasks st ON st.id = d.successor_id
               WHERE d.predecessor_id = ? OR d.successor_id = ?""",
            (task_id, task_id)
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/dependencies", methods=["POST"])
def create_dependency():
    """Create a dependency between two tasks."""
    data = request.get_json(silent=True) or {}

    predecessor_id = data.get("predecessor_id")
    successor_id = data.get("successor_id")
    dep_type = data.get("type", "FS")
    lag_days = data.get("lag_days", 0)

    if not predecessor_id or not successor_id:
        abort(400, "predecessor_id and successor_id are required.")
    if predecessor_id == successor_id:
        abort(400, "A task cannot depend on itself.")
    if dep_type not in DEPENDENCY_TYPES:
        abort(400, f"Invalid dependency type. Must be one of: {', '.join(sorted(DEPENDENCY_TYPES))}.")

    conn = get_connection()
    try:
        # Verify both tasks exist
        for tid in (predecessor_id, successor_id):
            if not conn.execute("SELECT id FROM tasks WHERE id = ?", (tid,)).fetchone():
                abort(404, f"Task {tid} not found.")

        # Check for duplicate
        existing = conn.execute(
            "SELECT id FROM dependencies WHERE predecessor_id = ? AND successor_id = ?",
            (predecessor_id, successor_id)
        ).fetchone()
        if existing:
            abort(400, "This dependency already exists.")

        cursor = conn.execute(
            "INSERT INTO dependencies (predecessor_id, successor_id, type, lag_days) VALUES (?, ?, ?, ?)",
            (predecessor_id, successor_id, dep_type, int(lag_days))
        )
        conn.commit()
        row = conn.execute("SELECT * FROM dependencies WHERE id = ?", (cursor.lastrowid,)).fetchone()
        return jsonify(row_to_dict(row)), 201
    finally:
        conn.close()


@bp.route("/dependencies/<int:dep_id>", methods=["PUT"])
def update_dependency(dep_id: int):
    """Update a dependency's type or lag_days."""
    data = request.get_json(silent=True) or {}
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM dependencies WHERE id = ?", (dep_id,)).fetchone()
        if row is None:
            abort(404, f"Dependency {dep_id} not found.")

        updates = {}
        if "type" in data:
            if data["type"] not in DEPENDENCY_TYPES:
                abort(400, f"Invalid dependency type.")
            updates["type"] = data["type"]
        if "lag_days" in data:
            try:
                updates["lag_days"] = int(data["lag_days"])
            except (TypeError, ValueError):
                abort(400, "lag_days must be an integer.")

        if not updates:
            abort(400, "No valid fields to update.")

        set_clause = ", ".join(f"{k} = :{k}" for k in updates)
        updates["_id"] = dep_id
        conn.execute(f"UPDATE dependencies SET {set_clause} WHERE id = :_id", updates)
        conn.commit()
        row = conn.execute("SELECT * FROM dependencies WHERE id = ?", (dep_id,)).fetchone()
        return jsonify(row_to_dict(row))
    finally:
        conn.close()


@bp.route("/dependencies/<int:dep_id>", methods=["DELETE"])
def delete_dependency(dep_id: int):
    """Remove a dependency."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM dependencies WHERE id = ?", (dep_id,)).fetchone():
            abort(404, f"Dependency {dep_id} not found.")
        conn.execute("DELETE FROM dependencies WHERE id = ?", (dep_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()
