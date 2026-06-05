/**
 * views/gantt.js — Full Gantt chart implementation.
 *
 * Layout:
 *   .gantt-view (flex column, full height)
 *     .gantt-toolbar       — project picker + zoom + today button
 *     .gantt-content       — label panel + scroll area (flex row)
 *       .gantt-labels      — sticky left HTML rows, translateY scroll-synced
 *       .gantt-scroll      — overflow:auto, houses sticky header + main SVG
 *
 * Coordinates:
 *   _chartOrigin = earliest task date − PAD_DAYS
 *   x = (date − _chartOrigin) * dayPx
 *   y = rowIndex * ROW_H   (inside main SVG; header SVG is separate)
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { openTaskForm } from "../components/task-form.js";
import { createModal } from "../components/modal.js";
import { openPhaseForm } from "../components/phase-form.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_H    = 36;          // px height per task row
const HDR_H    = 52;          // px height of date header (month/week rows)
const PHASE_H  = 24;          // px height of phase banner row below date header
const LABEL_W  = 320;         // px width of label panel (wider for WBS)
const WBS_W    = 50;          // px width of WBS number column
const INDENT_PX = 16;         // px indent per depth level
const PAD_DAYS = 14;          // padding days added on each side of task range
const SVG_NS   = "http://www.w3.org/2000/svg";
const MS_DAY   = 86_400_000;  // milliseconds per day

const ZOOM_LEVELS = {
  week:    { dayPx: 28, id: "week"    },
  month:   { dayPx: 8,  id: "month"   },
  quarter: { dayPx: 3,  id: "quarter" },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container   = null;
let _projects    = [];
let _projectId   = null;
let _tasks       = [];
let _zoom        = "month";
let _chartOrigin = null;   // Date — leftmost date on the chart canvas

// Tooltip DOM element (appended to body once, reused)
let _tooltip     = null;

// Cached DOM refs (set in _buildLayout, used in _renderAll)
let _scrollEl    = null;
let _labelsBody  = null;
let _mainSvg     = null;

// Bar move/resize drag state
let _drag        = null;
// shape: { type:"move"|"resize", taskId, startMouseX, origStartMs, origEndMs,
//          dayPx, moved:bool }

// Dependency-link drag state
let _depDrag     = null;
// shape: { predecessorId, startSvgX, startSvgY }
let _depPreviewG = null;   // <g> appended to _mainSvg for the live preview line

// Prevent click-after-drag opening edit form
let _justDragged = false;

// Undo stack — each entry: { taskId, prevStart, prevEnd, nextStart, nextEnd }
// Populated after each successful drag-save; cleared on project switch.
let _undoStack   = [];
let _undoBtn     = null;  // ref to the toolbar button so we can update its label

// Actuals + critical path
let _showActuals      = false;
let _criticalPathIds  = new Set();
let _showCriticalPath = false;

// Phase 1: WBS hierarchy — collapsed group IDs
let _collapsedGroups  = new Set();

// Phase 2: phase header banners
let _phases           = [];   // [{id, project_id, name, start_date, end_date, colour, ...}]

// Unavailability
let _unavailEntries   = [];   // raw entries from API [{person_id, person_name, person_colour, start_date, end_date, label}]
let _unavailMap       = {};   // "YYYY-MM-DD" → ["Alice", "Bob", ...]  (for quick lookup)
let _notableDatesCollapsed = false; // collapse state for the "Notable Dates" virtual group

// Named handler refs so we can remove them on destroy
function _onDocMouseMove(e) { _handleMouseMove(e); }
function _onDocMouseUp(e)   { _handleMouseUp(e);   }
function _onDocMouseTip(e)  { _repositionTooltip(e); }

// ---------------------------------------------------------------------------
// Hierarchy helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of parentId → [childTask, ...] from the flat task list.
 * Also returns depthOf: taskId → depth number.
 */
function _buildHierarchyMaps(tasks) {
  const childrenOf = {}; // null key = top-level
  tasks.forEach(t => {
    const pid = t.parent_id ?? null;
    if (!childrenOf[pid]) childrenOf[pid] = [];
    childrenOf[pid].push(t);
  });

  const depthOf = {};
  function assignDepth(taskId, depth) {
    depthOf[taskId] = depth;
    (childrenOf[taskId] || []).forEach(c => assignDepth(c.id, depth + 1));
  }
  (childrenOf[null] || []).forEach(t => assignDepth(t.id, 0));

  return { childrenOf, depthOf };
}

/**
 * Build the visible task list in depth-first order, honouring _collapsedGroups.
 * Each task gets a `_depth` annotation.
 */
function _buildVisibleList(tasks, childrenOf, depthOf) {
  const result = [];
  const emitted = new Set();

  function walk(parentId) {
    (childrenOf[parentId] || []).forEach(task => {
      result.push({ ...task, _depth: depthOf[task.id] ?? 0 });
      emitted.add(task.id);
      // Recurse into children unless this group is collapsed
      if (!_collapsedGroups.has(task.id)) {
        walk(task.id);
      }
    });
  }
  walk(null);

  // Truly orphaned tasks (parent deleted without reassign) — append at end.
  // Do NOT include tasks that are simply hidden under a collapsed group;
  // those have a valid parent_id that still exists in the task list.
  const allTaskIds = new Set(tasks.map(t => t.id));
  tasks.forEach(t => {
    if (!emitted.has(t.id) && (t.parent_id == null || !allTaskIds.has(t.parent_id))) {
      result.push({ ...t, _depth: 0 });
    }
  });

  return result;
}

/**
 * Compute summary date range for every group task by looking at all its
 * descendants (recursive). Returns map: taskId → {start, end} (ISO strings).
 */
function _computeGroupDates(tasks) {
  const byId = {};
  tasks.forEach(t => { byId[t.id] = t; });

  // Build children map including all descendants
  const childrenOf = {};
  tasks.forEach(t => {
    const pid = t.parent_id ?? null;
    if (!childrenOf[pid]) childrenOf[pid] = [];
    childrenOf[pid].push(t);
  });

  const groupDates = {};

  function computeRange(taskId) {
    const children = childrenOf[taskId] || [];
    let minStart = null;
    let maxEnd   = null;

    children.forEach(child => {
      // Recurse first so nested groups are computed
      if (child.type === "group") computeRange(child.id);

      // Use real dates or nested group's computed summary
      const cs = _parseDate(child.type === "group"
        ? (groupDates[child.id]?.start || child.start_date)
        : child.start_date);
      const ce = _parseDate(child.type === "group"
        ? (groupDates[child.id]?.end   || child.end_date || child.start_date)
        : (child.end_date || child.start_date));

      if (cs) minStart = minStart ? (cs < minStart ? cs : minStart) : cs;
      if (ce) maxEnd   = maxEnd   ? (ce > maxEnd   ? ce : maxEnd)   : ce;
    });

    if (minStart) {
      groupDates[taskId] = {
        start: _fmtDate(minStart),
        end:   maxEnd ? _fmtDate(maxEnd) : _fmtDate(minStart),
      };
    }
  }

  tasks.filter(t => t.type === "group").forEach(t => computeRange(t.id));
  return groupDates;
}

// ---------------------------------------------------------------------------
// Public view lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;

  // Build and attach tooltip once
  _tooltip = _makeTooltip();
  document.body.appendChild(_tooltip);
  document.addEventListener("mousemove", _onDocMouseTip);

  await _loadAndRender();
}

export async function render() {
  // Called by the router when the view is re-focused
  await _loadAndRender();
}

