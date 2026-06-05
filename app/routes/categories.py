"""
routes/categories.py — REST endpoints for category management.
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import rows_to_list, row_to_dict

bp = Blueprint("categories", __name__, url_prefix="/api")


def _validate_category(data: dict, require_all: bool = True) -> dict:
    cleaned = {}
    name = data.get("name", "").strip()
    if require_all or "name" in data:
        if not name:
            abort(400, "Category name is required.")
        if len(name) > 100:
            abort(400, "Name must be 100 characters or fewer.")
        cleaned["name"] = name
    if "colour" in data:
        colour = (data["colour"] or "").strip()
        if colour and not colour.startswith("#"):
            abort(400, "Colour must be a hex string starting with '#'.")
        cleaned["colour"] = colour or "#8892a4"
    if "sort_order" in data:
        cleaned["sort_order"] = int(data["sort_order"])
    return cleaned


@bp.route("/categories", methods=["GET"])
def list_categories():
    """Return all categories ordered by sort_order, then name."""
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM categories ORDER BY sort_order ASC, name ASC"
        ).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/categories", methods=["POST"])
def create_category():
    """Create a new category."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_category(data)
    conn = get_connection()
    try:
        # Check uniqueness
        if conn.execute(
            "SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", (cleaned["name"],)
        ).fetchone():
            abort(400, f"A category named '{cleaned['name']}' already exists.")
        # Place at end by default
        max_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) FROM categories"
        ).fetchone()[0]
        cursor = conn.execute(
            "INSERT INTO categories (name, colour, sort_order) VALUES (:name, :colour, :sort_order)",
            {
                "name":       cleaned["name"],
                "colour":     cleaned.get("colour", "#8892a4"),
                "sort_order": cleaned.get("sort_order", max_order + 1),
            }
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM categories WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
        return jsonify(row_to_dict(row)), 201
    finally:
        conn.close()


@bp.route("/categories/<int:cat_id>", methods=["PUT"])
def update_category(cat_id: int):
    """Update a category's name or colour."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_category(data, require_all=False)
    if not cleaned:
        abort(400, "No valid fields to update.")
    conn = get_connection()
    try:
        if not conn.execute(
            "SELECT id FROM categories WHERE id = ?", (cat_id,)
        ).fetchone():
            abort(404, f"Category {cat_id} not found.")
        # Uniqueness check if renaming
        if "name" in cleaned:
            clash = conn.execute(
                "SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != ?",
                (cleaned["name"], cat_id)
            ).fetchone()
            if clash:
                abort(400, f"A category named '{cleaned['name']}' already exists.")
        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = cat_id
        conn.execute(f"UPDATE categories SET {set_clause} WHERE id = :_id", cleaned)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM categories WHERE id = ?", (cat_id,)
        ).fetchone()
        return jsonify(row_to_dict(row))
    finally:
        conn.close()


@bp.route("/categories/<int:cat_id>", methods=["DELETE"])
def delete_category(cat_id: int):
    """
    Delete a category. Projects using it will have their category set to 'General'.
    Refuse to delete the last category.
    """
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM categories WHERE id = ?", (cat_id,)
        ).fetchone()
        if not row:
            abort(404, f"Category {cat_id} not found.")
        total = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
        if total <= 1:
            abort(400, "Cannot delete the last category.")
        cat_name = row_to_dict(row)["name"]
        # Reassign projects that used this category
        fallback = conn.execute(
            "SELECT name FROM categories WHERE id != ? ORDER BY sort_order ASC, name ASC LIMIT 1",
            (cat_id,)
        ).fetchone()
        fallback_name = fallback[0] if fallback else "General"
        conn.execute(
            "UPDATE projects SET category = ? WHERE category = ?",
            (fallback_name, cat_name)
        )
        conn.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()
