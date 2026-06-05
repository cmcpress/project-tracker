# Project Tracker — Architecture Reference

> **Purpose:** This document is the single reference for the codebase structure,
> data model, API surface, and key conventions. Read this at the start of any
> development session before touching code. Update it whenever something structural
> changes.
>
> *Last updated: 2026-06-02*

---

## 1. What the app is

A desktop project management application built on:

- **Python / Flask** — REST API server
- **pywebview** — wraps a WebView2 browser window around the Flask server, making it a native desktop app
- **SQLite** — single-file database, stored locally on the user's machine
- **Vanilla JS (ES modules)** — no build step, no framework
- **PyInstaller** — packages everything into a single Windows `.exe` directory

There is no separate frontend build process. The browser loads `static/index.html`
and imports JS modules directly. Flask serves both the API (`/api/...`) and the
static files.

---

## 2. File structure

```
Project Tracker App/
├── main.py                  Entry point. Starts Flask + pywebview. Houses JsApi.
├── requirements.txt
├── ProjectTracker.spec      PyInstaller build spec
├── ROADMAP.md               Feature roadmap and phase planning
├── ARCHITECTURE.md          This document
├── dev-online-version.md    Planning doc for cloud/collaborative version
│
├── app/
│   ├── __init__.py          Flask app factory — creates app, registers blueprints
│   ├── database.py          SQLite connection management + versioned migrations
│   ├── models.py            Dataclasses + enumerated constants (STATUSES, TASK_TYPES…)
│   └── routes/
│       ├── projects.py      /api/projects  (CRUD, expenses, earned value, reorder)
│       ├── tasks.py         /api/tasks     (CRUD, status, reorder, people assign)
│       ├── people.py        /api/people    (CRUD, task assignment)
│       ├── dependencies.py  /api/dependencies  (CRUD)
│       ├── items.py         /api/items     (task sub-items: notes/components/expenses)
│       ├── phases.py        /api/phases    (Gantt header phase banners)
│       ├── baselines.py     /api/baselines (date snapshots, restore)
│       ├── unavailability.py /api/unavailability (per-person blocked dates)
│       ├── categories.py    /api/categories (project categories)
│       ├── templates.py     /api/templates (save/apply task group templates)
│       ├── links.py         /api/links     (project URL/file links, open-link)
│       ├── settings.py      /api/settings  (key/value app config)
│       ├── export.py        /api/export, /api/import, /api/critical-path
│       └── db.py            /api/db/info   (database path endpoint)
│
└── static/
    ├── index.html           Single-page app shell
    ├── css/
    │   ├── variables.css    CSS custom properties — colours, spacing, typography
    │   ├── base.css         Reset, body, typography defaults
    │   ├── components.css   Buttons, badges, cards, form inputs, modals, toasts
    │   ├── layout.css       Topbar, sidebar, main area, db-menu, context-menu
    │   ├── gantt.css        Gantt chart specific styles
    │   ├── kanban.css       Kanban board specific styles
    │   ├── table.css        Table view specific styles
    │   ├── calendar.css     Calendar view specific styles
    │   └── timeline.css     Timeline view specific styles
    └── js/
        ├── main.js          Bootstrap: router, sidebar, topbar, data load
        ├── router.js        View lifecycle manager (init/render/destroy)
        ├── api.js           All fetch calls to the Flask API
        ├── state.js         In-memory app state (projects, people, active view)
        ├── utils.js         Shared helpers (el(), formatDate(), pendingIndicator()…)
        ├── toast.js         Toast notification system
        ├── components/
        │   ├── modal.js         createModal() — overlay + close button + wide/xl variants
        │   ├── task-form.js     Add/edit task modal (the largest component)
        │   ├── project-form.js  Add/edit project modal
        │   ├── people-form.js   People manager modal
        │   ├── phase-form.js    Add/edit Gantt phase modal
        │   ├── link-form.js     Project links manager modal
        │   ├── sidebar.js       Left sidebar — project list, navigation
        │   ├── db-menu.js       Database dropdown (New/Open/Recent/Export/Import)
        │   └── context-menu.js  Right-click context menu system
        └── views/
            ├── dashboard.js    Dashboard — project cards (clickable title → Cards view), Overdue, Up Next, Chase Required, People panels
            ├── cards.js        Cards view — task list per project with sidebar
            ├── gantt.js        Gantt — SVG chart, drag/resize, dependencies, PDF export
            ├── table.js        Table — spreadsheet-style task list
            ├── kanban.js       Kanban — drag-and-drop status columns
            ├── calendar.js     Calendar — monthly grid, task pills
            ├── timeline.js     Timeline — multi-project horizontal swimlane
            ├── resource.js     Resource — per-person SVG swimlane
            ├── expenses.js     Expenses — budget vs spend per project
            └── settings.js     Settings — categories, currency symbol, cards/sidebar defaults, show archived, dark mode, logging toggle
```

