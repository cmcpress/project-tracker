"""
routes/tasks.py — REST endpoints for task management.

Endpoints:
    GET    /api/projects/<id>/tasks       List tasks for a project (tree order)
    POST   /api/projects/<id>/tasks       Create a task
    GET    /api/tasks/<id>                Get full task detail
    PUT    /api/tasks/<id>                Update task fields
    DELETE /api/tasks/<id>                Delete task (checks for children first)
    DELETE /api/tasks/<id>?cascade=true   Delete task and all its children
    DELETE /api/tasks/<id>?reassign_to=N  Reassign children to group N, then delete
    DELETE /api/tasks/<id>?reassign_to=0  Promote children to top-level, then delete
    PUT    /api/tasks/<id>/status         Quick status update
    PUT    /api/tasks/reorder             Batch sort_order update
"""

import re
from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import TASK_TYPES, STATUSES, rows_to_list, row_to_dict

bp = Blueprint("tasks", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

def _validate_task_payload(data: dict, require_all: bool = True) -> dict:
    """
    Validate and sanitise a task creation or update payload.
    Returns a dict of clean fields ready for SQL.
    Aborts with 400 on any violation.
    """
    cleaned = {}

    name = data.get("name", "").strip()
    if require_all or "name" in data:
        if not name:
            abort(400, "Task name is required and cannot be blank.")
        if len(name) > 300:
            abort(400, "Task name must be 300 characters or fewer.")
        cleaned["name"] = name

    if "type" in data:
        if data["type"] not in TASK_TYPES:
            abort(400, f"Invalid task type '{data['type']}'. Must be one of: {', '.join(sorted(TASK_TYPES))}.")
        cleaned["type"] = data["type"]

    if "status" in data:
        if data["status"] not in STATUSES:
            abort(400, f"Invalid status '{data['status']}'. Must be one of: {', '.join(sorted(STATUSES))}.")
        cleaned["status"] = data["status"]

    for date_field in ("start_date", "end_date", "actual_start_date", "actual_end_date"):
        if date_field in data:
            val = data[date_field]
            if val:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(val)):
                    abort(400, f"'{date_field}' must be in YYYY-MM-DD format.")
                cleaned[date_field] = val
            else:
                cleaned[date_field] = None

    if "duration_days" in data:
        val = data["duration_days"]
        if val is not None:
            try:
                duration = int(val)
                if duration < 0:
                    abort(400, "duration_days cannot be negative.")
                cleaned["duration_days"] = duration
            except (TypeError, ValueError):
                abort(400, "duration_days must be an integer.")
        else:
            cleaned["duration_days"] = None

    if "is_firm_date" in data:
        cleaned["is_firm_date"] = 1 if data["is_firm_date"] else 0

    if "notes" in data:
        cleaned["notes"] = data["notes"] or None

    if "sort_order" in data:
        try:
            cleaned["sort_order"] = int(data["sort_order"])
        except (TypeError, ValueError):
            abort(400, "sort_order must be an integer.")

    # ------------------------------------------------------------------
    # Phase 1 — WBS hierarchy fields
    # ------------------------------------------------------------------

    if "parent_id" in data:
        val = data["parent_id"]
        if val is None or val == "" or val == 0:
            cleaned["parent_id"] = None
        else:
            try:
                cleaned["parent_id"] = int(val)
            except (TypeError, ValueError):
                abort(400, "parent_id must be an integer or null.")

    if "wbs_number" in data:
        val = data["wbs_number"]
        cleaned["wbs_number"] = str(val).strip() if val else None

    if "progress" in data:
        val = data["progress"]
        if val is None:
            cleaned["progress"] = 0.0
        else:
            try:
                p = float(val)
                if not (0.0 <= p <= 1.0):
                    abort(400, "progress must be between 0.0 and 1.0.")
                cleaned["progress"] = p
            except (TypeError, ValueError):
                abort(400, "progress must be a number between 0.0 and 1.0.")

    if "budget" in data:
        val = data["budget"]
        if val is None or val == "":
            cleaned["budget"] = None
        else:
            try:
                b = float(val)
                if b < 0:
                    abort(400, "budget cannot be negative.")
                cleaned["budget"] = b
            except (TypeError, ValueError):
                abort(400, "budget must be a number.")

    if "rag" in data:
        val = data["rag"]
        if val is None or val == "":
            cleaned["rag"] = None
        elif val not in ("red", "amber", "green"):
            abort(400, "rag must be 'red', 'amber', 'green', or null.")
        else:
            cleaned["rag"] = val

    if "pending_until" in data:
        val = data["pending_until"]
        if val:
            if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(val)):
                abort(400, "'pending_until' must be in YYYY-MM-DD format.")
            cleaned["pending_until"] = val
        else:
            cleaned["pending_until"] = None

    for hours_field in ("estimated_hours", "logged_hours"):
        if hours_field in data:
            val = data[hours_field]
            if val is None or val == "":
                cleaned[hours_field] = None
            else:
                try:
                    h = float(val)
                    if h < 0:
                        abort(400, f"{hours_field} cannot be negative.")
                    cleaned[hours_field] = h
                except (TypeError, ValueError):
                    abort(400, f"{hours_field} must be a number.")

    return cleaned