export function destroy() {
  document.removeEventListener("mousemove", _onDocMouseMove);
  document.removeEventListener("mouseup",   _onDocMouseUp);
  document.removeEventListener("mousemove", _onDocMouseTip);
  document.removeEventListener("keydown",   _onKeyDown);
  _tooltip?.remove();
  _tooltip     = null;
  _container   = null;
  _scrollEl    = null;
  _labelsBody  = null;
  _mainSvg     = null;
  _drag        = null;
  _depDrag     = null;
  _depPreviewG = null;
  _undoStack   = [];
  _undoBtn     = null;
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
        <div class="empty-state__body">Create a project to see it on the Gantt chart.</div>
      </div>`;
    return;
  }

  // Sidebar selection takes priority; fall back to last-used or first project
  const sidebarId = State.getActiveProjectId();
  if (sidebarId && _projects.find(p => p.id === sidebarId)) {
    _projectId = sidebarId;
  } else if (!_projectId || !_projects.find(p => p.id === _projectId)) {
    _projectId = _projects[0].id;
  }

  let tasks;
  try {
    tasks = await API.listTasks(_projectId);
  } catch (e) {
    _showError("Failed to load tasks: " + e.message);
    return;
  }
  _tasks = tasks || [];

  // Load phases and unavailability for this project (non-fatal)
  try {
    const [phases, unavail] = await Promise.all([
      API.listPhases(_projectId).catch(() => []),
      API.listProjectUnavailability(_projectId).catch(() => []),
    ]);
    _phases         = phases     || [];
    _unavailEntries = unavail    || [];
    _unavailMap     = _buildUnavailMap(_unavailEntries);
  } catch (_) {
    _phases         = [];
    _unavailEntries = [];
    _unavailMap     = {};
  }

  _buildLayout();
  _renderAll();
}

// ---------------------------------------------------------------------------
// DOM layout (called once per project/page load)
// ---------------------------------------------------------------------------

function _buildLayout() {
  _container.innerHTML = "";
  _container.className = "main__content main__content--fill gantt-view";

  // ── Toolbar ──────────────────────────────────────────────────────────────
  const toolbar = _el("div", "gantt-toolbar");

  // Project selector
  const projGroup = _el("div", "gantt-toolbar__group");
  const projLabel = _el("span", "gantt-toolbar__label");
  projLabel.textContent = "Project:";
  const projSel = _el("select", "btn btn--ghost");
  projSel.style.cssText = "font-size:var(--font-size-sm);height:28px;padding:0 var(--space-2);cursor:pointer;";
  _projects.forEach(p => {
    const opt = document.createElement("option");
    opt.value    = p.id;
    opt.text     = p.name;
    opt.selected = p.id === _projectId;
    projSel.appendChild(opt);
  });
  projSel.addEventListener("change", async () => {
    _projectId = parseInt(projSel.value, 10);
    _criticalPathIds  = new Set();
    _showCriticalPath = false;
    _collapsedGroups  = new Set();
    _undoStack        = [];
    _updateUndoBtn();
    try {
      const [tasks, phases, unavail] = await Promise.all([
        API.listTasks(_projectId),
        API.listPhases(_projectId).catch(() => []),
        API.listProjectUnavailability(_projectId).catch(() => []),
      ]);
      _tasks          = tasks      || [];
      _phases         = phases     || [];
      _unavailEntries = unavail    || [];
      _unavailMap     = _buildUnavailMap(_unavailEntries);
    } catch (e) {
      window.App?.toast?.("Failed to load tasks: " + e.message, "error");
      return;
    }
    _buildLayout();
    _renderAll();
  });
  projGroup.append(projLabel, projSel);

  // Zoom buttons
  const sep1 = _el("div", "gantt-toolbar__separator");
  const zoomGroup = _el("div", "gantt-toolbar__group");
  const zoomLabel = _el("span", "gantt-toolbar__label");
  zoomLabel.textContent = "Zoom:";
  zoomGroup.appendChild(zoomLabel);

  const zoomBtns = {};
  ["week", "month", "quarter"].forEach(z => {
    const btn = _el("button", "gantt-toggle" + (z === _zoom ? " is-active" : ""));
    btn.textContent = z.charAt(0).toUpperCase() + z.slice(1);
    btn.addEventListener("click", () => {
      _zoom = z;
      Object.values(zoomBtns).forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      _renderAll();
    });
    zoomBtns[z] = btn;
    zoomGroup.appendChild(btn);
  });

  // Today button
  const sep2 = _el("div", "gantt-toolbar__separator");
  const todayBtn = _el("button", "gantt-toggle");
  todayBtn.textContent = "Today";
  todayBtn.addEventListener("click", _scrollToToday);

  // ── Actuals toggle ────────────────────────────────────────────────────────
  const sep3 = _el("div", "gantt-toolbar__separator");

  const actualsBtn = _el("button", "gantt-toggle" + (_showActuals ? " is-active" : ""));
  actualsBtn.textContent = "Actuals";
  actualsBtn.title = "Show actual start/end date bars alongside planned dates";
  actualsBtn.addEventListener("click", () => {
    _showActuals = !_showActuals;
    actualsBtn.classList.toggle("is-active", _showActuals);
    _renderAll();
  });

  // ── Critical path ─────────────────────────────────────────────────────────
  const sep4 = _el("div", "gantt-toolbar__separator");

  const cpBtn = _el("button", "gantt-toggle" + (_showCriticalPath ? " is-active" : ""));
  cpBtn.textContent = "Critical Path";
  cpBtn.title = "Highlight tasks with zero float";
  cpBtn.addEventListener("click", async () => {
    _showCriticalPath = !_showCriticalPath;
    cpBtn.classList.toggle("is-active", _showCriticalPath);
    if (_showCriticalPath) {
      try {
        const res = await API.getCriticalPath(_projectId);
        _criticalPathIds = new Set(res.critical_path || []);
      } catch (e) {
        window.App?.toast?.("Critical path error: " + e.message, "error");
        _showCriticalPath = false;
        cpBtn.classList.remove("is-active");
        return;
      }
    } else {
      _criticalPathIds = new Set();
    }
    _renderAll();
  });

  // ── PDF export ────────────────────────────────────────────────
  const sep5 = _el("div", "gantt-toolbar__separator");

  const exportBtn = _el("button", "gantt-toggle");
  exportBtn.textContent = "Export PDF";
  exportBtn.title = "Download this Gantt chart as a PDF";
  exportBtn.addEventListener("click", async () => {
    if (!_projectId) { window.App?.toast?.("Select a project first", "error"); return; }
    exportBtn.disabled = true;
    exportBtn.textContent = "Exporting…";
    try {
      // Serialise the live SVG; replace CSS variable references with hex so
      // WeasyPrint (server-side, no stylesheet) can render colours correctly.
      const svgEl = _scrollEl ? _scrollEl.querySelector("svg.gantt-svg") : null;
      let svgStr = svgEl ? new XMLSerializer().serializeToString(svgEl) : "";
      const varMap = {
        "var(--gantt-bar)":         "#4a90e2",
        "var(--gantt-complete)":    "#22c55e",
        "var(--gantt-critical)":    "#ef4444",
        "var(--gantt-actual)":      "#16a34a",
        "var(--gantt-actual-wip)":  "#f59e0b",
        "var(--gantt-label-bg)":    "#f9fafb",
        "var(--gantt-bg)":          "#ffffff",
        "var(--gantt-row-alt)":     "#f3f4f6",
        "var(--text-primary)":      "#111827",
        "var(--text-secondary)":    "#6b7280",
        "var(--text-muted)":        "#9ca3af",
        "var(--border)":            "#e5e7eb",
        "var(--grey-300)":          "#d1d5db",
      };
      Object.entries(varMap).forEach(([v, hex]) => {
        svgStr = svgStr.split(v).join(hex);
      });

      const resp = await fetch(`/api/export/project/${_projectId}/pdf`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ svg: svgStr }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || resp.statusText);
      }
      // Use native OS save dialog in pywebview; blob-URL fallback in browser
      if (window.pywebview?.api?.save_file) {
        const arrayBuf = await resp.arrayBuffer();
        const bytes    = new Uint8Array(arrayBuf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64      = btoa(binary);
        const projName = (_projects.find(p => p.id === _projectId)?.name || "gantt")
          .replace(/[/\\:*?"<>|]/g, "_");
        const result   = await window.pywebview.api.save_file(b64, projName + ".pdf");
        if (!result.ok && result.error !== "cancelled") {
          throw new Error(result.error || "Save failed");
        }
      } else {
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = "gantt.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      window.App?.toast?.("PDF exported", "success");
    } catch (e) {
      window.App?.toast?.("Export failed: " + e.message, "error");
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "Export PDF";
    }
  });

  // ── Add Phase ─────────────────────────────────────────────────────────────
  const sep6 = _el("div", "gantt-toolbar__separator");

  const addPhaseBtn = _el("button", "gantt-toggle");
  addPhaseBtn.textContent = "+ Phase";
  addPhaseBtn.title = "Add a phase banner to the chart header";
  addPhaseBtn.addEventListener("click", () => {
    if (!_projectId) { window.App?.toast?.("Select a project first", "error"); return; }
    openPhaseForm(null, _projectId, async (saved) => {
      if (saved) {
        _phases = (await API.listPhases(_projectId).catch(() => _phases));
        _renderAll();
        window.App?.toast?.("Phase added", "success");
      }
    });
  });

  // ── Undo last drag ────────────────────────────────────────────────────────
  const sep7 = _el("div", "gantt-toolbar__separator");

  const undoBtn = _el("button", "gantt-toggle");
  undoBtn.title = "Undo last drag (Ctrl+Z)";
  _undoBtn = undoBtn;
  _updateUndoBtn();

  undoBtn.addEventListener("click", () => _doUndo());

  // Keyboard shortcut — registered on document for this view
  document.addEventListener("keydown", _onKeyDown);

  toolbar.append(projGroup, sep1, zoomGroup, sep2, todayBtn, sep3, actualsBtn, sep4, cpBtn, sep5, exportBtn, sep6, addPhaseBtn, sep7, undoBtn);

  // ── Content area (label panel + scroll) ──────────────────────────────────
  const content = _el("div", "gantt-content");
  content.style.cssText = "display:flex;flex:1;overflow:hidden;min-height:0;";

  // Label panel
  const labelsWrap = _el("div", "gantt-labels");
  labelsWrap.style.cssText = `
    width:${LABEL_W}px;
    flex-shrink:0;
    display:flex;
    flex-direction:column;
    overflow:hidden;
    border-right:1px solid var(--border);
    background:var(--gantt-label-bg);
    z-index:10;
  `;

  const labelsHdr = _el("div");
  labelsHdr.style.cssText = `
    height:${HDR_H + PHASE_H}px;
    flex-shrink:0;
    border-bottom:2px solid var(--border);
    background:var(--gantt-label-bg);
    display:flex;
    align-items:flex-end;
    font-size:var(--font-size-xs);
    font-weight:600;
    color:var(--text-secondary);
    box-sizing:border-box;
    padding-bottom:4px;
  `;
  const hdrWbs = _el("span");
  hdrWbs.textContent = "WBS";
  hdrWbs.style.cssText = `width:${WBS_W}px;flex-shrink:0;padding:0 var(--space-2);text-transform:uppercase;letter-spacing:0.05em;`;
  const hdrTask = _el("span");
  hdrTask.textContent = "Task";
  hdrTask.style.cssText = `flex:1;padding:0 var(--space-2);text-transform:uppercase;letter-spacing:0.05em;`;
  labelsHdr.append(hdrWbs, hdrTask);

  _labelsBody = _el("div");
  _labelsBody.style.cssText = "overflow:hidden;will-change:transform;flex-shrink:0;";

  labelsWrap.append(labelsHdr, _labelsBody);

  // Reparent drag listeners — attached once here so _renderAll() can clear and
  // rebuild child rows without accumulating duplicate handlers.
  _initReparentDrag(_labelsBody);

  // Scroll container
  _scrollEl = _el("div", "gantt-scroll");
  _scrollEl.addEventListener("scroll", _onScroll);

  content.append(labelsWrap, _scrollEl);
  _container.append(toolbar, content);
}

// ---------------------------------------------------------------------------
// Render chart content (called on zoom change, project change, drag end)
// ---------------------------------------------------------------------------

function _renderAll() {
  if (!_scrollEl || !_labelsBody) return;

  const { dayPx } = ZOOM_LEVELS[_zoom];

  // ── Build hierarchy ────────────────────────────────────────────────────────
  const { childrenOf, depthOf } = _buildHierarchyMaps(_tasks);
  const groupDates = _computeGroupDates(_tasks);

  // Visible list: depth-first, skipping children of collapsed groups
  const visibleTasks = _buildVisibleList(_tasks, childrenOf, depthOf);

  // Prepend "Notable Dates" virtual rows (group + per-person)
  const virtualRows = _buildNotableDateRows();
  const allRows = [...virtualRows, ...visibleTasks];

  // ── Compute date range (include group summary dates + unavailability) ──────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let minMs = today.getTime();
  let maxMs = today.getTime() + 30 * MS_DAY;

  visibleTasks.forEach(t => {
    const startStr = t.type === "group" ? (groupDates[t.id]?.start || t.start_date) : t.start_date;
    const endStr   = t.type === "group" ? (groupDates[t.id]?.end   || t.end_date)   : (t.end_date || t.start_date);
    const s = _parseDate(startStr);
    const e = _parseDate(endStr);
    if (s) minMs = Math.min(minMs, s.getTime());
    if (e) maxMs = Math.max(maxMs, e.getTime());
  });
  // Include unavailability date ranges in chart bounds
  for (const e of _unavailEntries) {
    const s = _parseDate(e.start_date);
    const en = _parseDate(e.end_date);
    if (s)  minMs = Math.min(minMs, s.getTime());
    if (en) maxMs = Math.max(maxMs, en.getTime());
  }

  _chartOrigin = new Date(minMs - PAD_DAYS * MS_DAY);
  _chartOrigin.setHours(0, 0, 0, 0);

  const totalDays = Math.ceil((maxMs - _chartOrigin.getTime()) / MS_DAY) + PAD_DAYS + 1;
  const chartW    = totalDays * dayPx;
  const chartH    = Math.max(allRows.length * ROW_H, 100);

  // ── Label rows ────────────────────────────────────────────────────────────
  _labelsBody.innerHTML = "";
  allRows.forEach((task, i) => {
    const isVirtualGroup  = !!task._isVirtualGroup;
    const isVirtualPerson = !!task._isVirtualPerson;
    const isGroup    = task.type === "group";
    const isCollapsed = isVirtualGroup
      ? _notableDatesCollapsed
      : _collapsedGroups.has(task.id);
    const hasChildren = isVirtualGroup
      ? _unavailEntries.length > 0          // Notable Dates always has children if entries exist
      : (childrenOf[task.id] || []).length > 0;
    const depth      = task._depth || 0;
    const rowBg      = (isGroup || isVirtualGroup)
      ? "var(--gantt-label-bg)"                                  // uses CSS variable, works in dark mode
      : (i % 2 ? "var(--gantt-row-alt)" : "var(--gantt-bg)");

    const row = _el("div");
    row.style.cssText = `
      height:${ROW_H}px;
      display:flex;
      align-items:center;
      font-size:var(--font-size-sm);
      color:var(--text-primary);
      border-bottom:1px solid var(--border);
      background:${rowBg};
      overflow:hidden;
      box-sizing:border-box;
      ${(isGroup || isVirtualGroup) ? "font-weight:600;" : ""}
    `;

    // WBS number column
    const wbsEl = _el("span");
    wbsEl.style.cssText = `
      width:${WBS_W}px;
      flex-shrink:0;
      padding:0 var(--space-2);
      font-size:var(--font-size-xs);
      font-family:var(--font-mono);
      color:var(--text-muted);
      white-space:nowrap;
      overflow:hidden;
    `;
    wbsEl.textContent = task.wbs_number || "";

    // Name area (indented)
    const nameArea = _el("div");
    nameArea.style.cssText = `
      flex:1;
      display:flex;
      align-items:center;
      gap:4px;
      padding-left:${depth * INDENT_PX + 4}px;
      padding-right:var(--space-2);
      min-width:0;
    `;

    // Collapse toggle
    if ((isGroup || isVirtualGroup) && hasChildren) {
      const toggle = _el("span");
      toggle.style.cssText = `
        font-size:9px;
        flex-shrink:0;
        cursor:pointer;
        color:var(--text-secondary);
        user-select:none;
        transition:transform var(--transition-fast);
        display:inline-block;
      `;
      toggle.textContent = isCollapsed ? "▶" : "▼";
      toggle.title = isCollapsed ? "Expand" : "Collapse";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isVirtualGroup) {
          _notableDatesCollapsed = !_notableDatesCollapsed;
        } else if (_collapsedGroups.has(task.id)) {
          _collapsedGroups.delete(task.id);
        } else {
          _collapsedGroups.add(task.id);
        }
        _renderAll();
      });
      nameArea.appendChild(toggle);
    } else if (isGroup || isVirtualGroup) {
      const spacer = _el("span");
      spacer.style.cssText = "width:12px;flex-shrink:0;";
      nameArea.appendChild(spacer);
    } else if (isVirtualPerson) {
      // Small coloured person dot
      const dot = _el("span");
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${task._personColour || "#f59e0b"};`;
      nameArea.appendChild(dot);
    } else {
      const iconEl = _el("span");
      iconEl.style.cssText = "font-size:9px;flex-shrink:0;color:var(--text-muted);";
      iconEl.textContent = _taskIcon(task);
      nameArea.appendChild(iconEl);
    }

    const nameEl = _el("span");
    nameEl.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;";
    nameEl.textContent = task.name;
    nameEl.title = task.name;
    nameArea.appendChild(nameEl);

    // RAG dot (shown when task has a rag value)
    if (task.rag) {
      const ragColors = { red: "#ef4444", amber: "#f59e0b", green: "#22c55e" };
      const ragTitles = { red: "Off track", amber: "At risk", green: "On track" };
      const ragDot = _el("span");
      ragDot.style.cssText = `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${ragColors[task.rag] || "#ccc"};`;
      ragDot.title = ragTitles[task.rag] || task.rag;
      nameArea.appendChild(ragDot);
    }

    // ── Drag-to-reparent handle (non-group, non-virtual tasks only) ──────────
    if (!isVirtualGroup && !isVirtualPerson && !isGroup && task.id) {
      row.draggable = true;
      row.dataset.taskId   = String(task.id);
      row.dataset.taskType = task.type;
      const reparentHandle = _el("span");
      reparentHandle.style.cssText = `
        width:14px;
        flex-shrink:0;
        text-align:center;
        color:var(--text-muted);
        opacity:0.35;
        cursor:grab;
        font-size:12px;
        padding-right:2px;
        user-select:none;
      `;
      reparentHandle.textContent = "⠿";
      reparentHandle.title = "Drag to move into a group";
      // Insert handle before wbsEl
      row.prepend(reparentHandle);
    } else if (isGroup && !isVirtualGroup && task.id) {
      // Mark group rows as valid drop targets
      row.dataset.dropTarget = String(task.id);
    }

    row.append(wbsEl, nameArea);
    _labelsBody.appendChild(row);
  });

  // ── Rebuild scroll container ──────────────────────────────────────────────
  _scrollEl.innerHTML = "";

  // Sticky date header (date ticks + phase banner row)
  const totalHdrH = HDR_H + PHASE_H;
  const hdrWrap = _el("div");
  hdrWrap.style.cssText = `
    position:sticky;
    top:0;
    z-index:5;
    width:${chartW}px;
    height:${totalHdrH}px;
    background:var(--gantt-label-bg);
    border-bottom:2px solid var(--border);
    box-sizing:border-box;
  `;
  const hdrSvg = _svgEl("svg");
  hdrSvg.setAttribute("width",  chartW);
  hdrSvg.setAttribute("height", totalHdrH);
  hdrSvg.style.display = "block";
  _buildDateHeader(hdrSvg, _chartOrigin, totalDays, dayPx);
  _buildPhaseBands(hdrSvg, _phases, _chartOrigin, dayPx, chartW);
  hdrWrap.appendChild(hdrSvg);

  // Main SVG
  _mainSvg = _svgEl("svg");
  _mainSvg.setAttribute("width",  chartW);
  _mainSvg.setAttribute("height", chartH);
  _mainSvg.classList.add("gantt-svg");
  _mainSvg.style.display = "block";

  _buildMainChart(_mainSvg, allRows, _chartOrigin, totalDays, dayPx, chartW, chartH, groupDates);

  _scrollEl.append(hdrWrap, _mainSvg);

  _scrollToToday();
}

