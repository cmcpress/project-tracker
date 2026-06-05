"""
database.py — Database connection management and versioned schema migrations.

Supports two backends:
  - SQLite  (local mode, default)
  - PostgreSQL via psycopg2 (cloud mode, activated by set_postgres_config())

The public interface is unchanged from the SQLite-only version:
  - get_connection() returns a ConnectionWrapper
  - ConnectionWrapper.execute(sql, params) accepts ? placeholders
  - Result rows support dict-style access: row["column_name"] and dict(row)
  - cursor.lastrowid works for INSERT statements on both backends
  - conn.commit(), conn.close() work identically

Routes require zero changes to move between backends.
"""

from __future__ import annotations

import re
import sqlite3
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level backend state
# ---------------------------------------------------------------------------

_db_path: Path | None = None          # SQLite file path (local mode)
_backend: str = "sqlite"              # "sqlite" or "postgres"
_pg_config: dict | None = None        # PostgreSQL connection parameters
_pg_pool = None                       # psycopg2 ThreadedConnectionPool


def is_local_mode() -> bool:
    """Return True when running against a local SQLite database."""
    return _backend == "sqlite"


def set_db_path(path: Path) -> None:
    """Store the SQLite database path. Must be called before get_connection()."""
    global _db_path
    _db_path = path


def set_postgres_config(host: str, port: int, dbname: str,
                        user: str, password: str, ssl: bool = True) -> None:
    """
    Switch to PostgreSQL mode and open a connection pool.
    Calling this replaces any existing pool — safe to call again on reconnect.
    """
    global _backend, _pg_config, _pg_pool
    try:
        from psycopg2 import pool as pg_pool
    except ImportError:
        raise RuntimeError(
            "psycopg2-binary is not installed. "
            "Run: pip install psycopg2-binary"
        )

    _pg_config = {
        "host":     host,
        "port":     port,
        "dbname":   dbname,
        "user":     user,
        "password": password,
        "sslmode":  "require" if ssl else "prefer",
    }

    # Close existing pool if any
    if _pg_pool is not None:
        try:
            _pg_pool.closeall()
        except Exception:
            pass

    _pg_pool = pg_pool.ThreadedConnectionPool(
        minconn=2,
        maxconn=10,
        **_pg_config,
    )
    _backend = "postgres"
    logger.info("PostgreSQL connection pool created (host=%s dbname=%s)", host, dbname)


def clear_postgres_config() -> None:
    """Switch back to SQLite (local) mode and close the PostgreSQL pool."""
    global _backend, _pg_config, _pg_pool
    if _pg_pool is not None:
        try:
            _pg_pool.closeall()
        except Exception:
            pass
        _pg_pool = None
    _pg_config = None
    _backend = "sqlite"
    logger.info("Switched back to SQLite (local) mode")


# ---------------------------------------------------------------------------
# SQL translation helpers (SQLite → PostgreSQL)
# ---------------------------------------------------------------------------

# Tables that have a SERIAL id column — used to decide whether to inject
# RETURNING id after INSERT statements on PostgreSQL.
_PG_TABLES_WITH_ID = {
    "projects", "tasks", "people", "baselines", "baseline_tasks",
    "task_items", "dependencies", "phases", "unavailability",
    "categories", "templates", "template_tasks", "project_links",
}

# Primary key column(s) per table — used to build ON CONFLICT clauses for
# INSERT OR REPLACE rewriting.
_PG_CONFLICT_TARGETS: dict[str, list[str]] = {
    "settings":       ["key"],
    "baseline_tasks": ["baseline_id", "task_id"],
    "task_people":    ["task_id", "person_id"],
    "dependencies":   ["predecessor_id", "successor_id"],
    "schema_version": ["version"],
    "categories":     ["name"],
    "templates":      ["name"],
}


def _extract_table(sql: str) -> str | None:
    """Extract the target table name from an INSERT INTO statement."""
    m = re.search(r'INTO\s+(\w+)', sql, re.IGNORECASE)
    return m.group(1).lower() if m else None