---

## 3. Startup sequence

```
main.py
  └─ start_flask_server()         starts Flask on a random port in a daemon thread
  └─ webview.create_window(...)   opens the OS window pointing at http://localhost:{port}
  └─ webview.start(js_api=JsApi()) begins the event loop

Browser loads index.html
  └─ main.js bootstraps:
       1. initRouter(container)   registers view registry, stores container ref
       2. initSidebar()           renders project list, wires sidebar clicks
       3. initTopbarNav()         wires view-switch buttons
       4. loadAppData()           fetches /api/projects + /api/people → State
       5. navigateTo("dashboard") loads and renders the default view
       6. initDbMenu()            wires database dropdown
```

---

## 4. Data model

All dates are stored as ISO 8601 strings (`YYYY-MM-DD`). All IDs are
auto-incrementing integers. Foreign keys are enforced (`PRAGMA foreign_keys = ON`).

### Tables

#### `projects`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| category | TEXT | FK-like reference to categories.name (not enforced) |
| status | TEXT | not-started / planning / in-progress / blocked / complete |
| description | TEXT | |
| colour | TEXT | Hex colour, e.g. `#4a90e2` |
| sort_order | INTEGER | Manual drag-reorder position |
| archived | INTEGER | 0 = active (default), 1 = archived; hidden from all views unless show_archived_projects is on |
| created_at / updated_at | TEXT | ISO datetime, updated_at maintained by trigger |

#### `tasks`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| project_id | INTEGER FK | → projects.id, CASCADE delete |
| name | TEXT | |
| type | TEXT | task / milestone / phase / group |
| status | TEXT | not-started / planning / in-progress / blocked / pending / complete |
| start_date / end_date | TEXT | Planned dates |
| duration_days | INTEGER | |
| is_firm_date | INTEGER | 0/1 — locks the date in Gantt |
| actual_start_date / actual_end_date | TEXT | |
| baseline_start_date / baseline_end_date | TEXT | Stored on task for quick access |
| notes | TEXT | Free text; also parsed for structured links |
| progress | REAL | 0.0–1.0 |
| parent_id | INTEGER FK | → tasks.id (self-ref), NULL = top-level |
| wbs_number | TEXT | e.g. "1.2.3" — stored as text to avoid float drift |
| rag | TEXT | red / amber / green / NULL |
| budget | REAL | Planned spend in currency units |
| estimated_hours | REAL | Planned effort in hours |
| logged_hours | REAL | Actual hours recorded |
| pending_until | TEXT | ISO date — expected delivery when status = pending |
| sort_order | INTEGER | |
| completed_at / created_at / updated_at | TEXT | |

#### `people`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT | |
| role | TEXT | |
| email | TEXT | |
| colour | TEXT | Hex, shown in avatars |

#### `task_people` (junction)
| Column | Type | Notes |
|---|---|---|
| task_id | INTEGER FK | → tasks.id |
| person_id | INTEGER FK | → people.id |
| PRIMARY KEY | | (task_id, person_id) |

#### `dependencies`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| predecessor_id | INTEGER FK | → tasks.id |
| successor_id | INTEGER FK | → tasks.id |
| type | TEXT | FS / SS / FF / SF |
| lag_days | INTEGER | |

#### `task_items`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| task_id | INTEGER FK | → tasks.id |
| content | TEXT | |
| item_type | TEXT | note / component / expense |
| is_complete | INTEGER | 0/1 |
| value | REAL | Cash amount (component/expense only) |
| sort_order | INTEGER | |

#### `phases`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| project_id | INTEGER FK | → projects.id |
| name | TEXT | |
| start_date / end_date | TEXT | |
| colour | TEXT | |
| sort_order | INTEGER | |

#### `baselines`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| project_id | INTEGER FK | → projects.id |
| name | TEXT | |
| saved_at | TEXT | |
| notes | TEXT | |

#### `baseline_tasks`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| baseline_id | INTEGER FK | → baselines.id |
| task_id | INTEGER FK | → tasks.id |
| start_date / end_date / duration_days | | Snapshot values |

#### `unavailability`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| person_id | INTEGER FK | → people.id |
| start_date / end_date | TEXT | Inclusive range; single day = same date |
| label | TEXT | e.g. "Holiday", "Training" |

#### `categories`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT UNIQUE | |
| colour | TEXT | |
| sort_order | INTEGER | |