// ---------------------------------------------------------------------------
// Date header (two-tier SVG)
// ---------------------------------------------------------------------------

function _buildDateHeader(svg, origin, totalDays, dayPx) {
  const TOP_H = 26;
  const BOT_H = HDR_H - TOP_H;

  svg.appendChild(_svgRect(0, 0, totalDays * dayPx, HDR_H, "var(--gantt-label-bg)"));

  if (_zoom === "week" || _zoom === "month") {
    _drawMonthBands(svg, origin, totalDays, dayPx, 0, TOP_H);
    _drawWeekTicks(svg, origin, totalDays, dayPx, TOP_H, BOT_H);
  } else {
    _drawQuarterBands(svg, origin, totalDays, dayPx, 0, TOP_H);
    _drawMonthTicks(svg, origin, totalDays, dayPx, TOP_H, BOT_H);
  }
}

function _drawMonthBands(svg, origin, totalDays, dayPx, y, h) {
  let cur = new Date(origin);
  cur.setHours(0, 0, 0, 0);
  let d = 0;
  while (d < totalDays) {
    const monthEnd  = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const daysLeft  = Math.ceil((monthEnd - cur) / MS_DAY);
    const bandDays  = Math.min(daysLeft, totalDays - d);
    const x = d * dayPx;
    const w = bandDays * dayPx;
    const label = cur.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    _drawBandLabel(svg, x, y, w, h, label, "var(--text-secondary)", "500", "11");
    d  += bandDays;
    cur = new Date(monthEnd);
  }
}

function _drawQuarterBands(svg, origin, totalDays, dayPx, y, h) {
  let cur = new Date(origin);
  cur.setHours(0, 0, 0, 0);
  let d = 0;
  while (d < totalDays) {
    const qMonth   = Math.floor(cur.getMonth() / 3) * 3;
    const qEnd     = new Date(cur.getFullYear(), qMonth + 3, 1);
    const daysLeft = Math.ceil((qEnd - cur) / MS_DAY);
    const bandDays = Math.min(daysLeft, totalDays - d);
    const x = d * dayPx;
    const w = bandDays * dayPx;
    const q = Math.floor(cur.getMonth() / 3) + 1;
    _drawBandLabel(svg, x, y, w, h, `Q${q} ${cur.getFullYear()}`, "var(--text-secondary)", "600", "11");
    d  += bandDays;
    cur = new Date(qEnd);
  }
}