def _translate_sql(sql: str) -> str:
    """
    Translate SQLite SQL to PostgreSQL SQL.

    Transformations applied:
      1. INSERT OR IGNORE  →  INSERT ... ON CONFLICT DO NOTHING
      2. INSERT OR REPLACE →  INSERT ... ON CONFLICT (...) DO UPDATE SET ...
      3. ?  →  %s  (placeholder syntax)
    """
    s = sql.strip()

    # INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    if re.match(r'INSERT\s+OR\s+IGNORE\b', s, re.IGNORECASE):
        s = re.sub(r'INSERT\s+OR\s+IGNORE\b', 'INSERT', s, count=1, flags=re.IGNORECASE)
        s = s.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING'

    # INSERT OR REPLACE → INSERT ... ON CONFLICT (...) DO UPDATE SET ...
    elif re.match(r'INSERT\s+OR\s+REPLACE\b', s, re.IGNORECASE):
        s = re.sub(r'INSERT\s+OR\s+REPLACE\b', 'INSERT', s, count=1, flags=re.IGNORECASE)
        table = _extract_table(s)
        conflict_cols = _PG_CONFLICT_TARGETS.get(table or "", [])

        if conflict_cols:
            col_match = re.search(r'INTO\s+\w+\s*\(([^)]+)\)', s, re.IGNORECASE)
            if col_match:
                all_cols = [c.strip() for c in col_match.group(1).split(',')]
                update_cols = [c for c in all_cols if c not in conflict_cols]
                target = '(' + ', '.join(conflict_cols) + ')'
                if update_cols:
                    updates = ', '.join(f'{c} = EXCLUDED.{c}' for c in update_cols)
                    s = s.rstrip().rstrip(';') + f' ON CONFLICT {target} DO UPDATE SET {updates}'
                else:
                    s = s.rstrip().rstrip(';') + f' ON CONFLICT {target} DO NOTHING'
            else:
                s = s.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING'
        else:
            s = s.rstrip().rstrip(';') + ' ON CONFLICT DO NOTHING'

    # ? → %s  (must come last to avoid interfering with the patterns above)
    s = s.replace('?', '%s')

    return s


def _should_add_returning(sql: str) -> bool:
    """
    Return True if this INSERT targets a table with a serial id column,
    meaning we should append RETURNING id for PostgreSQL.
    """
    m = re.match(r'\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)', sql, re.IGNORECASE)
    if m:
        return m.group(1).lower() in _PG_TABLES_WITH_ID
    return False


# ---------------------------------------------------------------------------
# CursorWrapper — uniform cursor interface across backends
# ---------------------------------------------------------------------------

class CursorWrapper:
    """
    Wraps a SQLite or psycopg2 cursor and provides a uniform interface.
    Supports dict-style row access (row["column"]) and lastrowid on both
    backends.
    """

    def __init__(self, raw_cursor, backend: str):
        self._cur = raw_cursor
        self._backend = backend
        self.lastrowid: int | None = None   # set by ConnectionWrapper.execute()

    def fetchone(self):
        row = self._cur.fetchone()
        if row is None:
            return None
        if self._backend == "sqlite":
            return row          # sqlite3.Row — already dict-like
        return dict(row)        # psycopg2 RealDictRow → plain dict

    def fetchall(self) -> list:
        rows = self._cur.fetchall()
        if self._backend == "sqlite":
            return rows         # list of sqlite3.Row
        return [dict(r) for r in rows]   # list of plain dicts

    def __iter__(self):
        return self

    def __next__(self):
        row = self._cur.fetchone()
        if row is None:
            raise StopIteration
        if self._backend == "sqlite":
            return row
        return dict(row)

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount


# ---------------------------------------------------------------------------
# ConnectionWrapper — uniform connection interface across backends
# ---------------------------------------------------------------------------

