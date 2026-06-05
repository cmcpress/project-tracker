"""
app/routes/baselines.py — Baseline snapshot endpoints.

A baseline is a named point-in-time snapshot of all task dates for a project.
Saving a baseline:
  - Creates a `baselines` row
  - Copies every task's start/end dates into `baseline_tasks`
  - Writes those dates to tasks.baseline_start_date / baseline_end_date so the
    grey comparison bar appears in the Gantt immediately

Restoring a baseline:
  - Copies baseline_tasks dates back to tasks.start_date / end_date
  - Also refreshes baseline_start_date / baseline_end_date to match

Endpoints
---------
GET    /api/projects/<project_id>/baselines
POST   /api/projects/<project_id>/baselines              body: {name, notes?}
GET    /api/baselines/<id>
DELETE /api/baselines/<id>
POST   /api/projects/<project_id>/baselines/<baseline_id>/restore
"""

from flask import Blueprint, jsonify, request, abort
from app.database import get_connection

bp = Blueprint("baselines", __name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _baseline_row(row) -> dict:
    return {
        "id":         row["id"],
        "project_id": row["project_id"],
        "name":       row["name"],
        "saved_at":   row["saved_at"],
        "notes":      row["notes"],
    }


# ---------------------------------------------------------------------------
# List baselines for a project
# ---------------------------------------------------------------------------

@bp.route("/api/projects/<int:project_id>/baselines", methods=["GET"])
def list_baselines(project_id: int):
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM baselines WHERE project_id = ? ORDER BY saved_at DESC",
            (project_id,)
        ).fetchall()
        return jsonify([_baseline_row(r) for r in rows])
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Save a new baseline
# ---------------------------------------------------------------------------

@bp.route("/api/projects/<int:project_id>/baselines", methods=["POST"])
def create_baseline(project_id: int):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    notes = (data.get("notes") or "").strip() or None

    if not name:
        abort(400, "name is required")

    conn = get_connection()
    try:
        # Check project exists
        proj = conn.execute(
            "SELECT id FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if not proj:
            abort(404, "Project not found")

        # Create the baseline record
        cur = conn.execute(
            "INSERT INTO baselines (project_id, name, notes) VALUES (?, ?, ?)",
            (project_id, name, notes)
        )
        baseline_id = cur.lastrowid

        # Snapshot current task dates into baseline_tasks
        tasks = conn.execute(
            "SELECT id, start_date, end_date, duration_days FROM tasks WHERE project_id = ?",
            (project_id,)
        ).fetchall()

        conn.executemany(
            """INSERT OR REPLACE INTO baseline_tasks
                   (baseline_id, task_id, start_date, end_date, duration_days)
               VALUES (?, ?, ?, ?, ?)""",
            [
                (baseline_id, t["id"], t["start_date"], t["end_date"], t["duration_days"])
                for t in tasks
            ]
        )

        # Also stamp baseline_start_date / baseline_end_date on every task
        # so the grey comparison bar shows in the Gantt immediately
        conn.executemany(
            """UPDATE tasks
                  SET baseline_start_date = ?,
                      baseline_end_date   = ?
                WHERE id = ?""",
            [
                (t["start_date"], t["end_date"], t["id"])
                for t in tasks
            ]
        )

        conn.commit()

        row = conn.execute(
            "SELECT * FROM baselines WHERE id = ?", (baseline_id,)
        ).fetchone()
        return jsonify(_baseline_row(row)), 201
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Get a single baseline (with its task snapshots)
# ---------------------------------------------------------------------------

@bp.route("/api/baselines/<int:baseline_id>", methods=["GET"])
def get_baseline(baseline_id: int):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM baselines WHERE id = ?", (baseline_id,)
        ).fetchone()
        if not row:
            abort(404, "Baseline not found")

        tasks = conn.execute(
            """SELECT bt.task_id, bt.start_date, bt.end_date, bt.duration_days,
                      t.name
                 FROM baseline_tasks bt
                 JOIN tasks t ON t.id = bt.task_id
                WHERE bt.baseline_id = ?""",
            (baseline_id,)
        ).fetchall()

        result = _baseline_row(row)
        result["tasks"] = [
            {
                "task_id":       t["task_id"],
                "name":          t["name"],
                "start_date":    t["start_date"],
                "end_date":      t["end_date"],
                "duration_days": t["duration_days"],
            }
            for t in tasks
        ]
        return jsonify(result)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Delete a baseline
# ---------------------------------------------------------------------------

@bp.route("/api/baselines/<int:baseline_id>", methods=["DELETE"])
def delete_baseline(baseline_id: int):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT id FROM baselines WHERE id = ?", (baseline_id,)
        ).fetchone()
        if not row:
            abort(404, "Baseline not found")
        conn.execute("DELETE FROM baselines WHERE id = ?", (baseline_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Restore a baseline — copies snapshot dates back to task start/end
# ---------------------------------------------------------------------------

@bp.route(
    "/api/projects/<int:project_id>/baselines/<int:baseline_id>/restore",
    methods=["POST"]
)
def restore_baseline(project_id: int, baseline_id: int):
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM baselines WHERE id = ? AND project_id = ?",
            (baseline_id, project_id)
        ).fetchone()
        if not row:
            abort(404, "Baseline not found")

        tasks = conn.execute(
            """SELECT task_id, start_date, end_date, duration_days
                 FROM baseline_tasks WHERE baseline_id = ?""",
            (baseline_id,)
        ).fetchall()

        # Restore start/end dates and refresh comparison bars
        conn.executemany(
            """UPDATE tasks
                  SET start_date          = ?,
                      end_date            = ?,
                      duration_days       = ?,
                      baseline_start_date = ?,
                      baseline_end_date   = ?
                WHERE id = ?""",
            [
                (t["start_date"], t["end_date"], t["duration_days"],
                 t["start_date"], t["end_date"], t["task_id"])
                for t in tasks
            ]
        )
        conn.commit()
        return jsonify({"ok": True, "tasks_restored": len(tasks)})
    finally:
        conn.close()