#### `templates` + `template_tasks`
Templates are date-agnostic snapshots of a task group. `template_tasks` mirrors
the tasks schema but stores `start_offset` / `end_offset` (days from group start)
instead of absolute dates. `parent_ref` stores the original `sort_order` of the
parent so hierarchy is reconstructed on apply.

#### `project_links`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| project_id | INTEGER FK | → projects.id |
| name | TEXT | Display name |
| url | TEXT | Web URL or local file path |
| sort_order | INTEGER | |

#### `settings`
Key/value table. Persisted settings:

| Key | Default | Description |
|---|---|---|
| `currency_symbol` | `£` | Symbol shown next to budget and expense amounts |
| `cards_default_expanded` | `false` | Cards view: expand all project cards on load |
| `sidebar_categories_expanded` | `true` | Sidebar: expand category groups on load |
| `show_archived_projects` | `false` | Show archived projects in sidebar and all views |
| `dark_mode` | `false` | Dark colour scheme |
| `enable_logging` | `true` | Write diagnostic log file on startup |

#### `schema_version`
Single-column table holding the current migration version integer.

---

## 5. Migration system

Migrations live in `app/database.py` as a list of `(version: int, sql: str)` tuples.

**Rules:**
- Never alter or delete existing migrations
- Add new migrations with the next unused version number
- `init_db()` is called at startup and on every database switch — it applies any
  outstanding migrations in version order, then commits
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` for new cols)
- The `schema_version` table stores the highest applied version

**Current version: 12**

| Version | What it added |
|---|---|
| 1 | Core schema: projects, tasks, people, dependencies, task_items, baselines |
| 2 | categories table + default category seed data |
| 3 | tasks: parent_id, wbs_number, progress |
| 4 | phases table |
| 5 | unavailability table |
| 6 | task_items.value, tasks.budget, settings table |
| 7 | tasks.rag |
| 8 | templates + template_tasks tables |
| 9 | project_links table |
| 10 | tasks.pending_until |
| 11 | projects.archived |
| 12 | tasks.estimated_hours, tasks.logged_hours |

---

## 6. API reference

All routes return JSON. Error responses use Flask's `abort()` with a JSON body
`{"error": "message"}`. All write endpoints require a `Content-Type: application/json`
body.

### Projects
| Method | URL | Description |
|---|---|---|
| GET | `/api/projects` | List all projects with task counts and link_count |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get single project (full detail) |
| PUT | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (cascades to tasks) |
| PUT | `/api/projects/reorder` | Update sort_order for multiple projects |
| GET | `/api/projects/:id/expenses` | Budget vs spend breakdown |
| GET | `/api/projects/:id/earned-value` | EV metrics (PV, EV, CPI, SPI) |
| GET | `/api/projects/:id/critical-path` | Critical path task IDs |

### Tasks
| Method | URL | Description |
|---|---|---|
| GET | `/api/projects/:id/tasks` | List tasks for a project (with assignees) |
| POST | `/api/projects/:id/tasks` | Create task |
| GET | `/api/tasks/:id` | Get single task |
| PUT | `/api/tasks/:id` | Update task (all writable fields) |
| DELETE | `/api/tasks/:id` | Delete task (with group/cascade options) |
| PUT | `/api/tasks/:id/status` | Update status only (Kanban drag) |
| PUT | `/api/tasks/reorder` | Bulk sort_order update |
| POST | `/api/tasks/:id/people/:pid` | Assign person to task |
| DELETE | `/api/tasks/:id/people/:pid` | Unassign person from task |

### People
| Method | URL | Description |
|---|---|---|
| GET | `/api/people` | List all people |
| POST | `/api/people` | Create person |
| PUT | `/api/people/:id` | Update person |
| DELETE | `/api/people/:id` | Delete person |

### Dependencies
| Method | URL | Description |
|---|---|---|
| GET | `/api/tasks/:id/dependencies` | List dependencies for a task |
| POST | `/api/dependencies` | Create dependency |
| PUT | `/api/dependencies/:id` | Update dependency (type/lag) |
| DELETE | `/api/dependencies/:id` | Delete dependency |

### Task Items
| Method | URL | Description |
|---|---|---|
| GET | `/api/tasks/:id/items` | List items for a task |
| POST | `/api/tasks/:id/items` | Create item |
| PUT | `/api/items/:id` | Update item |
| DELETE | `/api/items/:id` | Delete item |
| PUT | `/api/tasks/:id/items/reorder` | Reorder items |

### Phases
| Method | URL | Description |
|---|---|---|
| GET | `/api/projects/:id/phases` | List phases for a project |
| POST | `/api/projects/:id/phases` | Create phase |
| PUT | `/api/phases/:id` | Update phase |
| DELETE | `/api/phases/:id` | Delete phase |

### Baselines
| Method | URL | Description |
|---|---|---|
| GET | `/api/projects/:id/baselines` | List baselines |
| POST | `/api/projects/:id/baselines` | Create (save) baseline |
| GET | `/api/baselines/:id` | Get baseline with task snapshots |
| DELETE | `/api/baselines/:id` | Delete baseline |
| POST | `/api/projects/:id/baselines/:bid/restore` | Restore baseline dates to tasks |

### Unavailability
| Method | URL | Description |
|---|---|---|
| GET | `/api/people/:id/unavailability` | List for one person |
| POST | `/api/people/:id/unavailability` | Create entry |
| PUT | `/api/unavailability/:id` | Update entry |
| DELETE | `/api/unavailability/:id` | Delete entry |
| GET | `/api/projects/:id/unavailability` | All entries for people on a project |
| GET | `/api/unavailability/all` | All entries across all people |

### Categories
| Method | URL | Description |
|---|---|---|
| GET | `/api/categories` | List all categories |
| POST | `/api/categories` | Create category |
| PUT | `/api/categories/:id` | Update category |
| DELETE | `/api/categories/:id` | Delete category |

### Templates
| Method | URL | Description |
|---|---|---|
| GET | `/api/templates` | List all templates |
| POST | `/api/templates` | Save group task as template |
| GET | `/api/templates/:id` | Get template with tasks |
| DELETE | `/api/templates/:id` | Delete template |
| POST | `/api/templates/:id/apply` | Apply template to a project |

### Project Links
| Method | URL | Description |
|---|---|---|
| GET | `/api/projects/:id/links` | List links for a project |
| POST | `/api/projects/:id/links` | Create link |
| PUT | `/api/links/:id` | Update link |
| DELETE | `/api/links/:id` | Delete link |
| POST | `/api/open-link` | Ask OS to open a URL or file path |

### Settings
| Method | URL | Description |
|---|---|---|
| GET | `/api/settings` | Get all settings as key → value dict |
| PUT | `/api/settings/:key` | Update a setting value |

### Export / Import
| Method | URL | Description |
|---|---|---|
| POST | `/api/export/project/:id/pdf` | Generate Gantt PDF (reportlab, A3 landscape) |
| GET | `/api/export/project/:id/gantt` | SVG/PNG Gantt export |
| GET | `/api/export/data` | Full JSON backup of all data |
| GET | `/api/export/data/excel` | Full Excel export |
| POST | `/api/import/data` | Import a JSON backup (with ID remapping) |

### Misc
| Method | URL | Description |
|---|---|---|
| GET | `/api/db/info` | Returns current database file path |

---

## 7. JavaScript architecture

### State (`state.js`)
Central in-memory store. Holds: projects list, people list, active project ID,
active view name, currency symbol. Views subscribe to state changes via
`State.subscribe(key, callback)`. The sidebar and router both use state.

### Router (`router.js`)
Manages view lifecycle. Each view module must export:
- `init(container)` — called once when the view first activates
- `render()` — called to re-render with fresh data
- `destroy()` — called before switching away; must clean up event listeners

Views are lazy-loaded via dynamic `import()` — only the active view's code is
loaded at any time.

### API (`api.js`)
One exported function per API endpoint. All calls go through a central `request()`
helper that sets headers, parses JSON, and throws on non-2xx responses. The base
URL is auto-detected from `window.location.origin`.

### Utils (`utils.js`)
Shared helpers used across views and components:
- `el(tag, className)` — createElement shorthand
- `formatDate(d)`, `formatDateShort(d)`, `today()` — date formatting
- `STATUS_LABELS` — map of status key → display string
- `pendingIndicator(task)` — returns `"⚠"` or `"💤"` or null
- `isPendingOverdue(task)` — boolean
- `formatDuration(days)` — "3d", "2w 1d" etc.

### Modal (`components/modal.js`)
`createModal({ title, wide, xl, onClose })` — creates an overlay + modal panel,
returns `{ el, close }`. `wide` = 720px, `xl` = 940px. The task form uses `xl`
to accommodate the links panel.

### Task form (`components/task-form.js`)
The largest and most complex component. `openTaskForm(task, projectId, onSaved)`.
Key features: all task fields, assignee multi-select, task items (notes/
components/expenses), dependencies manager, links panel (parses notes for
`# SECTION` / `## NAME(URL)` format), pending_until date field.