class ConnectionWrapper:
    """
    Wraps a SQLite or psycopg2 connection and provides a uniform interface.

    Key behaviours:
      - execute() translates ? placeholders and INSERT OR IGNORE/REPLACE
        automatically for PostgreSQL.
      - For PostgreSQL INSERT statements targeting tables with a serial id
        column, RETURNING id is injected automatically so that lastrowid works.
      - close() returns the connection to the PostgreSQL pool (or closes the
        SQLite connection), and rolls back any uncommitted transaction first.
    """

    def __init__(self, raw_conn, backend: str, pool=None):
        self._conn = raw_conn
        self._backend = backend
        self._pool = pool       # psycopg2 pool, or None for SQLite
        self._committed = False

    # ------------------------------------------------------------------
    # execute
    # ------------------------------------------------------------------

    def execute(self, sql: str, params=()) -> CursorWrapper:
        if self._backend == "sqlite":
            raw = self._conn.execute(sql, params)
            wrapper = CursorWrapper(raw, "sqlite")
            wrapper.lastrowid = raw.lastrowid
            return wrapper

        # PostgreSQL
        from psycopg2.extras import RealDictCursor
        add_returning = _should_add_returning(sql)
        translated = _translate_sql(sql)

        if add_returning and "RETURNING" not in translated.upper():
            translated = translated.rstrip().rstrip(';') + ' RETURNING id'

        raw = self._conn.cursor(cursor_factory=RealDictCursor)
        raw.execute(translated, params if params else None)
        wrapper = CursorWrapper(raw, "postgres")

        if add_returning:
            row = raw.fetchone()
            wrapper.lastrowid = row["id"] if row else None
        else:
            wrapper.lastrowid = None

        return wrapper

    # ------------------------------------------------------------------
    # executemany
    # ------------------------------------------------------------------

    def executemany(self, sql: str, params_list) -> None:
        if self._backend == "sqlite":
            self._conn.executemany(sql, params_list)
            return
        translated = _translate_sql(sql)
        cur = self._conn.cursor()
        cur.executemany(translated, params_list)

    # ------------------------------------------------------------------
    # executescript — used only by the migration system
    # ------------------------------------------------------------------

    def executescript(self, sql: str) -> None:
        """
        Execute multiple SQL statements separated by semicolons.
        SQLite: delegates to conn.executescript() directly.
        PostgreSQL: not used (PG migrations use list-of-statements).
        """
        if self._backend == "sqlite":
            self._conn.executescript(sql)
        else:
            # Fallback: split and execute individually (best-effort)
            cur = self._conn.cursor()
            for stmt in sql.split(';'):
                stmt = stmt.strip()
                if stmt:
                    cur.execute(stmt)

    # ------------------------------------------------------------------
    # Transaction control
    # ------------------------------------------------------------------

    def commit(self) -> None:
        self._conn.commit()
        self._committed = True

    def rollback(self) -> None:
        self._conn.rollback()
        self._committed = False

    def close(self) -> None:
        """
        Commit-or-rollback then release the connection.
        For PostgreSQL: returns the connection to the pool.
        For SQLite: closes the file connection.
        """
        if not self._committed:
            try:
                self._conn.rollback()
            except Exception:
                pass

        if self._pool is not None:
            try:
                self._pool.putconn(self._conn)
            except Exception:
                pass
        else:
            try:
                self._conn.close()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Context manager support
    # ------------------------------------------------------------------

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False


# ---------------------------------------------------------------------------
# get_connection — public factory
# ---------------------------------------------------------------------------

