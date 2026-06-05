"""
routes/templates.py — REST endpoints for task templates.

A template is a date-agnostic snapshot of any task and its children.
When applied, the user supplies a start date and all task dates are
computed from that anchor using stored day offsets.

Endpoints:
    GET    /api/templates              List all templates
    POST   /api/templates              Save a task (+ children) as a new template
    GET    /api/templates/<id>         Get template detail with tasks
    DELETE /api/templates/<id>         Delete a template
    POST   /api/templates/<id>/apply   Apply template to a project
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import row_to_dict, rows_to_list

bp = Blueprint("templates", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route("/templates", methods=["GET"])
def list_templates():
    """Return all templates (summary — no task detail)."""
    conn = get_connection()
    try:
        rows = conn.execute("""
            SELECT t.*,
                   COUNT(tt.id) AS task_count
            FROM templates t
            LEFT JOIN template_tasks tt ON tt.template_id = t.id
            GROUP BY t.id
            ORDER BY t.name ASC
        """).fetchall()
        return jsonify(rows_to_list(rows))
    finally:
        conn.close()


@bp.route("/templates", methods=["POST"])
def save_template():
    """
    Save any task (and its children, if any) as a new template.
    Body: { "group_task_id": <int>, "name": <str>, "description": <str|null> }
    (The field is named group_task_id for backwards compatibility but accepts any task type.)
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        abort(400, "Template name is required.")
    if len(name) > 200:
        abort(400, "Template name must be 200 characters or fewer.")

    group_task_id = data.get("group_task_id")
    if not group_task_id:
        abort(400, "group_task_id is required.")
    try:
        group_task_id = int(group_task_id)
    except (TypeError, ValueError):
        abort(400, "group_task_id must be an integer.")

    description = (data.get("description") or "").strip() or None

    conn = get_connection()
    try:
        # Load the root task (any type)
        group_row = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (group_task_id,)
        ).fetchone()
        if group_row is None:
            abort(404, f"Task {group_task_id} not found.")
        group = row_to_dict(group_row)

        # Load all children (depth-first, all descendants)
        def _load_children(parent_id):
            rows = conn.execute(
                "SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
                (parent_id,)
            ).fetchall()
            result = []
            for r in rows:
                d = row_to_dict(r)
                d["_children"] = _load_children(d["id"])
                result.append(d)
            return result

        children_tree = _load_children(group_task_id)

        # Find the earliest start date across the group and all descendants
        all_tasks_flat = [group]
        def _flatten(tasks):
            for t in tasks:
                all_tasks_flat.append(t)
                _flatten(t.get("_children", []))
        _flatten(children_tree)

        from datetime import date
        start_dates = [
            date.fromisoformat(t["start_date"])
            for t in all_tasks_flat
            if t.get("start_date")
        ]
        anchor = min(start_dates) if start_dates else date.today()

        # Check for name uniqueness
        existing = conn.execute(
            "SELECT id FROM templates WHERE name = ?", (name,)
        ).fetchone()
        if existing:
            abort(409, f"A template named \"{name}\" already exists.")

        # Insert template header
        cursor = conn.execute(
            "INSERT INTO templates (name, description) VALUES (?, ?)",
            (name, description)
        )
        # NOTE: do NOT commit here — the header and all task rows must be
        # committed atomically so a mid-insert failure can't leave a
        # zero-task template in the list.
        template_id = cursor.lastrowid

        # Insert template tasks — walk the tree, assigning a local index as
        # parent_ref so we can reconstruct hierarchy on apply.
        _task_index = [0]          # mutable counter
        _index_map  = {}           # original task id → local index

        def _insert_tasks(tasks, parent_ref=None):
            for t in tasks:
                local_idx = _task_index[0]
                _task_index[0] += 1
                _index_map[t["id"]] = local_idx

                s_off = e_off = 0
                if t.get("start_date"):
                    try:
                        s_off = (date.fromisoformat(t["start_date"]) - anchor).days
                    except ValueError:
                        pass
                if t.get("end_date"):
                    try:
                        e_off = (date.fromisoformat(t["end_date"]) - anchor).days
                    except ValueError:
                        pass

                conn.execute(
                    """INSERT INTO template_tasks
                       (template_id, name, type, wbs_number, notes,
                        duration_days, start_offset, end_offset,
                        parent_ref, sort_order)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        template_id,
                        t["name"],
                        t["type"],
                        t.get("wbs_number"),
                        t.get("notes"),
                        t.get("duration_days"),
                        s_off,
                        e_off,
                        parent_ref,
                        local_idx,   # sequential index — guarantees correct load order on apply
                    )
                )
                _insert_tasks(t.get("_children", []), parent_ref=local_idx)

        # Group task itself gets index 0, parent_ref = None
        g_idx = _task_index[0]
        _task_index[0] += 1
        _index_map[group["id"]] = g_idx
        g_s_off = (date.fromisoformat(group["start_date"]) - anchor).days if group.get("start_date") else 0
        g_e_off = (date.fromisoformat(group["end_date"]) - anchor).days   if group.get("end_date")   else 0
        conn.execute(
            """INSERT INTO template_tasks
               (template_id, name, type, wbs_number, notes,
                duration_days, start_offset, end_offset,
                parent_ref, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                template_id, group["name"], group["type"],
                group.get("wbs_number"), group.get("notes"),
                group.get("duration_days"), g_s_off, g_e_off,
                None, g_idx,   # always 0 — group must sort first on apply
            )
        )
        _insert_tasks(children_tree, parent_ref=g_idx)
        conn.commit()

        return jsonify({
            "id": template_id,
            "name": name,
            "description": description,
            "task_count": _task_index[0],
        }), 201
    finally:
        conn.close()


