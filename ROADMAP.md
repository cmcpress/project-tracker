# Project Tracker — Development Roadmap

## Status key
- ✅ Complete
- 🔄 In progress
- 📋 Planned
- 💡 Future idea

---

## Version control and build numbering

### Alpha phase (current)
Builds are numbered incrementally in steps of 0.01, starting at 0.01.
The app is still in alpha — no stable API or data format guarantees.

**Build archive format:** `ProjectTracker_alpha_0.xx.zip`
Each zip contains the PyInstaller output: the `.exe` and its accompanying internal folder.

**Current build: alpha 0.33**

Builds are created manually after each significant change:
1. Run `build.bat` (`pyinstaller ProjectTracker.spec --noconfirm`)
2. Zip `dist/ProjectTracker/` (the `.exe` + internal folder)
3. Name the zip `ProjectTracker_alpha_0.xx.zip` (incrementing by 0.01)
4. Store the zip as a backup

### Beta phase (future)
When the app reaches a feature-complete, stable state suitable for wider use,
the version number will be reset and a new scheme applied (e.g. `0.9.0` or `1.0.0-beta`).
The zip naming convention will be updated to match at that point.

### Cloud/multi-user builds (Phase 5)
Server-side builds will follow a separate versioning scheme to be defined when
Phase 5 development begins. The desktop client version and server version will
be tracked independently.

---

## Completed

### Core app shell
- ✅ Python/Flask REST API + SQLite backend
- ✅ Vanilla JS ES-module SPA (no framework)
- ✅ pywebview desktop window (Windows)
- ✅ PyInstaller `.exe` packaging (onedir, UPX disabled)
- ✅ Database versioned migrations system
- ✅ Config persistence — remembers last-opened database across restarts
- ✅ OS window title shows active database path

### Data model
- ✅ Projects (name, category, status, colour, description)
- ✅ Tasks (name, type, status, planned dates, actual dates, duration, progress, sort order, notes)
- ✅ Task types: task, group, phase, milestone
- ✅ WBS hierarchy — parent/child tasks with collapsible groups
- ✅ People — full CRUD, assignable to tasks, unavailability periods
- ✅ Task items (notes and checklist items per task)
- ✅ Task dependencies (FS/SS/FF/SF with lag)
- ✅ Phases — named date-range banners displayed on the Gantt header
- ✅ Categories — project grouping with colour, full CRUD in Settings
- ✅ Budget and expenses — per-task budget fields and line-item expenses
- ✅ RAG status — Red/Amber/Green health indicator on tasks
- ✅ Project links — named URL/file links attached to a project
- ✅ Pending status — tasks awaiting an external action, with `pending_until` date, 💤/⚠ indicators

### Views
- ✅ Cards — task list per project, sidebar group hierarchy, filters (status, search, assignee, date range)
- ✅ Gantt — SVG chart with drag/resize, zoom, WBS hierarchy, phase banners, actuals overlay, critical path, dependency arrows, drag-to-reparent, PDF export
- ✅ Table — spreadsheet-style task view with WBS indentation
- ✅ Kanban — drag-and-drop status columns including Pending
- ✅ Calendar — monthly task calendar with unavailability shading
- ✅ Timeline — multi-project swimlane view
- ✅ Resource — per-person swimlane view showing assigned tasks across all projects
- ✅ Expenses — per-project spend breakdown: budget vs spend, progress bar, per-task line items
- ✅ Dashboard — project cards with clickable title (navigates to Cards view), overdue panel, up-next panel, Chase Required panel (overdue pending tasks), people panel
- ✅ Settings — category management, currency symbol, cards/sidebar defaults, show archived, dark mode, logging toggle + log folder link

### Tooling
- ✅ JSON export (full backup) + import (with ID remapping)
- ✅ Excel export
- ✅ PDF Gantt export — renders a proper Gantt chart (reportlab, landscape A3)
- ✅ Database menu — New / Open / Export database from topbar dropdown
- ✅ Recent databases — submenu in the database menu showing the 8 most recently opened files
- ✅ Toast notifications, modal system, context menus
- ✅ Task templates — save a group task as a template, apply to any project
- ✅ Earned value metrics — PV, EV, CPI, SPI panel per project
- ✅ Links panel in task form — parses structured markdown in notes into a clickable right-side panel
- ✅ Diagnostic logging — rotating log file on startup; enable/disable toggle in Settings with log folder link; preference persisted between sessions
- ✅ Startup overdue pending notification — modal on launch listing tasks past their pending_until date
- ✅ Per-project JSON and Excel export
- ✅ Time tracking — estimated and logged hours per task, in task form, Table view, and Expenses view
- ✅ Bulk actions in Table view — multi-select rows, floating action bar (set status, RAG, assignee, move to project)
- ✅ Archive projects — hide from all views, reveal via Settings toggle