def _auto_rag(task: dict):
    """
    Compute the automatic RAG status for a task from its dates and status.

    Rules (highest priority first):
      1. status == "complete"          → "green"
      2. end_date is before today      → "red"   (overdue)
      3. end_date is within 7 days     → "amber" (at risk) — unless stored rag is
                                         already "red" (never downgrade)
      4. Otherwise                     → keep the stored rag value (may be None)

    Milestones and group tasks without dates are left unchanged.
    """
    from datetime import date

    status   = task.get("status") or ""
    end_date = task.get("end_date")
    stored   = task.get("rag")

    if status == "complete":
        return "green"

    if end_date:
        try:
            end   = date.fromisoformat(end_date)
            today = date.today()
            diff  = (end - today).days      # negative = overdue
            if diff < 0:
                return "red"
            if diff <= 7 and stored != "red":
                return "amber"
        except ValueError:
            pass

    return stored


def _check_circular_parent(conn, task_id: int, new_parent_id: int) -> None:
    """
    Walk the parent chain from new_parent_id upward.
    Aborts 400 if task_id is found in the chain (circular reference).
    """
    visited = set()
    current = new_parent_id
    while current is not None:
        if current == task_id:
            abort(400, "Setting this parent would create a circular reference.")
        if current in visited:
            break  # Unexpected cycle guard — already in chain
        visited.add(current)
        row = conn.execute(
            "SELECT parent_id FROM tasks WHERE id = ?", (current,)
        ).fetchone()
        if row is None:
            break
        current = row["parent_id"]


def _fetch_task_row(conn, task_id: int):
    """Fetch a single task row by ID. Aborts 404 if not found."""
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        abort(404, f"Task {task_id} not found.")
    return row


def _build_task_detail(conn, task_row) -> dict:
    """
    Given a task row, assemble the full task detail dict including
    assignees, items, dependency count, and direct children IDs.
    """
    task = row_to_dict(task_row)
    task["is_firm_date"] = bool(task.get("is_firm_date"))
    task["progress"] = float(task.get("progress") or 0.0)

    # Assignees
    assignee_rows = conn.execute(
        """SELECT p.id, p.name, p.colour, p.role
           FROM people p
           JOIN task_people tp ON tp.person_id = p.id
           WHERE tp.task_id = ?""",
        (task["id"],)
    ).fetchall()
    task["assignees"] = rows_to_list(assignee_rows)

    # Items
    item_rows = conn.execute(
        "SELECT * FROM task_items WHERE task_id = ? ORDER BY sort_order ASC, id ASC",
        (task["id"],)
    ).fetchall()
    items = []
    for ir in item_rows:
        item = row_to_dict(ir)
        item["is_complete"] = bool(item.get("is_complete"))
        items.append(item)
    task["items"] = items

    # Full dependencies list (with task names for display)
    dep_rows = conn.execute(
        """SELECT d.*,
                  pt.name AS predecessor_name,
                  st.name AS successor_name
           FROM dependencies d
           JOIN tasks pt ON pt.id = d.predecessor_id
           JOIN tasks st ON st.id = d.successor_id
           WHERE d.predecessor_id = ? OR d.successor_id = ?
           ORDER BY d.id ASC""",
        (task["id"], task["id"])
    ).fetchall()
    task["dependencies"] = rows_to_list(dep_rows)
    task["dependency_count"] = len(task["dependencies"])

    # Direct children (summary — just id + name + wbs_number)
    child_rows = conn.execute(
        "SELECT id, name, wbs_number FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
        (task["id"],)
    ).fetchall()
    task["children"] = rows_to_list(child_rows)

    # Computed budget fields
    spend_row = conn.execute(
        "SELECT COALESCE(SUM(value), 0.0) FROM task_items WHERE task_id = ? AND value IS NOT NULL",
        (task["id"],)
    ).fetchone()
    task["actual_spend"] = round(float(spend_row[0] or 0.0), 2)
    task["budget"] = float(task["budget"]) if task.get("budget") is not None else None

    # Auto-compute RAG and lazy-write back to DB if it has changed.
    # This ensures all tasks (including ones created before this feature) stay
    # up-to-date the first time they are fetched after a date passes.
    auto_rag = _auto_rag(task)
    if auto_rag != task.get("rag"):
        try:
            conn.execute("UPDATE tasks SET rag = ? WHERE id = ?", (auto_rag, task["id"]))
            conn.commit()
        except Exception:
            pass  # best-effort — never fail a read because of a RAG update
    task["rag"] = auto_rag

    return task


