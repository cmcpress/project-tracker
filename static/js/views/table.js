/**
 * views/table.js — Table view: sortable, filterable flat task list.
 *
 * Implements the view interface: init(), render(), destroy()
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { openTaskForm } from "../components/task-form.js";
import {
  el, clearChildren, formatDateShort, formatDuration,
  statusLabel, statusClass, typeLabel, initials, pendingIndicator,
} from "../utils.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container = null;
const _unsubs = [];
let _allTasks = [];
let _sortKey = "wbs_number";
let _sortDir = "asc";
let _filterProject = "";
let _filterStatus  = "";
let _filterType    = "";
let _filterSearch  = "";
const _selectedIds = new Set(); // bulk-action selection

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;
  _container.className = "main__content main__content--fill";
  _unsubs.push(State.subscribe("activeProjectId", () => _loadAndRender()));
  await _loadAndRender();
}

export async function render() {
  await _loadAndRender();
}

export function destroy() {
  _unsubs.forEach(fn => fn());
  _unsubs.length = 0;
  _container = null;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function _loadAndRender() {
  if (!_container) return;
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  try {
    const projects = State.getProjects();
    const activeId  = State.getActiveProjectId();

    // Keep the table's own project filter in sync with the sidebar selection.
    // Without this, a stale _filterProject from a previous session silently
    // hides all rows even though the correct tasks have been loaded.
    if (activeId) {
      _filterProject = String(activeId);
    } else {
      _filterProject = "";
    }

    const toShow    = activeId ? projects.filter(p => p.id === activeId) : projects;

    if (toShow.length === 0) {
      _renderEmpty();
      return;
    }

    const projectsWithTasks = await Promise.all(toShow.map(p => API.getProject(p.id)));

    _allTasks = [];
    for (const proj of projectsWithTasks) {
      for (const task of (proj.tasks || [])) {
        _allTasks.push({ ...task, _project: proj });
      }
    }

    _renderView(toShow);
  } catch (e) {
    console.error("[table] Load failed:", e);
    _container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__title">Failed to load tasks</div>
        <div class="empty-state__body">${e.message}</div>
      </div>`;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function _renderEmpty() {
  _container.innerHTML = `
    <div class="empty-state">
      <div class="empty-state__icon">&#x1F4CB;</div>
      <div class="empty-state__title">No projects yet</div>
      <div class="empty-state__body">Click "+ Project" in the top bar to create your first project.</div>
    </div>`;
}

function _renderView(shownProjects) {
  clearChildren(_container);
  _selectedIds.clear();
  const root = el("div", "table-view");
  root.style.position = "relative";
  root.appendChild(_buildFilterBar(shownProjects));
  const scroll = el("div", "table-scroll");
  scroll.appendChild(_buildTable());
  root.appendChild(scroll);
  root.appendChild(_buildActionBar(shownProjects));
  _container.appendChild(root);
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function _buildFilterBar(shownProjects) {
  const bar = el("div", "table-filters");

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "table-filter-input";
  searchInput.placeholder = "Search tasks...";
  searchInput.value = _filterSearch;
  searchInput.style.maxWidth = "200px";
  searchInput.addEventListener("input", () => {
    _filterSearch = searchInput.value.trim().toLowerCase();
    _redrawBody();
  });

  const projectSel = document.createElement("select");
  projectSel.className = "table-filter-select";
  [{ id: "", name: "All projects" }, ...shownProjects].forEach(p => {
    const o = document.createElement("option");
    o.value = String(p.id || "");
    o.textContent = p.name;
    if (String(p.id || "") === _filterProject) o.selected = true;
    projectSel.appendChild(o);
  });
  projectSel.addEventListener("change", () => { _filterProject = projectSel.value; _redrawBody(); });

  const statusSel = document.createElement("select");
  statusSel.className = "table-filter-select";
  [
    { value: "",            label: "All statuses" },
    { value: "not-started", label: "Not Started"  },
    { value: "planning",    label: "Planning"     },
    { value: "in-progress", label: "In Progress"  },
    { value: "blocked",     label: "Blocked"      },
    { value: "pending",     label: "Pending"      },
    { value: "complete",    label: "Complete"     },
  ].forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === _filterStatus) o.selected = true;
    statusSel.appendChild(o);
  });
  statusSel.addEventListener("change", () => { _filterStatus = statusSel.value; _redrawBody(); });

  const typeSel = document.createElement("select");
  typeSel.className = "table-filter-select";
  [
    { value: "",          label: "All types" },
    { value: "task",      label: "Task"      },
    { value: "group",     label: "Group"     },
    { value: "milestone", label: "Milestone" },
    { value: "phase",     label: "Phase"     },
  ].forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === _filterType) o.selected = true;
    typeSel.appendChild(o);
  });
  typeSel.addEventListener("change", () => { _filterType = typeSel.value; _redrawBody(); });

  const countEl = el("span", "");
  countEl.id = "table-task-count";
  countEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted); margin-left:auto; white-space:nowrap;";

  bar.appendChild(searchInput);
  bar.appendChild(projectSel);
  bar.appendChild(statusSel);
  bar.appendChild(typeSel);
  bar.appendChild(countEl);
  return bar;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: "_check",           label: "",         cls: "col-check",    nosort: true },
  { key: "wbs_number",       label: "WBS",      cls: "col-wbs"       },
  { key: "name",             label: "Task",     cls: "col-task"      },
  { key: "project",          label: "Project",  cls: "col-project"   },
  { key: "type",             label: "Type",     cls: "col-type"      },
  { key: "rag",              label: "RAG",      cls: "col-rag",      nosort: false },
  { key: "status",           label: "Status",   cls: "col-status"    },
  { key: "progress",         label: "Progress", cls: "col-progress", nosort: false },
  { key: "assignees",        label: "People",   cls: "col-assignees", nosort: true },
  { key: "start_date",       label: "Start",    cls: "col-date"      },
  { key: "end_date",         label: "End",      cls: "col-date"      },
  { key: "duration_days",    label: "Duration", cls: "col-duration"  },
  { key: "dependency_count",  label: "Deps",     cls: "col-deps"      },
  { key: "item_count",        label: "Items",    cls: "col-items"     },
  { key: "estimated_hours",   label: "Est. h",  cls: "col-hours"     },
  { key: "logged_hours",      label: "Log. h",  cls: "col-hours"     },
];

function _buildTable() {
  const table = document.createElement("table");
  table.className = "data-table";
  table.id = "data-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  for (const col of COLUMNS) {
    const th = document.createElement("th");
    th.className = col.cls;
    th.dataset.sortKey = col.key;
    if (_sortKey === col.key) th.classList.add("is-sorted");

    // Checkbox column — "select all" toggle
    if (col.key === "_check") {
      const selectAll = document.createElement("input");
      selectAll.type = "checkbox";
      selectAll.title = "Select / deselect all";
      selectAll.addEventListener("change", () => {
        const checked = selectAll.checked;
        document.querySelectorAll(".row-check").forEach(cb => {
          cb.checked = checked;
          const id = parseInt(cb.dataset.taskId, 10);
          checked ? _selectedIds.add(id) : _selectedIds.delete(id);
        });
        _updateActionBar();
      });
      th.appendChild(selectAll);
      headerRow.appendChild(th);
      continue;
    }

    th.appendChild(el("span", "", col.label));

    if (!col.nosort) {
      const si = el("span", "sort-indicator");
      si.textContent = _sortKey === col.key ? (_sortDir === "asc" ? " ▲" : " ▼") : " ⬍";
      th.appendChild(si);
      th.addEventListener("click", () => {
        if (_sortKey === col.key) {
          _sortDir = _sortDir === "asc" ? "desc" : "asc";
        } else {
          _sortKey = col.key;
          _sortDir = "asc";
        }
        table.querySelectorAll("th[data-sort-key]").forEach(t => {
          t.classList.remove("is-sorted");
          const s = t.querySelector(".sort-indicator");
          if (s) s.textContent = " ⬍";
        });
        th.classList.add("is-sorted");
        const s = th.querySelector(".sort-indicator");
        if (s) s.textContent = _sortDir === "asc" ? " ▲" : " ▼";
        _redrawBody();
      });
    }
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  tbody.id = "table-body";
  table.appendChild(tbody);

  // Pass the reference directly — getElementById won't find it yet because
  // the table hasn't been appended to the document at this point.
  _redrawBody(tbody);
  return table;
}

// ---------------------------------------------------------------------------
// Filter + sort
// ---------------------------------------------------------------------------

function _getFilteredSorted() {
  let tasks = [..._allTasks];

  if (_filterProject) tasks = tasks.filter(t => String(t._project.id) === _filterProject);
  if (_filterStatus)  tasks = tasks.filter(t => t.status === _filterStatus);
  if (_filterType)    tasks = tasks.filter(t => t.type === _filterType);
  if (_filterSearch)  tasks = tasks.filter(t => t.name.toLowerCase().includes(_filterSearch));

  tasks.sort((a, b) => {
    let va, vb;
    switch (_sortKey) {
      case "project":          va = a._project.name;                         vb = b._project.name;                         break;
      case "name":             va = a.name;                                  vb = b.name;                                  break;
      case "type":             va = a.type;                                  vb = b.type;                                  break;
      case "status":           va = a.status;                                vb = b.status;                                break;
      case "start_date":       va = a.start_date       || "";                vb = b.start_date       || "";                break;
      case "end_date":         va = a.end_date         || "";                vb = b.end_date         || "";                break;
      case "duration_days":    va = a.duration_days    || 0;                 vb = b.duration_days    || 0;                 break;
      case "dependency_count": va = a.dependency_count || 0;                 vb = b.dependency_count || 0;                 break;
      case "item_count":       va = a.item_count ?? (a.items?.length ?? 0); vb = b.item_count ?? (b.items?.length ?? 0); break;
      case "estimated_hours":  va = a.estimated_hours || 0;                 vb = b.estimated_hours || 0;                 break;
      case "logged_hours":     va = a.logged_hours    || 0;                 vb = b.logged_hours    || 0;                 break;
      case "wbs_number":       va = a.wbs_number || "";                     vb = b.wbs_number || "";                     break;
      case "progress":         va = a.progress   || 0;                      vb = b.progress   || 0;                      break;
      case "rag": {
        const ragOrder = { red: 0, amber: 1, green: 2, "": 3 };
        va = ragOrder[a.rag || ""] ?? 3;
        vb = ragOrder[b.rag || ""] ?? 3;
        break;
      }
      default: va = ""; vb = "";
    }
    if (va < vb) return _sortDir === "asc" ? -1 :  1;
    if (va > vb) return _sortDir === "asc" ?  1 : -1;
    return 0;
  });

  return tasks;
}

// ---------------------------------------------------------------------------
// Body redraw
// ---------------------------------------------------------------------------

function _redrawBody(tbodyEl) {
  const tbody = tbodyEl || document.getElementById("table-body");
  if (!tbody) return;

  clearChildren(tbody);
  const tasks = _getFilteredSorted();

  const countEl = document.getElementById("table-task-count");
  if (countEl) countEl.textContent = tasks.length + " task" + (tasks.length !== 1 ? "s" : "");

  if (tasks.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = COLUMNS.length;
    td.style.cssText = "text-align:center; color:var(--text-muted); padding:var(--space-8);";
    td.textContent = _allTasks.length === 0
      ? "No tasks yet — add tasks from the Cards view."
      : "No tasks match the current filters.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const task of tasks) {
    tbody.appendChild(_buildRow(task));
  }
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function _buildRow(task) {
  const tr = document.createElement("tr");
  tr.dataset.taskId = String(task.id);
  const isGroup = task.type === "group";
  if (isGroup) tr.style.fontWeight = "600";
  if (_selectedIds.has(task.id)) tr.classList.add("is-selected");

  // Checkbox cell
  const checkTd = document.createElement("td");
  checkTd.className = "col-check";
  checkTd.style.cssText = "text-align:center;";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "row-check";
  cb.dataset.taskId = String(task.id);
  cb.checked = _selectedIds.has(task.id);
  cb.addEventListener("change", (e) => {
    e.stopPropagation();
    if (cb.checked) _selectedIds.add(task.id);
    else            _selectedIds.delete(task.id);
    tr.classList.toggle("is-selected", cb.checked);
    _updateActionBar();
  });
  checkTd.appendChild(cb);

  // WBS number
  const wbsTd = document.createElement("td");
  wbsTd.className = "col-wbs";
  wbsTd.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted); font-family:var(--font-mono); white-space:nowrap;";
  wbsTd.textContent = task.wbs_number || "";

  // Name (indent if has parent — type icons removed, Type column shows type)
  const nameTd = document.createElement("td");
  nameTd.className = "col-task";
  const nameWrap = el("div", "");
  const indentPx = task.parent_id ? 16 : 0;
  nameWrap.style.cssText = `display:flex; align-items:center; padding-left:${indentPx}px;`;
  const nameSpan = el("span", "truncate");
  nameSpan.style.cssText = task.status === "complete"
    ? "font-size:var(--font-size-sm); text-decoration:line-through; color:var(--text-muted);"
    : "font-size:var(--font-size-sm);";
  nameSpan.textContent = task.name;
  nameSpan.title = task.name;
  nameWrap.appendChild(nameSpan);
  nameTd.appendChild(nameWrap);

  // Project tag
  const projTd = document.createElement("td");
  projTd.className = "col-project";
  const tag = el("div", "table-project-tag");
  const dot = el("span", "table-project-tag__dot");
  dot.style.background = task._project.colour || "var(--blue)";
  const projName = el("span", "truncate");
  projName.textContent = task._project.name;
  projName.title = task._project.name;
  tag.appendChild(dot);
  tag.appendChild(projName);
  projTd.appendChild(tag);

  // Type
  const typeTd = document.createElement("td");
  typeTd.className = "col-type";
  typeTd.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary);";
  typeTd.textContent = typeLabel(task.type);

  // RAG
  const ragTd = document.createElement("td");
  ragTd.className = "col-rag";
  ragTd.style.cssText = "text-align:center;";
  if (task.rag) {
    const ragColors = { red: "#ef4444", amber: "#f59e0b", green: "#22c55e" };
    const ragTitles = { red: "Off track", amber: "At risk", green: "On track" };
    const ragDot = el("span", "");
    ragDot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${ragColors[task.rag]};vertical-align:middle;`;
    ragDot.title = ragTitles[task.rag];
    ragTd.appendChild(ragDot);
  } else {
    ragTd.style.color = "var(--text-muted)";
    ragTd.textContent = "—";
  }

  // Status
  const statusTd = document.createElement("td");
  statusTd.className = "col-status";
  statusTd.style.cssText = "display:flex; align-items:center; gap:4px; white-space:nowrap;";
  statusTd.appendChild(el("span", "badge badge--" + statusClass(task.status), statusLabel(task.status)));
  const pip = pendingIndicator(task);
  if (pip) {
    const pipEl = el("span", "");
    pipEl.textContent = pip;
    pipEl.style.cssText = `font-size:11px; color:${pip === "⚠" ? "#f59e0b" : "var(--status-pending-text)"};`;
    pipEl.title = pip === "⚠"
      ? "Pending overdue — expected " + (task.pending_until || "unknown")
      : "Pending — expected by " + (task.pending_until || "unknown");
    statusTd.appendChild(pipEl);
  }

  // Progress
  const progressTd = document.createElement("td");
  progressTd.className = "col-progress";
  const progressPct = Math.round((parseFloat(task.progress) || 0) * 100);
  if (progressPct > 0) {
    const track = el("div", "");
    track.style.cssText = "display:flex; align-items:center; gap:var(--space-2);";
    const bar = el("div", "");
    bar.style.cssText = `height:6px; width:60px; background:var(--grey-200); border-radius:3px; overflow:hidden; flex-shrink:0;`;
    const fill = el("div", "");
    fill.style.cssText = `height:100%; width:${progressPct}%; background:var(--blue); border-radius:3px;`;
    bar.appendChild(fill);
    const label = el("span", "");
    label.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary);";
    label.textContent = progressPct + "%";
    track.appendChild(bar);
    track.appendChild(label);
    progressTd.appendChild(track);
  } else {
    progressTd.style.color = "var(--text-muted)";
    progressTd.textContent = "—";
  }

  // Assignees
  const assignTd = document.createElement("td");
  assignTd.className = "col-assignees";
  if (task.assignees && task.assignees.length > 0) {
    const stack = el("div", "avatar-stack");
    task.assignees.slice(0, 2).forEach(p => {
      const av = el("div", "avatar avatar--sm");
      av.style.background = p.colour || "#8892a4";
      av.textContent = initials(p.name);
      av.title = p.name;
      stack.appendChild(av);
    });
    if (task.assignees.length > 2) {
      const more = el("div", "avatar avatar--sm");
      more.style.background = "var(--grey-400)";
      more.textContent = "+" + (task.assignees.length - 2);
      stack.appendChild(more);
    }
    assignTd.appendChild(stack);
  }

  // Dates
  const startTd = document.createElement("td");
  startTd.className = "col-date";
  startTd.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary);";
  startTd.textContent = task.start_date ? formatDateShort(task.start_date) : "—";

  const endTd = document.createElement("td");
  endTd.className = "col-date";
  endTd.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary);";
  endTd.textContent = task.end_date ? formatDateShort(task.end_date) : "—";

  // Duration
  const durTd = document.createElement("td");
  durTd.className = "col-duration";
  durTd.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary);";
  durTd.textContent = task.duration_days ? formatDuration(task.duration_days) : "—";

  // Deps
  const depsTd = document.createElement("td");
  depsTd.className = "col-deps";
  const depCount = task.dependency_count || 0;
  if (depCount > 0) {
    const b = el("span", "count-badge");
    b.title = depCount + " dependenc" + (depCount === 1 ? "y" : "ies");
    b.textContent = String(depCount);
    depsTd.appendChild(b);
  } else {
    depsTd.style.color = "var(--text-muted)";
    depsTd.textContent = "—";
  }

  // Items
  const itemsTd = document.createElement("td");
  itemsTd.className = "col-items";
  const itemCount = task.item_count != null ? task.item_count : (task.items ? task.items.length : 0);
  if (itemCount > 0) {
    const b = el("span", "count-badge");
    b.title = itemCount + " item" + (itemCount === 1 ? "" : "s");
    b.textContent = String(itemCount);
    itemsTd.appendChild(b);
  } else {
    itemsTd.style.color = "var(--text-muted)";
    itemsTd.textContent = "—";
  }

  // Estimated hours
  const estTd = document.createElement("td");
  estTd.className = "col-hours";
  estTd.style.cssText = "font-size:var(--font-size-xs);color:var(--text-secondary);text-align:right;white-space:nowrap;";
  estTd.textContent = task.estimated_hours != null ? task.estimated_hours + "h" : "—";
  if (task.estimated_hours == null) estTd.style.color = "var(--text-muted)";

  // Logged hours
  const logTd = document.createElement("td");
  logTd.className = "col-hours";
  const overlogged = task.estimated_hours > 0 && task.logged_hours > task.estimated_hours;
  logTd.style.cssText = `font-size:var(--font-size-xs);text-align:right;white-space:nowrap;color:${
    task.logged_hours == null ? "var(--text-muted)" :
    overlogged ? "#ef4444" : "var(--text-secondary)"};`;
  logTd.textContent = task.logged_hours != null ? task.logged_hours + "h" : "—";

  tr.appendChild(checkTd);
  tr.appendChild(wbsTd);
  tr.appendChild(nameTd);
  tr.appendChild(projTd);
  tr.appendChild(typeTd);
  tr.appendChild(ragTd);
  tr.appendChild(statusTd);
  tr.appendChild(progressTd);
  tr.appendChild(assignTd);
  tr.appendChild(startTd);
  tr.appendChild(endTd);
  tr.appendChild(durTd);
  tr.appendChild(depsTd);
  tr.appendChild(itemsTd);
  tr.appendChild(estTd);
  tr.appendChild(logTd);

  // Click to edit — but not if clicking the checkbox cell
  tr.addEventListener("click", async (e) => {
    if (e.target.closest(".col-check")) return;
    await openTaskForm(task, task.project_id, async () => {
      window.App && window.App.toast && window.App.toast("Task saved", "success");
      const updated = await API.listProjects();
      State.setProjects(updated);
      await _loadAndRender();
    });
  });

  return tr;
}

// ---------------------------------------------------------------------------
// Bulk action bar
// ---------------------------------------------------------------------------

function _buildActionBar(shownProjects) {
  const bar = el("div", "bulk-action-bar");
  bar.id = "bulk-action-bar";
  bar.style.display = "none"; // hidden until rows selected

  // Count label
  const countEl = el("span", "bulk-action-bar__count");
  countEl.id = "bulk-action-count";

  // ── Set Status ──────────────────────────────────────────────────────────
  const statusSel = document.createElement("select");
  statusSel.className = "table-filter-select";
  statusSel.style.height = "30px";
  const statusPlaceholder = document.createElement("option");
  statusPlaceholder.value = ""; statusPlaceholder.textContent = "Set status…";
  statusSel.appendChild(statusPlaceholder);
  [
    { value: "not-started",  label: "Not Started"  },
    { value: "planning",     label: "Planning"     },
    { value: "in-progress",  label: "In Progress"  },
    { value: "blocked",      label: "Blocked"      },
    { value: "pending",      label: "Pending"      },
    { value: "complete",     label: "Complete"     },
  ].forEach(({ value, label }) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = label;
    statusSel.appendChild(o);
  });

  // ── Set RAG ────────────────────────────────────────────────────────────
  const ragSel = document.createElement("select");
  ragSel.className = "table-filter-select";
  ragSel.style.height = "30px";
  const ragPlaceholder = document.createElement("option");
  ragPlaceholder.value = ""; ragPlaceholder.textContent = "Set RAG…";
  ragSel.appendChild(ragPlaceholder);
  [
    { value: "red",   label: "🔴 Red"   },
    { value: "amber", label: "🟡 Amber" },
    { value: "green", label: "🟢 Green" },
    { value: "none",  label: "— Clear"  },
  ].forEach(({ value, label }) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = label;
    ragSel.appendChild(o);
  });

  // ── Move to project ────────────────────────────────────────────────────
  const projSel = document.createElement("select");
  projSel.className = "table-filter-select";
  projSel.style.height = "30px";
  const projPlaceholder = document.createElement("option");
  projPlaceholder.value = ""; projPlaceholder.textContent = "Move to project…";
  projSel.appendChild(projPlaceholder);
  shownProjects.forEach(p => {
    const o = document.createElement("option");
    o.value = String(p.id); o.textContent = p.name;
    projSel.appendChild(o);
  });

  // ── Apply button ────────────────────────────────────────────────────────
  const applyBtn = el("button", "btn btn--primary btn--sm", "Apply");
  applyBtn.type = "button";
  applyBtn.addEventListener("click", () => _applyBulkAction(statusSel, ragSel, projSel));

  // ── Clear button ────────────────────────────────────────────────────────
  const clearBtn = el("button", "btn btn--ghost btn--sm", "Clear");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", () => {
    _selectedIds.clear();
    document.querySelectorAll(".row-check").forEach(cb => { cb.checked = false; });
    document.querySelectorAll("tr.is-selected").forEach(tr => tr.classList.remove("is-selected"));
    _updateActionBar();
  });

  bar.append(countEl, statusSel, ragSel, projSel, applyBtn, clearBtn);
  return bar;
}

function _updateActionBar() {
  const bar      = document.getElementById("bulk-action-bar");
  const countEl  = document.getElementById("bulk-action-count");
  if (!bar) return;
  const n = _selectedIds.size;
  bar.style.display = n > 0 ? "" : "none";
  if (countEl) countEl.textContent = `${n} task${n !== 1 ? "s" : ""} selected`;
}

async function _applyBulkAction(statusSel, ragSel, projSel) {
  const ids     = [..._selectedIds];
  if (ids.length === 0) return;

  const status  = statusSel.value;
  const rag     = ragSel.value;
  const projId  = projSel.value ? parseInt(projSel.value, 10) : null;

  if (!status && !rag && !projId) {
    window.App?.toast?.("Choose at least one action to apply", "info");
    return;
  }

  const applyBtn = document.querySelector(".bulk-action-bar .btn--primary");
  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = "Applying…"; }

  try {
    const patch = {};
    if (status)          patch.status     = status;
    if (rag === "none")  patch.rag        = null;
    else if (rag)        patch.rag        = rag;
    if (projId) {
      // Moving to a different project — use a project-specific create then delete approach
      // For simplicity, we pass project_id via the move endpoint if available,
      // otherwise skip (task routes don't support cross-project moves directly via PUT)
      // We'll update what we can and show a warning for project moves.
      window.App?.toast?.("Moving tasks between projects is not yet supported via bulk action", "info");
    }

    if (Object.keys(patch).length > 0) {
      await Promise.all(ids.map(id => API.updateTask(id, patch)));
    }

    _selectedIds.clear();
    statusSel.value = "";
    ragSel.value    = "";
    projSel.value   = "";

    window.App?.toast?.(`Updated ${ids.length} task${ids.length !== 1 ? "s" : ""}`, "success");
    const updated = await API.listProjects();
    State.setProjects(updated);
    await _loadAndRender();
  } catch (e) {
    window.App?.toast?.("Error: " + e.message, "error");
    if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = "Apply"; }
  }
}
