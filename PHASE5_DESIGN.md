# Phase 5 — Design and Conflict Analysis

> **Purpose:** Lock in every architectural decision that affects more than one
> Phase 5 sub-phase before any code is written. Each section identifies a risk,
> the decision made to resolve it, and what must be built in which phase to
> prevent rework downstream.
>
> *Read this at the start of every Phase 5 session.*
>
> *Last updated: 2026-06-04 — all open questions resolved, design locked.*

---

## 1. Executive summary of risks

A codebase review of the existing routes and database layer found the following
cross-cutting concerns that, if not designed upfront, will require reworking
already-completed code:

| Risk | Affects | Must be resolved in |
|---|---|---|
| `lastrowid` incompatible with PostgreSQL | Every INSERT in all 14 routes | 5A |
| `INSERT OR IGNORE / REPLACE` SQLite-only syntax | 4 route files | 5A |
| `?` placeholder vs `%s` | All 254 SQL calls across all routes | 5A |
| Connection pooling for PostgreSQL | 5A database layer | 5A |
| Auth hook design — if deferred, all 14 routes need touching in 5D | All routes | Design in 5A, implement in 5D |
| Real-time broadcast hook — if deferred, all write routes need touching in 5F | All write routes | Design in 5A, implement in 5F |
| Local vs cloud mode — single source of truth needed | JsApi, routes, frontend | 5A |
| Transaction safety — PostgreSQL is strict, SQLite is forgiving | All routes | 5A |
| `dict(row)` — 30 uses that depend on sqlite3.Row dict-like behaviour | All routes | 5A |

---

## 2. Critical design decisions — locked in

These decisions are final. Changing them after 5A is complete would require
reworking the database layer.

---

### Decision 1: ConnectionWrapper contract

All routes call `get_connection()` and use the result as follows:

```python
conn = get_connection()
try:
    rows = conn.execute("SELECT ...", (p1, p2)).fetchall()
    cursor = conn.execute("INSERT INTO ...", (p1, p2))
    new_id = cursor.lastrowid
    conn.commit()
finally:
    conn.close()
```

The `ConnectionWrapper` returned by `get_connection()` must support exactly
this interface with no changes to any route. Specifically:

- `conn.execute(sql, params)` — translates `?` → `%s` for PostgreSQL automatically
- `conn.execute(...).fetchall()` — returns list of dict-like row objects
- `conn.execute(...).fetchone()` — returns single dict-like row or None
- `conn.execute(...).lastrowid` — returns the new row's ID (see Decision 2)
- `conn.executemany(sql, list_of_params)` — bulk insert
- `conn.executescript(sql)` — for migrations only; splits on `;` for PostgreSQL
- `conn.commit()` — commits the transaction
- `conn.close()` — returns connection to pool (PostgreSQL) or closes (SQLite)
- `row["column_name"]` — dict-style column access on all result rows
- `dict(row)` — converts any result row to a plain dict

---

### Decision 2: lastrowid resolution

`cursor.lastrowid` is used in **15 places across 10 route files**. It is not
reliably available in psycopg2 without OIDs (disabled by default in modern
PostgreSQL).

**Resolution:** The `CursorWrapper` returned by `conn.execute()` intercepts
INSERT statements on PostgreSQL and automatically appends `RETURNING id` to
the SQL before executing. The returned ID is stored on the cursor and exposed
as `.lastrowid`. Routes require zero changes.

**Implementation detail:**
```python
# In CursorWrapper.execute() for PostgreSQL backend:
if sql.strip().upper().startswith("INSERT") and "RETURNING" not in sql.upper():
    sql = sql.rstrip().rstrip(";") + " RETURNING id"
    self._cursor.execute(sql, params)
    row = self._cursor.fetchone()
    self.lastrowid = row[0] if row else None
else:
    self._cursor.execute(sql, params)
    self.lastrowid = None
```

---

### Decision 3: INSERT OR IGNORE / INSERT OR REPLACE

Found in 4 locations:

