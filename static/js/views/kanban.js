/**
 * views/kanban.js — Kanban board view.
 *
 * Layout:
 *   .kanban-view (flex column)
 *     toolbar  — project filter dropdown
 *     .kanban-board — one .kanban-column per status, horizontal scroll
 *
 * Drag & drop uses the HTML5 native API:
 *   dragstart on .kanban-card  -> stores taskId in dataTransfer
 *   dragover  on .kanban-column__cards -> preventDefault to allow drop
 *   drop      on .kanban-column__cards -> API.updateTaskStatus -> re-render board
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { openTaskForm } from "../components/task-form.js";

// ---------------------------------------------------------------------------
// Column definitions (order = left to right on the board)
// ---------------------------------------------------------------------------

const COLUMNS = [
  { status: "not-started", label: "Not Started", icon: "○" },
  { status: "planning",    label: "Planning",    icon: "◎" },
  { status: "in-progress", label: "In Progress", icon: "◑" },
  { status: "blocked",     label: "Blocked",     icon: "⊗" },
  { status: "pending",     label: "Pending",     icon: "💤" },
  { status: "complete",    label: "Complete",    icon: "●" },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container       = null;
let _projects        = [];
let _allTasks        = [];   // flat list, _projectName/_projectColour injected
let _filterProjectId = null; // null = all projects

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;
  await _loadAndRender();
}

export async function render() {
  await _loadAndRender();
}

export function destroy() {
  _container = null;
  _projects  = [];
  _allTasks  = [];
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function _loadAndRender() {
  try {
    _projects = await API.listProjects();
  } catch (e) {
    _showError("Failed to load projects: " + e.message);
    return;
  }

  if (!_projects.length) {
    _container.innerHTML = `
      <div class="empty-state" style="padding-top:var(--space-8);">
        <div class="empty-state__icon">📋</div>
        <div class="empty-state__title">No projects yet</div>
        <div class="empty-state__body">Create a project first, then add tasks to see them here.</div>
      </div>`;
    return;
  }

  // Sidebar selection overrides the toolbar dropdown filter
  _filterProjectId = State.getActiveProjectId() || null;

  await _fetchTasks();
  _buildLayout();
  _renderBoard();
}

async function _fetchTasks() {
  const targets = _filterProjectId
    ? _projects.filter(p => p.id === _filterProjectId)
    : _projects;

  const results = await Promise.allSettled(
    targets.map(p => API.listTasks(p.id))
  );

  _allTasks = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    const proj = targets[i];
    (r.value || []).forEach(task => {
      _allTasks.push({
        ...task,
        _projectName:   proj.name,
        _projectColour: proj.colour || "#4a90e2",
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Layout (toolbar + board shell)
// ---------------------------------------------------------------------------

function _buildLayout() {
  _container.innerHTML = "";
  _container.className = "main__content main__content--fill kanban-view";

  // Toolbar
  const toolbar = _el("div", "gantt-toolbar");

  const projGroup = _el("div", "gantt-toolbar__group");
  const projLabel = _el("span", "gantt-toolbar__label");
  projLabel.textContent = "Project:";

  const projSel = _el("select", "btn btn--ghost");
  projSel.style.cssText = "font-size:var(--font-size-sm);height:28px;padding:0 var(--space-2);cursor:pointer;";

  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.text  = "All projects";
  projSel.appendChild(allOpt);

  _projects.forEach(p => {
    const opt = document.createElement("option");
    opt.value    = p.id;
    opt.text     = p.name;
    opt.selected = p.id === _filterProjectId;
    projSel.appendChild(opt);
  });

  projSel.addEventListener("change", async () => {
    _filterProjectId = projSel.value ? parseInt(projSel.value, 10) : null;
    await _fetchTasks();
    _renderBoard();
  });

  projGroup.append(projLabel, projSel);
  toolbar.appendChild(projGroup);

  // Board
  const board = _el("div", "kanban-board");
  board.id = "kanban-board";

  _container.append(toolbar, board);
}

// ---------------------------------------------------------------------------
// Board rendering
// ---------------------------------------------------------------------------

function _renderBoard() {
  const board = _container.querySelector("#kanban-board");
  if (!board) return;
  board.innerHTML = "";
  COLUMNS.forEach(col => {
    const tasks = _allTasks.filter(t => t.status === col.status);
    board.appendChild(_buildColumn(col, tasks));
  });
}

function _buildColumn(col, tasks) {
  const column = _el("div", `kanban-column kanban-column--${col.status}`);

  // Header
  const header = _el("div", "kanban-column__header");
  const title  = _el("div", "kanban-column__title");

  const iconEl = _el("span");
  iconEl.style.cssText = `color:var(--status-${col.status}-text);font-size:12px;line-height:1;`;
  iconEl.textContent = col.icon;

  const labelEl = _el("span");
  labelEl.textContent = col.label;

  const count = _el("span", "kanban-column__count");
  count.textContent = tasks.length;

  title.append(iconEl, labelEl);
  header.append(title, count);

  // Cards drop zone
  const cards = _el("div", "kanban-column__cards");
  cards.dataset.status = col.status;

  cards.addEventListener("dragover", (e) => {
    e.preventDefault();
    cards.classList.add("is-drag-over");
  });
  cards.addEventListener("dragleave", (e) => {
    if (!cards.contains(e.relatedTarget)) {
      cards.classList.remove("is-drag-over");
    }
  });
  cards.addEventListener("drop", async (e) => {
    e.preventDefault();
    cards.classList.remove("is-drag-over");
    const taskId    = parseInt(e.dataTransfer.getData("text/plain"), 10);
    const newStatus = cards.dataset.status;
    if (!taskId || !newStatus) return;

    const task = _allTasks.find(t => t.id === taskId);
    if (!task || task.status === newStatus) return;

    // Optimistic update
    task.status = newStatus;
    _renderBoard();

    try {
      await API.updateTaskStatus(taskId, newStatus);
      window.App?.toast?.("Status updated", "success");
    } catch (err) {
      window.App?.toast?.("Failed to update status: " + err.message, "error");
      await _fetchTasks();
      _renderBoard();
    }
  });

  tasks.forEach(task => cards.appendChild(_buildCard(task)));
  column.append(header, cards);
  return column;
}

// ---------------------------------------------------------------------------
// Task card
// ---------------------------------------------------------------------------

function _buildCard(task) {
  const card = _el("div", "kanban-card");
  card.draggable = true;
  card.dataset.taskId = task.id;

  card.addEventListener("dragstart", (e) => {
    card.classList.add("is-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("is-dragging");
  });
  card.addEventListener("click", () => {
    openTaskForm(task, task.project_id, async (saved) => {
      const idx = _allTasks.findIndex(t => t.id === saved.id);
      if (idx !== -1) {
        _allTasks[idx] = {
          ...saved,
          _projectName:   task._projectName,
          _projectColour: task._projectColour,
        };
      }
      _renderBoard();
    });
  });

  // Project tag — only in "All projects" mode
  if (!_filterProjectId) {
    const tag = _el("div", "kanban-card__project-tag");
    const dot = _el("span", "kanban-card__project-dot");
    dot.style.background = task._projectColour;
    const tagName = _el("span");
    tagName.textContent = task._projectName;
    tag.append(dot, tagName);
    card.appendChild(tag);
  }

  // Task name
  const name = _el("div", "kanban-card__name");
  name.textContent = task.name;
  card.appendChild(name);

  // Footer: type badge + due date
  const footer = _el("div", "kanban-card__footer");
  footer.style.cssText = "display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:var(--space-2);";

  const badge = _el("span");
  badge.style.cssText = "font-size:var(--font-size-xs);padding:1px 6px;border-radius:var(--radius-full);background:var(--grey-100);color:var(--text-secondary);font-weight:500;";
  badge.textContent = _typeLabel(task.type);
  footer.appendChild(badge);

  // Pending indicator — ⚠ if overdue, 💤 if within window
  if (task.status === "pending") {
    const todayStr = new Date().toISOString().slice(0, 10);
    const isOverduePending = task.pending_until && task.pending_until < todayStr;
    const pip = _el("span");
    pip.style.cssText = `font-size:11px;color:${isOverduePending ? "#f59e0b" : "var(--status-pending-text, #7c3aed)"};`;
    pip.textContent = isOverduePending ? "⚠" : "💤";
    pip.title = isOverduePending
      ? "Pending overdue — expected " + (task.pending_until || "unknown")
      : "Pending — expected by " + (task.pending_until || "unknown");
    footer.appendChild(pip);
  }

  if (task.end_date) {
    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const due     = new Date(task.end_date + "T00:00:00");
    const overdue = due < today && task.status !== "complete";
    const dueEl   = _el("span", "kanban-card__due" + (overdue ? " kanban-card__due--overdue" : ""));
    dueEl.textContent = (overdue ? "⚠ " : "") + _fmtDate(due);
    footer.appendChild(dueEl);
  }

  card.appendChild(footer);
  return card;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _typeLabel(type) {
  return { task: "Task", milestone: "Milestone", phase: "Phase" }[type] || type || "Task";
}

function _fmtDate(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function _el(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function _showError(msg) {
  if (_container) {
    _container.innerHTML = `
      <div class="empty-state" style="padding-top:var(--space-8);">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Error</div>
        <div class="empty-state__body">${msg}</div>
      </div>`;
  }
}
