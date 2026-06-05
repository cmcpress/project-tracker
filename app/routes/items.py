"""
routes/items.py — REST endpoints for task items (notes, components, subtasks).
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import ITEM_TYPES, rows_to_list, row_to_dict
from datetime import datetime

bp = Blueprint("items", __name__, url_prefix="/api")


def _validate_item(data: dict, require_all: bool = True) -> dict:
    """Validate and sanitise a task item payload."""
    cleaned = {}
    content = data.get("content", "").strip()
    if require_all or "content" in data:
        if not content:
            abort(400, "Item content is required.")
        cleaned["content"] = content
    if "item_type" in data:
        item_type = data["item_type"]
        if item_type == "subtask":
            abort(400, "item_type 'subtask' is no longer supported. Use 'note' instead.")
        if item_type not in ITEM_TYPES:
            abort(400, f"item_type must be one of: {', '.join(sorted(ITEM_TYPES))}.")
        cleaned["item_type"] = item_type
    if "is_complete" in data:
        cleaned["is_complete"] = 1 if data["is_complete"] else 0
        if cleaned["is_complete"]:
            cleaned["completed_at"] = datetime.utcnow().isoformat()
        else:
            cleaned["completed_at"] = None
    if "sort_order" in data:
        try:
            cleaned["sort_order"] = int(data["sort_order"])
        except (TypeError, ValueError):
            abort(400, "sort_order must be an integer.")
    if "value" in data:
        val = data["value"]
        if val is None or val == "":
            cleaned["value"] = None
        else:
            try:
                cleaned["value"] = float(val)
                if cleaned["value"] < 0:
                    abort(400, "Item value cannot be negative.")
            except (TypeError, ValueError):
                abort(400, "value must be a number.")
    return cleaned


@bp.route("/tasks/<int:task_id>/items", methods=["GET"])
def list_items(task_id: int):
    """List all items for a task, ordered by sort_order."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            abort(404, f"Task {task_id} not found.")
        rows = conn.execute(
            "SELECT * FROM task_items WHERE task_id = ? ORDER BY sort_order ASC, id ASC",
            (task_id,)
        ).fetchall()
        items = []
        for r in rows:
            d = row_to_dict(r)
            d["is_complete"] = bool(d.get("is_complete"))
            items.append(d)
        return jsonify(items)
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>/items", methods=["POST"])
def create_item(task_id: int):
    """Create a new item on a task."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM tasks WHERE id = ?", (task_id,)).fetchone():
            abort(404, f"Task {task_id} not found.")
        data = request.get_json(silent=True) or {}
        cleaned = _validate_item(data)
        row = conn.execute(
            "SELECT MAX(sort_order) FROM task_items WHERE task_id = ?", (task_id,)
        ).fetchone()
        sort_order = cleaned.get("sort_order", (row[0] or 0) + 1)
        cursor = conn.execute(
            """INSERT INTO task_items (task_id, content, item_type, is_complete, sort_order, value)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (task_id, cleaned["content"], cleaned.get("item_type", "note"),
             cleaned.get("is_complete", 0), sort_order, cleaned.get("value"))
        )
        conn.commit()
        r = conn.execute("SELECT * FROM task_items WHERE id = ?", (cursor.lastrowid,)).fetchone()
        d = row_to_dict(r)
        d["is_complete"] = bool(d.get("is_complete"))
        return jsonify(d), 201
    finally:
        conn.close()


@bp.route("/items/<int:item_id>", methods=["PUT"])
def update_item(item_id: int):
    """Update an item."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_item(data, require_all=False)
    if not cleaned:
        abort(400, "No valid fields to update.")
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM task_items WHERE id = ?", (item_id,)).fetchone():
            abort(404, f"Item {item_id} not found.")
        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = item_id
        conn.execute(f"UPDATE task_items SET {set_clause} WHERE id = :_id", cleaned)
        conn.commit()
        r = conn.execute("SELECT * FROM task_items WHERE id = ?", (item_id,)).fetchone()
        d = row_to_dict(r)
        d["is_complete"] = bool(d.get("is_complete"))
        return jsonify(d)
    finally:
        conn.close()


@bp.route("/items/<int:item_id>", methods=["DELETE"])
def delete_item(item_id: int):
    """Delete an item."""
    conn = get_connection()
    try:
        if not conn.execute("SELECT id FROM task_items WHERE id = ?", (item_id,)).fetchone():
            abort(404, f"Item {item_id} not found.")
        conn.execute("DELETE FROM task_items WHERE id = ?", (item_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>/items/reorder", methods=["PUT"])
def reorder_items(task_id: int):
    """Batch-update sort_order for items."""
    data = request.get_json(silent=True)
    if not isinstance(data, list):
        abort(400, "Expected a JSON array of {id, sort_order} objects.")
    conn = get_connection()
    try:
        for item in data:
            if not isinstance(item, dict) or "id" not in item or "sort_order" not in item:
                abort(400, "Each item must have 'id' and 'sort_order' fields.")
            conn.execute(
                "UPDATE task_items SET sort_order = ? WHERE id = ?",
                (int(item["sort_order"]), int(item["id"]))
            )
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