| File | Statement | Used for |
|---|---|---|
| `people.py` | `INSERT OR IGNORE INTO task_people` | Assign person to task |
| `export.py` (×2) | `INSERT OR IGNORE INTO task_people`, `INSERT OR IGNORE INTO dependencies` | Import |
| `baselines.py` | `INSERT OR REPLACE INTO baseline_tasks` | Save baseline |
| `settings.py` | `INSERT OR REPLACE INTO settings` | Update setting |

**Resolution:** The `ConnectionWrapper.execute()` method detects these patterns
and rewrites them for PostgreSQL before execution:

```
INSERT OR IGNORE INTO table (cols) VALUES (?)
→ INSERT INTO table (cols) VALUES (%s) ON CONFLICT DO NOTHING

INSERT OR REPLACE INTO table (col1, col2) VALUES (?, ?)
→ INSERT INTO table (col1, col2) VALUES (%s, %s)
   ON CONFLICT (col1) DO UPDATE SET col2 = EXCLUDED.col2
```

For `INSERT OR REPLACE`, the conflict target (primary key column) is inferred
from the table name using a lookup table defined in `database.py`. Routes
require zero changes.

**Conflict targets by table:**
```python
PG_CONFLICT_TARGETS = {
    "settings":       "key",
    "baseline_tasks": "(baseline_id, task_id)",
    "task_people":    "(task_id, person_id)",
    "dependencies":   "(predecessor_id, successor_id)",
    "schema_version": "version",
}
```

---

### Decision 4: Connection pooling

SQLite opens a fresh file connection per request (cheap). PostgreSQL connections
are expensive — opening one per request would be unacceptably slow under any
concurrent load.

**Resolution:** When `set_postgres_config()` is called, a
`psycopg2.pool.ThreadedConnectionPool` is created with `minconn=2, maxconn=10`.
`get_connection()` acquires a connection from the pool and wraps it. When
`conn.close()` is called on the wrapper, the underlying connection is returned
to the pool rather than closed.

The pool is stored as a module-level singleton in `database.py`. If a pool
connection goes stale (e.g. PostgreSQL server restart), psycopg2 raises
`OperationalError`; the wrapper catches this, discards the connection, acquires
a fresh one, and retries once.

```python
_pg_pool: ThreadedConnectionPool | None = None

def get_connection() -> ConnectionWrapper:
    if _backend == "postgres":
        conn = _pg_pool.getconn()
        return ConnectionWrapper(conn, backend="postgres", pool=_pg_pool)
    else:
        conn = sqlite3.connect(str(_db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return ConnectionWrapper(conn, backend="sqlite")
```

---

### Decision 5: Authentication hook — designed now, wired in 5D

If auth is bolted on in 5D without a pre-designed hook, all 14 route files
will need editing. This is the largest single source of potential rework.

**Resolution:** In 5A, add a `before_request` handler in `app/__init__.py`
that sets `flask.g.current_user` and `flask.g.mode`:

```python
@app.before_request
def _attach_request_context():
    from app.auth import resolve_user   # stub in 5A, real in 5D
    flask.g.current_user = resolve_user()
    flask.g.mode = "local" if is_local_mode() else "cloud"
```

In 5A, `resolve_user()` is a stub that always returns `None` (local mode,
no auth). In local mode, all routes continue to work exactly as now.

In 5D, `resolve_user()` validates the JWT token from the `Authorization`
header, looks up the user, and returns a user object. The routes themselves
never change — they just check `flask.g.current_user` where needed, and the
project membership decorator (see below) handles the rest.

**Project membership decorator — designed now, implemented in 5D:**
```python
# Designed in 5A as a no-op, activated in 5D
def require_project_access(role="viewer"):
    def decorator(f):
        @wraps(f)
        def wrapped(*args, **kwargs):
            if flask.g.mode == "local":
                return f(*args, **kwargs)   # local mode: always allow
            # 5D: check project membership here
            return f(*args, **kwargs)
        return wrapped
    return decorator
```