def get_connection() -> ConnectionWrapper:
    """
    Open and return a database connection as a ConnectionWrapper.

    Local mode  (default): opens a new SQLite connection.
    Cloud mode:            acquires a connection from the PostgreSQL pool.

    Caller is responsible for calling conn.close() (or using as context manager).
    """
    if _backend == "postgres":
        if _pg_pool is None:
            raise RuntimeError("PostgreSQL pool is not initialised.")
        try:
            raw = _pg_pool.getconn()
        except Exception as exc:
            raise RuntimeError(f"Failed to acquire PostgreSQL connection: {exc}") from exc
        return ConnectionWrapper(raw, "postgres", pool=_pg_pool)

    # SQLite
    if _db_path is None:
        raise RuntimeError("Database path has not been set. Call set_db_path() first.")
    raw = sqlite3.connect(str(_db_path))
    raw.row_factory = sqlite3.Row
    raw.execute("PRAGMA foreign_keys = ON")
    return ConnectionWrapper(raw, "sqlite")


# ---------------------------------------------------------------------------
# Schema migrations — SQLite
# ---------------------------------------------------------------------------

MIGRATIONS: list[tuple[int, str]] = [
    (1, """
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS people (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            role       TEXT,
            email      TEXT,
            colour     TEXT DEFAULT '#8892a4',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            category    TEXT NOT NULL DEFAULT 'General',
            status      TEXT NOT NULL DEFAULT 'not-started',
            description TEXT,
            colour      TEXT DEFAULT '#4a90e2',
            sort_order  INTEGER DEFAULT 0,
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at          TEXT DEFAULT (datetime('now')),
            updated_at          TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS baselines (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            saved_at   TEXT DEFAULT (datetime('now')),
            notes      TEXT
        );

        CREATE TABLE IF NOT EXISTS baseline_tasks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            baseline_id   INTEGER NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
            task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            start_date    TEXT,
            end_date      TEXT,
            duration_days INTEGER,
            UNIQUE(baseline_id, task_id)
        );

        CREATE TABLE IF NOT EXISTS task_people (
            task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            PRIMARY KEY (task_id, person_id)
        );

        CREATE TABLE IF NOT EXISTS dependencies (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            predecessor_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            successor_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            type           TEXT NOT NULL DEFAULT 'FS',
            lag_days       INTEGER DEFAULT 0,
            UNIQUE(predecessor_id, successor_id),
            CHECK(predecessor_id != successor_id)
        );

        CREATE TABLE IF NOT EXISTS task_items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            content      TEXT NOT NULL,
            item_type    TEXT NOT NULL DEFAULT 'note',
            is_complete  INTEGER DEFAULT 0,
            completed_at TEXT,
            sort_order   INTEGER DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE TRIGGER IF NOT EXISTS trg_project_updated
        AFTER UPDATE ON projects
        BEGIN
            UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_task_updated
        AFTER UPDATE ON tasks
        BEGIN
            UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
        END;
    """),

    (2, """
        CREATE TABLE IF NOT EXISTS categories (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            colour     TEXT DEFAULT '#8892a4',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );

        INSERT OR IGNORE INTO categories (name, colour, sort_order) VALUES
            ('General',     '#8892a4', 0),
            ('Engineering', '#4a90e2', 1),
            ('Design',      '#7b68ee', 2),
            ('Marketing',   '#f5a623', 3),
            ('Publishing',  '#d0021b', 4),
            ('Music',       '#417505', 5);
    """),

    (3, """
        ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id);
        ALTER TABLE tasks ADD COLUMN wbs_number TEXT;
        ALTER TABLE tasks ADD COLUMN progress REAL DEFAULT 0.0;
    """),

    (4, """
        CREATE TABLE IF NOT EXISTS phases (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            start_date TEXT,
            end_date   TEXT,
            colour     TEXT DEFAULT '#6366f1',
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
    """),

    (5, """
        CREATE TABLE IF NOT EXISTS unavailability (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
            start_date TEXT NOT NULL,
            end_date   TEXT NOT NULL,
            label      TEXT NOT NULL DEFAULT 'Unavailable',
            created_at TEXT DEFAULT (datetime('now'))
        );
    """),

    (6, """
        ALTER TABLE task_items ADD COLUMN value REAL DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN budget REAL DEFAULT NULL;
        UPDATE task_items SET item_type = 'note' WHERE item_type = 'subtask';

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );

        INSERT OR IGNORE INTO settings (key, value) VALUES ('currency_symbol', '£');
    """),

    (7, """
        ALTER TABLE tasks ADD COLUMN rag TEXT DEFAULT NULL;
    """),

    (8, """
        CREATE TABLE IF NOT EXISTS templates (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL UNIQUE,
            description TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS template_tasks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
        );
    """),

    (9, """
        CREATE TABLE IF NOT EXISTS project_links (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            url        TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
    """),

    (10, """
        ALTER TABLE tasks ADD COLUMN pending_until TEXT DEFAULT NULL;
    """),

    (11, """
        ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    """),

    (12, """
        ALTER TABLE tasks ADD COLUMN estimated_hours REAL DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN logged_hours    REAL DEFAULT NULL;
    """),
]