---

## Phase 3 — Advanced features
*Largely complete.*

- ✅ 3A — Actual dates in task form
- ✅ 3B — RAG status
- ✅ 3C — Dark mode
- ✅ 3D — Resource view
- ✅ 3E — Task templates
- ✅ 3F — Drag-to-reparent in Gantt
- ✅ 3G — Earned value metrics
- 📋 3H — Recurring tasks *(deferred to Phase 4)*

---

## Phase 4 — Polish and feature completion
*Next phase. Build these before touching the cloud architecture.*

### 4A — Documentation (ARCHITECTURE.md)
**What:** A single reference document covering architecture overview, file map,
data model (all tables and relationships), API surface (all endpoints), and a guide
to the migration system. Lives in the project root as `ARCHITECTURE.md`.

**Why first:** The app is large. Every session without this costs time re-reading
source files from scratch. Generating it now while the codebase is well understood
prevents compounding rework. It also becomes the foundation document for anyone
setting up a cloud instance.

**Effort:** One session.

---

### 4B — Launch notifications for overdue pending tasks ✅
Implemented. On startup, `_checkOverduePending()` in `main.js` queries for any
tasks with `status = 'pending'` and `pending_until < today` and shows a
dismissable modal listing them. The Dashboard Chase Required panel also surfaces
these tasks persistently.

---

### 4C — Archive projects ✅
Implemented. `archived` column on projects (migration v11). Toggle in Settings
reveals archived projects. Data fully preserved.

---

### 4D — Per-project export and printable task report ✅
Implemented. Per-project JSON and Excel export routes in `export.py`, wired up
in `api.js` and `db-menu.js`.

---

### 4E — Time tracking ✅
Implemented. `estimated_hours` and `logged_hours` on tasks (migration v12).
Effort fields in the task form, columns in Table view, summary in Expenses view.

---

### 4F — Bulk actions in Table view ✅
Implemented. Multi-select rows in Table view with a floating bulk action bar.
Set Status, Set RAG, Set Assignee, Move to Project actions.

---

### 4G — Dark mode ✅
Implemented. Toggle in Settings, persisted in the `settings` table, applied
via `[data-theme="dark"]` on `document.documentElement`.

---

### Phase 4 status

All Phase 4 items are complete except 4H (recurring tasks, deferred to Phase 6).

---

## Phase 5 — Cloud mode: "Connect to remote database"

### Design principle

The app stays exactly as it is for local users. Cloud access is added as a single
new option in the existing database menu: **"Connect to remote…"**

There are two distinct audiences:

**The technical person (sets up the server — does this once)**
Sets up a PostgreSQL server on a VPS (Oracle Cloud Free Tier recommended),
runs a setup script, and creates user credentials. Comfortable with a terminal.
This is a one-time job done by one person per organisation.

**The app user (connects to the server — no technical knowledge needed)**
Opens the database menu, chooses "Connect to remote…", enters the credentials
they were given, and clicks Connect. The app works identically to local mode.

---

### 5A — Database abstraction layer
**What:** The foundational piece everything else in Phase 5 depends on.
`get_connection()` in `database.py` checks the active config: if a remote
connection is saved, it returns a PostgreSQL connection pool; otherwise SQLite
as now. The rest of the app is unaware of the difference.

**SQL compatibility:** The existing schema transfers with minor changes.
Placeholder syntax changes from `?` to `%s` (psycopg2 style). Type handling
is adjusted where SQLite's flexible typing was relied upon.

**The migration system** runs against whichever database is active — same
version table, same migration list.

**Effort:** Medium. Foundational — must be built before 5B–5E.

---

### 5B — "Connect to remote" UI
**What:** A new option in the database menu opens a connection modal:

```
Host:      [                        ]
Port:      [ 5432                   ]
Database:  [                        ]
Username:  [                        ]
Password:  [••••••••••••••••        ]
           [x] Use SSL (recommended)

           [ Test Connection ]   [ Connect ]
```