function _drawBandLabel(svg, x, y, w, h, label, fill, weight, size) {
  const line = _svgEl("line");
  line.setAttribute("x1", x); line.setAttribute("x2", x);
  line.setAttribute("y1", y); line.setAttribute("y2", y + h);
  line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "1");
  svg.appendChild(line);

  if (w > 16) {
    const txt = _svgEl("text");
    txt.setAttribute("x",           x + 5);
    txt.setAttribute("y",           y + h / 2 + 4);
    txt.setAttribute("font-size",   size   || "11");
    txt.setAttribute("fill",        fill   || "var(--text-secondary)");
    txt.setAttribute("font-weight", weight || "500");
    txt.setAttribute("font-family", "inherit");
    txt.textContent = label;
    svg.appendChild(txt);
  }
}

function _drawWeekTicks(svg, origin, totalDays, dayPx, y, h) {
  const cur = new Date(origin);
  cur.setHours(0, 0, 0, 0);
  for (let d = 0; d < totalDays; d++) {
    if (cur.getDay() === 1) {
      const x = d * dayPx;
      const line = _svgEl("line");
      line.setAttribute("x1", x); line.setAttribute("x2", x);
      line.setAttribute("y1", y); line.setAttribute("y2", y + h);
      line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "1");
      svg.appendChild(line);
      if (dayPx >= 7) {
        const txt = _svgEl("text");
        txt.setAttribute("x",           x + 3);
        txt.setAttribute("y",           y + h / 2 + 4);
        txt.setAttribute("font-size",   "10");
        txt.setAttribute("fill",        "var(--text-muted)");
        txt.setAttribute("font-family", "inherit");
        txt.textContent = cur.getDate() + " " + cur.toLocaleDateString("en-GB", { month: "short" });
        svg.appendChild(txt);
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
}

function _drawMonthTicks(svg, origin, totalDays, dayPx, y, h) {
  let cur = new Date(origin);
  cur.setHours(0, 0, 0, 0);
  let d = 0;
  while (d < totalDays) {
    const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    const daysLeft = Math.ceil((monthEnd - cur) / MS_DAY);
    const bandDays = Math.min(daysLeft, totalDays - d);
    const x = d * dayPx;
    const w = bandDays * dayPx;
    const line = _svgEl("line");
    line.setAttribute("x1", x); line.setAttribute("x2", x);
    line.setAttribute("y1", y); line.setAttribute("y2", y + h);
    line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    if (w > 10) {
      const txt = _svgEl("text");
      txt.setAttribute("x",           x + 3);
      txt.setAttribute("y",           y + h / 2 + 4);
      txt.setAttribute("font-size",   "10");
      txt.setAttribute("fill",        "var(--text-muted)");
      txt.setAttribute("font-family", "inherit");
      txt.textContent = cur.toLocaleDateString("en-GB", { month: "short" });
      svg.appendChild(txt);
    }
    d  += bandDays;
    cur = new Date(monthEnd);
  }
}

// ---------------------------------------------------------------------------
// Notable Dates virtual rows
// ---------------------------------------------------------------------------

/**
 * Build the virtual "Notable Dates" group + per-person child rows
 * to prepend to the Gantt visible list.
 *
 * Virtual rows use negative IDs to avoid collision with real task IDs.
 * The group row (_isVirtualGroup) mirrors a real group task for styling.
 * Person rows (_isVirtualPerson) carry their raw unavailability entries
 * so the SVG renderer can draw amber bars for each date range.
 */
function _buildNotableDateRows() {
  if (!_unavailEntries.length) return [];

  // Group by person (preserve insertion order = API order)
  const byPerson = new Map();
  for (const e of _unavailEntries) {
    if (!byPerson.has(e.person_id)) {
      byPerson.set(e.person_id, {
        person_id:    e.person_id,
        name:         e.person_name,
        colour:       e.person_colour || "#f59e0b",
        entries:      [],
      });
    }
    byPerson.get(e.person_id).entries.push(e);
  }

  const people = [...byPerson.values()];
  if (!people.length) return [];

  const rows = [];

  // Header group row
  rows.push({
    _isVirtualGroup: true,
    id:          -1,
    name:        "Notable Dates",
    wbs_number:  "0.00",
    type:        "group",
    _depth:      0,
    start_date:  null,
    end_date:    null,
    dependencies: [],
  });

  if (!_notableDatesCollapsed) {
    people.forEach((p, i) => {
      rows.push({
        _isVirtualPerson: true,
        id:              -(i + 2),
        name:            p.name,
        wbs_number:      `0.${String(i + 1).padStart(2, "0")}`,
        type:            "task",
        _depth:          1,
        _personUnavail:  p.entries,
        _personColour:   p.colour,
        start_date:      null,
        end_date:        null,
        dependencies:    [],
      });
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Unavailability helpers
// ---------------------------------------------------------------------------

/**
 * Build a map of ISO date string → [person names] from an array of
 * unavailability entries (as returned by /api/projects/:id/unavailability).
 */
function _buildUnavailMap(entries) {
  const map = {};
  for (const e of entries) {
    // Expand each range into individual days
    const sd = new Date(e.start_date + "T00:00:00");
    const ed = new Date(e.end_date   + "T00:00:00");
    const cur = new Date(sd);
    while (cur <= ed) {
      const key = _fmtDate(cur);
      if (!map[key]) map[key] = [];
      if (!map[key].includes(e.person_name)) map[key].push(e.person_name);
      cur.setDate(cur.getDate() + 1);
    }
  }
  return map;
}


// ---------------------------------------------------------------------------
// Phase banner row (rendered inside the sticky header SVG, below date ticks)
// ---------------------------------------------------------------------------

/**
 * Draw coloured phase bands in the bottom PHASE_H strip of the header SVG.
 * Each band is clickable to open the edit modal.
 *
 * @param {SVGElement} svg      - The header SVG element.
 * @param {Array}      phases   - Phase objects from the API.
 * @param {Date}       origin   - Chart left-edge date.
 * @param {number}     dayPx    - Pixels per day.
 * @param {number}     chartW   - Total chart width in px.
 */
function _buildPhaseBands(svg, phases, origin, dayPx, chartW) {
  // Background strip for the phase row
  const strip = _svgRect(0, HDR_H, chartW, PHASE_H, "var(--gantt-label-bg)");
  svg.appendChild(strip);

  // Separator line between date header and phase row
  const sepLine = _svgEl("line");
  sepLine.setAttribute("x1", 0);      sepLine.setAttribute("x2", chartW);
  sepLine.setAttribute("y1", HDR_H);  sepLine.setAttribute("y2", HDR_H);
  sepLine.setAttribute("stroke", "var(--border)"); sepLine.setAttribute("stroke-width", "1");
  svg.appendChild(sepLine);

  // "Phases" label on far left (visible in the labels panel area — purely decorative here)
  // Draw each phase band
  phases.forEach(phase => {
    if (!phase.start_date && !phase.end_date) return;

    const startDate = _parseDate(phase.start_date) || _parseDate(phase.end_date);
    const endDate   = _parseDate(phase.end_date)   || _parseDate(phase.start_date);
    if (!startDate || !endDate) return;

    const x1 = _dateToX(startDate, origin, dayPx);
    const x2 = _dateToX(endDate,   origin, dayPx) + dayPx;
    const w  = Math.max(x2 - x1, 4);

    // Clamp to visible chart area
    const bx = Math.max(x1, 0);
    const bw = Math.min(x1 + w, chartW) - bx;
    if (bw <= 0) return;

    const bY = HDR_H + 3;
    const bH = PHASE_H - 6;

    const g = _svgEl("g");
    g.style.cursor = "pointer";

    // Band background
    const band = _svgEl("rect");
    band.setAttribute("x",       x1);
    band.setAttribute("y",       bY);
    band.setAttribute("width",   w);
    band.setAttribute("height",  bH);
    band.setAttribute("rx",      "3");
    band.setAttribute("fill",    phase.colour || "#6366f1");
    band.setAttribute("opacity", "0.85");
    g.appendChild(band);

    // Label (clipped to band width)
    if (bw > 20) {
      const lbl = _svgEl("text");
      lbl.setAttribute("x",              Math.max(x1, bx) + 5);
      lbl.setAttribute("y",              bY + bH / 2 + 4);
      lbl.setAttribute("font-size",      "10");
      lbl.setAttribute("font-family",    "inherit");
      lbl.setAttribute("font-weight",    "600");
      lbl.setAttribute("fill",           "#fff");
      lbl.setAttribute("pointer-events", "none");

      // Use SVG clipPath so text doesn't overflow the band
      const clipId = `phase-clip-${phase.id}`;
      let defs = svg.querySelector("defs");
      if (!defs) {
        defs = _svgEl("defs");
        svg.insertBefore(defs, svg.firstChild);
      }
      const clip = _svgEl("clipPath");
      clip.setAttribute("id", clipId);
      const clipRect = _svgEl("rect");
      clipRect.setAttribute("x",      x1 + 2);
      clipRect.setAttribute("y",      bY);
      clipRect.setAttribute("width",  Math.max(w - 4, 0));
      clipRect.setAttribute("height", bH);
      clip.appendChild(clipRect);
      defs.appendChild(clip);

      lbl.setAttribute("clip-path", `url(#${clipId})`);
      lbl.textContent = phase.name;
      g.appendChild(lbl);
    }

    // Click to edit
    g.addEventListener("click", () => {
      openPhaseForm(phase, phase.project_id, async (saved) => {
        _phases = (await API.listPhases(_projectId).catch(() => _phases));
        _renderAll();
        if (saved) {
          window.App?.toast?.("Phase updated", "success");
        } else {
          window.App?.toast?.("Phase deleted", "success");
        }
      });
    });

    // Hover highlight
    g.addEventListener("mouseenter", () => {
      band.setAttribute("opacity", "1");
    });
    g.addEventListener("mouseleave", () => {
      band.setAttribute("opacity", "0.85");
    });

    svg.appendChild(g);
  });
}

// ---------------------------------------------------------------------------
// Main chart body
// ---------------------------------------------------------------------------

function _buildMainChart(svg, tasks, origin, totalDays, dayPx, chartW, chartH, groupDates = {}) {
  _ensureArrowMarker(svg);

  // Build a set of visible real task IDs (excludes virtual rows with negative IDs)
  const visibleIds = new Set(tasks.filter(t => t.id > 0).map(t => t.id));

  // Row backgrounds + separators
  tasks.forEach((t, i) => {
    const isGroup = (t.type === "group" || t._isVirtualGroup);
    const fill = isGroup
      ? (i % 2 ? "#edf0f5" : "#f0f3f8")
      : (i % 2 ? "var(--gantt-row-alt)" : "var(--gantt-bg)");
    svg.appendChild(_svgRect(0, i * ROW_H, chartW, ROW_H, fill));
    const sep = _svgEl("line");
    sep.setAttribute("x1", 0);           sep.setAttribute("x2", chartW);
    sep.setAttribute("y1", (i+1)*ROW_H); sep.setAttribute("y2", (i+1)*ROW_H);
    sep.setAttribute("stroke", "var(--gantt-grid-line)"); sep.setAttribute("stroke-width", "1");
    svg.appendChild(sep);
  });

  _drawGridLines(svg, origin, totalDays, dayPx, chartH);
  _drawTodayLine(svg, origin, dayPx, chartH);

  // Phase bars behind task bars
  tasks.forEach((task, i) => {
    if (task.type === "phase") _drawPhaseBar(svg, task, i, origin, dayPx);
  });

  // Group summary bars (behind regular task bars)
  tasks.forEach((task, i) => {
    if (task.type === "group" && !task._isVirtualGroup) {
      _drawGroupBar(svg, task, i, origin, dayPx, groupDates);
    }
  });

  // Virtual person rows: draw amber bar segments for each unavailability range
  tasks.forEach((task, i) => {
    if (!task._isVirtualPerson) return;
    const entries = task._personUnavail || [];
    const barY    = i * ROW_H + ROW_H * 0.25;
    const barH    = ROW_H * 0.5;
    const colour  = task._personColour || "#f59e0b";

    entries.forEach(e => {
      const sd = _parseDate(e.start_date);
      const ed = _parseDate(e.end_date || e.start_date);
      if (!sd) return;

      const x = Math.round((sd.getTime() - origin.getTime()) / MS_DAY * dayPx);
      const w = Math.max(
        Math.round((ed.getTime() - sd.getTime()) / MS_DAY * dayPx) + dayPx,
        dayPx
      );

      if (x + w < 0 || x > chartW) return; // off-screen

      const rect = _svgRect(x, barY, w, barH, colour);
      rect.setAttribute("rx", "3");
      rect.setAttribute("opacity", "0.75");
      svg.appendChild(rect);

      // Label inside bar if wide enough
      if (w > 40) {
        const lbl = _svgEl("text");
        lbl.setAttribute("x", x + 4);
        lbl.setAttribute("y", barY + barH * 0.68);
        lbl.setAttribute("font-size", "10");
        lbl.setAttribute("fill", "#fff");
        lbl.setAttribute("pointer-events", "none");
        lbl.textContent = e.label || "Unavailable";
        svg.appendChild(lbl);
      }

      // Tooltip via title element
      const title = _svgEl("title");
      title.textContent = `${e.label || "Unavailable"}: ${e.start_date}${e.end_date !== e.start_date ? " – " + e.end_date : ""}`;
      rect.appendChild(title);
    });
  });

  // Dependency arrows — drawn BEFORE task bars so bar fills + text render on top,
  // preventing lines from obscuring task names. Skip if either end is hidden.
  tasks.forEach((task, i) => {
    if (task._isVirtualGroup || task._isVirtualPerson) return;
    if (!task.dependencies?.length) return;
    task.dependencies.forEach(dep => {
      if (!visibleIds.has(dep.predecessor_id) || !visibleIds.has(dep.successor_id)) return;
      const predIdx = tasks.findIndex(t => t.id === dep.predecessor_id);
      if (predIdx !== -1 && dep.successor_id === task.id) {
        _drawArrow(svg, tasks[predIdx], predIdx, task, i, origin, dayPx, dep.id, groupDates);
      }
    });
  });

  // Task bars + milestones (rendered after arrows so they sit on top)
  tasks.forEach((task, i) => {
    if (task._isVirtualGroup || task._isVirtualPerson) return;
    if (task.type === "milestone") {
      _drawMilestone(svg, task, i, origin, dayPx);
    } else if (task.type !== "phase" && task.type !== "group") {
      _drawTaskBar(svg, task, i, origin, dayPx);
    }
  });
}

// ---------------------------------------------------------------------------
// Grid lines + today line
// ---------------------------------------------------------------------------

function _drawGridLines(svg, origin, totalDays, dayPx, h) {
  const cur = new Date(origin);
  cur.setHours(0, 0, 0, 0);
  for (let d = 0; d < totalDays; d++) {
    if (_zoom === "week") {
      const isWeekend = cur.getDay() === 0 || cur.getDay() === 6;
      if (isWeekend) {
        svg.appendChild(_svgRect(d * dayPx, 0, dayPx, h, "rgba(0,0,0,0.025)"));
      }
      const line = _svgEl("line");
      line.setAttribute("x1", d*dayPx); line.setAttribute("x2", d*dayPx);
      line.setAttribute("y1", 0);       line.setAttribute("y2", h);
      line.setAttribute("stroke", "var(--gantt-grid-line)"); line.setAttribute("stroke-width", "0.5");
      svg.appendChild(line);
    } else if (cur.getDay() === 1) {
      const line = _svgEl("line");
      line.setAttribute("x1", d*dayPx); line.setAttribute("x2", d*dayPx);
      line.setAttribute("y1", 0);       line.setAttribute("y2", h);
      line.setAttribute("stroke", "var(--gantt-grid-line)"); line.setAttribute("stroke-width", "0.5");
      svg.appendChild(line);
    }
    cur.setDate(cur.getDate() + 1);
  }
}

function _drawTodayLine(svg, origin, dayPx, h) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const x = _dateToX(today, origin, dayPx);
  if (x < 0) return;

  const line = _svgEl("line");
  line.setAttribute("x1", x); line.setAttribute("x2", x);
  line.setAttribute("y1", 0); line.setAttribute("y2", h);
  line.setAttribute("stroke", "var(--gantt-today)");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "4 3");
  svg.appendChild(line);

  const tri = _svgEl("polygon");
  tri.setAttribute("points", `${x-5},0 ${x+5},0 ${x},9`);
  tri.setAttribute("fill", "var(--gantt-today)");
  svg.appendChild(tri);
}

// ---------------------------------------------------------------------------
// Group summary bar
// ---------------------------------------------------------------------------

function _drawGroupBar(svg, task, rowIdx, origin, dayPx, groupDates) {
  const dates = groupDates[task.id];
  if (!dates?.start) return;

  const x1 = _dateToX(_parseDate(dates.start), origin, dayPx);
  const x2 = _dateToX(_parseDate(dates.end || dates.start), origin, dayPx) + dayPx;
  const bY = rowIdx * ROW_H + 8;
  const bH = ROW_H - 16;
  const w  = Math.max(x2 - x1, 6);

  const g = _svgEl("g");
  g.setAttribute("data-task-id", task.id);
  g.style.cursor = "pointer";

  // Main summary bar
  const bar = _svgEl("rect");
  bar.setAttribute("x",       x1);
  bar.setAttribute("y",       bY);
  bar.setAttribute("width",   w);
  bar.setAttribute("height",  bH);
  bar.setAttribute("rx",      "3");
  bar.setAttribute("fill",    "var(--grey-600)");
  bar.setAttribute("opacity", "0.65");
  g.appendChild(bar);

  // Left cap (thick end-cap marker)
  const capL = _svgEl("rect");
  capL.setAttribute("x",      x1);
  capL.setAttribute("y",      rowIdx * ROW_H + 4);
  capL.setAttribute("width",  5);
  capL.setAttribute("height", ROW_H - 8);
  capL.setAttribute("rx",     "2");
  capL.setAttribute("fill",   "var(--grey-700)");
  capL.setAttribute("opacity", "0.7");
  g.appendChild(capL);

  // Right cap
  const capR = _svgEl("rect");
  capR.setAttribute("x",      x1 + w - 5);
  capR.setAttribute("y",      rowIdx * ROW_H + 4);
  capR.setAttribute("width",  5);
  capR.setAttribute("height", ROW_H - 8);
  capR.setAttribute("rx",     "2");
  capR.setAttribute("fill",   "var(--grey-700)");
  capR.setAttribute("opacity", "0.7");
  g.appendChild(capR);

  // Progress overlay on group bar
  const progress = parseFloat(task.progress) || 0;
  if (progress > 0 && w > 4) {
    const progW = Math.max(Math.round(w * progress), 4);
    const progRect = _svgEl("rect");
    progRect.setAttribute("x",       x1);
    progRect.setAttribute("y",       bY);
    progRect.setAttribute("width",   Math.min(progW, w));
    progRect.setAttribute("height",  bH);
    progRect.setAttribute("rx",      "3");
    progRect.setAttribute("fill",    "var(--blue)");
    progRect.setAttribute("opacity", "0.45");
    progRect.setAttribute("pointer-events", "none");
    g.appendChild(progRect);
  }

  if (w > 24) {
    const lbl = _svgEl("text");
    lbl.setAttribute("x",              x1 + 7);
    lbl.setAttribute("y",              bY + bH / 2 + 4);
    lbl.setAttribute("font-size",      "10");
    lbl.setAttribute("font-family",    "inherit");
    lbl.setAttribute("fill",           "#fff");
    lbl.setAttribute("font-weight",    "600");
    lbl.setAttribute("pointer-events", "none");
    lbl.textContent = _truncate(task.name, Math.floor((w - 14) / 6));
    g.appendChild(lbl);
  }

  // ── Dependency-link port (right / finish end of group bar) ───────────────
  const portCx = x1 + w;
  const portCy = rowIdx * ROW_H + ROW_H / 2;
  const port   = _svgEl("circle");
  port.setAttribute("cx",           String(portCx));
  port.setAttribute("cy",           String(portCy));
  port.setAttribute("r",            "5");
  port.setAttribute("fill",         "white");
  port.setAttribute("stroke",       "#4a90e2");
  port.setAttribute("stroke-width", "2");
  port.setAttribute("opacity",      "0");
  port.setAttribute("class",        "dep-port");
  port.style.cursor = "crosshair";
  port.title = "Drag to link a dependency";
  port.addEventListener("mousedown", (e) => {
    _startDepDrag(e, task.id, portCx, portCy);
  });
  g.appendChild(port);

  g.addEventListener("mouseenter", (e) => {
    _showTooltip(e, task);
    if (!_depDrag) port.setAttribute("opacity", "1");
  });
  g.addEventListener("mouseleave", () => {
    _hideTooltip();
    if (!_depDrag) port.setAttribute("opacity", "0");
  });
  g.addEventListener("click", () => _openEdit(task));

  svg.appendChild(g);
}

// ---------------------------------------------------------------------------
// Task bar
// ---------------------------------------------------------------------------

function _drawTaskBar(svg, task, rowIdx, origin, dayPx) {
  if (!task.start_date) return;

  const x1  = _dateToX(_parseDate(task.start_date), origin, dayPx);
  const x2  = _dateToX(_parseDate(task.end_date || task.start_date), origin, dayPx) + dayPx;
  const bY  = rowIdx * ROW_H + 5;
  const bH  = ROW_H - 10;
  const w   = Math.max(x2 - x1, 4);
  const isDone      = task.status === "complete";
  const isCritical  = _showCriticalPath && _criticalPathIds.has(task.id);

  const g = _svgEl("g");
  g.setAttribute("data-task-id", task.id);
  g.style.cursor = "grab";

  // Actuals bar — shown below the planned bar when actuals toggle is on
  // Green  (--gantt-actual)     = has both actual_start_date and actual_end_date
  // Amber  (--gantt-actual-wip) = started (actual_start_date) but not yet finished
  if (_showActuals && task.actual_start_date) {
    const hasEnd   = !!task.actual_end_date;
    const axDate   = _parseDate(task.actual_start_date);
    const ax2Date  = hasEnd ? _parseDate(task.actual_end_date) : _parseDate(task.end_date || task.start_date);
    const ax1 = _dateToX(axDate,  origin, dayPx);
    const ax2 = _dateToX(ax2Date, origin, dayPx) + dayPx;
    const aw  = Math.max(ax2 - ax1, 4);

    const actualBar = _svgEl("rect");
    actualBar.setAttribute("x",       ax1);
    actualBar.setAttribute("y",       bY + bH - 5);
    actualBar.setAttribute("width",   aw);
    actualBar.setAttribute("height",  5);
    actualBar.setAttribute("rx",      "2");
    actualBar.setAttribute("fill",    hasEnd ? "var(--gantt-actual)" : "var(--gantt-actual-wip)");
    actualBar.setAttribute("opacity", "0.85");
    actualBar.setAttribute("pointer-events", "none");
    g.appendChild(actualBar);
  }

  const barFill = isCritical ? "var(--gantt-critical)"
                : isDone     ? "var(--gantt-complete)"
                :              "var(--gantt-bar)";

  const bar = _svgEl("rect");
  bar.setAttribute("x",       x1);
  bar.setAttribute("y",       bY);
  bar.setAttribute("width",   w);
  bar.setAttribute("height",  bH);
  bar.setAttribute("rx",      "3");
  bar.setAttribute("fill",    barFill);
  bar.setAttribute("opacity", isDone ? "1" : "0.85");
  if (isCritical) bar.setAttribute("stroke", "var(--gantt-critical)");
  g.appendChild(bar);

  // Progress overlay — semi-transparent lighter fill over left N% of bar
  const progress = parseFloat(task.progress) || 0;
  if (progress > 0 && !isDone && w > 4) {
    const progW = Math.max(Math.round(w * progress), 4);
    const progRect = _svgEl("rect");
    progRect.setAttribute("x",       x1);
    progRect.setAttribute("y",       bY);
    progRect.setAttribute("width",   Math.min(progW, w));
    progRect.setAttribute("height",  bH);
    progRect.setAttribute("rx",      "3");
    progRect.setAttribute("fill",    "#fff");
    progRect.setAttribute("opacity", "0.3");
    progRect.setAttribute("pointer-events", "none");
    g.appendChild(progRect);
  }

  if (w > 24) {
    const lbl = _svgEl("text");
    lbl.setAttribute("x",              x1 + 5);
    lbl.setAttribute("y",              bY + bH / 2 + 4);
    lbl.setAttribute("font-size",      "10");
    lbl.setAttribute("font-family",    "inherit");
    lbl.setAttribute("fill",           "#fff");
    lbl.setAttribute("pointer-events", "none");
    lbl.textContent = _truncate(task.name, Math.floor((w - 10) / 6));
    g.appendChild(lbl);
  }

  // Resize handle (invisible rect on right edge)
  const handle = _svgEl("rect");
  handle.setAttribute("x",       x1 + w - 7);
  handle.setAttribute("y",       bY);
  handle.setAttribute("width",   7);
  handle.setAttribute("height",  bH);
  handle.setAttribute("fill",    "transparent");
  handle.setAttribute("rx",      "3");
  handle.style.cursor = "ew-resize";
  handle.dataset.resize = "1";
  g.appendChild(handle);

  g.addEventListener("mouseenter", (e) => _showTooltip(e, task));
  g.addEventListener("mouseleave", _hideTooltip);
  g.addEventListener("mousedown",  (e) => _startDrag(e, task, origin, dayPx));
  g.addEventListener("click", (e) => {
    if (_justDragged) { _justDragged = false; return; }
    e.stopPropagation();
    _openEdit(task);
  });

  // ── Dependency-link port (finish/right end) ────────────────────────────────
  // A small circle that appears on bar hover; drag it to wire up a dependency.
  const portCy = bY + bH / 2;
  const port   = _svgEl("circle");
  port.setAttribute("cx",           String(x1 + w));
  port.setAttribute("cy",           String(portCy));
  port.setAttribute("r",            "5");
  port.setAttribute("fill",         "white");
  port.setAttribute("stroke",       "#4a90e2");
  port.setAttribute("stroke-width", "2");
  port.setAttribute("opacity",      "0");
  port.setAttribute("class",        "dep-port");
  port.style.cursor = "crosshair";
  port.title = "Drag to link a dependency";
  port.addEventListener("mousedown", (e) => {
    e.stopPropagation();   // prevent bar-move drag from starting
    _startDepDrag(e, task.id, x1 + w, portCy);
  });
  g.appendChild(port);

  // Show port on hover; hide it on leave unless a dep-drag is in progress
  g.addEventListener("mouseenter", () => { if (!_depDrag) port.setAttribute("opacity", "1"); });
  g.addEventListener("mouseleave", () => { if (!_depDrag) port.setAttribute("opacity", "0"); });

  svg.appendChild(g);
}

// ---------------------------------------------------------------------------
// Milestone diamond
// ---------------------------------------------------------------------------

function _drawMilestone(svg, task, rowIdx, origin, dayPx) {
  if (!task.start_date) return;

  const cx = _dateToX(_parseDate(task.start_date), origin, dayPx) + dayPx / 2;
  const cy = rowIdx * ROW_H + ROW_H / 2;
  const s  = 8;

  const g = _svgEl("g");
  g.setAttribute("data-task-id", task.id);
  g.style.cursor = "pointer";

  const diamond = _svgEl("polygon");
  diamond.setAttribute("points", `${cx},${cy-s} ${cx+s},${cy} ${cx},${cy+s} ${cx-s},${cy}`);
  diamond.setAttribute("fill",   "var(--gantt-milestone)");
  g.appendChild(diamond);

  g.addEventListener("mouseenter", (e) => _showTooltip(e, task));
  g.addEventListener("mouseleave", _hideTooltip);
  g.addEventListener("click",      () => _openEdit(task));

  svg.appendChild(g);
}

// ---------------------------------------------------------------------------
// Phase bar
// ---------------------------------------------------------------------------

function _drawPhaseBar(svg, task, rowIdx, origin, dayPx) {
  if (!task.start_date) return;

  const x1 = _dateToX(_parseDate(task.start_date), origin, dayPx);
  const x2 = _dateToX(_parseDate(task.end_date || task.start_date), origin, dayPx) + dayPx;
  const bY = rowIdx * ROW_H + 2;
  const bH = ROW_H - 4;
  const w  = Math.max(x2 - x1, 4);

  const g = _svgEl("g");
  g.setAttribute("data-task-id", task.id);
  g.style.cursor = "pointer";

  const bar = _svgEl("rect");
  bar.setAttribute("x",            x1);
  bar.setAttribute("y",            bY);
  bar.setAttribute("width",        w);
  bar.setAttribute("height",       bH);
  bar.setAttribute("rx",           "3");
  bar.setAttribute("fill",         "var(--gantt-phase-bg)");
  bar.setAttribute("stroke",       "var(--blue)");
  bar.setAttribute("stroke-width", "1.5");
  g.appendChild(bar);

  if (w > 20) {
    const lbl = _svgEl("text");
    lbl.setAttribute("x",              x1 + 5);
    lbl.setAttribute("y",              bY + bH / 2 + 4);
    lbl.setAttribute("font-size",      "10");
    lbl.setAttribute("font-family",    "inherit");
    lbl.setAttribute("fill",           "var(--blue-text)");
    lbl.setAttribute("font-weight",    "600");
    lbl.setAttribute("pointer-events", "none");
    lbl.textContent = _truncate(task.name, Math.floor((w - 10) / 6));
    g.appendChild(lbl);
  }

  g.addEventListener("mouseenter", (e) => _showTooltip(e, task));
  g.addEventListener("mouseleave", _hideTooltip);
  g.addEventListener("click",      () => _openEdit(task));

  svg.appendChild(g);
}

// ---------------------------------------------------------------------------
// Dependency arrows
// ---------------------------------------------------------------------------

function _ensureArrowMarker(svg) {
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = _svgEl("defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  if (!defs.querySelector("#gantt-arrow")) {
    const marker = _svgEl("marker");
    marker.setAttribute("id",           "gantt-arrow");
    marker.setAttribute("markerWidth",  "7");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("refX",         "7");
    marker.setAttribute("refY",         "2.5");
    marker.setAttribute("orient",       "auto");
    const poly = _svgEl("polygon");
    poly.setAttribute("points", "0 0, 7 2.5, 0 5");
    poly.setAttribute("fill",   "var(--grey-300)");
    marker.appendChild(poly);
    defs.appendChild(marker);
  }
}

function _drawArrow(svg, pred, predIdx, succ, succIdx, origin, dayPx, depId, groupDates = {}) {
  // Resolve dates: group tasks store summary dates in groupDates (computed from
  // children) rather than in task.end_date / task.start_date, which may be null.
  const predEnd   = pred.end_date   || groupDates[pred.id]?.end;
  const succStart = succ.start_date || groupDates[succ.id]?.start;
  if (!predEnd || !succStart) return;

  const x1     = _dateToX(_parseDate(predEnd),   origin, dayPx) + dayPx;
  const y1     = predIdx * ROW_H + ROW_H / 2;
  const x2     = _dateToX(_parseDate(succStart), origin, dayPx);
  const y2     = succIdx * ROW_H + ROW_H / 2;
  const elbowX = x1 + Math.max((x2 - x1) / 2, 8);

  const d = `M ${x1} ${y1} H ${elbowX} V ${y2} H ${x2}`;

  // Visible arrow line
  const path = _svgEl("path");
  path.setAttribute("d",              d);
  path.setAttribute("fill",           "none");
  path.setAttribute("stroke",         "var(--grey-300)");
  path.setAttribute("stroke-width",   "1.5");
  path.setAttribute("marker-end",     "url(#gantt-arrow)");
  path.setAttribute("pointer-events", "none");
  svg.appendChild(path);

  // Invisible wide hit-test path — right-click to delete
  if (depId != null) {
    const hit = _svgEl("path");
    hit.setAttribute("d",              d);
    hit.setAttribute("fill",           "none");
    hit.setAttribute("stroke",         "transparent");
    hit.setAttribute("stroke-width",   "12");
    hit.setAttribute("pointer-events", "stroke");
    hit.style.cursor = "pointer";
    hit.title = "Right-click to delete dependency";
    hit.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _confirmDeleteDep(depId, pred.name, succ.name, pred.id, succ.id);
    });
    svg.appendChild(hit);
  }
}

// ---------------------------------------------------------------------------
// Drag interaction
// ---------------------------------------------------------------------------

function _startDrag(e, task, origin, dayPx) {
  if (!task.start_date) return;

  const isResize = !!e.target.dataset?.resize;
  e.preventDefault();
  e.stopPropagation();

  _drag = {
    type:        isResize ? "resize" : "move",
    taskId:      task.id,
    startMouseX: e.clientX,
    origStartMs: _parseDate(task.start_date).getTime(),
    origEndMs:   _parseDate(task.end_date || task.start_date).getTime(),
    dayPx,
    origin,
    moved:       false,
  };

  document.addEventListener("mousemove", _onDocMouseMove);
  document.addEventListener("mouseup",   _onDocMouseUp);
  if (_mainSvg) _mainSvg.classList.add("is-dragging");
}

// ---------------------------------------------------------------------------
// Drag-to-link dependency creation
// ---------------------------------------------------------------------------

function _startDepDrag(e, predecessorId, portSvgX, portSvgY) {
  e.preventDefault();
  _depDrag = { predecessorId, startSvgX: portSvgX, startSvgY: portSvgY };
  if (_mainSvg) {
    _depPreviewG = _svgEl("g");
    _depPreviewG.setAttribute("pointer-events", "none");
    _mainSvg.appendChild(_depPreviewG);
  }
  document.addEventListener("mousemove", _onDocMouseMove);
  document.addEventListener("mouseup",   _onDocMouseUp);
  if (_mainSvg) _mainSvg.classList.add("is-dragging");
}

function _svgPoint(e) {
  // Convert a MouseEvent client position into SVG coordinates, accounting for
  // scroll offset of the gantt-scroll container.
  if (!_mainSvg) return { x: 0, y: 0 };
  const svgRect = _mainSvg.getBoundingClientRect();
  return {
    x: e.clientX - svgRect.left,
    y: e.clientY - svgRect.top,
  };
}

function _updateDepPreview(e) {
  if (!_depDrag || !_depPreviewG || !_mainSvg) return;

  const pt = _svgPoint(e);

  // Clear previous preview contents
  while (_depPreviewG.firstChild) _depPreviewG.removeChild(_depPreviewG.firstChild);

  // Dashed preview line from port to cursor
  const line = _svgEl("line");
  line.setAttribute("x1",           String(_depDrag.startSvgX));
  line.setAttribute("y1",           String(_depDrag.startSvgY));
  line.setAttribute("x2",           String(pt.x));
  line.setAttribute("y2",           String(pt.y));
  line.setAttribute("stroke",       "#4a90e2");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-dasharray", "5,3");
  _depPreviewG.appendChild(line);

  // Highlight the bar under the cursor (if any)
  _mainSvg.querySelectorAll("[data-task-id]").forEach(g => {
    const bar = g.querySelector("rect");
    if (!bar) return;
    const bx = parseFloat(bar.getAttribute("x"));
    const by = parseFloat(bar.getAttribute("y"));
    const bw = parseFloat(bar.getAttribute("width"));
    const bh = parseFloat(bar.getAttribute("height"));
    const tid = parseInt(g.dataset.taskId, 10);
    if (pt.x >= bx && pt.x <= bx + bw && pt.y >= by && pt.y <= by + bh
        && tid !== _depDrag.predecessorId) {
      const hl = _svgEl("rect");
      hl.setAttribute("x",      String(bx - 2));
      hl.setAttribute("y",      String(by - 2));
      hl.setAttribute("width",  String(bw + 4));
      hl.setAttribute("height", String(bh + 4));
      hl.setAttribute("fill",           "none");
      hl.setAttribute("stroke",         "#4a90e2");
      hl.setAttribute("stroke-width",   "2");
      hl.setAttribute("rx",             "3");
      _depPreviewG.appendChild(hl);
    }
  });
}

async function _finishDepDrag(e) {
  if (!_depDrag) return;
  const predecessorId = _depDrag.predecessorId;
  _depDrag = null;

  // Remove preview
  if (_depPreviewG && _mainSvg && _mainSvg.contains(_depPreviewG)) {
    _mainSvg.removeChild(_depPreviewG);
  }
  _depPreviewG = null;

  if (_mainSvg) _mainSvg.classList.remove("is-dragging");

  // Find task bar under the mouse
  const pt = _svgPoint(e);
  let successorId = null;
  _mainSvg?.querySelectorAll("[data-task-id]").forEach(g => {
    const bar = g.querySelector("rect");
    if (!bar) return;
    const bx = parseFloat(bar.getAttribute("x"));
    const by = parseFloat(bar.getAttribute("y"));
    const bw = parseFloat(bar.getAttribute("width"));
    const bh = parseFloat(bar.getAttribute("height"));
    const tid = parseInt(g.dataset.taskId, 10);
    if (pt.x >= bx && pt.x <= bx + bw && pt.y >= by && pt.y <= by + bh
        && tid !== predecessorId) {
      successorId = tid;
    }
  });

  if (!successorId) return;  // dropped on nothing

  try {
    const created = await API.createDependency({ predecessor_id: predecessorId, successor_id: successorId, type: "FS", lag_days: 0 });
    _undoStack.push({ type: "dep_create", depId: created.id });
    if (_undoStack.length > 20) _undoStack.shift();
    _updateUndoBtn();
    window.App?.toast?.("Dependency created", "success");
    await _loadAndRender();
  } catch (err) {
    window.App?.toast?.("Failed to create dependency: " + err.message, "error");
  }
}

function _confirmDeleteDep(depId, predName, succName, predecessorId, successorId) {
  const modal = createModal({ title: "Delete Dependency" });
  const p = document.createElement("p");
  p.innerHTML = `Remove the dependency <strong>${predName}</strong> → <strong>${succName}</strong>?`;
  modal.setBody(p);
  modal.addButton("Delete", "btn--danger", async () => {
    try {
      await API.deleteDependency(depId);
      _undoStack.push({ type: "dep_delete", predecessorId, successorId, depType: "FS", lagDays: 0 });
      if (_undoStack.length > 20) _undoStack.shift();
      _updateUndoBtn();
      window.App?.toast?.("Dependency removed", "success");
      modal.close();
      await _loadAndRender();
    } catch (err) {
      window.App?.toast?.("Failed to delete: " + err.message, "error");
    }
  });
  modal.addButton("Cancel", "btn--ghost", () => modal.close());
  modal.open();
}

// ---------------------------------------------------------------------------
// Drag-to-reparent (label panel HTML5 DnD)
// ---------------------------------------------------------------------------

let _reparentDragTaskId  = null;
let _reparentDropTarget  = null;   // the highlighted group row element

function _initReparentDrag(labelsBody) {
  labelsBody.addEventListener("dragstart", (e) => {
    const row = e.target.closest("[data-task-id]");
    if (!row || row.dataset.dropTarget) return;   // don't drag group rows
    _reparentDragTaskId = parseInt(row.dataset.taskId, 10);
    e.dataTransfer.effectAllowed = "move";
    row.style.opacity = "0.5";
  });

  labelsBody.addEventListener("dragend", (e) => {
    const row = e.target.closest("[data-task-id]");
    if (row) row.style.opacity = "";
    _clearReparentHighlight();
    _reparentDragTaskId = null;
  });

  labelsBody.addEventListener("dragover", (e) => {
    if (_reparentDragTaskId == null) return;
    const row = e.target.closest("[data-drop-target]");
    if (!row) { _clearReparentHighlight(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (row !== _reparentDropTarget) {
      _clearReparentHighlight();
      _reparentDropTarget = row;
      row.style.outline = "2px solid var(--blue)";
      row.style.outlineOffset = "-2px";
    }
  });

  labelsBody.addEventListener("dragleave", (e) => {
    // Only clear if we've left the labelsBody entirely
    if (!labelsBody.contains(e.relatedTarget)) {
      _clearReparentHighlight();
    }
  });

  labelsBody.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (_reparentDragTaskId == null) return;

    // Capture and clear immediately so concurrent firings are no-ops
    const taskId = _reparentDragTaskId;
    _reparentDragTaskId = null;
    _clearReparentHighlight();

    const row = e.target.closest("[data-drop-target]");
    if (!row) return;

    const newParentId = parseInt(row.dataset.dropTarget, 10);
    if (newParentId === taskId) return;   // can't reparent to self

    try {
      await API.updateTask(taskId, { parent_id: newParentId });
      window.App?.toast?.("Task moved into group", "success");
      // Re-fetch from the server so the hierarchy reflects the change
      await _loadAndRender();
    } catch (err) {
      window.App?.toast?.("Reparent failed: " + err.message, "error");
    }
  });
}

function _clearReparentHighlight() {
  if (_reparentDropTarget) {
    _reparentDropTarget.style.outline = "";
    _reparentDropTarget.style.outlineOffset = "";
    _reparentDropTarget = null;
  }
}

function _handleMouseMove(e) {
  if (_depDrag) { _updateDepPreview(e); return; }
  if (!_drag) return;

  const dx    = e.clientX - _drag.startMouseX;
  const dDays = Math.round(dx / _drag.dayPx);
  if (dDays === 0) return;

  _drag.moved = true;
  const g = _mainSvg?.querySelector(`[data-task-id="${_drag.taskId}"]`);
  if (!g) return;

  if (_drag.type === "move") {
    const newStartMs = _drag.origStartMs + dDays * MS_DAY;
    const origX1     = _dateToX(new Date(_drag.origStartMs), _drag.origin, _drag.dayPx);
    const newX1      = _dateToX(new Date(newStartMs),        _drag.origin, _drag.dayPx);
    g.setAttribute("transform", `translate(${newX1 - origX1}, 0)`);
  } else {
    const bar = g.querySelector("rect");
    if (!bar) return;
    const x1    = parseFloat(bar.getAttribute("x"));
    const origW = _dateToX(new Date(_drag.origEndMs), _drag.origin, _drag.dayPx)
                + _drag.dayPx
                - _dateToX(new Date(_drag.origStartMs), _drag.origin, _drag.dayPx);
    const newW  = Math.max(origW + dDays * _drag.dayPx, _drag.dayPx);
    bar.setAttribute("width", newW);
    const handle = g.querySelector("[data-resize]");
    if (handle) handle.setAttribute("x", x1 + newW - 7);
  }
}

// ---------------------------------------------------------------------------
// Undo helpers
// ---------------------------------------------------------------------------

/** Refresh the undo button's label and disabled state. */
function _updateUndoBtn() {
  if (!_undoBtn) return;
  const n = _undoStack.length;
  _undoBtn.textContent = n > 0 ? `Undo (${n})` : "Undo";
  _undoBtn.disabled    = n === 0;
  _undoBtn.classList.toggle("is-active", false);
}

/** Keyboard handler — Ctrl+Z triggers undo while the Gantt view is active. */
function _onKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
    // Only fire if no modal or input is focused
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    e.preventDefault();
    _doUndo();
  }
}