### Note links format
The task form's right-side links panel parses the `notes` field for a structured
markdown-like format:
```
# SECTION TITLE
## Display Name(https://url-or-file-path)
## Another Link(C:\path\to\file.pdf)
```
`#` creates a section heading. `##` creates a clickable link. The URL inside
`()` can be `http://`, `https://`, `file://`, `ftp://`, or a Windows path
(`C:\...` or `\\server\...`).

---

## 8. Python ↔ JavaScript bridge (JsApi)

pywebview exposes a `JsApi` class instance to the browser at
`window.pywebview.api`. Methods are called as `await window.pywebview.api.method(args)`.
All methods return a dict.

| Method | Returns | Description |
|---|---|---|
| `get_db_path()` | `{path}` | Current database file path |
| `new_db()` | `{ok, path/error}` | Open Save dialog, create new database |
| `load_db()` | `{ok, error?}` | Open dialog, switch to chosen database |
| `export_db()` | `{ok, path/error}` | Save dialog, SQLite backup copy |
| `get_recent_dbs()` | `{recents: [{path, name}]}` | Recently opened databases |
| `open_recent_db(path)` | `{ok, error?}` | Switch to a specific path (no dialog) |
| `save_file(b64, filename)` | `{ok, path/error}` | Save dialog for file downloads |
| `get_log_path()` | `{path}` | Path of the startup log file |
| `open_log_folder()` | `{ok, error?}` | Open the log file's containing folder in Explorer |

