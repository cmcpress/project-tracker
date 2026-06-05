/**
 * views/timeline.js -- Project-level roadmap / timeline view.
 *
 * One row per project, month columns across the top.
 * Each row shows all tasks for that project as horizontal bars
 * positioned by start_date / end_date.
 * A dashed today line runs the full height of the chart.
 * Click any bar to open the task edit form.
 *
 * Layout:
 *   .timeline-view (flex column)
 *     .gantt-toolbar    -- zoom buttons + today button (reuse gantt styles)
 *     .timeline-body    -- overflow:auto
 *       .timeline-header  -- sticky top: label col + month cells
 *       .timeline-row x N -- label col + track with positioned bars
 */

import * as API from "../api.js";
import { openTaskForm } from "../components/task-form.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_H    = 52;   // px per project row
const HDR_H    = 36;   // px for month header
const LABEL_W  = 160;  // px for project label column
const PAD_MO   = 1;    // padding months on each side
const MS_DAY   = 86_400_000;

// Zoom levels: how many px per day
const ZOOM = {
  quarter: { dayPx: 3,  label: "Quarter" },
  month:   { dayPx: 8,  label: "Month"   },
  week:    { dayPx: 20, label: "Week"     },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container  = null;
let _projects   = [];   // [{id, name, colour, ...}]
let _taskMap    = {};   // projectId -> [task, ...]
let _zoom       = "month";
let _origin     = null; // Date: first day of the leftmost month
let _unavailMap = {};   // "YYYY-MM-DD" → ["Alice", "Bob", ...]

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
  _container  = null;
  _projects   = [];
  _taskMap    = {};
  _unavailMap = {};
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
        <div class="empty-state__body">Create a project to see it on the timeline.</div>
      </div>`;
    return;
  }

  // Fetch all tasks + unavailability in parallel
  const [taskResults, unavailEntries] = await Promise.all([
    Promise.allSettled(_projects.map(p => API.listTasks(p.id))),
    API.listAllUnavailability().catch(() => []),
  ]);
  _taskMap = {};
  taskResults.forEach((r, i) => {
    _taskMap[_projects[i].id] = r.status === "fulfilled" ? (r.value || []) : [];
  });

  // Build unavail map: "YYYY-MM-DD" → ["Alice", ...]
  _unavailMap = {};
  for (const e of (unavailEntries || [])) {
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

  _buildLayout();
  _renderTimeline();
}

// ---------------------------------------------------------------------------
// Layout (toolbar + body shell)
// ---------------------------------------------------------------------------

function _buildLayout() {
  _container.innerHTML = "";
  _container.className = "main__content main__content--fill timeline-view";

  // Toolbar (reuse gantt-toolbar styles)
  const toolbar = _el("div", "gantt-toolbar");

  // Zoom buttons
  const zoomGroup = _el("div", "gantt-toolbar__group");
  const zoomLabel = _el("span", "gantt-toolbar__label");
  zoomLabel.textContent = "Zoom:";
  zoomGroup.appendChild(zoomLabel);

  const zoomBtns = {};
  Object.keys(ZOOM).forEach(z => {
    const btn = _el("button", "gantt-toggle" + (z === _zoom ? " is-active" : ""));
    btn.textContent = ZOOM[z].label;
    btn.addEventListener("click", () => {
      _zoom = z;
      Object.values(zoomBtns).forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      _renderTimeline();
    });
    zoomBtns[z] = btn;
    zoomGroup.appendChild(btn);
  });

  const sep = _el("div", "gantt-toolbar__separator");

  // Today button
  const todayBtn = _el("button", "gantt-toggle");
  todayBtn.textContent = "Today";
  todayBtn.addEventListener("click", _scrollToToday);

  toolbar.append(zoomGroup, sep, todayBtn);

  // Body
  const body = _el("div", "timeline-body");
  body.id = "tl-body";

  _container.append(toolbar, body);
}

// ---------------------------------------------------------------------------
// Timeline rendering
// ---------------------------------------------------------------------------

function _renderTimeline() {
  const body = _container.querySelector("#tl-body");
  if (!body) return;
  body.innerHTML = "";

  const { dayPx } = ZOOM[_zoom];

  // Compute date range across all tasks
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let minMs = today.getTime();
  let maxMs = today.getTime();

  _projects.forEach(p => {
    (_taskMap[p.id] || []).forEach(t => {
      if (t.start_date) minMs = Math.min(minMs, _parseDate(t.start_date).getTime());
      if (t.end_date)   maxMs = Math.max(maxMs, _parseDate(t.end_date).getTime());
    });
  });

  // Snap origin to first of month, padded
  const minDate = new Date(minMs);
  _origin = new Date(minDate.getFullYear(), minDate.getMonth() - PAD_MO, 1);

  const maxDate   = new Date(maxMs);
  const endMonth  = new Date(maxDate.getFullYear(), maxDate.getMonth() + PAD_MO + 1, 1);
  const totalDays = Math.ceil((endMonth - _origin) / MS_DAY);
  const chartW    = LABEL_W + totalDays * dayPx;

  // ── Sticky header ─────────────────────────────────────────────────────────
  const header = _el("div", "timeline-header");
  header.style.width = chartW + "px";

  const hdrLabel = _el("div", "timeline-header__label-col");
  hdrLabel.style.height = HDR_H + "px";
  header.appendChild(hdrLabel);

  const months = _el("div", "timeline-header__months");
  months.style.position = "relative";

  // Draw month cells
  let cur = new Date(_origin);
  while (cur < endMonth) {
    const mo     = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const days   = Math.ceil((mo - cur) / MS_DAY);
    const cell   = _el("div", "timeline-header__month");
    cell.style.cssText = `flex:none;width:${days * dayPx}px;box-sizing:border-box;`;
    cell.textContent = cur.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    months.appendChild(cell);
    cur = mo;
  }
  header.appendChild(months);
  body.appendChild(header);

  // ── Today line (absolute, spans all rows) ─────────────────────────────────
  const todayX = LABEL_W + _dateToX(today, dayPx);
  if (todayX >= LABEL_W) {
    const todayLine = _el("div", "timeline-today-line");
    todayLine.style.cssText = `
      position:sticky;
      left:${todayX}px;
      top:0;
      width:2px;
      height:0;           /* visual line drawn per-row instead */
      pointer-events:none;
    `;
    // We'll draw it inline per row for simpler positioning
  }

  // ── Project rows ───────────────────────────────────────────────────────────
  _projects.forEach(proj => {
    const tasks = (_taskMap[proj.id] || []).filter(t => t.start_date);
    const row   = _buildRow(proj, tasks, dayPx, totalDays, todayX, chartW);
    body.appendChild(row);
  });

  // Scroll to show today
  requestAnimationFrame(() => _scrollToToday());
}

function _buildRow(proj, tasks, dayPx, totalDays, todayX, chartW) {
  const row = _el("div", "timeline-row");
  row.style.width = chartW + "px";

  // Label
  const label = _el("div", "timeline-row__label");
  label.style.cssText = `width:${LABEL_W}px;flex-shrink:0;box-sizing:border-box;`;

  const dot = _el("div", "timeline-row__project-dot");
  dot.style.background = proj.colour || "#4a90e2";

  const name = _el("div", "timeline-row__project-name");
  name.textContent = proj.name;
  name.title = proj.name;

  label.append(dot, name);

  // Track
  const track = _el("div", "timeline-row__track");
  track.style.cssText = `flex:1;position:relative;height:${ROW_H}px;overflow:hidden;`;

  // Today line within this row
  const tX = todayX - LABEL_W; // relative to track
  if (tX >= 0 && tX <= totalDays * dayPx) {
    const tLine = _el("div");
    tLine.style.cssText = `
      position:absolute;
      left:${tX}px;
      top:0;
      bottom:0;
      width:2px;
      background:var(--gantt-today);
      opacity:0.5;
      pointer-events:none;
      z-index:2;
    `;
    track.appendChild(tLine);
  }

  // Unavailability shading (amber bands, behind task bars)
  const { dayPx: _dp } = ZOOM[_zoom]; // same dayPx as passed arg
  const cur = new Date(_origin);
  for (let d = 0; d < totalDays; d++) {
    const key = _isoDate(cur);
    const names = _unavailMap[key];
    if (names && names.length > 0) {
      const band = _el("div");
      band.style.cssText = `
        position:absolute;
        left:${d * dayPx}px;
        top:0;
        width:${dayPx}px;
        height:100%;
        background:rgba(245,158,11,0.18);
        pointer-events:none;
        z-index:0;
      `;
      band.title = "Unavailable: " + names.join(", ");
      track.appendChild(band);
    }
    cur.setDate(cur.getDate() + 1);
  }

  // Task bars
  tasks.forEach(task => {
    const bar = _buildBar(task, proj, dayPx);
    if (bar) track.appendChild(bar);
  });

  row.append(label, track);
  return row;
}

function _buildBar(task, proj, dayPx) {
  if (!task.start_date) return null;

  const startMs = _parseDate(task.start_date).getTime();
  const endMs   = _parseDate(task.end_date || task.start_date).getTime();
  const x       = _dateToX(_parseDate(task.start_date), dayPx);
  const w       = Math.max(
    Math.ceil((endMs - startMs) / MS_DAY + 1) * dayPx,
    task.type === "milestone" ? 12 : 6
  );

  const bar = _el("div", "timeline-bar");

  if (task.type === "milestone") {
    // Diamond shape for milestones
    bar.style.cssText = `
      left:${x}px;
      width:12px;
      height:12px;
      transform:translateY(-50%) rotate(45deg);
      top:50%;
      background:var(--gantt-milestone);
      border-radius:2px;
    `;
  } else {
    const isDone = task.status === "complete";
    bar.style.cssText = `
      left:${x}px;
      width:${w}px;
      background:${isDone ? "var(--gantt-complete)" : proj.colour || "var(--gantt-bar)"};
      opacity:${isDone ? "1" : "0.85"};
      color:#fff;
      font-size:var(--font-size-xs);
      padding:0 var(--space-1);
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    `;
    if (w > 30) bar.textContent = task.name;
  }

  bar.title = task.name + " (" + _statusLabel(task.status) + ")"
    + (task.start_date ? "\n" + _fmtDisplay(task.start_date) : "")
    + (task.end_date   ? " → " + _fmtDisplay(task.end_date) : "");

  bar.addEventListener("click", () => {
    openTaskForm(task, task.project_id, async (saved) => {
      const arr = _taskMap[proj.id] || [];
      const idx = arr.findIndex(t => t.id === saved.id);
      if (idx !== -1) arr[idx] = saved;
      _renderTimeline();
    });
  });

  return bar;
}

// ---------------------------------------------------------------------------
// Scroll to today
// ---------------------------------------------------------------------------

function _scrollToToday() {
  const body = _container?.querySelector("#tl-body");
  if (!body || !_origin) return;
  const { dayPx } = ZOOM[_zoom];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const x     = LABEL_W + _dateToX(today, dayPx);
  body.scrollLeft = Math.max(0, x - body.clientWidth / 2);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _dateToX(date, dayPx) {
  if (!_origin) return 0;
  return Math.round((date.getTime() - _origin.getTime()) / MS_DAY * dayPx);
}

function _isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function _parseDate(str) {
  if (!str) return null;
  return new Date(str + "T00:00:00");
}

function _fmtDisplay(str) {
  const d = _parseDate(str);
  if (!d) return str;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function _statusLabel(status) {
  return {
    "not-started": "Not started",
    "planning":    "Planning",
    "in-progress": "In progress",
    "blocked":     "Blocked",
    "complete":    "Complete",
  }[status] || status || "";
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