/** Pop the top of the undo stack and restore the previous state. */
async function _doUndo() {
  if (_undoStack.length === 0) return;

  const entry = _undoStack.pop();
  _updateUndoBtn();

  try {
    if (entry.type === "dep_create") {
      // Undo a dependency creation — delete the dependency
      await API.deleteDependency(entry.depId);
      await _loadAndRender();
      window.App?.toast?.("Undo: dependency removed", "success");

    } else if (entry.type === "dep_delete") {
      // Undo a dependency deletion — recreate it
      await API.createDependency({
        predecessor_id: entry.predecessorId,
        successor_id:   entry.successorId,
        type:           entry.depType,
        lag_days:       entry.lagDays,
      });
      await _loadAndRender();
      window.App?.toast?.("Undo: dependency restored", "success");

    } else {
      // Default: restore task dates
      await API.updateTask(entry.taskId, {
        start_date: entry.prevStart,
        end_date:   entry.prevEnd,
      });
      const idx = _tasks.findIndex(t => t.id === entry.taskId);
      if (idx !== -1) {
        _tasks[idx] = { ..._tasks[idx], start_date: entry.prevStart, end_date: entry.prevEnd };
      }
      _renderAll();
      window.App?.toast?.("Undo: dates restored", "success");
    }
  } catch (err) {
    // Put it back so the user can retry
    _undoStack.push(entry);
    _updateUndoBtn();
    window.App?.toast?.("Undo failed: " + err.message, "error");
  }
}

