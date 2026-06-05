# Project Tracker

A desktop project management application for Windows, built with Python, Flask, SQLite, and pywebview.

## What it does

Project Tracker is a standalone Windows desktop app for managing multiple projects and their tasks. It provides a suite of views — Gantt chart, Kanban board, Calendar, Timeline, Resource planner, and more — all backed by a local SQLite database that lives on your machine.

**Current version: alpha 0.33**

---

## Features

- **Projects** — create and manage multiple projects with categories, colours, status, and descriptions
- **Tasks** — full task hierarchy (groups, sub-tasks, milestones, phases) with WBS numbering, dependencies, RAG status, and progress tracking
- **People** — assign team members to tasks, manage availability and unavailability periods
- **Views** — Dashboard, Cards, Gantt, Table, Kanban, Calendar, Timeline, Resource, Expenses
- **Gantt chart** — SVG Gantt with drag/resize, zoom levels, phase banners, dependency arrows, baselines, critical path, and PDF export
- **Budget and expenses** — per-task budgets and line-item expenses with earned value metrics (CPI/SPI)
- **Time tracking** — estimated and logged hours per task
- **Bulk actions** — multi-select tasks in Table view for batch status/RAG/assignee changes
- **Templates** — save task groups as reusable templates
- **Export** — JSON backup, Excel, PDF Gantt, per-project export
- **Dark mode** — toggle in Settings
- **Database management** — create, open, export, and switch between multiple databases

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop window | pywebview (WebView2 / Edge) |
| API server | Python / Flask |
| Database | SQLite |
| Frontend | Vanilla JS (ES modules), no framework |
| Packaging | PyInstaller (onedir) + Inno Setup 6 |

---

## Installation

Download the latest installer from the [Releases](../../releases) page and run it. The installer will:

- Install the app to `Program Files\ProjectTracker\`
- Create Start Menu and Desktop shortcuts
- Install Microsoft WebView2 Runtime if not already present

User data is stored in `%APPDATA%\ProjectTracker\` and is never touched by the installer or uninstaller.

---

## Building from source

### Requirements

- Python 3.12+
- Inno Setup 6 — https://jrsoftware.org/isinfo.php
- `MicrosoftEdgeWebview2Setup.exe` in the `installer\` folder — https://go.microsoft.com/fwlink/p/?LinkId=2124703

### Build

```
build.bat
```

This runs PyInstaller followed by Inno Setup and produces:

- `dist\ProjectTracker\ProjectTracker.exe` — the app bundle
- `installer\output\ProjectTracker_Setup_alpha_0.33.exe` — the installer

To build the app bundle only (no installer):

```
build.bat /apponly
```

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full reference covering file structure, data model, API surface, and development conventions.

See [ROADMAP.md](ROADMAP.md) for the feature roadmap and phase planning.

---

## Version history

Builds are numbered in increments of 0.01 during the alpha phase.
Each release is a self-contained installer: `ProjectTracker_Setup_alpha_0.xx.exe`.

---

## Licence

Private — all rights reserved.
