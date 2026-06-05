"""
pg_schema.py — PostgreSQL schema migrations.

Mirrors the SQLite MIGRATIONS list in database.py but written in
PostgreSQL-compatible SQL.  Each entry is (version, [list_of_statements]).
Statements are executed individually inside a transaction — no executescript().

Rules:
  - Version numbers MUST match the SQLite MIGRATIONS list exactly.
  - Every new SQLite migration must have a corresponding entry here.
  - Use %s placeholders (not ?) — these statements are run via psycopg2.
  - Use SERIAL PRIMARY KEY (not INTEGER PRIMARY KEY AUTOINCREMENT).
  - Use NOW() (not datetime('now')).
  - Use INSERT ... ON CONFLICT for upserts (not INSERT OR IGNORE/REPLACE).
  - PostgreSQL enforces FK constraints natively — no PRAGMA needed.
  - Triggers use CREATE OR REPLACE FUNCTION + CREATE TRIGGER syntax.
"""

from __future__ import annotations

PG_MIGRATIONS: list[tuple[int, list[str]]] = [

    # v1 — Core schema
    (1, [
        """
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS people (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL,
            role       TEXT,
            email      TEXT,
            colour     TEXT DEFAULT '#8892a4',
            created_at TIMESTAMP DEFAULT NOW()
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS projects (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            category    TEXT NOT NULL DEFAULT 'General',
            status      TEXT NOT NULL DEFAULT 'not-started',
            description TEXT,
            colour      TEXT DEFAULT '#4a90e2',
            sort_order  INTEGER DEFAULT 0,
            created_at  TIMESTAMP DEFAULT NOW(),
            updated_at  TIMESTAMP DEFAULT NOW()
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS tasks (
            id                  SERIAL PRIMARY KEY,
            project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name                TEXT NOT NULL,
            type                TEXT NOT NULL DEFAULT 'task',
            status              TEXT NOT NULL DEFAULT 'not-started',
            start_date          TEXT,
            end_date            TEXT,
            duration_days       INTEGER,
            is_firm_date        INTEGER DEFAULT 0,
            actual_start_date   TEXT,
            actual_end_date     TEXT,
            baseline_start_date TEXT,
            baseline_end_date   TEXT,
            notes               TEXT,
            completed_at        TEXT,
            sort_order          INTEGER DEFAULT 0,
            created_at          TIMESTAMP DEFAULT NOW(),
            updated_at          TIMESTAMP DEFAULT NOW()
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS baselines (
            id         SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            saved_at   TIMESTAMP DEFAULT NOW(),
            notes      TEXT
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS baseline_tasks (
            id            SERIAL PRIMARY KEY,
            baseline_id   INTEGER NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
            task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            start_date    TEXT,
            end_date      TEXT,
            duration_days INTEGER,
            UNIQUE(baseline_id, task_id)
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS task_people (
            task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, person_id)
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS dependencies (
            id             SERIAL PRIMARY KEY,
            predecessor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            successor_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            type           TEXT NOT NULL DEFAULT 'FS',
            lag_days       INTEGER DEFAULT 0,
            UNIQUE(predecessor_id, successor_id),
            CHECK(predecessor_id != successor_id)
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS task_items (
            id           SERIAL PRIMARY KEY,
            task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            content      TEXT NOT NULL,
            item_type    TEXT NOT NULL DEFAULT 'note',
            is_complete  INTEGER DEFAULT 0,
            completed_at TEXT,
            sort_order   INTEGER DEFAULT 0,
            created_at   TIMESTAMP DEFAULT NOW()
        )
        """,

        # Shared trigger function for updated_at columns
        """
        CREATE OR REPLACE FUNCTION _set_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
        """,

        "DROP TRIGGER IF EXISTS trg_project_updated ON projects",
        """
        CREATE TRIGGER trg_project_updated
        BEFORE UPDATE ON projects
        FOR EACH ROW EXECUTE FUNCTION _set_updated_at()
        """,

        "DROP TRIGGER IF EXISTS trg_task_updated ON tasks",
        """
        CREATE TRIGGER trg_task_updated
        BEFORE UPDATE ON tasks
        FOR EACH ROW EXECUTE FUNCTION _set_updated_at()
        """,
    ]),

    # v2 — Categories table + default seed data
    (2, [
        """
        CREATE TABLE IF NOT EXISTS categories (
            id         SERIAL PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            colour     TEXT DEFAULT '#8892a4',
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )
        """,

        "INSERT INTO categories (name, colour, sort_order) VALUES ('General',     '#8892a4', 0) ON CONFLICT (name) DO NOTHING",
        "INSERT INTO categories (name, colour, sort_order) VALUES ('Engineering', '#4a90e2', 1) ON CONFLICT (name) DO NOTHING",
        "INSERT INTO categories (name, colour, sort_order) VALUES ('Design',      '#7b68ee', 2) ON CONFLICT (name) DO NOTHING",
        "INSERT INTO categories (name, colour, sort_order) VALUES ('Marketing',   '#f5a623', 3) ON CONFLICT (name) DO NOTHING",
        "INSERT INTO categories (name, colour, sort_order) VALUES ('Publishing',  '#d0021b', 4) ON CONFLICT (name) DO NOTHING",
        "INSERT INTO categories (name, colour, sort_order) VALUES ('Music',       '#417505', 5) ON CONFLICT (name) DO NOTHING",
    ]),

    # v3 — WBS hierarchy, progress tracking
    (3, [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES tasks(id)",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS wbs_number TEXT",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress REAL DEFAULT 0.0",
    ]),

    # v4 — Phase header banners
    (4, [
        """
        CREATE TABLE IF NOT EXISTS phases (
            id         SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            start_date TEXT,
            end_date   TEXT,
            colour     TEXT DEFAULT '#6366f1',
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )
        """,
    ]),

    # v5 — Per-person unavailability date ranges
    (5, [
        """
        CREATE TABLE IF NOT EXISTS unavailability (
            id         SERIAL PRIMARY KEY,
            person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            start_date TEXT NOT NULL,
            end_date   TEXT NOT NULL,
            label      TEXT NOT NULL DEFAULT 'Unavailable',
            created_at TIMESTAMP DEFAULT NOW()
        )
        """,
    ]),

    # v6 — Budget & expense tracking, settings table
    (6, [
        "ALTER TABLE task_items ADD COLUMN IF NOT EXISTS value REAL DEFAULT NULL",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget REAL DEFAULT NULL",
        "UPDATE task_items SET item_type = 'note' WHERE item_type = 'subtask'",

        """
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        )
        """,

        "INSERT INTO settings (key, value) VALUES ('currency_symbol', '£') ON CONFLICT (key) DO NOTHING",
    ]),

    # v7 — RAG health status
    (7, [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rag TEXT DEFAULT NULL",
    ]),

    # v8 — Task templates
    (8, [
        """
        CREATE TABLE IF NOT EXISTS templates (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            description TEXT,
            created_at  TIMESTAMP DEFAULT NOW()
        )
        """,

        """
        CREATE TABLE IF NOT EXISTS template_tasks (
            id            SERIAL PRIMARY KEY,
            template_id   INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
            name          TEXT NOT NULL,
            type          TEXT NOT NULL DEFAULT 'task',
            wbs_number    TEXT,
            notes         TEXT,
            duration_days INTEGER,
            start_offset  INTEGER DEFAULT 0,
            end_offset    INTEGER DEFAULT 0,
            parent_ref    INTEGER,
            sort_order    INTEGER DEFAULT 0
        )
        """,
    ]),

    # v9 — Project links
    (9, [
        """
        CREATE TABLE IF NOT EXISTS project_links (
            id         SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            url        TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        )
        """,
    ]),

    # v10 — Pending status support
    (10, [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_until TEXT DEFAULT NULL",
    ]),

    # v11 — Project archiving
    (11, [
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived INTEGER NOT NULL DEFAULT 0",
    ]),

    # v12 — Time tracking
    (12, [
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_hours REAL DEFAULT NULL",
        "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS logged_hours    REAL DEFAULT NULL",
    ]),
]

CURRENT_VERSION = max(v for v, _ in PG_MIGRATIONS)