def _tree_order(all_tasks: list[dict]) -> list[dict]:
    """
    Return tasks in depth-first tree order:
      parent, child1, child1's children..., child2, ...
    Top-level tasks (parent_id IS NULL) are sorted by sort_order/id first.
    """
    # Build children map
    children_map: dict[int | None, list[dict]] = {}
    for t in all_tasks:
        pid = t.get("parent_id")
        children_map.setdefault(pid, []).append(t)

    result = []

    def _walk(parent_id):
        for task in children_map.get(parent_id, []):
            result.append(task)
            _walk(task["id"])

    _walk(None)

    # Any orphaned tasks (parent deleted without reassign) — append at end
    emitted_ids = {t["id"] for t in result}
    for t in all_tasks:
        if t["id"] not in emitted_ids:
            result.append(t)

    return result


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route("/projects/<int:project_id>/tasks", methods=["GET"])
def list_tasks(project_id: int):
    """Return all tasks for a project in tree order, with full detail."""
    conn = get_connection()
    try:
        proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if proj is None:
            abort(404, f"Project {project_id} not found.")

        task_rows = conn.execute(
            "SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC, id ASC",
            (project_id,)
        ).fetchall()

        tasks = [_build_task_detail(conn, tr) for tr in task_rows]
        return jsonify(_tree_order(tasks))
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/tasks", methods=["POST"])
def create_task(project_id: int):
    """Create a new task in the specified project. Returns the created task."""
    conn = get_connection()
    try:
        proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if proj is None:
            abort(404, f"Project {project_id} not found.")

        data = request.get_json(silent=True) or {}
        cleaned = _validate_task_payload(data, require_all=True)

        # Validate parent_id belongs to the same project
        pid = cleaned.get("parent_id")
        if pid is not None:
            parent_row = conn.execute(
                "SELECT id, project_id FROM tasks WHERE id = ?", (pid,)
            ).fetchone()
            if parent_row is None:
                abort(400, f"Parent task {pid} does not exist.")
            if parent_row["project_id"] != project_id:
                abort(400, "Parent task must belong to the same project.")

        # Compute duration_days from dates if not provided
        if "duration_days" not in cleaned and cleaned.get("start_date") and cleaned.get("end_date"):
            from datetime import date
            try:
                start = date.fromisoformat(cleaned["start_date"])
                end = date.fromisoformat(cleaned["end_date"])
                cleaned["duration_days"] = max(0, (end - start).days + 1)
            except ValueError:
                pass

        # Default sort_order = max + 1
        if "sort_order" not in cleaned:
            row = conn.execute(
                "SELECT MAX(sort_order) FROM tasks WHERE project_id = ?", (project_id,)
            ).fetchone()
            cleaned["sort_order"] = (row[0] or 0) + 1

        cursor = conn.execute(
            """INSERT INTO tasks
               (project_id, name, type, status, start_date, end_date, duration_days,
                is_firm_date, actual_start_date, actual_end_date, notes, sort_order,
                parent_id, wbs_number, progress, budget, rag, pending_until,
                estimated_hours, logged_hours)
               VALUES
               (:project_id, :name, :type, :status, :start_date, :end_date, :duration_days,
                :is_firm_date, :actual_start_date, :actual_end_date, :notes, :sort_order,
                :parent_id, :wbs_number, :progress, :budget, :rag, :pending_until,
                :estimated_hours, :logged_hours)""",
            {
                "project_id": project_id,
                "name": cleaned["name"],
                "type": cleaned.get("type", "task"),
                "status": cleaned.get("status", "not-started"),
                "start_date": cleaned.get("start_date"),
                "end_date": cleaned.get("end_date"),
                "duration_days": cleaned.get("duration_days"),
                "is_firm_date": cleaned.get("is_firm_date", 0),
                "actual_start_date": cleaned.get("actual_start_date"),
                "actual_end_date": cleaned.get("actual_end_date"),
                "notes": cleaned.get("notes"),
                "sort_order": cleaned["sort_order"],
                "parent_id": cleaned.get("parent_id"),
                "wbs_number": cleaned.get("wbs_number"),
                "progress": cleaned.get("progress", 0.0),
                "budget": cleaned.get("budget"),
                "rag": cleaned.get("rag"),
                "pending_until": cleaned.get("pending_until"),
                "estimated_hours": cleaned.get("estimated_hours"),
                "logged_hours": cleaned.get("logged_hours"),
            }
        )
        conn.commit()
        new_id = cursor.lastrowid

        task_row = _fetch_task_row(conn, new_id)
        return jsonify(_build_task_detail(conn, task_row)), 201
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>", methods=["GET"])
def get_task(task_id: int):
    """Return the full detail for a single task."""
    conn = get_connection()
    try:
        task_row = _fetch_task_row(conn, task_id)
        return jsonify(_build_task_detail(conn, task_row))
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>", methods=["PUT"])
def update_task(task_id: int):
    """Update one or more fields of a task. Returns the updated task."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_task_payload(data, require_all=False)

    if not cleaned:
        abort(400, "No valid fields provided for update.")

    conn = get_connection()
    try:
        task_row = _fetch_task_row(conn, task_id)  # 404 guard
        existing = row_to_dict(task_row)

        # Validate parent_id update
        if "parent_id" in cleaned:
            new_pid = cleaned["parent_id"]
            if new_pid is not None:
                # Must not be the task itself
                if new_pid == task_id:
                    abort(400, "A task cannot be its own parent.")
                # Must exist in the same project
                parent_row = conn.execute(
                    "SELECT id, project_id FROM tasks WHERE id = ?", (new_pid,)
                ).fetchone()
                if parent_row is None:
                    abort(400, f"Parent task {new_pid} does not exist.")
                if parent_row["project_id"] != existing["project_id"]:
                    abort(400, "Parent task must belong to the same project.")
                # Circular reference check
                _check_circular_parent(conn, task_id, new_pid)

        # Recompute duration if dates changed
        start = cleaned.get("start_date", existing.get("start_date"))
        end = cleaned.get("end_date", existing.get("end_date"))
        if "duration_days" not in cleaned and start and end:
            from datetime import date
            try:
                d_start = date.fromisoformat(start)
                d_end = date.fromisoformat(end)
                cleaned["duration_days"] = max(0, (d_end - d_start).days + 1)
            except ValueError:
                pass

        # Set completed_at when marking complete
        if cleaned.get("status") == "complete":
            if existing.get("status") != "complete":
                from datetime import datetime
                cleaned["completed_at"] = datetime.utcnow().isoformat()
        elif "status" in cleaned and cleaned["status"] != "complete":
            cleaned["completed_at"] = None

        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = task_id
        conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = :_id", cleaned)
        conn.commit()

        task_row = _fetch_task_row(conn, task_id)
        return jsonify(_build_task_detail(conn, task_row))
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>", methods=["DELETE"])
def delete_task(task_id: int):
    """
    Delete a task.

    If the task has children and neither ?cascade=true nor ?reassign_to=N is
    provided, returns 409 with {"has_children": true, "children": [...]}.

    Query params:
        cascade=true        — delete the task and all its children
        reassign_to=N       — move children to group task N first (N=0 → top-level)
    """
    conn = get_connection()
    try:
        _fetch_task_row(conn, task_id)  # 404 guard

        # Check for children
        child_rows = conn.execute(
            "SELECT id, name, wbs_number, type FROM tasks WHERE parent_id = ?",
            (task_id,)
        ).fetchall()
        children = rows_to_list(child_rows)

        cascade = request.args.get("cascade", "").lower() == "true"
        reassign_to_raw = request.args.get("reassign_to")

        if children and not cascade and reassign_to_raw is None:
            # Caller must decide what to do with children
            return jsonify({
                "has_children": True,
                "children": children,
            }), 409

        if children and reassign_to_raw is not None:
            # Reassign children to another group (or promote to top-level)
            try:
                reassign_to = int(reassign_to_raw)
            except (TypeError, ValueError):
                abort(400, "reassign_to must be an integer task ID (or 0 for top-level).")

            new_parent = None if reassign_to == 0 else reassign_to

            if new_parent is not None:
                # Verify the target group exists and is in the same project
                target = conn.execute(
                    "SELECT id, project_id FROM tasks WHERE id = ?", (new_parent,)
                ).fetchone()
                if target is None:
                    abort(400, f"Reassign target task {new_parent} does not exist.")
                original = conn.execute(
                    "SELECT project_id FROM tasks WHERE id = ?", (task_id,)
                ).fetchone()
                if target["project_id"] != original["project_id"]:
                    abort(400, "Reassign target must be in the same project.")

            conn.execute(
                "UPDATE tasks SET parent_id = ? WHERE parent_id = ?",
                (new_parent, task_id)
            )

        # Delete the task (cascade FK deletes dependencies, task_people, task_items)
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/tasks/<int:task_id>/status", methods=["PUT"])
def update_task_status(task_id: int):
    """
    Quick-update a task's status only.
    Body: {"status": "in-progress"}
    Returns the updated task.
    """
    data = request.get_json(silent=True) or {}
    status = data.get("status")
    if not status:
        abort(400, "Field 'status' is required.")
    if status not in STATUSES:
        abort(400, f"Invalid status '{status}'. Must be one of: {', '.join(sorted(STATUSES))}.")

    conn = get_connection()
    try:
        task_row = _fetch_task_row(conn, task_id)
        existing = row_to_dict(task_row)

        update_data = {"status": status, "_id": task_id}

        if status == "complete" and existing.get("status") != "complete":
            from datetime import datetime
            update_data["completed_at"] = datetime.utcnow().isoformat()
            conn.execute(
                "UPDATE tasks SET status = :status, completed_at = :completed_at WHERE id = :_id",
                update_data
            )
        elif status != "complete":
            update_data["completed_at"] = None
            conn.execute(
                "UPDATE tasks SET status = :status, completed_at = :completed_at WHERE id = :_id",
                update_data
            )
        else:
            conn.execute("UPDATE tasks SET status = :status WHERE id = :_id", update_data)

        conn.commit()
        task_row = _fetch_task_row(conn, task_id)
        return jsonify(_build_task_detail(conn, task_row))
    finally:
        conn.close()


@bp.route("/tasks/overdue-pending", methods=["GET"])
def get_overdue_pending_tasks():
    """
    Return all tasks that are pending and past their expected date.
    Used by the launch notification to show a "Chase Required" alert on startup.
    Returns: [{id, name, project_id, project_name, pending_until}]
    """
    from datetime import date
    today = date.today().isoformat()
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT t.id, t.name, t.project_id, t.pending_until, p.name AS project_name
            FROM tasks t
            JOIN projects p ON p.id = t.project_id
            WHERE t.status = 'pending'
              AND t.pending_until IS NOT NULL
              AND t.pending_until < ?
            ORDER BY t.pending_until ASC
        """, (today,)).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@bp.route("/tasks/reorder", methods=["PUT"])
def reorder_tasks():
    """
    Batch-update sort_order for multiple tasks.
    Body: [{"id": 1, "sort_order": 0}, ...]
    """
    data = request.get_json(silent=True)
    if not isinstance(data, list):
        abort(400, "Expected a JSON array of {id, sort_order} objects.")

    conn = get_connection()
    try:
        for item in data:
            if not isinstance(item, dict) or "id" not in item or "sort_order" not in item:
                abort(400, "Each item must have 'id' and 'sort_order' fields.")
            try:
                conn.execute(
                    "UPDATE tasks SET sort_order = ? WHERE id = ?",
                    (int(item["sort_order"]), int(item["id"]))
                )
            except (TypeError, ValueError):
                abort(400, "id and sort_order must be integers.")
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()
