"""
routes/projects.py — REST endpoints for project management.

Endpoints:
    GET    /api/projects            List all projects with task counts
    POST   /api/projects            Create a new project
    GET    /api/projects/<id>       Get project detail with full task list
    PUT    /api/projects/<id>       Update project fields
    DELETE /api/projects/<id>       Delete project (cascades to tasks)
    PUT    /api/projects/reorder    Batch-update sort_order values
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection
from app.models import STATUSES, rows_to_list, row_to_dict

bp = Blueprint("projects", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------

VALID_CATEGORIES = {"Engineering", "Publishing", "Music", "Jobs", "General"}


def _validate_project_payload(data: dict, require_all: bool = True) -> dict:
    """
    Validate and sanitise a project creation or update payload.
    Returns a dict of clean fields.
    Raises a 400 abort with a descriptive message on any violation.
    """
    cleaned = {}

    name = data.get("name", "").strip()
    if require_all or "name" in data:
        if not name:
            abort(400, "Project name is required and cannot be blank.")
        if len(name) > 200:
            abort(400, "Project name must be 200 characters or fewer.")
        cleaned["name"] = name

    if "category" in data:
        category = data["category"].strip()
        # Accept any non-empty string — categories are user-defined
        if not category:
            abort(400, "Category cannot be blank.")
        cleaned["category"] = category

    if "status" in data:
        status = data["status"]
        if status not in STATUSES:
            abort(400, f"Invalid status '{status}'. Must be one of: {', '.join(sorted(STATUSES))}.")
        cleaned["status"] = status

    if "description" in data:
        cleaned["description"] = data["description"] or None

    if "colour" in data:
        colour = data["colour"].strip()
        if colour and not colour.startswith("#"):
            abort(400, "Colour must be a hex colour string starting with '#'.")
        cleaned["colour"] = colour or "#4a90e2"

    if "sort_order" in data:
        try:
            cleaned["sort_order"] = int(data["sort_order"])
        except (TypeError, ValueError):
            abort(400, "sort_order must be an integer.")

    return cleaned


def _fetch_project_row(conn, project_id: int):
    """
    Fetch a single project row by ID. Aborts with 404 if not found.
    """
    row = conn.execute(
        "SELECT * FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    if row is None:
        abort(404, f"Project {project_id} not found.")
    return row


def _project_summary(row) -> dict:
    """
    Build a project summary dict that includes computed task counts
    and completion percentage. Expects row to already contain these
    fields from the summary query.
    """
    d = row_to_dict(row)
    total = d.get("task_count", 0) or 0
    complete = d.get("completed_task_count", 0) or 0
    d["completion_pct"] = round((complete / total * 100) if total > 0 else 0)
    return d


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@bp.route("/projects", methods=["GET"])
def list_projects():
    """Return projects ordered by sort_order.
    By default only active (non-archived) projects are returned.
    Pass ?include_archived=1 to include archived projects too.
    """
    include_archived = request.args.get("include_archived", "0") == "1"
    archived_filter = "" if include_archived else "WHERE p.archived = 0"

    conn = get_connection()
    try:
        rows = conn.execute(f"""
            SELECT
                p.*,
                COUNT(t.id)                                    AS task_count,
                SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS completed_task_count,
                SUM(CASE WHEN t.end_date < date('now') AND t.status != 'complete' THEN 1 ELSE 0 END) AS overdue_count,
                COALESCE(SUM(t.budget), 0)                    AS total_budget,
                COALESCE((SELECT SUM(ti.value) FROM task_items ti
                          JOIN tasks t2 ON t2.id = ti.task_id
                          WHERE t2.project_id = p.id AND ti.value IS NOT NULL), 0) AS total_spend,
                (SELECT COUNT(*) FROM project_links pl WHERE pl.project_id = p.id) AS link_count
            FROM projects p
            LEFT JOIN tasks t ON t.project_id = p.id
            {archived_filter}
            GROUP BY p.id
            ORDER BY p.sort_order ASC, p.name ASC
        """).fetchall()

        projects = []
        for row in rows:
            d = row_to_dict(row)
            total = d.get("task_count", 0) or 0
            complete = d.get("completed_task_count", 0) or 0
            d["completion_pct"] = round((complete / total * 100) if total > 0 else 0)
            projects.append(d)

        return jsonify(projects)
    finally:
        conn.close()


@bp.route("/projects", methods=["POST"])
def create_project():
    """Create a new project. Returns the created project object."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_project_payload(data, require_all=True)

    conn = get_connection()
    try:
        # Assign sort_order = current max + 1 if not specified
        if "sort_order" not in cleaned:
            row = conn.execute("SELECT MAX(sort_order) FROM projects").fetchone()
            cleaned["sort_order"] = (row[0] or 0) + 1

        cursor = conn.execute(
            """INSERT INTO projects (name, category, status, description, colour, sort_order)
               VALUES (:name, :category, :status, :description, :colour, :sort_order)""",
            {
                "name": cleaned["name"],
                "category": cleaned.get("category", "General"),
                "status": cleaned.get("status", "not-started"),
                "description": cleaned.get("description"),
                "colour": cleaned.get("colour", "#4a90e2"),
                "sort_order": cleaned["sort_order"],
            }
        )
        conn.commit()
        new_id = cursor.lastrowid

        row = conn.execute(
            """SELECT p.*,
                      0 AS task_count,
                      0 AS completed_task_count,
                      0 AS overdue_count
               FROM projects p WHERE p.id = ?""",
            (new_id,)
        ).fetchone()

        d = row_to_dict(row)
        d["completion_pct"] = 0
        return jsonify(d), 201
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>", methods=["GET"])
def get_project(project_id: int):
    """Return a project with its full task list including assignees."""
    conn = get_connection()
    try:
        project_row = conn.execute(
            """SELECT p.*,
                      COUNT(t.id) AS task_count,
                      SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS completed_task_count,
                      SUM(CASE WHEN t.end_date < date('now') AND t.status != 'complete' THEN 1 ELSE 0 END) AS overdue_count,
                      COALESCE(SUM(t.budget), 0) AS total_budget,
                      COALESCE((SELECT SUM(ti.value) FROM task_items ti
                                JOIN tasks t2 ON t2.id = ti.task_id
                                WHERE t2.project_id = p.id AND ti.value IS NOT NULL), 0) AS total_spend,
                      (SELECT COUNT(*) FROM project_links pl WHERE pl.project_id = p.id) AS link_count
               FROM projects p
               LEFT JOIN tasks t ON t.project_id = p.id
               WHERE p.id = ?
               GROUP BY p.id""",
            (project_id,)
        ).fetchone()

        if project_row is None:
            abort(404, f"Project {project_id} not found.")

        project = row_to_dict(project_row)
        total = project.get("task_count", 0) or 0
        complete = project.get("completed_task_count", 0) or 0
        project["completion_pct"] = round((complete / total * 100) if total > 0 else 0)

        # Fetch tasks for this project
        task_rows = conn.execute(
            """SELECT t.*,
                      (SELECT COUNT(*) FROM dependencies d
                       WHERE d.predecessor_id = t.id OR d.successor_id = t.id) AS dependency_count,
                      (SELECT COUNT(*) FROM task_items i WHERE i.task_id = t.id) AS item_count
               FROM tasks t
               WHERE t.project_id = ?
               ORDER BY t.sort_order ASC, t.id ASC""",
            (project_id,)
        ).fetchall()

        tasks = []
        for tr in task_rows:
            task = row_to_dict(tr)
            task["is_firm_date"] = bool(task.get("is_firm_date"))

            # Fetch assignees for this task
            assignee_rows = conn.execute(
                """SELECT p.id, p.name, p.colour
                   FROM people p
                   JOIN task_people tp ON tp.person_id = p.id
                   WHERE tp.task_id = ?""",
                (task["id"],)
            ).fetchall()
            task["assignees"] = rows_to_list(assignee_rows)

            tasks.append(task)

        project["tasks"] = tasks
        return jsonify(project)
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>", methods=["PUT"])
def update_project(project_id: int):
    """Update one or more fields of an existing project. Returns the updated project."""
    data = request.get_json(silent=True) or {}
    cleaned = _validate_project_payload(data, require_all=False)

    if not cleaned:
        abort(400, "No valid fields provided for update.")

    conn = get_connection()
    try:
        _fetch_project_row(conn, project_id)  # 404 guard

        set_clause = ", ".join(f"{k} = :{k}" for k in cleaned)
        cleaned["_id"] = project_id
        conn.execute(
            f"UPDATE projects SET {set_clause} WHERE id = :_id",
            cleaned
        )
        conn.commit()

        # Return the updated project with counts
        row = conn.execute(
            """SELECT p.*,
                      COUNT(t.id) AS task_count,
                      SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) AS completed_task_count,
                      SUM(CASE WHEN t.end_date < date('now') AND t.status != 'complete' THEN 1 ELSE 0 END) AS overdue_count,
                      COALESCE(SUM(t.budget), 0) AS total_budget,
                      COALESCE((SELECT SUM(ti.value) FROM task_items ti
                                JOIN tasks t2 ON t2.id = ti.task_id
                                WHERE t2.project_id = p.id AND ti.value IS NOT NULL), 0) AS total_spend
               FROM projects p
               LEFT JOIN tasks t ON t.project_id = p.id
               WHERE p.id = ?
               GROUP BY p.id""",
            (project_id,)
        ).fetchone()

        d = row_to_dict(row)
        total = d.get("task_count", 0) or 0
        complete = d.get("completed_task_count", 0) or 0
        d["completion_pct"] = round((complete / total * 100) if total > 0 else 0)
        return jsonify(d)
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>", methods=["DELETE"])
def delete_project(project_id: int):
    """Delete a project and all its tasks (cascade). Returns 204 No Content."""
    conn = get_connection()
    try:
        _fetch_project_row(conn, project_id)  # 404 guard
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
        return "", 204
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/expenses", methods=["GET"])
def get_project_expenses(project_id: int):
    """
    Return all expense/component items (those with a cash value) for a project,
    grouped by task, plus overall and per-task budget vs spend figures.

    Returns:
        project_id, project_name, currency_symbol
        total_budget  — sum of task budgets
        total_spend   — sum of all valued item values
        tasks[]       — only tasks that have at least one valued item:
            task_id, task_name, wbs_number, budget, task_spend, items[]
                item: id, content, item_type, value
    """
    conn = get_connection()
    try:
        proj_row = conn.execute(
            "SELECT id, name FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if proj_row is None:
            abort(404, f"Project {project_id} not found.")

        # Fetch currency symbol from settings
        sym_row = conn.execute(
            "SELECT value FROM settings WHERE key = 'currency_symbol'"
        ).fetchone()
        currency_symbol = sym_row["value"] if sym_row else "£"

        # All valued items for this project, joined with their tasks
        rows = conn.execute(
            """SELECT ti.id, ti.content, ti.item_type, ti.value,
                      t.id AS task_id, t.name AS task_name,
                      t.wbs_number, t.budget
               FROM task_items ti
               JOIN tasks t ON t.id = ti.task_id
               WHERE t.project_id = ?
                 AND ti.value IS NOT NULL
                 AND ti.value > 0
               ORDER BY t.sort_order ASC, t.id ASC, ti.sort_order ASC, ti.id ASC""",
            (project_id,)
        ).fetchall()

        # Group by task
        task_map = {}   # task_id → dict
        for row in rows:
            tid = row["task_id"]
            if tid not in task_map:
                task_map[tid] = {
                    "task_id":    tid,
                    "task_name":  row["task_name"],
                    "wbs_number": row["wbs_number"],
                    "budget":     float(row["budget"]) if row["budget"] is not None else None,
                    "task_spend": 0.0,
                    "items":      [],
                }
            val = float(row["value"])
            task_map[tid]["task_spend"] += val
            task_map[tid]["items"].append({
                "id":        row["id"],
                "content":   row["content"],
                "item_type": row["item_type"],
                "value":     val,
            })

        tasks = list(task_map.values())
        total_spend  = round(sum(t["task_spend"] for t in tasks), 2)

        # Total budget = all tasks in the project with a budget, not just those with items
        budget_row = conn.execute(
            "SELECT COALESCE(SUM(budget), 0) FROM tasks WHERE project_id = ?",
            (project_id,)
        ).fetchone()
        total_budget = round(float(budget_row[0] or 0), 2)

        # Round task spend
        for t in tasks:
            t["task_spend"] = round(t["task_spend"], 2)

        # Effort totals across all tasks in the project
        effort_row = conn.execute(
            """SELECT COALESCE(SUM(estimated_hours), 0) AS total_est,
                      COALESCE(SUM(logged_hours),    0) AS total_logged
               FROM tasks WHERE project_id = ?""",
            (project_id,)
        ).fetchone()

        return jsonify({
            "project_id":       project_id,
            "project_name":     proj_row["name"],
            "currency_symbol":  currency_symbol,
            "total_budget":     total_budget,
            "total_spend":      total_spend,
            "total_est_hours":  round(float(effort_row["total_est"] or 0), 1),
            "total_log_hours":  round(float(effort_row["total_logged"] or 0), 1),
            "tasks":            tasks,
        })
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/earned-value", methods=["GET"])
def get_earned_value(project_id: int):
    """
    Compute Earned Value Management metrics for a project.

    Returns:
        pv      — Planned Value  (budget × fraction of planned duration elapsed)
        ev      — Earned Value   (budget × progress)
        ac      — Actual Cost    (sum of item values)
        sv      — Schedule Variance (EV - PV)
        cv      — Cost Variance  (EV - AC)
        cpi     — Cost Performance Index (EV / AC), null if AC = 0
        spi     — Schedule Performance Index (EV / PV), null if PV = 0
        bac     — Budget at Completion (total task budgets)
        budgeted_tasks — number of tasks with a budget set
    """
    conn = get_connection()
    try:
        proj = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if proj is None:
            abort(404, f"Project {project_id} not found.")

        from datetime import date
        today = date.today()

        task_rows = conn.execute(
            """SELECT t.budget, t.progress, t.start_date, t.end_date,
                      COALESCE((SELECT SUM(ti.value) FROM task_items ti
                                WHERE ti.task_id = t.id AND ti.value IS NOT NULL), 0) AS actual_spend
               FROM tasks t
               WHERE t.project_id = ? AND t.budget IS NOT NULL AND t.budget > 0""",
            (project_id,)
        ).fetchall()

        bac  = 0.0
        pv   = 0.0
        ev   = 0.0
        ac   = 0.0

        for row in task_rows:
            budget   = float(row["budget"])
            progress = float(row["progress"] or 0.0)
            spend    = float(row["actual_spend"] or 0.0)
            bac += budget
            ev  += budget * progress
            ac  += spend

            # PV: fraction of planned duration elapsed as of today
            if row["start_date"] and row["end_date"]:
                try:
                    s = date.fromisoformat(row["start_date"])
                    e = date.fromisoformat(row["end_date"])
                    total_days = max(1, (e - s).days + 1)
                    elapsed    = max(0, (today - s).days + 1)
                    frac       = min(1.0, elapsed / total_days)
                    pv += budget * frac
                except ValueError:
                    pv += 0.0
            # Tasks with no dates contribute 0 to PV

        sv  = ev - pv
        cv  = ev - ac
        cpi = round(ev / ac,  4) if ac  > 0 else None
        spi = round(ev / pv,  4) if pv  > 0 else None

        return jsonify({
            "bac":             round(bac,  2),
            "pv":              round(pv,   2),
            "ev":              round(ev,   2),
            "ac":              round(ac,   2),
            "sv":              round(sv,   2),
            "cv":              round(cv,   2),
            "cpi":             cpi,
            "spi":             spi,
            "budgeted_tasks":  len(task_rows),
        })
    finally:
        conn.close()


@bp.route("/projects/reorder", methods=["PUT"])
def reorder_projects():
    """
    Batch-update sort_order for multiple projects.
    Body: [{"id": 1, "sort_order": 0}, ...]
    Returns 200 with the updated list.
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
                    "UPDATE projects SET sort_order = ? WHERE id = ?",
                    (int(item["sort_order"]), int(item["id"]))
                )
            except (TypeError, ValueError):
                abort(400, "id and sort_order must be integers.")
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@bp.route("/projects/<int:project_id>/archive", methods=["PUT"])
def archive_project(project_id: int):
    """
    Archive or unarchive a project.
    Body: {"archived": true|false}
    Returns the updated project summary.
    """
    data = request.get_json(silent=True) or {}
    archived = 1 if data.get("archived") else 0

    conn = get_connection()
    try:
        result = conn.execute(
            "UPDATE projects SET archived = ? WHERE id = ?",
            (archived, project_id)
        )
        if result.rowcount == 0:
            abort(404, f"Project {project_id} not found.")
        conn.commit()
        return jsonify({"ok": True, "archived": bool(archived)})
    finally:
        conn.close()
