"""
models.py — Python dataclasses representing every database entity.

These are used for type-safe data transfer between the database layer
and the route handlers. They are never used as ORM objects — all SQL
is written explicitly in the route files.

Enumerated value constants are also defined here and shared with
validation helpers used in route handlers.
"""
from __future__ import annotations


from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Enumerated value constants — single source of truth
# ---------------------------------------------------------------------------

TASK_TYPES = {"task", "milestone", "phase", "group"}

STATUSES = {"not-started", "planning", "in-progress", "blocked", "pending", "complete"}

DEPENDENCY_TYPES = {"FS", "SS", "FF", "SF"}

ITEM_TYPES = {"note", "component", "expense"}


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Person:
    """A collaborator who can be assigned to tasks."""
    id: int
    name: str
    role: Optional[str]
    email: Optional[str]
    colour: str
    created_at: str


@dataclass
class Project:
    """A top-level project grouping tasks."""
    id: int
    name: str
    category: str
    status: str
    description: Optional[str]
    colour: str
    sort_order: int
    created_at: str
    updated_at: str
    # Computed fields populated by queries (not stored directly)
    task_count: int = 0
    completed_task_count: int = 0


@dataclass
class Task:
    """A unit of work within a project."""
    id: int
    project_id: int
    name: str
    type: str
    status: str
    start_date: Optional[str]
    end_date: Optional[str]
    duration_days: Optional[int]
    is_firm_date: bool
    actual_start_date: Optional[str]
    actual_end_date: Optional[str]
    baseline_start_date: Optional[str]
    baseline_end_date: Optional[str]
    notes: Optional[str]
    completed_at: Optional[str]
    sort_order: int
    created_at: str
    updated_at: str
    # Hierarchy fields (Phase 1 — WBS)
    parent_id: Optional[int] = None
    wbs_number: Optional[str] = None
    progress: float = 0.0
    # Joined fields populated by queries
    assignees: list = field(default_factory=list)
    items: list = field(default_factory=list)
    dependency_count: int = 0
    children: list = field(default_factory=list)


@dataclass
class Dependency:
    """A directional dependency between two tasks."""
    id: int
    predecessor_id: int
    successor_id: int
    type: str       # FS | SS | FF | SF
    lag_days: int


@dataclass
class TaskItem:
    """A sub-item (note, component, or expense) belonging to a task."""
    id: int
    task_id: int
    content: str
    item_type: str  # note | component | expense
    is_complete: bool
    completed_at: Optional[str]
    sort_order: int
    created_at: str
    value: Optional[float] = None  # cash value (component or expense items)


@dataclass
class Baseline:
    """A named snapshot of planned dates for all tasks in a project."""
    id: int
    project_id: int
    name: str
    saved_at: str
    notes: Optional[str]


@dataclass
class BaselineTask:
    """A single task's date snapshot within a baseline."""
    id: int
    baseline_id: int
    task_id: int
    start_date: Optional[str]
    end_date: Optional[str]
    duration_days: Optional[int]


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def row_to_dict(row) -> dict:
    """
    Convert a sqlite3.Row object to a plain dict.
    Works with both sqlite3.Row instances and plain dicts.
    """
    if row is None:
        return {}
    if isinstance(row, dict):
        return row
    return dict(row)


def rows_to_list(rows) -> list[dict]:
    """Convert a list of sqlite3.Row objects to a list of plain dicts."""
    return [row_to_dict(r) for r in rows]
