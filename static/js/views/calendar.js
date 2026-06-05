/**
 * views/calendar.js -- Monthly calendar view.
 *
 * Tasks appear as coloured pills on their end_date.
 * Tasks with no end_date are listed below the grid.
 * Month nav arrows + Today button in the header.
 * Project dropdown filters to one project or all.
 * Click any pill to open the task edit form.
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { openTaskForm } from "../components/task-form.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container       = null;
let _projects        = [];
let _allTasks        = [];   // flat, _projectColour/_projectName injected
let _filterProjectId = null;
let _year            = new Date().getFullYear();
let _month           = new Date().getMonth(); // 0-based
let _unavailMap      = {};   // "YYYY-MM-DD" → ["Alice", "Bob", ...]

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
  _container   = null;
  _projects    = [];
  _allTasks    = [];
  _unavailMap  = {};
}

// ---------------------------------------------------------------------------
// Data
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
  await _fetchUnavailability();
  _buildLayout();
  _renderCalendar();
}

async function _fetchUnavailability() {
  try {
    const entries = await API.listAllUnavailability();
    _unavailMap = {};
    for (const e of entries) {
      const sd = new Date(e.start_date + "T00:00:00");
      const ed = new Date(e.end_date   + "T00:00:00");
      const cur = new Date(sd);
      while (cur <= ed) {
        const key = _isoDate(cur);
        if (!_unavailMap[key]) _unavailMap[key] = [];
        if (!_unavailMap[key].includes(e.person_name)) _unavailMap[key].push(e.person_name);
        cur.setDate(cur.getDate() + 1);
      }
    }
  } catch (_) {
    _unavailMap = {};
  }
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
// Layout (header + body shell — built once)
// ---------------------------------------------------------------------------

function _buildLayout() {
  _container.innerHTML = "";
  _container.className = "main__content main__content--fill calendar-view";

  // Header
  const header = _el("div", "calendar-header");

  // Left: project filter
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
    _renderCalendar();
  });
  projGroup.append(projLabel, projSel);

  // Centre: month navigation
  const nav = _el("div", "calendar-nav");

  const prevBtn = _el("button", "btn btn--ghost btn--icon");
  prevBtn.innerHTML = "&#8249;";
  prevBtn.style.fontSize = "20px";
  prevBtn.title = "Previous month";
  prevBtn.addEventListener("click", () => {
    _month--;
    if (_month < 0) { _month = 11; _year--; }
    _renderCalendar();
  });

  const monthLabel = _el("div", "calendar-month-label");
  monthLabel.id = "cal-month-label";

  const nextBtn = _el("button", "btn btn--ghost btn--icon");
  nextBtn.innerHTML = "&#8250;";
  nextBtn.style.fontSize = "20px";
  nextBtn.title = "Next month";
  nextBtn.addEventListener("click", () => {
    _month++;
    if (_month > 11) { _month = 0; _year++; }
    _renderCalendar();
  });

  nav.append(prevBtn, monthLabel, nextBtn);

  // Right: Today button
  const todayBtn = _el("button", "btn btn--ghost btn--sm");
  todayBtn.textContent = "Today";
  todayBtn.addEventListener("click", () => {
    const now = new Date();
    _year  = now.getFullYear();
    _month = now.getMonth();
    _renderCalendar();
  });

  header.append(projGroup, nav, todayBtn);

  // Body
  const body = _el("div", "calendar-body");
  body.id = "cal-body";

  _container.append(header, body);
}

// ---------------------------------------------------------------------------
// Calendar rendering (re-runs on month/filter change)
// ---------------------------------------------------------------------------

function _renderCalendar() {
  const body = _container.querySelector("#cal-body");
  if (!body) return;
  body.innerHTML = "";

  // Update month label
  const label = _container.querySelector("#cal-month-label");
  if (label) {
    label.textContent = new Date(_year, _month, 1)
      .toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const lastDay  = new Date(_year, _month + 1, 0);
  const firstDay = new Date(_year, _month, 1);

  // Build lookup: "YYYY-MM-DD" -> [task, ...]
  const byDate = {};
  const noDate = [];
  _allTasks.forEach(task => {
    if (!task.end_date) { noDate.push(task); return; }
    const key = task.end_date.slice(0, 10);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(task);
  });

  // Grid
  const grid = _el("div", "calendar-grid");

  // Day-of-week headers (Mon-Sun)
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(d => {
    const h = _el("div", "calendar-weekday");
    h.textContent = d;
    grid.appendChild(h);
  });

  // Leading blanks (Mon-based: JS Sun=0 -> Mon=0)
  const startDow = (firstDay.getDay() + 6) % 7;
  for (let i = 0; i < startDow; i++) {
    grid.appendChild(_el("div", "calendar-day calendar-day--outside"));
  }

  // Day cells
  for (let d = 1; d <= lastDay.getDate(); d++) {
    const date    = new Date(_year, _month, d);
    const dateStr = _isoDate(date);
    const isToday = date.getTime() === today.getTime();

    const unavailNames = _unavailMap[dateStr] || [];
    const isUnavail = unavailNames.length > 0;

    const cell = _el("div", "calendar-day" + (isToday ? " calendar-day--today" : "") + (isUnavail ? " calendar-day--unavail" : ""));
    if (isUnavail) {
      cell.title = "Unavailable: " + unavailNames.join(", ");
    }

    const num = _el("div", "calendar-day__number");
    num.textContent = d;
    cell.appendChild(num);

    (byDate[dateStr] || []).forEach(task => cell.appendChild(_buildPill(task)));

    grid.appendChild(cell);
  }

  // Trailing blanks to fill last row
  const totalCells = startDow + lastDay.getDate();
  const remainder  = totalCells % 7;
  if (remainder !== 0) {
    for (let i = remainder; i < 7; i++) {
      grid.appendChild(_el("div", "calendar-day calendar-day--outside"));
    }
  }

  body.appendChild(grid);

  // No-date section
  if (noDate.length) {
    const section = _el("div", "calendar-no-date");
    const title   = _el("div", "calendar-no-date__title");
    title.textContent = "Tasks without a due date";
    section.appendChild(title);
    const list = _el("div", "calendar-no-date__list");
    noDate.forEach(task => list.appendChild(_buildPill(task)));
    section.appendChild(list);
    body.appendChild(section);
  }
}

// ---------------------------------------------------------------------------
// Task pill
// ---------------------------------------------------------------------------

function _buildPill(task) {
  const pill = _el("div", "calendar-task");
  pill.style.background = task._projectColour || "#4a90e2";
  pill.title = task.name + (task._projectName ? " • " + task._projectName : "");

  const dot = _el("span", "calendar-task__dot");
  const lbl = _el("span");
  lbl.textContent = task.name;
  pill.append(dot, lbl);

  pill.addEventListener("click", () => {
    openTaskForm(task, task.project_id, async (saved) => {
      const idx = _allTasks.findIndex(t => t.id === saved.id);
      if (idx !== -1) {
        _allTasks[idx] = {
          ...saved,
          _projectName:   task._projectName,
          _projectColour: task._projectColour,
        };
      }
      _renderCalendar();
    });
  });

  return pill;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _isoDate(d) {
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
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
        <div class="empty-state__icon">&#9888;</div>
        <div class="empty-state__title">Error</div>
        <div class="empty-state__body">${msg}</div>
      </div>`;
  }
}