async function _handleMouseUp(e) {
  document.removeEventListener("mousemove", _onDocMouseMove);
  document.removeEventListener("mouseup",   _onDocMouseUp);

  if (_depDrag) { await _finishDepDrag(e); return; }

  if (_mainSvg) _mainSvg.classList.remove("is-dragging");

  if (!_drag) return;
  const savedDrag = _drag;
  const wasMoved  = savedDrag.moved;
  _drag = null;

  if (!wasMoved) return;

  _justDragged = true;

  const dx    = e.clientX - savedDrag.startMouseX;
  const dDays = Math.round(dx / savedDrag.dayPx);
  const dMs   = dDays * MS_DAY;

  let newStart = new Date(savedDrag.origStartMs);
  let newEnd   = new Date(savedDrag.origEndMs);

  if (savedDrag.type === "move") {
    newStart = new Date(savedDrag.origStartMs + dMs);
    newEnd   = new Date(savedDrag.origEndMs   + dMs);
  } else {
    newEnd = new Date(savedDrag.origEndMs + dMs);
    if (newEnd <= newStart) newEnd = new Date(newStart.getTime() + MS_DAY);
  }

  try {
    await API.updateTask(savedDrag.taskId, {
      start_date: _fmtDate(newStart),
      end_date:   _fmtDate(newEnd),
    });

    // Push previous state onto the undo stack (cap at 20 entries)
    _undoStack.push({
      taskId:    savedDrag.taskId,
      prevStart: _fmtDate(new Date(savedDrag.origStartMs)),
      prevEnd:   _fmtDate(new Date(savedDrag.origEndMs)),
    });
    if (_undoStack.length > 20) _undoStack.shift();
    _updateUndoBtn();

    const idx = _tasks.findIndex(t => t.id === savedDrag.taskId);
    if (idx !== -1) {
      _tasks[idx] = { ..._tasks[idx], start_date: _fmtDate(newStart), end_date: _fmtDate(newEnd) };
    }
    window.App?.toast?.("Task dates updated", "success");
  } catch (err) {
    window.App?.toast?.("Failed to save: " + err.message, "error");
  }

  _renderAll();
}