This decorator is added to routes in 5D. Because local mode always passes
through, existing behaviour is unchanged until 5D activates it.

---

### Decision 6: Real-time broadcast hook — designed now, wired in 5F

If Flask-SocketIO broadcast is added in 5F without a hook, every write route
needs touching. There are approximately 60 write endpoints.

**Resolution:** Use Flask's Blinker signal system. In 5A, define a signal in
`app/__init__.py`:

```python
from blinker import Namespace
_signals = Namespace()
data_changed = _signals.signal("data-changed")
```

In 5F, Flask-SocketIO subscribes to this signal and broadcasts to the
appropriate room. Routes never change — they just fire the signal after
committing:

```python
# Pattern for write routes (added in 5F, not 5A):
data_changed.send(project_id=project_id, entity="task", action="updated")
```

To avoid touching 60 routes in 5F, the broadcast can also be fired
automatically from the `ConnectionWrapper.commit()` method, which can inspect
what tables were written to during the transaction and emit appropriate events.
This approach means **zero route changes in 5F**.

---

### Decision 7: Local vs cloud mode — single source of truth

Multiple parts of the app need to know if it's running in local or cloud mode:
routes, JsApi methods, the frontend, the auth system.

**Resolution:** A single function in `database.py`:

```python
def is_local_mode() -> bool:
    return _backend == "sqlite"
```

And a new API endpoint added in 5A:
```
GET /api/mode   →   {"mode": "local"} or {"mode": "cloud", "host": "..."}
```

The frontend calls this on startup and stores the result in `State`. In cloud
mode, the frontend hides the database menu (new/open/export) and shows a
"Connected to: hostname" indicator in the topbar instead. This frontend change
is made in 5B.

The `JsApi` methods `new_db`, `load_db`, `export_db` check `is_local_mode()`
and return an error if called in cloud mode. Added in 5A.

---

### Decision 8: Transaction safety

SQLite auto-commits by default in most configurations and is tolerant of
unclosed transactions. PostgreSQL is not — unclosed transactions hold locks
and connections, and idle transactions will cause pool exhaustion.

The current route pattern is:
```python
conn = get_connection()
try:
    # ... reads and writes ...
    conn.commit()      # only called on writes
finally:
    conn.close()
```

Read-only routes never call `conn.commit()`. This is fine for SQLite but
leaves a PostgreSQL transaction open (though read-only transactions are
harmless, they still consume pool connections until `close()` is called).

**Resolution:**
- The `ConnectionWrapper.close()` method calls `rollback()` before returning
  the connection to the pool if the transaction was not committed. This ensures
  clean state.
- No route changes needed.

---

### Decision 9: PostgreSQL migrations — separate list

The SQLite migration SQL uses SQLite-specific syntax that will not run on
PostgreSQL. A separate `PG_MIGRATIONS` list is maintained in `app/pg_schema.py`.

**Rules:**
- Both lists must stay in sync — every new migration added to `MIGRATIONS`
  (SQLite) must have a corresponding entry in `PG_MIGRATIONS`
- The version numbers must match between both lists
- SQLite list uses `?`, PG list uses `%s`
- PG list uses `SERIAL PRIMARY KEY`, `NOW()`, `ON CONFLICT`, PG trigger syntax
- `init_db()` dispatches to the correct list based on `_backend`
- The `schema_version` table is identical in both backends

---

## 3. Phase-by-phase implementation order and constraints

### 5A — Database abstraction layer

**Must deliver:**
- `ConnectionWrapper` and `CursorWrapper` classes (Decisions 1–4)
- `lastrowid` auto-RETURNING for PostgreSQL (Decision 2)
- `INSERT OR IGNORE/REPLACE` rewriting (Decision 3)
- `?` → `%s` placeholder translation (Decision 1)
- `dict(row)` compatibility (Decision 1)
- Connection pool for PostgreSQL (Decision 4)
- `is_local_mode()` function (Decision 7)
- `/api/mode` endpoint (Decision 7)
- `auth.py` stub with `resolve_user()` returning None (Decision 5)
- `before_request` hook wired (Decision 5)
- `require_project_access` decorator as a no-op pass-through (Decision 5)
- `data_changed` Blinker signal defined but not yet subscribed (Decision 6)
- `JsApi` cloud-mode guards on file-based methods (Decision 7)
- `app/pg_schema.py` with full PostgreSQL migration list (Decision 9)
- `psycopg2-binary` added to `requirements.txt`