Config is persisted to `config.json` in the OS app data directory. Keys:
`last_db` (string), `recent_dbs` (list of strings, max 8).

App settings (currency symbol, dark mode, logging, etc.) are stored in the
`settings` table of the active SQLite database — not in `config.json`.

**Log file location:**
- Bundled `.exe`: `%APPDATA%\ProjectTracker\startup.log`
- Script mode: `<project root>/startup.log`

File logging is skipped on startup if `enable_logging = "false"` in the settings
table. The preference is read directly from SQLite before any log handlers are
attached, so it takes effect immediately on the next launch after the user changes it.

---

## 9. CSS conventions

All colour, spacing, and typography values are CSS custom properties defined in
`variables.css`. Never hard-code these values in component CSS.

Key tokens:
- `--space-1` through `--space-8` — spacing scale
- `--font-size-xs` through `--font-size-xl` — type scale
- `--text-primary`, `--text-secondary`, `--text-muted` — text colours
- `--surface`, `--border`, `--grey-100` — surface and border colours
- `--blue`, `--green`, `--red`, `--amber` — semantic colours
- `--status-{status}-bg`, `--status-{status}-text` — per-status colour pairs
- `--radius`, `--radius-full` — border radius
- `--shadow-sm`, `--shadow-lg` — box shadows
- `--transition-fast` — transition duration

Dark mode is implemented as a `[data-theme="dark"]` override block in
`variables.css` — no component code needs to change. It is toggled from Settings
and persisted in the `settings` table. The theme attribute is applied to
`document.documentElement` on load and on toggle.

---

## 10. Adding a new feature — checklist

**New database field:**
1. Add a migration entry to `MIGRATIONS` in `database.py` with the next version number
2. Add the field to the relevant dataclass in `models.py`
3. Add the field to the relevant route's validation function and SQL queries
4. Add the field to `api.js` if it needs to be sent from the frontend
5. Add the field to any relevant export/import in `routes/export.py`

**New API endpoint:**
1. Add the route function to the appropriate file in `app/routes/`
2. Register the blueprint in `app/__init__.py` if it's a new file
3. Add the corresponding fetch function to `api.js`
4. Add the new route file to `hiddenimports` in `ProjectTracker.spec` if it's a new module

**New view:**
1. Create `static/js/views/newview.js` exporting `init`, `render`, `destroy`
2. Add it to `VIEW_REGISTRY` in `router.js`
3. Add a nav button in `index.html`
4. Add any view-specific CSS in a new `static/css/newview.css` and link in `index.html`

**New JS component:**
1. Create `static/js/components/newcomponent.js`
2. Import and call it from whatever view or component needs it
3. No registration needed — ES module imports handle it

---

## 11. PyInstaller packaging

The app is packaged with PyInstaller using `ProjectTracker.spec`. Key points:

- `onedir` mode (not `onefile`) — produces a `dist/ProjectTracker/` folder
- UPX disabled — avoids antivirus false positives
- The `static/` folder is included as a data file: `('static', 'static')`
- Flask blueprint modules must be listed in `hiddenimports` — PyInstaller cannot
  detect dynamic imports. If a new route file is added, it must be added here.
- Run: `pyinstaller ProjectTracker.spec --noconfirm`

---

*End of architecture reference.*
