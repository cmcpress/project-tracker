/**
 * views/cards.js — Card view: expandable accordion cards per project.
 *
 * Features:
 *   - Click task row to open edit modal
 *   - Inline status dropdown on each task row
 *   - Right-click context menu (Edit, Duplicate, Delete, Mark complete)
 *   - Quick-add task input at bottom of each card
 *   - Drag-to-reorder tasks within a card (HTML5 DnD)
 *   - Edit and delete buttons on project card header
 *
 * Implements the view interface: init(container), render(), destroy()
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { openTaskForm } from "../components/task-form.js";
import { openProjectForm } from "../components/project-form.js";
import { openLinkForm } from "../components/link-form.js";
import { createModal } from "../components/modal.js";
import { showContextMenu } from "../components/context-menu.js";
import {
  el, clearChildren, formatDateShort,
  statusLabel, statusClass, typeIcon, typeLabel,
  initials, isOverdue, pendingIndicator,
} from "../utils.js";

let _container        = null;
let _filterProjectId  = null;   // in-view project dropdown (or sidebar selection)
let _filterGroupId    = null;   // sidebar group task selection
let _filterStatus     = "";     // in-view status dropdown
let _filterSearch     = "";     // in-view search text
let _filterAssigneeId = null;   // assignee person id
let _filterDateFrom   = "";     // ISO date string, inclusive start
let _filterDateTo     = "";     // ISO date string, inclusive end
let _allLoadedProjects        = [];         // cached after last full load
let _groupProjectMap          = {};         // groupId → projectId (reverse lookup)
const _unsubs = [];

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;
  _unsubs.push(State.subscribe("activeProjectId", () => {
    _loadAndRender();
  }));
  _unsubs.push(State.subscribe("activeGroupId", (groupId) => {
    _filterGroupId = groupId;
    if (groupId !== null) {
      // Also sync the project filter to match the group's owning project
      const ownerProject = _groupProjectMap[groupId];
      if (ownerProject) _filterProjectId = ownerProject;
    } else {
      // Group cleared — revert project filter to sidebar selection
      _filterProjectId = State.getActiveProjectId();
    }
    _applyFilters(_allLoadedProjects);
  }));
  await _loadAndRender();
}

export async function render() {
  await _loadAndRender();
}

export function destroy() {
  _unsubs.forEach(fn => fn());
  _unsubs.length = 0;
  // Reset any container styles set by this view so other views aren't affected
  if (_container) _container.style.cssText = "";
  _filterProjectId          = null;
  _filterGroupId            = null;
  _filterStatus             = "";
  _filterSearch             = "";
  _filterAssigneeId         = null;
  _filterDateFrom           = "";
  _filterDateTo             = "";
  _allLoadedProjects        = [];
  _groupProjectMap          = {};
  State.setActiveGroupId(null);
  State.setProjectGroupTasks({});
  _container = null;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function _loadAndRender() {
  if (!_container) return;
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  try {
    const projects  = State.getProjects();
    const sidebarId = State.getActiveProjectId();

    // Sync project filter from sidebar
    if (sidebarId && !_filterProjectId) _filterProjectId = sidebarId;
    if (!sidebarId && _filterProjectId) _filterProjectId = null;

    // Sync group filter from state
    _filterGroupId = State.getActiveGroupId();
    if (_filterGroupId && _groupProjectMap[_filterGroupId]) {
      _filterProjectId = _groupProjectMap[_filterGroupId];
    }

    if (projects.length === 0) { _renderEmpty(); return; }
    const full = await Promise.all(projects.map(p => API.getProject(p.id)));

    // Build group task index for sidebar + local reverse map
    const groupMap = {};
    _groupProjectMap = {};
    full.forEach(proj => {
      const groups = (proj.tasks || []).filter(t => t.type === "group");
      if (groups.length > 0) {
        groupMap[proj.id] = groups.map(g => ({
          id: g.id, name: g.name, wbs_number: g.wbs_number || "",
        }));
        groups.forEach(g => { _groupProjectMap[g.id] = proj.id; });
      }
    });
    State.setProjectGroupTasks(groupMap);

    _renderCards(full, projects);
  } catch (e) {
    console.error("[cards] Load failed:", e);
    _container.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">Failed to load projects</div>
      <div class="empty-state__body">${e.message}</div></div>`;
  }
}

function _renderEmpty() {
  // Even empty state keeps the two-pane shell so the right pane is visible
  _buildTwoPaneShell([]);
}

function _buildFilterBar(allProjects) {
  // Two-row filter bar: dropdowns on row 1, date range on row 2
  const bar = el("div", "");
  bar.style.cssText = "display:flex;flex-direction:column;gap:var(--space-2);margin-bottom:0;";

  // ── Row 1: search + dropdowns ─────────────────────────────────────────────
  const row1 = el("div", "table-filters");
  row1.style.cssText = "flex-wrap:nowrap;margin-bottom:0;";

  // Search
  const searchInput = document.createElement("input");
  searchInput.type        = "search";
  searchInput.placeholder = "Search tasks…";
  searchInput.className   = "table-filter-input";
  searchInput.value       = _filterSearch;
  searchInput.addEventListener("input", () => {
    _filterSearch = searchInput.value;
    _applyFilters(allProjects);
  });

  // Project dropdown
  const projSel = document.createElement("select");
  projSel.className = "table-filter-select";
  const allProjOpt = document.createElement("option");
  allProjOpt.value = ""; allProjOpt.textContent = "All projects";
  projSel.appendChild(allProjOpt);
  allProjects.forEach(p => {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    if (p.id === _filterProjectId) o.selected = true;
    projSel.appendChild(o);
  });
  projSel.addEventListener("change", () => {
    _filterProjectId = projSel.value ? parseInt(projSel.value, 10) : null;
    _filterGroupId   = null;
    State.setActiveGroupId(null);
    _applyFilters(allProjects);
  });

  // Status dropdown
  const statusSel = document.createElement("select");
  statusSel.className = "table-filter-select";
  [
    { value: "", label: "All statuses" },
    { value: "not-started",  label: "Not Started" },
    { value: "planning",     label: "Planning" },
    { value: "in-progress",  label: "In Progress" },
    { value: "blocked",      label: "Blocked" },
    { value: "pending",      label: "Pending" },
    { value: "complete",     label: "Complete" },
  ].forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === _filterStatus) o.selected = true;
    statusSel.appendChild(o);
  });
  statusSel.addEventListener("change", () => {
    _filterStatus = statusSel.value;
    _applyFilters(allProjects);
  });

  // Assignee dropdown
  const assigneeSel = document.createElement("select");
  assigneeSel.className = "table-filter-select";
  const allPersonOpt = document.createElement("option");
  allPersonOpt.value = ""; allPersonOpt.textContent = "All people";
  assigneeSel.appendChild(allPersonOpt);
  State.getPeople().forEach(person => {
    const o = document.createElement("option");
    o.value = person.id; o.textContent = person.name;
    if (person.id === _filterAssigneeId) o.selected = true;
    assigneeSel.appendChild(o);
  });
  assigneeSel.addEventListener("change", () => {
    _filterAssigneeId = assigneeSel.value ? parseInt(assigneeSel.value, 10) : null;
    _applyFilters(allProjects);
  });

  row1.appendChild(searchInput);
  row1.appendChild(projSel);
  row1.appendChild(statusSel);
  row1.appendChild(assigneeSel);

  // ── Row 2: date range ─────────────────────────────────────────────────────
  const row2 = el("div", "table-filters");
  row2.style.cssText = "flex-wrap:nowrap;margin-bottom:0;";

  const dateFromLabel = el("span", "");
  dateFromLabel.textContent = "From:";
  dateFromLabel.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);white-space:nowrap;align-self:center;";

  const dateFromInput = document.createElement("input");
  dateFromInput.type      = "date";
  dateFromInput.className = "table-filter-select";
  dateFromInput.value     = _filterDateFrom;
  dateFromInput.style.cssText = "min-width:130px;cursor:pointer;";
  dateFromInput.addEventListener("change", () => {
    _filterDateFrom = dateFromInput.value;
    _applyFilters(allProjects);
  });

  const dateToLabel = el("span", "");
  dateToLabel.textContent = "To:";
  dateToLabel.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);white-space:nowrap;align-self:center;";

  const dateToInput = document.createElement("input");
  dateToInput.type      = "date";
  dateToInput.className = "table-filter-select";
  dateToInput.value     = _filterDateTo;
  dateToInput.style.cssText = "min-width:130px;cursor:pointer;";
  dateToInput.addEventListener("change", () => {
    _filterDateTo = dateToInput.value;
    _applyFilters(allProjects);
  });

  // Clear dates shortcut
  const clearDatesBtn = el("button", "btn btn--ghost btn--sm");
  clearDatesBtn.textContent = "Clear";
  clearDatesBtn.style.cssText = "font-size:var(--font-size-xs);padding:2px 8px;";
  clearDatesBtn.addEventListener("click", () => {
    dateFromInput.value = _filterDateFrom = "";
    dateToInput.value   = _filterDateTo   = "";
    _applyFilters(allProjects);
  });

  row2.appendChild(dateFromLabel);
  row2.appendChild(dateFromInput);
  row2.appendChild(dateToLabel);
  row2.appendChild(dateToInput);
  row2.appendChild(clearDatesBtn);

  bar.appendChild(row1);
  bar.appendChild(row2);
  return bar;
}

function _applyFilters(allProjects) {
  if (!_container || !allProjects || allProjects.length === 0) return;
  const wrapper = _container.querySelector("[data-cards-wrapper]");
  if (!wrapper) return;

  // Determine which project cards to show
  const visibleProjects = _filterProjectId
    ? allProjects.filter(p => p.id === _filterProjectId)
    : allProjects;

  // Show/hide project cards and filter task rows within them
  const search = _filterSearch.toLowerCase();
  allProjects.forEach(p => {
    const card = wrapper.querySelector(`[data-project-id="${p.id}"]`);
    if (!card) return;
    const show = visibleProjects.includes(p);
    card.style.display = show ? "" : "none";
    if (!show) return;

    // Filter task rows
    const rows = card.querySelectorAll(".task-row");
    rows.forEach(row => {
      const name       = (row.dataset.taskName  || "").toLowerCase();
      const status     = row.dataset.taskStatus || "";
      const parentId   = row.dataset.parentId   ? parseInt(row.dataset.parentId, 10) : null;
      const assigneeIds = row.dataset.assigneeIds
        ? row.dataset.assigneeIds.split(",").map(Number)
        : [];
      const taskStart  = row.dataset.startDate || "";
      const taskEnd    = row.dataset.endDate   || "";

      const matchSearch   = !search || name.includes(search);
      const matchStatus   = !_filterStatus    || status === _filterStatus;
      const matchGroup    = !_filterGroupId   || parentId === _filterGroupId;
      const matchAssignee = !_filterAssigneeId || assigneeIds.includes(_filterAssigneeId);
      // Date overlap: task overlaps filter window if task ends >= filterFrom AND task starts <= filterTo
      const effectiveStart = taskStart || taskEnd;
      const effectiveEnd   = taskEnd   || taskStart;
      const matchDateFrom  = !_filterDateFrom || !effectiveEnd   || effectiveEnd   >= _filterDateFrom;
      const matchDateTo    = !_filterDateTo   || !effectiveStart || effectiveStart <= _filterDateTo;

      row.style.display = (matchSearch && matchStatus && matchGroup && matchAssignee && matchDateFrom && matchDateTo)
        ? "" : "none";
    });
  });

}

function _renderCards(allProjects, projectList) {
  _allLoadedProjects = allProjects;
  _buildTwoPaneShell(allProjects);
  const wrapper = _container.querySelector("[data-cards-wrapper]");
  for (const p of allProjects) wrapper.appendChild(_buildProjectCard(p));
  _applyFilters(allProjects);
}

// ---------------------------------------------------------------------------
// Two-pane shell
// ---------------------------------------------------------------------------

function _buildTwoPaneShell(allProjects) {
  clearChildren(_container);
  _container.style.cssText = "display:flex;flex-direction:row;height:100%;overflow:hidden;";

  // ── Left pane — filter bar + cards ────────────────────────────────────────
  const leftPane = el("div", "");
  leftPane.style.cssText = "flex:1;overflow-y:auto;padding:var(--space-4);min-width:0;";

  const bar = _buildFilterBar(allProjects);
  leftPane.appendChild(bar);

  const wrapper = el("div", "");
  wrapper.setAttribute("data-cards-wrapper", "");
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:var(--space-4);margin-top:var(--space-4);";

  if (allProjects.length === 0) {
    const emptyMsg = el("div", "empty-state");
    emptyMsg.innerHTML = `<div class="empty-state__title">No projects yet</div>
      <div class="empty-state__body">Create your first project using the sidebar.</div>`;
    wrapper.appendChild(emptyMsg);
  }

  leftPane.appendChild(wrapper);

  // ── Right pane — action buttons + expenses ─────────────────────────────────
  const rightPane = _buildRightPane(allProjects);

  _container.appendChild(leftPane);
  _container.appendChild(rightPane);
}

function _buildRightPane(allProjects) {
  const pane = el("div", "");
  pane.style.cssText = [
    "width:280px;flex-shrink:0;",
    "border-left:1px solid var(--border);",
    "display:flex;flex-direction:column;",
    "background:var(--surface);",
    "overflow-y:auto;",
  ].join("");

  // ── Pill buttons ──────────────────────────────────────────────────────────
  const btnSection = el("div", "");
  btnSection.style.cssText = "padding:var(--space-4);display:flex;flex-direction:column;gap:var(--space-2);";

  const addTaskBtn = el("button", "btn btn--primary");
  addTaskBtn.style.cssText = "width:100%;justify-content:center;font-size:var(--font-size-sm);font-weight:600;border-radius:999px;padding:var(--space-2) var(--space-3);";
  addTaskBtn.innerHTML = `<span style="font-size:16px;margin-right:6px;">＋</span>Add Task`;
  addTaskBtn.addEventListener("click", () => {
    if (!_filterProjectId) {
      window.App?.toast?.("Select a project first to add a task", "info");
      return;
    }
    openTaskForm({}, _filterProjectId, async () => {
      window.App?.toast?.("Task created", "success");
      const updated = await API.listProjects();
      State.setProjects(updated);
      await _refreshProjectCard(_filterProjectId);
      });
  });

  const fromTplBtn = el("button", "btn btn--secondary");
  fromTplBtn.style.cssText = "width:100%;justify-content:center;font-size:var(--font-size-sm);border-radius:999px;padding:var(--space-2) var(--space-3);";
  fromTplBtn.innerHTML = `<span style="margin-right:6px;">⊞</span>From Template`;
  fromTplBtn.addEventListener("click", () => _openApplyTemplateModal(allProjects));

  btnSection.appendChild(addTaskBtn);
  btnSection.appendChild(fromTplBtn);
  pane.appendChild(btnSection);

  return pane;
}

// ---------------------------------------------------------------------------
// Project card
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Earned Value panel
// ---------------------------------------------------------------------------

async function _loadEVPanel(projectId, container) {
  try {
    const ev = await API.getEarnedValue(projectId);
    if (!ev || ev.budgeted_tasks === 0) return;   // nothing to show

    const sym = State.getCurrencySymbol ? State.getCurrencySymbol() : "£";

    const fmt = (n) => n == null ? "N/A" : Number(n).toFixed(2);
    const fmtCcy = (n) => n == null ? "N/A" : sym + Number(n).toFixed(0);

    // CPI/SPI colour coding: <0.9 red, 0.9–1.0 amber, ≥1.0 green
    const indexColor = (v) => {
      if (v == null) return "var(--text-muted)";
      if (v < 0.9)  return "#ef4444";
      if (v < 1.0)  return "#f59e0b";
      return "#22c55e";
    };

    const strip = el("div", "");
    strip.style.cssText = [
      "display:flex;flex-wrap:wrap;gap:var(--space-2);",
      "padding:var(--space-2) var(--space-3) var(--space-3);",
      "border-top:1px solid var(--border);",
      "margin-top:var(--space-1);",
    ].join("");

    const label = el("span", "");
    label.style.cssText = "font-size:var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;align-self:center;flex-shrink:0;margin-right:var(--space-1);";
    label.textContent = "EV";
    strip.appendChild(label);

    const metrics = [
      { key: "BAC",  value: fmtCcy(ev.bac),  title: "Budget at Completion" },
      { key: "PV",   value: fmtCcy(ev.pv),   title: "Planned Value" },
      { key: "EV",   value: fmtCcy(ev.ev),   title: "Earned Value" },
      { key: "AC",   value: fmtCcy(ev.ac),   title: "Actual Cost" },
      { key: "CPI",  value: fmt(ev.cpi),      title: "Cost Performance Index (EV/AC)", color: indexColor(ev.cpi) },
      { key: "SPI",  value: fmt(ev.spi),      title: "Schedule Performance Index (EV/PV)", color: indexColor(ev.spi) },
    ];

    for (const m of metrics) {
      const chip = el("div", "");
      chip.style.cssText = "display:flex;align-items:center;gap:4px;padding:2px 8px;background:var(--grey-50);border:1px solid var(--border);border-radius:var(--radius);";
      chip.title = m.title;

      const keyEl = el("span", "");
      keyEl.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);font-weight:500;";
      keyEl.textContent = m.key;

      const valEl = el("span", "");
      valEl.style.cssText = `font-size:var(--font-size-xs);font-weight:600;color:${m.color || "var(--text-primary)"};`;
      valEl.textContent = m.value;

      chip.appendChild(keyEl);
      chip.appendChild(valEl);
      strip.appendChild(chip);
    }

    container.appendChild(strip);
  } catch (e) {
    // EV load failure is non-fatal — silently skip
    console.warn("[cards] EV panel failed to load:", e.message);
  }
}

function _buildProjectCard(project) {
  const card = el("div", "card");
  card.dataset.projectId = String(project.id);

  const accent = el("div", "card__accent");
  accent.style.background = project.colour || "#4a90e2";

  const header = el("div", "card__header");
  header.style.cursor = "pointer";

  const headerLeft = el("div", "");
  headerLeft.style.cssText = "display:flex;align-items:center;gap:var(--space-3);flex:1;min-width:0;";

  const titleEl = el("span", "card__title truncate", project.name);
  titleEl.title = project.name;
  const catBadge = el("span", "badge badge--category", project.category);
  const statusBadge = el("span", `badge badge--${statusClass(project.status)}`, statusLabel(project.status));
  headerLeft.appendChild(titleEl);
  headerLeft.appendChild(catBadge);
  headerLeft.appendChild(statusBadge);

  const total = project.task_count || 0;
  const done = project.completed_task_count || 0;
  const pct = project.completion_pct || 0;

  const progressWrap = el("div", "");
  progressWrap.style.cssText = "display:flex;align-items:center;gap:var(--space-3);flex-shrink:0;";
  const progressText = el("span", "");
  progressText.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);white-space:nowrap;";
  progressText.textContent = `${done}/${total}`;
  const progressBar = el("div", "progress-bar");
  progressBar.style.width = "72px";
  const progressFill = el("div", "progress-bar__fill" + (pct === 100 ? " progress-bar__fill--complete" : ""));
  progressFill.style.width = pct + "%";
  progressBar.appendChild(progressFill);
  progressWrap.appendChild(progressText);
  progressWrap.appendChild(progressBar);

  const headerActions = el("div", "");
  headerActions.style.cssText = "display:flex;align-items:center;gap:var(--space-1);flex-shrink:0;";

  // Links button — shows count badge, opens link manager modal
  const linkCount = project.link_count || 0;
  const linksBtn = el("button", "btn btn--ghost btn--sm");
  linksBtn.title = "Manage project links";
  linksBtn.style.cssText = "flex-shrink:0;font-size:var(--font-size-xs);padding:2px 8px;display:flex;align-items:center;gap:4px;";
  const linkIcon = el("span", "");
  linkIcon.textContent = "🔗";
  linkIcon.style.fontSize = "12px";
  const linkLabel = el("span", "");
  linkLabel.textContent = linkCount > 0 ? `Links (${linkCount})` : "Links";
  linksBtn.appendChild(linkIcon);
  linksBtn.appendChild(linkLabel);
  linksBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openLinkForm(project, (newCount) => {
      // Update the badge text in-place without re-rendering the whole card
      linkLabel.textContent = newCount > 0 ? `Links (${newCount})` : "Links";
      project.link_count = newCount;
    });
  });

  const editBtn = el("button", "btn btn--ghost btn--icon");
  editBtn.title = "Edit project";
  editBtn.innerHTML = "✎";
  editBtn.style.fontSize = "13px";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openProjectForm(project, async (saved) => {
      State.upsertProject(saved);
      window.App?.toast?.(`Project "${saved.name}" updated`, "success");
      await _loadAndRender();
    });
  });

  const delBtn = el("button", "btn btn--ghost btn--icon");
  delBtn.title = "Delete project";
  delBtn.innerHTML = "🗑";
  delBtn.style.fontSize = "12px";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _confirmDeleteProject(project);
  });

  const chevron = el("button", "btn btn--ghost btn--icon");
  chevron.setAttribute("aria-label", "Toggle tasks");
  chevron.innerHTML = `<span style="font-size:12px;display:inline-block;transition:transform var(--transition-base);">▾</span>`;

  headerActions.appendChild(linksBtn);
  headerActions.appendChild(editBtn);
  headerActions.appendChild(delBtn);
  headerActions.appendChild(chevron);

  header.appendChild(headerLeft);
  header.appendChild(progressWrap);
  header.appendChild(headerActions);

  const body = el("div", "card__body");
  body.style.paddingTop = "0";

  const taskListEl = el("div", "");
  taskListEl.dataset.taskList = String(project.id);
  _renderTaskList(taskListEl, project);

  body.appendChild(taskListEl);

  // Earned Value panel — loaded async, only shown when project has budgeted tasks
  const evContainer = el("div", "");
  evContainer.dataset.evPanel = "1";
  body.appendChild(evContainer);
  _loadEVPanel(project.id, evContainer);

  if (project.description) {
    const descEl = el("div", "");
    descEl.style.cssText = "padding:var(--space-2) 0 var(--space-1);font-size:var(--font-size-sm);color:var(--text-secondary);border-top:1px solid var(--border);margin-top:var(--space-2);";
    descEl.textContent = project.description;
    body.appendChild(descEl);
  }

  card.appendChild(accent);
  card.appendChild(header);
  card.appendChild(body);

  // Default is collapsed. Setting saved as "true" opts in to expanded.
  const defaultExpanded = localStorage.getItem("cards_default_expanded") === "true";
  let expanded = defaultExpanded;
  const chevronSpan = chevron.querySelector("span");

  const toggleExpand = () => {
    expanded = !expanded;
    body.style.display = expanded ? "" : "none";
    chevronSpan.style.transform = expanded ? "" : "rotate(-90deg)";
    chevron.setAttribute("aria-expanded", String(expanded));
  };

  // Apply initial state (collapsed by default unless setting says otherwise)
  if (!expanded) {
    body.style.display = "none";
    chevronSpan.style.transform = "rotate(-90deg)";
    chevron.setAttribute("aria-expanded", "false");
  }

  header.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    toggleExpand();
  });
  chevron.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(); });

  return card;
}

// ---------------------------------------------------------------------------
// Task list
// ---------------------------------------------------------------------------

function _renderTaskList(taskListEl, project) {
  clearChildren(taskListEl);
  if (!project.tasks || project.tasks.length === 0) {
    const empty = el("div", "");
    empty.style.cssText = "padding:var(--space-3) var(--space-1);font-size:var(--font-size-sm);color:var(--text-muted);";
    empty.textContent = "No tasks yet — add one below.";
    taskListEl.appendChild(empty);
    return;
  }
  for (const task of project.tasks) {
    taskListEl.appendChild(_buildTaskRow(task, project));
  }
  _initDragReorder(taskListEl, project.id);
}

function _buildTaskRow(task, project) {
  const row = el("div", "task-row");
  row.draggable = true;
  row.dataset.taskId     = String(task.id);
  row.dataset.taskName   = task.name || "";
  row.dataset.taskStatus = task.status || "";
  if (task.parent_id != null) row.dataset.parentId = String(task.parent_id);
  if (task.start_date)  row.dataset.startDate   = task.start_date;
  if (task.end_date)    row.dataset.endDate      = task.end_date;
  if (task.assignees && task.assignees.length > 0) {
    row.dataset.assigneeIds = task.assignees.map(a => a.id).join(",");
  }
  // Outer row: handle | type | [content area] | status | meta
  row.style.cssText = "display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--border);cursor:pointer;transition:background var(--transition-fast);user-select:none;";

  // ── Drag handle ───────────────────────────────────────────────────────────
  const handle = el("span", "");
  handle.textContent = "⠿";
  handle.style.cssText = "color:var(--text-muted);cursor:grab;font-size:14px;opacity:0.4;flex-shrink:0;";
  handle.title = "Drag to reorder";

  // ── Type icon ─────────────────────────────────────────────────────────────
  const typeEl = el("span", "");
  typeEl.style.cssText = "font-size:11px;width:14px;text-align:center;flex-shrink:0;";
  typeEl.textContent = typeIcon(task.type);
  typeEl.title = typeLabel(task.type);
  if (task.type === "milestone") typeEl.style.color = "var(--gantt-milestone)";
  if (task.type === "phase")     typeEl.style.color = "var(--blue)";

  const isDone = task.status === "complete";

  // ── Content area (takes all remaining space) ──────────────────────────────
  // Flex-column: top row (name | date | assignee) + progress bar underneath
  const contentArea = el("div", "");
  contentArea.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;";

  // ── Top row: name, date and assignee all in one flex row ──────────────────
  const topRow = el("div", "");
  topRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3);min-width:0;";

  // WBS badge (optional, inside name section)
  const nameSection = el("div", "");
  nameSection.style.cssText = "flex:1;min-width:0;display:flex;align-items:baseline;gap:var(--space-2);";

  if (task.wbs_number) {
    const wbsBadge = el("span", "");
    wbsBadge.style.cssText = "font-size:var(--font-size-xs);font-family:var(--font-mono);color:var(--text-muted);flex-shrink:0;";
    wbsBadge.textContent = task.wbs_number;
    nameSection.appendChild(wbsBadge);
  }

  const nameEl = el("span", "truncate");
  nameEl.style.cssText = "font-size:var(--font-size-base);font-weight:500;min-width:0;" +
    "color:" + (isDone ? "var(--text-muted)" : "var(--text-primary)") + ";" +
    (isDone ? "text-decoration:line-through;" : "");
  nameEl.textContent = task.name;
  nameEl.title = task.name;
  nameSection.appendChild(nameEl);

  // Date column — fixed width, right of name
  const dateCol = el("span", "");
  dateCol.style.cssText = "flex-shrink:0;width:150px;font-size:var(--font-size-sm);white-space:nowrap;";
  if (task.start_date || task.end_date) {
    const overdue = task.end_date && isOverdue(task.end_date) && !isDone;
    dateCol.style.color = overdue ? "var(--status-blocked-text)" : "var(--text-muted)";
    if (task.start_date && task.end_date) {
      dateCol.textContent = formatDateShort(task.start_date) + " – " + formatDateShort(task.end_date);
    } else {
      dateCol.textContent = formatDateShort(task.start_date || task.end_date);
    }
  }

  // Assignee column — fixed width, right of date
  const assigneeCol = el("span", "");
  assigneeCol.style.cssText = "flex-shrink:0;width:140px;font-size:var(--font-size-sm);color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  if (task.assignees && task.assignees.length > 0) {
    const names = task.assignees.map(a => a.name.split(" ")[0]);
    assigneeCol.textContent = names.length <= 2
      ? names.join(", ")
      : names[0] + " +" + (names.length - 1) + " more";
    assigneeCol.title = task.assignees.map(a => a.name).join(", ");
  }

  // Assemble the top row: [name section] [date] [assignee] — status appended below after declaration
  topRow.appendChild(nameSection);
  topRow.appendChild(dateCol);
  topRow.appendChild(assigneeCol);
  contentArea.appendChild(topRow);

  // Progress bar (sits below the top row, inside contentArea)
  const progressPct = Math.round((parseFloat(task.progress) || 0) * 100);
  if (progressPct > 0) {
    const track = el("div", "");
    track.style.cssText = "height:3px;background:var(--grey-200);border-radius:2px;overflow:hidden;";
    const fill = el("div", "");
    fill.style.cssText = `height:100%;width:${progressPct}%;background:var(--blue);border-radius:2px;`;
    track.appendChild(fill);
    contentArea.appendChild(track);
  }

  // ── Status select ─────────────────────────────────────────────────────────
  const statusSel = document.createElement("select");
  statusSel.className = "status-select status-select--" + statusClass(task.status);
  statusSel.title = "Change status";
  [
    { value: "not-started", label: "Not Started" },
    { value: "planning",    label: "Planning" },
    { value: "in-progress", label: "In Progress" },
    { value: "blocked",     label: "Blocked" },
    { value: "pending",     label: "Pending" },
    { value: "complete",    label: "Complete" },
  ].forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === task.status) o.selected = true;
    statusSel.appendChild(o);
  });
  statusSel.addEventListener("click", (e) => e.stopPropagation());
  statusSel.addEventListener("change", async (e) => {
    e.stopPropagation();
    const newStatus = statusSel.value;
    statusSel.className = "status-select status-select--" + statusClass(newStatus);
    const nowDone = newStatus === "complete";
    nameEl.style.textDecoration = nowDone ? "line-through" : "";
    nameEl.style.color = nowDone ? "var(--text-muted)" : "var(--text-primary)";
    row.dataset.taskStatus = newStatus;
    try {
      await API.updateTaskStatus(task.id, newStatus);
      task.status = newStatus;
      const updated = await API.listProjects();
      State.setProjects(updated);
    } catch (err) {
      window.App?.toast?.("Failed to update status: " + err.message, "error");
      statusSel.value = task.status;
      statusSel.className = "status-select status-select--" + statusClass(task.status);
    }
  });

  // Status is the rightmost item in the top row
  topRow.appendChild(statusSel);

  // ── Meta badges ───────────────────────────────────────────────────────────
  const metaEl = el("div", "");
  metaEl.style.cssText = "display:flex;gap:var(--space-1);flex-shrink:0;align-items:center;";

  // Pending indicator — ⚠ if overdue, 💤 if within window
  const pendingIcon = pendingIndicator(task);
  if (pendingIcon) {
    const pip = el("span", "");
    const isOverduePending = pendingIcon === "⚠";
    pip.style.cssText = `font-size:12px;flex-shrink:0;color:${isOverduePending ? "#f59e0b" : "var(--status-pending-text)"};`;
    pip.textContent = pendingIcon;
    pip.title = isOverduePending
      ? "Pending overdue — expected " + (task.pending_until || "unknown")
      : "Pending — expected by " + (task.pending_until || "unknown");
    metaEl.appendChild(pip);
  }

  // RAG dot — value already computed by backend (auto-red/amber/green rules applied)
  if (task.rag) {
    const ragColors = { red: "#ef4444", amber: "#f59e0b", green: "#22c55e" };
    const ragTitles = { red: "Off track (Red)", amber: "At risk (Amber)", green: "On track (Green)" };
    const ragDot = el("span", "");
    ragDot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${ragColors[task.rag] || "var(--grey-400)"};flex-shrink:0;`;
    ragDot.title = ragTitles[task.rag] || task.rag;
    metaEl.appendChild(ragDot);
  }

  const depCount  = task.dependency_count || 0;
  const itemCount = task.item_count       || 0;
  if (depCount > 0) {
    const b = el("span", "count-badge");
    b.title = depCount + " " + (depCount === 1 ? "dependency" : "dependencies");
    b.textContent = "⇒ " + depCount;
    metaEl.appendChild(b);
  }
  if (itemCount > 0) {
    const b = el("span", "count-badge");
    b.title = itemCount + " item" + (itemCount === 1 ? "" : "s");
    b.textContent = "☑ " + itemCount;
    metaEl.appendChild(b);
  }

  // ── Events ────────────────────────────────────────────────────────────────
  row.addEventListener("click", (e) => {
    if (e.target.closest("select, button, input")) return;
    _openEditTask(task, project);
  });
  row.addEventListener("contextmenu", (e) => {
    const isGroup = task.type === "group";
    const menuItems = [
      { label: "Edit task",  icon: "✎", action: () => _openEditTask(task, project) },
      { label: "Duplicate",  icon: "⧉", action: () => _duplicateTask(task, project) },
      { label: isDone ? "Mark incomplete" : "Mark complete",
        icon: isDone ? "○" : "✓",
        action: async () => {
          const ns = isDone ? "not-started" : "complete";
          try {
            await API.updateTaskStatus(task.id, ns);
            const up = await API.listProjects();
            State.setProjects(up);
            await _refreshProjectCard(project.id);
          } catch (err) { window.App?.toast?.(err.message, "error"); }
        },
      },
    ];
    menuItems.push({ type: "divider" });
    menuItems.push({
      label: "Save as template…", icon: "⊞",
      action: () => _saveAsTemplate(task),
    });
    menuItems.push({ type: "divider" });
    menuItems.push({ label: "Delete task", icon: "🗑", danger: true, action: () => _confirmDeleteTask(task, project) });
    showContextMenu(e, menuItems);
  });
  row.addEventListener("mouseenter", () => { row.style.background = "var(--grey-50)"; });
  row.addEventListener("mouseleave", () => { row.style.background = ""; });

  row.appendChild(handle);
  row.appendChild(typeEl);
  row.appendChild(contentArea);
  row.appendChild(metaEl);
  return row;
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

async function _saveAsTemplate(task) {
  const { createModal } = await import("../components/modal.js");
  const modal = createModal({ title: "Save as Template", wide: false, onClose: () => {} });

  const body = el("div", "");
  body.style.cssText = "display:flex;flex-direction:column;gap:var(--space-4);";

  const desc = el("p", "");
  desc.style.cssText = "font-size:var(--font-size-sm);color:var(--text-secondary);margin:0;";
  desc.textContent = `Save "${task.name}" and all its child tasks as a reusable template.`;
  body.appendChild(desc);

  const nameGroup = el("div", "form-group");
  const nameLbl = el("label", "form-label", "Template name");
  const nameInp = document.createElement("input");
  nameInp.type = "text";
  nameInp.className = "form-input";
  nameInp.value = task.name;
  nameInp.placeholder = "e.g. Sprint Setup";
  nameGroup.appendChild(nameLbl);
  nameGroup.appendChild(nameInp);
  body.appendChild(nameGroup);

  const descGroup = el("div", "form-group");
  const descLbl = el("label", "form-label", "Description (optional)");
  const descInp = document.createElement("input");
  descInp.type = "text";
  descInp.className = "form-input";
  descInp.placeholder = "Short description…";
  descGroup.appendChild(descLbl);
  descGroup.appendChild(descInp);
  body.appendChild(descGroup);

  modal.setBody(body);

  const cancelBtn = el("button", "btn btn--secondary", "Cancel");
  cancelBtn.addEventListener("click", () => modal.close());

  const saveBtn = el("button", "btn btn--primary", "Save template");
  saveBtn.addEventListener("click", async () => {
    const name = nameInp.value.trim();
    if (!name) { nameInp.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await API.saveTemplate({ group_task_id: task.id, name, description: descInp.value.trim() || null });
      window.App?.toast?.(`Template "${name}" saved`, "success");
      modal.close();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save template";
    }
  });
  nameInp.addEventListener("keydown", (e) => { if (e.key === "Enter") saveBtn.click(); });

  modal.setFooter(cancelBtn, saveBtn);
  modal.open();
  setTimeout(() => nameInp.select(), 50);
}

async function _openApplyTemplateModal(allProjects) {
  const { createModal } = await import("../components/modal.js");

  let templates = [];
  try {
    templates = await API.listTemplates();
  } catch (e) {
    window.App?.toast?.("Could not load templates: " + e.message, "error");
    return;
  }

  const modal = createModal({ title: "Apply Template", wide: false, onClose: () => {} });
  const body = el("div", "");
  body.style.cssText = "display:flex;flex-direction:column;gap:var(--space-4);";

  if (templates.length === 0) {
    const empty = el("p", "");
    empty.style.cssText = "font-size:var(--font-size-sm);color:var(--text-muted);margin:0;";
    empty.textContent = "No templates saved yet. Right-click a group task in Cards view and choose “Save as template”.";
    body.appendChild(empty);
    modal.setBody(body);
    const closeBtn = el("button", "btn btn--secondary", "Close");
    closeBtn.addEventListener("click", () => modal.close());
    modal.setFooter(closeBtn);
    modal.open();
    return;
  }

  // Template picker
  const tplGroup = el("div", "form-group");
  const tplLbl = el("label", "form-label", "Template");
  const tplSel = document.createElement("select");
  tplSel.className = "form-select";
  templates.forEach(t => {
    const o = document.createElement("option");
    o.value = String(t.id);
    o.textContent = `${t.name} (${t.task_count} tasks)`;
    tplSel.appendChild(o);
  });
  tplGroup.appendChild(tplLbl);
  tplGroup.appendChild(tplSel);
  body.appendChild(tplGroup);

  // Project picker
  const projGroup = el("div", "form-group");
  const projLbl = el("label", "form-label", "Add to project");
  const projSel = document.createElement("select");
  projSel.className = "form-select";
  allProjects.forEach(p => {
    const o = document.createElement("option");
    o.value = String(p.id);
    o.textContent = p.name;
    projSel.appendChild(o);
  });
  projGroup.appendChild(projLbl);
  projGroup.appendChild(projSel);
  body.appendChild(projGroup);

  // Start date
  const dateGroup = el("div", "form-group");
  const dateLbl = el("label", "form-label", "Start date");
  const dateInp = document.createElement("input");
  dateInp.type = "date";
  dateInp.className = "form-input";
  dateInp.value = new Date().toISOString().slice(0, 10);
  dateGroup.appendChild(dateLbl);
  dateGroup.appendChild(dateInp);
  body.appendChild(dateGroup);

  modal.setBody(body);

  const cancelBtn = el("button", "btn btn--secondary", "Cancel");
  cancelBtn.addEventListener("click", () => modal.close());

  const applyBtn = el("button", "btn btn--primary", "Apply template");
  applyBtn.addEventListener("click", async () => {
    const tplId = parseInt(tplSel.value, 10);
    const projId = parseInt(projSel.value, 10);
    const startDate = dateInp.value;
    if (!startDate) { dateInp.focus(); return; }
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    try {
      const result = await API.applyTemplate(tplId, { project_id: projId, start_date: startDate });
      window.App?.toast?.(`Template applied — ${result.tasks_created} tasks created`, "success");
      const updated = await API.listProjects();
      State.setProjects(updated);
      modal.close();
      await _loadAndRender();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply template";
    }
  });

  modal.setFooter(cancelBtn, applyBtn);
  modal.open();
}

// ---------------------------------------------------------------------------
// Drag-to-reorder
// ---------------------------------------------------------------------------

function _initDragReorder(taskListEl, projectId) {
  let dragging = null;
  taskListEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".task-row");
    if (!row) return;
    dragging = row;
    row.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
  });
  taskListEl.addEventListener("dragend", () => {
    if (dragging) dragging.style.opacity = "";
    dragging = null;
  });
  taskListEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!dragging) return;
    const row = e.target.closest(".task-row");
    if (!row || row === dragging) return;
    const mid = row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    taskListEl.insertBefore(dragging, e.clientY < mid ? row : row.nextSibling);
  });
  taskListEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    const rows = [...taskListEl.querySelectorAll(".task-row")];
    const order = rows.map((r, i) => ({ id: parseInt(r.dataset.taskId, 10), sort_order: i }));
    try { await API.reorderTasks(order); } catch (err) { console.error("[cards] Reorder:", err); }
  });
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

async function _openEditTask(task, project) {
  await openTaskForm(task, project.id, async () => {
    window.App?.toast?.("Task saved", "success");
    await _refreshProjectCard(project.id);
  });
}

async function _duplicateTask(task, project) {
  try {
    await API.createTask(project.id, {
      name: task.name + " (copy)",
      type: task.type,
      status: "not-started",
      start_date: task.start_date,
      end_date: task.end_date,
      notes: task.notes,
    });
    window.App?.toast?.('"' + task.name + '" duplicated', "success");
    await _refreshProjectCard(project.id);
  } catch (err) {
    window.App?.toast?.("Error: " + err.message, "error");
  }
}

function _confirmDeleteTask(task, project) {
  const modal = createModal({ title: "Delete Task" });
  const msg = document.createElement("p");
  msg.style.cssText = "margin:0;line-height:1.5;";
  msg.innerHTML = 'Delete <strong>' + task.name + '</strong>? This cannot be undone.';
  modal.setBody(msg);
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => modal.close());
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn--danger";
  deleteBtn.textContent = "Delete Task";
  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting…";
    try {
      await API.deleteTask(task.id);
      modal.close();
      window.App?.toast?.('"' + task.name + '" deleted', "success");
      const updated = await API.listProjects();
      State.setProjects(updated);
      await _refreshProjectCard(project.id);
    } catch (err) {
      window.App?.toast?.("Error: " + err.message, "error");
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete Task";
    }
  });
  modal.setFooter(cancelBtn, deleteBtn);
  modal.open();
}

function _confirmDeleteProject(project) {
  const modal = createModal({ title: "Delete Project" });
  const msg = document.createElement("p");
  msg.style.cssText = "margin:0;line-height:1.5;";
  msg.innerHTML = 'Delete <strong>' + project.name + '</strong> and all its tasks? This cannot be undone.';
  modal.setBody(msg);
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => modal.close());
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn--danger";
  deleteBtn.textContent = "Delete Project";
  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting…";
    try {
      await API.deleteProject(project.id);
      modal.close();
      State.removeProject(project.id);
      window.App?.toast?.('"' + project.name + '" deleted', "success");
      await _loadAndRender();
    } catch (err) {
      window.App?.toast?.("Error: " + err.message, "error");
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete Project";
    }
  });
  modal.setFooter(cancelBtn, deleteBtn);
  modal.open();
}

// ---------------------------------------------------------------------------
// Refresh a single card in-place
// ---------------------------------------------------------------------------

async function _refreshProjectCard(projectId) {
  if (!_container) return;
  try {
    const updated = await API.getProject(projectId);
    const projects = await API.listProjects();
    State.setProjects(projects);
    const card = _container.querySelector('[data-project-id="' + projectId + '"]');
    if (!card) { await _loadAndRender(); return; }
    const newCard = _buildProjectCard(updated);
    card.parentNode.replaceChild(newCard, card);
  } catch (e) {
    console.error("[cards] Refresh failed:", e);
    await _loadAndRender();
  }
}