On Test: attempts a connection and reports success or the error message.
On Connect: saves credentials to local config (encrypted), reconnects the app.
Title bar updates to show the remote host instead of a file path.
Disconnecting ("Switch to local") returns to the last-used local `.db` file.

Credentials are stored locally using the OS keychain or an AES-encrypted
config entry — never in plaintext.

**Effort:** Small to medium (the abstraction layer does the hard work).

---

### 5C — Server setup (technical person)
**What:** A setup script and documentation for the person provisioning the server.
This is terminal-based and intended for a technical administrator.

**Recommended stack:**
- Oracle Cloud Free Tier — ARM instance (Ubuntu 22.04), always-free, 24GB RAM available
- PostgreSQL 15 on the same machine
- nginx as reverse proxy
- Let's Encrypt SSL via Certbot (free, auto-renewing)
- systemd to keep the app running

**Setup script does:**
1. Installs Python, PostgreSQL, nginx, Certbot
2. Clones the app, installs Python dependencies
3. Generates a `SECRET_KEY`
4. Creates the PostgreSQL database and a first admin user
5. Runs database migrations
6. Configures nginx and systemd
7. Issues an SSL certificate

**Output:** A hostname, database name, and credentials ready to hand to users.

**Disk encryption:** Oracle Cloud encrypts boot volumes at rest by default.
All traffic is encrypted in transit via SSL. This covers the realistic threat
model for a self-hosted tool.

**Effort:** One session to write the script and documentation.

---

### 5D — User management and access control
**What:** When running in cloud mode, the app needs to know who each user is
and what they can access.

**Authentication:** PostgreSQL-level users for the connection itself, plus an
application-level `users` table for project membership and roles. Login is
email + password (bcrypt). OAuth (Google/Microsoft) is a future extension.

**Access model:**
- Every project has an **owner**
- The owner invites others by email with a role: **Viewer**, **Editor**, or **Admin**
- A `project_members` table links users to projects with their role
- Each API route checks membership and role before allowing the operation
- The project list returns only projects the requesting user is a member of
- Creating a project makes the creator the owner automatically
- The server administrator can see all projects for support purposes

**In local mode:** No auth, no membership checks. Behaviour unchanged.

**Effort:** Large. The biggest single piece of Phase 5.

---

### 5E — Backup and data export for cloud users
**What:** Cloud users need a way to get their data out and back it up locally,
independently of the server administrator.

**For regular users:** A "Download backup" option in the database menu when
connected to a remote database. Produces a full JSON export of all projects
the user has access to, downloadable to their machine. Same format as the
existing JSON export so it can be reimported into a local database.

**For the server administrator:** A scheduled cron job on the server runs
nightly and writes a timestamped JSON backup to a local folder (or an
S3-compatible bucket). Keeps the last 30 days. This is set up as part of
the server setup script (5C) and requires no ongoing action.

**On the locking question:** PostgreSQL has no concept of a "locked file" the
way SQLite does. Multiple users can have the app open and read any project
simultaneously with no conflict. The only case where a conflict arises is two
users saving changes to the exact same task field at exactly the same moment —
handled by the version counter in 5F.

**Effort:** Small (user-facing download button is trivial; cron job is part of 5C).

---

### 5F — Real-time sync (WebSockets)
**What:** Changes made by one user appear on all other connected users' screens
within a second, without a refresh.

**Concurrent viewing:** Any number of users can view any project simultaneously
with no conflict. Reading never blocks reading. The conflict only arises when two
users save changes to the exact same task at exactly the same moment.

**Implementation:** Flask-SocketIO on the server. Each write endpoint broadcasts
an event to all connected clients after saving. The JavaScript front-end receives
events and updates only the affected element. Clients join a "room" per project
so they only receive events for projects they have open.

**Conflict resolution and locking notification:** A `version` counter on each
task row prevents silent overwrites. If two users save the same task simultaneously,
the second save is rejected and that user sees a clear toast: *"This task was
updated by someone else while you had it open — your changes were not saved.
Reload to see the latest version."* No data is lost — the first save wins,
the second user is notified immediately.

**Effort:** Large. Do after 5D is stable.

---

### Phase 5 implementation order