@bp.route("/templates/<int:template_id>", methods=["GET"])
def get_template(template_id: int):
    """Return a template with its full task list."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM templates WHERE id = ?", (template_id,)
        ).fetchone()
        if row is None:
            abort(404, f"Template {template_id} not found.")
        t = row_to_dict(row)
        task_rows = conn.execute(
            "SELECT * FROM template_tasks WHERE template_id = ? ORDER BY sort_order ASC, id ASC",
            (template_id,)
        ).fetchall()
        t["tasks"] = rows_to_list(task_rows)
        return jsonify(t)
    finally:
        conn.close()


@bp.route("/templates/<int:template_id>", methods=["DELETE"])
def delete_template(template_id: int):
    """Delete a template (cascades to template_tasks)."""
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM templates WHERE id = ?", (template_id,)
        ).fetchone()
        if row is None:
            abort(404, f"Template {template_id} not found.")
        conn.execute("DELETE FROM templates WHERE id = ?", (template_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/templates/<int:template_id>/apply", methods=["POST"])
def apply_template(template_id: int):
    """
    Apply a template to a project.
    Body: { "project_id": <int>, "start_date": "YYYY-MM-DD" }
    Creates the group task + all children with dates offset from start_date.
    Returns the created group task id.
    """
    data = request.get_json(silent=True) or {}
    project_id = data.get("project_id")
    start_date_str = data.get("start_date")

    if not project_id:
        abort(400, "project_id is required.")
    try:
        project_id = int(project_id)
    except (TypeError, ValueError):
        abort(400, "project_id must be an integer.")

    if not start_date_str:
        abort(400, "start_date is required (YYYY-MM-DD).")

    from datetime import date, timedelta
    try:
        anchor = date.fromisoformat(start_date_str)
    except ValueError:
        abort(400, "start_date must be in YYYY-MM-DD format.")

    conn = get_connection()
    try:
        # Verify project exists
        proj = conn.execute(
            "SELECT id FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if proj is None:
            abort(404, f"Project {project_id} not found.")

        # Load template
        tmpl_row = conn.execute(
            "SELECT * FROM templates WHERE id = ?", (template_id,)
        ).fetchone()
        if tmpl_row is None:
            abort(404, f"Template {template_id} not found.")

        task_rows = conn.execute(
            """SELECT * FROM template_tasks WHERE template_id = ?
               ORDER BY sort_order ASC, id ASC""",
            (template_id,)
        ).fetchall()
        template_tasks = rows_to_list(task_rows)

        if not template_tasks:
            abort(400, "Template has no tasks.")

        # Determine max sort_order in the project
        max_sort = conn.execute(
            "SELECT COALESCE(MAX(sort_order), 0) FROM tasks WHERE project_id = ?",
            (project_id,)
        ).fetchone()[0]

        # Maps local parent_ref → newly created task id
        ref_to_id = {}

        def _date_str(offset):
            return (anchor + timedelta(days=offset)).isoformat()

        # Insert tasks in order; parent_ref is the local index of the parent
        # template task — which was inserted before children (tree order guaranteed
        # by the save logic above).
        for i, tt in enumerate(template_tasks):
            parent_ref = tt.get("parent_ref")
            db_parent_id = ref_to_id.get(parent_ref) if parent_ref is not None else None

            s = _date_str(tt.get("start_offset", 0))
            e = _date_str(tt.get("end_offset",   0))
            dur = tt.get("duration_days")
            if dur is None and s and e:
                try:
                    dur = max(0, (date.fromisoformat(e) - date.fromisoformat(s)).days + 1)
                except ValueError:
                    dur = None

            cursor = conn.execute(
                """INSERT INTO tasks
                   (project_id, name, type, wbs_number, notes,
                    start_date, end_date, duration_days,
                    status, sort_order, parent_id, progress)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'not-started', ?, ?, 0.0)""",
                (
                    project_id,
                    tt["name"],
                    tt.get("type", "task"),
                    tt.get("wbs_number"),
                    tt.get("notes"),
                    s,
                    e,
                    dur,
                    max_sort + i + 1,
                    db_parent_id,
                )
            )
            ref_to_id[i] = cursor.lastrowid

        conn.commit()

        # Return the root task id (first inserted = the group task, parent_ref=None)
        root_id = ref_to_id.get(0)
        return jsonify({"root_task_id": root_id, "tasks_created": len(template_tasks)}), 201
    finally:
        conn.close()