// ---------------------------------------------------------------------------
// Task editing (open the existing task form modal)
// ---------------------------------------------------------------------------

function _openEdit(task) {
  openTaskForm(task, task.project_id, async (saved) => {
    const idx = _tasks.findIndex(t => t.id === saved.id);
    if (idx !== -1) _tasks[idx] = saved;
    _renderAll();
  });
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function _makeTooltip() {
  const el = document.createElement("div");
  el.className     = "gantt-tooltip";
  el.style.display = "none";
  return el;
}

function _showTooltip(e, task) {
  if (_drag || !_tooltip) return;
  const start = task.start_date ? _fmtDisplay(task.start_date) : null;
  const end   = task.end_date   ? _fmtDisplay(task.end_date)   : null;
  const range = start
    ? (end && end !== start ? `${start} → ${end}` : start)
    : null;

  const progressPct = Math.round((parseFloat(task.progress) || 0) * 100);
  _tooltip.innerHTML = `
    <div class="gantt-tooltip__title">${task.wbs_number ? `<span style="font-family:monospace;font-size:10px;opacity:0.7;">${_esc(task.wbs_number)}</span> ` : ""}${_esc(task.name)}</div>
    <div class="gantt-tooltip__meta">${_typeLabel(task.type)} · ${_statusLabel(task.status)}${progressPct > 0 ? ` · ${progressPct}%` : ""}</div>
    ${range ? `<div class="gantt-tooltip__meta">${_esc(range)}</div>` : ""}
    ${task.duration_days ? `<div class="gantt-tooltip__meta">${task.duration_days} day${task.duration_days !== 1 ? "s" : ""}</div>` : ""}
  `;
  _tooltip.style.display = "block";
  _repositionTooltip(e);
}

function _hideTooltip() {
  if (_tooltip) _tooltip.style.display = "none";
}

function _repositionTooltip(e) {
  if (!_tooltip || _tooltip.style.display === "none") return;
  const pad = 14;
  const tw  = _tooltip.offsetWidth  || 200;
  const th  = _tooltip.offsetHeight || 60;
  let tx = e.clientX + pad;
  let ty = e.clientY + pad;
  if (tx + tw > window.innerWidth  - 8) tx = e.clientX - tw - pad;
  if (ty + th > window.innerHeight - 8) ty = e.clientY - th - pad;
  _tooltip.style.left = tx + "px";
  _tooltip.style.top  = ty + "px";
}

// ---------------------------------------------------------------------------
// Scroll sync
// ---------------------------------------------------------------------------

function _onScroll() {
  if (_labelsBody && _scrollEl) {
    _labelsBody.style.transform = `translateY(-${_scrollEl.scrollTop}px)`;
  }
}

function _scrollToToday() {
  if (!_scrollEl || !_chartOrigin) return;
  const { dayPx } = ZOOM_LEVELS[_zoom];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const x    = _dateToX(today, _chartOrigin, dayPx);
  const half = _scrollEl.clientWidth / 2;
  _scrollEl.scrollLeft = Math.max(0, x - half);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function _dateToX(date, origin, dayPx) {
  return Math.round((date.getTime() - origin.getTime()) / MS_DAY * dayPx);
}

function _parseDate(str) {
  if (!str) return null;
  const d = new Date(str + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function _fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function _fmtDisplay(str) {
  const d = _parseDate(str);
  if (!d) return str || "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function _taskIcon(task) {
  if (task.type === "milestone") return "◆";
  if (task.type === "phase")     return "▶";
  if (task.type === "group")     return "▸";
  return "▪";
}

function _typeLabel(type) {
  return { task: "Task", milestone: "Milestone", phase: "Phase", group: "Group" }[type] || type || "Task";
}

function _statusLabel(status) {
  return {
    "not-started": "Not started",
    "in-progress": "In progress",
    "complete":    "Complete",
    "on-hold":     "On hold",
    "cancelled":   "Cancelled",
  }[status] || status || "—";
}

function _truncate(str, maxChars) {
  if (!str) return "";
  return str.length > maxChars ? str.slice(0, Math.max(maxChars - 1, 1)) + "…" : str;
}

function _esc(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _el(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function _svgEl(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function _svgRect(x, y, w, h, fill) {
  const r = _svgEl("rect");
  r.setAttribute("x",      x);
  r.setAttribute("y",      y);
  r.setAttribute("width",  w);
  r.setAttribute("height", h);
  r.setAttribute("fill",   fill);
  return r;
}

function _showError(msg) {
  if (_container) {
    _container.innerHTML = `
      <div class="empty-state" style="padding-top:var(--space-8);">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Error</div>
        <div class="empty-state__body">${_esc(msg)}</div>
      </div>`;
  }
}