CURRENT_VERSION = max(v for v, _ in MIGRATIONS)


# ---------------------------------------------------------------------------
# Migration helpers
# ---------------------------------------------------------------------------

def _get_schema_version(conn: ConnectionWrapper) -> int:
    """
    Return the current schema version from the database.
    Returns 0 if the schema_version table does not yet exist.
    """
    try:
        row = conn.execute(
            "SELECT MAX(version) AS ver FROM schema_version"
        ).fetchone()
        if row is None:
            return 0
        ver = row["ver"] if isinstance(row, dict) else row[0]
        return ver if ver is not None else 0
    except Exception:
        return 0


def _init_sqlite() -> None:
    """Apply outstanding SQLite migrations in version order."""
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    try:
        current = _get_schema_version(conn)
        logger.info("SQLite schema version: %d (target: %d)", current, CURRENT_VERSION)
        for version, sql in sorted(MIGRATIONS, key=lambda x: x[0]):
            if version > current:
                logger.info("Applying SQLite migration v%d", version)
                conn.executescript(sql)
                conn.execute(
                    "INSERT OR REPLACE INTO schema_version (version) VALUES (?)",
                    (version,)
                )
                conn.commit()
                logger.info("SQLite migration v%d applied", version)
    finally:
        conn.close()


def _init_postgres() -> None:
    """Apply outstanding PostgreSQL migrations in version order."""
    from app.pg_schema import PG_MIGRATIONS, CURRENT_VERSION as PG_CURRENT
    conn = get_connection()
    try:
        current = _get_schema_version(conn)
        logger.info("PostgreSQL schema version: %d (target: %d)", current, PG_CURRENT)
        for version, statements in sorted(PG_MIGRATIONS, key=lambda x: x[0]):
            if version > current:
                logger.info("Applying PostgreSQL migration v%d", version)
                for stmt in statements:
                    stmt = stmt.strip()
                    if not stmt:
                        continue
                    try:
                        conn.execute(stmt)
                    except Exception as exc:
                        conn.rollback()
                        logger.error(
                            "Migration v%d FAILED\nStatement: %s\nError: %s",
                            version, stmt[:300], exc
                        )
                        raise RuntimeError(
                            f"PostgreSQL migration v{version} failed: {exc}\n"
                            f"Statement: {stmt[:300]}"
                        ) from exc
                conn.execute(
                    "INSERT INTO schema_version (version) VALUES (%s) "
                    "ON CONFLICT (version) DO NOTHING",
                    (version,)
                )
                conn.commit()
                logger.info("PostgreSQL migration v%d applied", version)
    finally:
        conn.close()


def init_db() -> None:
    """
    Apply any outstanding migrations to the active database.
    Dispatches to the correct backend automatically.
    Safe to call on every startup — migrations are idempotent.
    """
    if _backend == "postgres":
        _init_postgres()
    else:
        if _db_path is None:
            raise RuntimeError("Database path has not been set. Call set_db_path() first.")
        _init_sqlite()