| # | Item | Why this order |
|---|---|---|
| 1 | 5A Database abstraction layer | Everything else depends on this |
| 2 | 5C Server setup script | Need a real server to test against |
| 3 | 5B "Connect to remote" UI | Core user-facing feature |
| 4 | 5D User management + access control | Required before sharing with others |
| 5 | 5E Backup + download for cloud users | Small; completes the data-safety story |
| 6 | 5F Real-time sync | Polish — the app works without it, just needs a refresh |

---

### Overall recommended sequence across all phases

```
Phase 4 first — complete the desktop app properly before adding cloud complexity.
Then Phase 5 in order: abstraction layer → server → connect UI → auth → realtime.
```

The reason to do Phase 4 before Phase 5: every feature added to the local app
(time tracking, bulk actions, archive, etc.) has to work in cloud mode too.
Building them before the abstraction layer means they only need to be written once.
Building Phase 5 first and then adding Phase 4 features means testing everything
twice across two database backends.

Dark mode (4G) is complete. Recurring tasks are deferred to Phase 6.

---

## Phase 6 — Post-cloud features

These items are deferred until Phase 5 (cloud mode) is stable.

### 6A — Recurring tasks
**What:** Mark a task as recurring (weekly, fortnightly, monthly). The app
generates the next instance automatically on startup when one is due.
Instances show a 🔁 icon. Scope to weekly/monthly for v1.

**Implementation:** New fields on tasks: `recurrence_rule`, `recurrence_end_date`,
`recurrence_parent_id`. A startup function checks for tasks due to recur and
creates the next instance. Instances appear as normal tasks with a 🔁 icon.

**Effort:** Large. Complex edge cases around month-end dates and editing
"one vs all" instances. Scope carefully before starting.

---

### 6B — PRINCE2 alignment: Risk Register
**What:** A per-project risk register. Each risk has: ID (auto-generated), category
(Resource / Schedule / Scope / Technical / Budget / External), description,
probability (Low/Medium/High), impact (Low/Medium/High), RAG rating
(auto-calculated), owner (drawn from the existing People list), response/action,
and status (Open / Closed / Realised).

**Implementation:** New `risks` table, `/api/projects/:id/risks` route, `risks.js`
view tab. Leverages existing RAG and People infrastructure.

**Effort:** Small to medium.

---

### 6C — PRINCE2 alignment: Issue Register / Change Log
**What:** A per-project issue and change control log. Each entry has: type
(Issue / Change Request / Off-Specification), description, raised by, date raised,
priority, owner, and resolution notes.

**Implementation:** New `issues` table, `/api/projects/:id/issues` route,
`issues.js` view tab. Similar pattern to the Risk Register.

**Effort:** Small to medium.

---

### 6D — PRINCE2 alignment: Lessons Log
**What:** A project-level lessons log capturing what went well and what could
improve throughout delivery. Each entry has: description, category
(Went Well / Improve / Process / Technical), stage captured, and recorded by.

**Implementation:** New `lessons` table, per-project tab or Settings-level view.

**Effort:** Small.

---

### 6E — PRINCE2 alignment: Business Case
**What:** A structured per-project business case form covering: objective/reason,
expected benefits, costs (linking to existing budget data), timescale, and risk
summary. A read-only summary panel pulls live data from existing expenses and
earned value figures.

**Implementation:** New `business_case` table (one row per project), a panel in
the project detail view. No new view tab needed — embed in the existing project
structure.

**Effort:** Medium.

---

### 6F — PRINCE2 alignment: Stage gates
**What:** A special milestone type — a gate milestone — that requires an explicit
Approved / Rejected / Pending status before successor tasks can logically proceed.
Visible as a distinct marker on the Gantt and flagged on the Dashboard.

**Implementation:** Extend the existing milestone task type with a `gate_status`
field. Gantt renders gate milestones with a distinct diamond style. No hard
enforcement of task locking in v1 — visual indicator only.

**Effort:** Small to medium.

---

### 6G — PRINCE2 alignment: Structured roles on People
**What:** Add a structured role dropdown to the People form — Executive, Senior
User, Senior Supplier, Project Manager, Team Manager, Project Support, or Custom
— alongside the existing free-text field. Allows PRINCE2 governance structure to
be recorded without enforcing it.

**Implementation:** New `prince2_role` column on `people` table (migration),
dropdown in the People form.

**Effort:** Small.

---

*Last updated: 2026-06-02*