**Must not change:**
- Any route file
- Any frontend JS file
- Existing SQLite migration list

**Test:** All existing local functionality must work identically after 5A.
The abstraction layer is invisible to SQLite users.

---

### 5B — Connect to remote UI

**Depends on:** 5A complete and tested

**Delivers:** Connection modal in the database menu, credential storage,
title bar update, disconnect option.

**Constraints:**
- Must call `set_postgres_config()` from `database.py` (5A)
- Must call `/api/mode` and update State (5A)
- Must hide/show database menu items based on mode (5A)
- Credentials stored in OS keychain or AES-encrypted config — never plaintext
- The `JsApi` needs two new methods: `connect_remote(config)` and
  `disconnect_remote()` — these are the only `main.py` changes in 5B

---

### 5C — Server setup script

**Depends on:** 5A (needs the PG schema from `pg_schema.py`)

**Delivers:** Shell script that provisions Ubuntu + PostgreSQL + nginx + SSL.

**Constraints:**
- The PostgreSQL schema used by the script must be generated from
  `pg_schema.py` — never maintained separately. A utility script
  `tools/export_pg_schema.py` produces a `schema.sql` for the server
  setup script to run.
- Any future migration added to `pg_schema.py` must also be reflected
  in the server migration process.

---

### 5D — User management and access control

**Depends on:** 5A (auth hook), 5B (connection UI), 5C (server running)

**Delivers:** `users` table, login, JWT tokens, `project_members` table,
per-route membership checks.

**Constraints:**
- `resolve_user()` stub in `app/auth.py` (5A) is replaced with real
  JWT validation. **No other files change** due to the hook design.
- `require_project_access` decorator (5A) is activated — it now actually
  checks `project_members`. Added to routes by decorating the route
  functions. This is the **only route file change in all of Phase 5**.
- In local mode, the decorator always passes through — existing behaviour
  unchanged.
- New tables: `users`, `project_members`. These exist only in PostgreSQL
  (added to `PG_MIGRATIONS`). SQLite schema is untouched.
- The `/api/auth/login` endpoint is new in 5D. All other endpoints gain
  `@require_project_access` decorators but their logic does not change.

---

### 5E — Backup and data export for cloud users

**Depends on:** 5D (need to know which projects a user can access)

**Delivers:** "Download backup" in database menu for cloud users, server
cron job (part of 5C setup script).

**Constraints:**
- The JSON export format is already defined by the existing export routes.
  5E re-uses these routes — no new export logic needed.
- In local mode, the existing export UI is unchanged.
- The "Download backup" menu item is shown only when `mode == "cloud"`.

---

### 5F — Real-time sync

**Depends on:** 5D (need user rooms), 5A (Blinker signal)

**Delivers:** Flask-SocketIO, per-project rooms, broadcast on write,
version counter conflict detection.

**Constraints:**
- The `data_changed` signal (5A) is subscribed to by Flask-SocketIO here.
  **Zero route changes** if the auto-broadcast-from-commit approach is used.
- `version` column added to `tasks` table (new migration in both SQLite
  and PG lists). Conflict check added to `update_task` route — this is
  the only route logic change in 5F.
- Flask-SocketIO requires `eventlet` or `gevent` as the async worker.
  PyInstaller spec must be updated to include the chosen worker.
- In local mode (single user), SocketIO is initialised but rooms are
  empty — no performance impact.

---

## 4. Files that will change across Phase 5 — full map

| File | 5A | 5B | 5C | 5D | 5E | 5F |
|---|---|---|---|---|---|---|
| `app/database.py` | Major rewrite | — | — | New tables to PG list | — | New migration |
| `app/pg_schema.py` | Created | — | — | New tables | — | New migration |
| `app/auth.py` | Created (stub) | — | — | Real implementation | — | — |
| `app/__init__.py` | before_request, signal | — | — | — | — | SocketIO init |
| `app/routes/*.py` | Zero changes | Zero changes | — | Add decorators only | Zero changes | 1 change in tasks.py |
| `main.py` | Mode guards on JsApi | 2 new JsApi methods | — | — | — | — |
| `requirements.txt` | psycopg2-binary | keyring | — | PyJWT, bcrypt | — | flask-socketio, eventlet |
| `static/js/main.js` | — | Mode check on load | — | Login flow | — | SocketIO client |
| `static/js/components/db-menu.js` | — | Connect/disconnect UI | — | — | Download backup | — |
| `ProjectTracker.spec` | — | — | — | — | — | eventlet hidden imports |
| `installer/ProjectTracker.iss` | — | — | — | — | — | — |

---

## 5. Things that must NOT be done

- **Do not change any route SQL** to add `%s` or `RETURNING id` manually —
  the wrapper handles this. Doing so would break SQLite mode.
- **Do not add auth checks directly in route functions** — use the decorator.
- **Do not maintain the PostgreSQL schema separately** from `pg_schema.py` —
  always generate from source.
- **Do not open PostgreSQL connections outside of `get_connection()`** —
  the pool must be the only connection source.
- **Do not add SocketIO broadcast calls directly in routes** — use the signal.

---

## 6. Resolved decisions

All three open questions have been resolved. These are final.

### Decision 10: Credential storage — OS keychain via `keyring`

**Resolved:** Use the `keyring` Python library, which stores credentials in
Windows Credential Manager. This is the correct approach for a desktop app —
the OS handles security properly and there is no key-management problem.

AES encryption was considered but rejected: it requires storing a derived key
somewhere on disk, which provides no meaningful security advantage over storing
the credentials directly.

**Implementation notes:**
- Add `keyring` to `requirements.txt`
- Add `keyring` and its backends to `hiddenimports` in `ProjectTracker.spec`
- Credentials stored under service name `ProjectTracker` with the hostname
  as the username key

---

### Decision 11: Authentication tokens — JWT with 8-hour expiry + refresh tokens

**Resolved:** Use JWT (JSON Web Tokens) signed with a server-side secret.
Access tokens expire after 8 hours. A refresh token (longer-lived, stored
securely on the client) allows silent renewal without re-login.

Session tokens were considered but rejected: they require a `sessions` table
on the server, adding complexity to backup, migration, and the 5F real-time
sync setup (stateless JWT works across any server instance without shared
session storage).

**Emergency revocation:** Rotating the server's JWT signing secret immediately
invalidates all issued tokens — sufficient for a small team deployment.

**Implementation notes:**
- Add `PyJWT` to `requirements.txt`
- JWT secret stored in server environment variable, never in code
- Access token: 8-hour expiry, contains `user_id` and `role`
- Refresh token: 30-day expiry, stored in `keyring` on the client

---

### Decision 12: Flask-SocketIO async worker — eventlet

**Resolved:** Use `eventlet` as the async worker for Flask-SocketIO.

`gevent` was considered but rejected: it has a more complex PyInstaller
bundling story and known conflicts with some psycopg2 connection pool
configurations — exactly the stack we are running.

**Implementation notes:**
- Add `flask-socketio` and `eventlet` to `requirements.txt`
- Add `eventlet` and its dependencies to `hiddenimports` in
  `ProjectTracker.spec`
- Call `eventlet.monkey_patch()` at the top of `main.py` before any other
  imports when in cloud/server mode

4. **Offline mode:** If a cloud user loses connectivity, does the app show
   an error or fall back to read-only from cache? Out of scope for Phase 5
   but worth noting as a Phase 6 item.
