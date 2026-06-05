/**
 * components/task-form.js — Add/edit task modal.
 *
 * Handles:
 *   - All task fields: name, type, status, planned dates, actual dates,
 *     duration (auto-computed), is_firm_date, notes
 *   - Phase 1 additions: parent group, WBS number, progress (0-100%)
 *   - Group type: hides date fields (dates derived from children)
 *   - Assignee multi-select (shows all people, toggles assignment)
 *   - Task items section: add/edit/delete components, notes, subtasks
 *     with completion checkboxes
 *   - Dependencies manager (edit mode only)
 *
 * @param {object|null} task       - Existing task to edit, or null for create
 * @param {number}      projectId  - Required when creating (ignored on edit)
 * @param {Function}    onSaved    - Called with the saved task object
 */

import { createModal } from "./modal.js";
import * as API from "../api.js";
import * as State from "../state.js";
import { el, formatDuration } from "../utils.js";

/** Return the currency symbol from state (safe default). */
const _currency = () => State.getCurrencySymbol() || "£";

// ---------------------------------------------------------------------------
// Note-links parser + right-panel builder
// ---------------------------------------------------------------------------

/**
 * Parse a notes string for the structured link format:
 *   # SECTION TITLE      → named section
 *   ## DISPLAY NAME(URL) → named clickable link
 * Also picks up bare URLs and Windows paths on their own lines.
 *
 * Returns an array of { title: string|null, links: [{name, url}] }
 */
function _parseNoteLinks(text) {
  const sections = [];
  let current = null;

  const ensureCurrent = () => {
    if (!current) {
      current = { title: null, links: [] };
      sections.push(current);
    }
  };

  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // # SECTION (single #, not ##)
    if (/^#(?!#)/.test(line)) {
      const title = line.replace(/^#+\s*/, "").trim();
      current = { title: title || null, links: [] };
      sections.push(current);
      continue;
    }

    // ## NAME(URL)  — the URL/path is inside the trailing parentheses
    // Use greedy match for name so last (...) is always the URL, even if name contains parens
    const mdMatch = line.match(/^##?\s*(.+)\s*\(\s*(.+?)\s*\)\s*$/);
    if (mdMatch) {
      const name = mdMatch[1].trim();
      const url  = mdMatch[2].trim();
      // Only treat as a link if the parens content looks like a URL or Windows path
      if (/^https?:\/\/|^ftps?:\/\/|^file:\/\/|^[A-Za-z]:\\|^\\\\/.test(url)) {
        ensureCurrent();
        current.links.push({ name, url });
        continue;
      }
    }

    // Bare URL or Windows path on its own line
    const bareMatch = line.match(/^(https?:\/\/\S+|ftps?:\/\/\S+|[A-Za-z]:\\\S+|\\\\[^\s]+)$/);
    if (bareMatch) {
      ensureCurrent();
      current.links.push({ name: bareMatch[1], url: bareMatch[1] });
    }
  }

  return sections.filter(s => s.links.length > 0);
}

/**
 * Build the right-hand "Links" side panel for the task modal.
 * Listens to the notes textarea (found by #tf-notes inside container) for
 * live updates.
 *
 * @param {HTMLElement} container - The split wrapper element; used to locate
 *                                  the textarea after it's in the DOM.
 * @returns {HTMLElement}
 */
function _buildLinksPanel(container) {
  const panel = document.createElement("div");
  panel.style.cssText = [
    "width:230px;",
    "flex-shrink:0;",
    "border-left:1px solid var(--border);",
    "margin-left:var(--space-4);",
    "padding-left:var(--space-4);",
    "display:flex;",
    "flex-direction:column;",
    "gap:var(--space-2);",
  ].join("");

  // Panel heading
  const heading = document.createElement("div");
  heading.style.cssText = "font-size:var(--font-size-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;padding-bottom:4px;border-bottom:1px solid var(--border);margin-bottom:var(--space-1);";
  heading.textContent = "Links";
  panel.appendChild(heading);

  // Scrollable content area
  const content = document.createElement("div");
  content.style.cssText = "flex:1;display:flex;flex-direction:column;gap:var(--space-3);overflow-y:auto;";
  panel.appendChild(content);

  // Hint shown when no links are found
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);line-height:1.6;";
  hint.innerHTML =
    "Add links in Notes using:<br>" +
    "<code style='font-size:10px;background:var(--grey-100);padding:2px 4px;border-radius:3px;'>" +
    "# Section<br>## Name(url)" +
    "</code>";
  panel.appendChild(hint);

  function refresh(text) {
    content.innerHTML = "";
    const sections = _parseNoteLinks(text);

    if (sections.length === 0) {
      hint.style.display = "";
      return;
    }
    hint.style.display = "none";

    for (const sec of sections) {
      const block = document.createElement("div");
      block.style.cssText = "display:flex;flex-direction:column;gap:3px;";

      if (sec.title) {
        const secTitle = document.createElement("div");
        secTitle.style.cssText = "font-size:var(--font-size-xs);font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px;";
        secTitle.textContent = sec.title;
        block.appendChild(secTitle);
      }

      for (const link of sec.links) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn--ghost btn--sm";
        btn.style.cssText = "width:100%;text-align:left;justify-content:flex-start;font-size:var(--font-size-xs);padding:4px 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--blue);";
        btn.textContent = link.name;
        btn.title = link.url;
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try { await API.openLink(link.url); }
          catch (err) { window.App?.toast?.("Could not open: " + err.message, "error"); }
        });
        block.appendChild(btn);
      }
      content.appendChild(block);
    }
  }

  // Wire up once the container is in the DOM (requestAnimationFrame ensures
  // the textarea exists when we query for it)
  requestAnimationFrame(() => {
    const textarea = container.querySelector("#tf-notes");
    if (textarea) {
      refresh(textarea.value);
      textarea.addEventListener("input", () => refresh(textarea.value));
    }
  });

  return panel;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Open the task creation or edit modal.
 */
export async function openTaskForm(task, projectId, onSaved) {
  const isEdit   = !!(task?.id);
  const projId   = task?.project_id || projectId;

  // Fetch full task detail (items + dependencies) when editing
  let fullTask = task;
  if (isEdit && (!Array.isArray(task?.items) || !Array.isArray(task?.dependencies))) {
    try {
      fullTask = await API.getTask(task.id);
    } catch (e) {
      console.warn("[task-form] Could not fetch full task detail:", e);
      fullTask = task;
    }
  }

  // Load group tasks in this project (for parent dropdown)
  let groupTasks = [];
  if (projId) {
    try {
      const allTasks = await API.listTasks(projId);
      groupTasks = allTasks.filter(t =>
        t.type === "group" && t.id !== (task?.id)
      );
    } catch (e) {
      console.warn("[task-form] Could not load group tasks:", e);
    }
  }

  // Pre-load all tasks for the dependency picker (edit mode only)
  let allTasksFlat = [];
  if (isEdit) {
    try {
      const projects = State.getProjects();
      const projectsData = await Promise.all(projects.map(p => API.getProject(p.id)));
      allTasksFlat = projectsData.flatMap(p =>
        (p.tasks || []).map(t => ({ id: t.id, name: t.name, project_name: p.name }))
      );
    } catch (e) {
      console.warn("[task-form] Could not load tasks for dependency picker:", e);
    }
  }

  const modal = createModal({
    title: isEdit ? "Edit Task" : "New Task",
    xl: true,
    onClose: () => {},
  });

  const form = _buildForm(fullTask, projectId, modal, onSaved, isEdit, allTasksFlat, groupTasks);

  // ── Split layout: form (left) + links panel (right) ──────────────────────
  const splitWrapper = document.createElement("div");
  splitWrapper.style.cssText = "display:flex; gap:0; align-items:flex-start;";

  const formCol = document.createElement("div");
  formCol.style.cssText = "flex:1; min-width:0;";
  formCol.appendChild(form.el);

  splitWrapper.appendChild(formCol);

  // Build the links panel (parses notes textarea live)
  const linksPanel = _buildLinksPanel(splitWrapper);
  splitWrapper.appendChild(linksPanel);

  modal.setBody(splitWrapper);

  const cancelBtn = el("button", "btn btn--secondary", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => modal.close());

  const saveBtn = el("button", "btn btn--primary", isEdit ? "Save Changes" : "Create Task");
  saveBtn.type = "button";
  saveBtn.addEventListener("click", () => form.submit(saveBtn, modal));

  modal.setFooter(cancelBtn, saveBtn);
  modal.open();

  setTimeout(() => form.focusName(), 50);
}

/**
 * Handle deletion of a task, including showing a modal when the task has
 * children that need to be reassigned or deleted.
 *
 * Intended to be called from any view that has a delete action (cards, gantt,
 * table). Abstracts the 409 "has children" flow from the caller.
 *
 * @param {object}   task       - Task object (needs .id, .name)
 * @param {Function} onDeleted  - Called after successful deletion
 */
export async function openDeleteTaskModal(task, onDeleted) {
  // Try a plain delete first
  let result;
  try {
    result = await API.deleteTask(task.id);
  } catch (e) {
    window.App?.toast?.("Error: " + e.message, "error");
    return;
  }

  if (result === null) {
    // Deleted cleanly — no children
    if (typeof onDeleted === "function") onDeleted();
    return;
  }

  if (!result?.has_children) {
    window.App?.toast?.("Unexpected response from server.", "error");
    return;
  }

  // ── Task has children — show resolution modal ──────────────────────────
  const children = result.children || [];

  const modal = createModal({
    title: "Delete Group Task",
    wide: false,
    onClose: () => {},
  });

  const body = el("div", "");
  body.style.cssText = "display:flex; flex-direction:column; gap:var(--space-4);";

  const desc = el("p", "");
  desc.style.cssText = "font-size:var(--font-size-sm); color:var(--text-secondary); margin:0;";
  desc.innerHTML = `<strong>${_escHtml(task.name)}</strong> is a group task with ${children.length} child task${children.length !== 1 ? "s" : ""}. What should happen to ${children.length !== 1 ? "them" : "it"}?`;

  // List of children
  if (children.length > 0) {
    const list = el("ul", "");
    list.style.cssText = "margin:0; padding-left:var(--space-5); font-size:var(--font-size-sm); color:var(--text-secondary);";
    children.slice(0, 8).forEach(c => {
      const li = document.createElement("li");
      li.textContent = c.wbs_number ? `${c.wbs_number} — ${c.name}` : c.name;
      list.appendChild(li);
    });
    if (children.length > 8) {
      const li = document.createElement("li");
      li.textContent = `… and ${children.length - 8} more`;
      li.style.color = "var(--text-muted)";
      list.appendChild(li);
    }
    body.appendChild(desc);
    body.appendChild(list);
  } else {
    body.appendChild(desc);
  }

  // Option 1: Reassign to another group (or top-level)
  const reassignSection = el("div", "");
  reassignSection.style.cssText = "display:flex; flex-direction:column; gap:var(--space-2);";

  const reassignLabel = el("label", "form-label", "Reassign children to:");
  const reassignSelect = document.createElement("select");
  reassignSelect.className = "form-select";

  // Load siblings (other group tasks in the same project)
  let siblingGroups = [];
  try {
    const allTasks = await API.listTasks(task.project_id || 0);
    siblingGroups = allTasks.filter(t =>
      t.type === "group" && t.id !== task.id && !children.some(c => c.id === t.id)
    );
  } catch (e) { /* non-fatal */ }

  const topLevelOpt = document.createElement("option");
  topLevelOpt.value = "0";
  topLevelOpt.textContent = "— Top level (no parent) —";
  reassignSelect.appendChild(topLevelOpt);

  siblingGroups.forEach(g => {
    const o = document.createElement("option");
    o.value = String(g.id);
    o.textContent = g.wbs_number ? `${g.wbs_number} — ${g.name}` : g.name;
    reassignSelect.appendChild(o);
  });

  reassignSection.appendChild(reassignLabel);
  reassignSection.appendChild(reassignSelect);
  body.appendChild(reassignSection);

  modal.setBody(body);

  // Footer buttons
  const cancelBtn = el("button", "btn btn--secondary", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => modal.close());

  const reassignBtn = el("button", "btn btn--primary", "Reassign & Delete");
  reassignBtn.type = "button";
  reassignBtn.addEventListener("click", async () => {
    reassignBtn.disabled = true;
    reassignBtn.textContent = "Deleting…";
    try {
      const reassignTo = parseInt(reassignSelect.value, 10);
      await API.deleteTaskReassign(task.id, reassignTo);
      modal.close();
      if (typeof onDeleted === "function") onDeleted();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      reassignBtn.disabled = false;
      reassignBtn.textContent = "Reassign & Delete";
    }
  });

  const cascadeBtn = el("button", "btn btn--danger", "Delete All");
  cascadeBtn.type = "button";
  cascadeBtn.style.cssText += "; background:var(--status-blocked-text); color:#fff; border-color:var(--status-blocked-text);";
  cascadeBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${task.name}" and all ${children.length} child task${children.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
    cascadeBtn.disabled = true;
    cascadeBtn.textContent = "Deleting…";
    try {
      await API.deleteTaskCascade(task.id);
      modal.close();
      if (typeof onDeleted === "function") onDeleted();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      cascadeBtn.disabled = false;
      cascadeBtn.textContent = "Delete All";
    }
  });

  modal.setFooter(cancelBtn, reassignBtn, cascadeBtn);
  modal.open();
}

// ---------------------------------------------------------------------------
// Form builder
// ---------------------------------------------------------------------------

/**
 * @param {object|null} task
 * @param {number|null} projectId
 * @param {object}      modal
 * @param {Function}    onSaved
 * @param {boolean}     isEdit
 * @param {Array}       allTasksFlat  - All tasks across all projects (for dep picker)
 * @param {Array}       groupTasks    - Group tasks in this project (for parent dropdown)
 */
function _buildForm(task, projectId, modal, onSaved, isEdit, allTasksFlat = [], groupTasks = []) {
  const people = State.getPeople();

  const root = el("div", "");
  root.style.cssText = "display:flex; flex-direction:column; gap:var(--space-4);";

  // ── Row 1: Name + Type ──────────────────────────────────────────────────
  const row1 = el("div", "form-row");
  row1.style.gridTemplateColumns = "1fr auto";

  const nameGroup = _group("Task name", true);
  const nameInput = _input("text", task?.name || "", "e.g. Order components");
  nameInput.id = "tf-name";
  nameGroup.appendChild(nameInput);

  const typeGroup = _group("Type");
  const typeSelect = _select("tf-type", [
    { value: "task",      label: "Task" },
    { value: "group",     label: "Group" },
    { value: "milestone", label: "Milestone" },
    { value: "phase",     label: "Phase" },
  ], task?.type || "task");
  typeGroup.appendChild(typeSelect);

  row1.appendChild(nameGroup);
  row1.appendChild(typeGroup);

  // ── Row 1b: Parent + WBS number ─────────────────────────────────────────
  const row1b = el("div", "form-row");

  const parentGroup = _group("Parent group");
  const parentSelect = document.createElement("select");
  parentSelect.id = "tf-parent";
  parentSelect.className = "form-select";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "— None (top level) —";
  parentSelect.appendChild(noneOpt);
  groupTasks.forEach(g => {
    const o = document.createElement("option");
    o.value = String(g.id);
    o.textContent = g.wbs_number ? `${g.wbs_number} — ${g.name}` : g.name;
    if (task?.parent_id === g.id) o.selected = true;
    parentSelect.appendChild(o);
  });
  parentGroup.appendChild(parentSelect);

  const wbsGroup = _group("WBS number");
  const wbsInput = _input("text", task?.wbs_number || "", "e.g. 1.02");
  wbsInput.id = "tf-wbs";
  wbsInput.style.fontFamily = "var(--font-mono)";
  wbsGroup.appendChild(wbsInput);

  row1b.appendChild(parentGroup);
  row1b.appendChild(wbsGroup);

  // ── Row 2: Status + Progress + Firm date ────────────────────────────────
  const row2 = el("div", "form-row form-row--3");

  const statusGroup = _group("Status");
  const statusSelect = _select("tf-status", [
    { value: "not-started", label: "Not Started" },
    { value: "planning",    label: "Planning" },
    { value: "in-progress", label: "In Progress" },
    { value: "blocked",     label: "Blocked" },
    { value: "pending",     label: "Pending" },
    { value: "complete",    label: "Complete" },
  ], task?.status || "not-started");
  statusGroup.appendChild(statusSelect);

  // ── Pending Until field (shown only when status = "pending") ─────────────
  const pendingUntilGroup = _group("Expected by");
  const pendingUntilInput = document.createElement("input");
  pendingUntilInput.type = "date";
  pendingUntilInput.id = "tf-pending-until";
  pendingUntilInput.className = "form-input";
  // Default: today + 7 days
  const _pendingDefault = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  };
  pendingUntilInput.value = task?.pending_until || _pendingDefault();
  pendingUntilGroup.appendChild(pendingUntilInput);

  const progressGroup = _group("Progress (%)");
  const progressInput = document.createElement("input");
  progressInput.type = "number";
  progressInput.id = "tf-progress";
  progressInput.className = "form-input";
  progressInput.min = "0";
  progressInput.max = "100";
  progressInput.step = "5";
  progressInput.value = String(Math.round((task?.progress || 0) * 100));
  progressInput.placeholder = "0";
  // Progress bar strip under the input
  const progressWrap = el("div", "");
  progressWrap.style.cssText = "display:flex; flex-direction:column; gap:4px;";
  const progressTrack = el("div", "");
  progressTrack.style.cssText = "height:4px; border-radius:2px; background:var(--grey-200); overflow:hidden;";
  const progressFill = el("div", "");
  progressFill.style.cssText = `height:100%; background:var(--blue); border-radius:2px; width:${Math.round((task?.progress || 0) * 100)}%; transition:width var(--transition-fast);`;
  progressTrack.appendChild(progressFill);
  progressInput.addEventListener("input", () => {
    const pct = Math.min(100, Math.max(0, parseInt(progressInput.value, 10) || 0));
    progressFill.style.width = pct + "%";
  });
  progressWrap.appendChild(progressInput);
  progressWrap.appendChild(progressTrack);
  progressGroup.appendChild(progressWrap);

  const firmGroup = _group("Options");
  const firmLabel = el("label", "form-checkbox");
  const firmCheck = document.createElement("input");
  firmCheck.type = "checkbox";
  firmCheck.id = "tf-firm";
  firmCheck.checked = task?.is_firm_date || false;
  const firmText = el("span", "", "Firm date");
  firmText.style.fontSize = "var(--font-size-sm)";
  firmLabel.appendChild(firmCheck);
  firmLabel.appendChild(firmText);
  firmGroup.appendChild(firmLabel);

  // Show/hide "Expected by" field when status changes to/from pending
  statusSelect.addEventListener("change", () => {
    const isPending = statusSelect.value === "pending";
    pendingRow.style.display = isPending ? "" : "none";
    if (isPending && !pendingUntilInput.value) {
      pendingUntilInput.value = _pendingDefault();
    }
  });

  // Wrap the pending_until field in its own collapsible row
  const pendingRow = el("div", "form-row");
  pendingRow.style.gridTemplateColumns = "1fr auto";
  pendingRow.style.alignItems = "end";
  pendingRow.style.display = (task?.status === "pending") ? "" : "none";

  const pendingHint = el("div", "");
  pendingHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);align-self:center;padding-bottom:4px;";
  pendingHint.textContent = "💤 Task actioned — awaiting delivery or external response.";

  pendingRow.appendChild(pendingUntilGroup);
  pendingRow.appendChild(pendingHint);

  row2.appendChild(statusGroup);
  row2.appendChild(progressGroup);
  row2.appendChild(firmGroup);

  // ── RAG status toggle ────────────────────────────────────────────────────
  const ragRow = el("div", "form-row");
  ragRow.style.gridTemplateColumns = "auto 1fr";
  ragRow.style.alignItems = "center";

  const ragGroup = _group("RAG status");
  const ragWrap = el("div", "");
  ragWrap.style.cssText = "display:flex; align-items:center; gap:var(--space-2); flex-wrap:wrap;";

  let _ragValue = task?.rag || null;

  const ragOptions = [
    { value: null,    label: "None", emoji: "○",  title: "No RAG status",  style: "background:var(--grey-100); color:var(--text-secondary); border-color:var(--border);" },
    { value: "green", label: "Green", emoji: "🟢", title: "On track",       style: "background:#d1fae5; color:#065f46; border-color:#6ee7b7;" },
    { value: "amber", label: "Amber", emoji: "🟡", title: "At risk",        style: "background:#fef3c7; color:#92400e; border-color:#fcd34d;" },
    { value: "red",   label: "Red",   emoji: "🔴", title: "Off track",      style: "background:#fee2e2; color:#991b1b; border-color:#fca5a5;" },
  ];

  const ragBtns = ragOptions.map(opt => {
    const btn = el("button", "btn btn--sm");
    btn.type = "button";
    btn.title = opt.title;
    btn.style.cssText = `font-size:var(--font-size-sm); padding:4px 10px; border-radius:var(--radius); border:1px solid var(--border); cursor:pointer; transition: all var(--transition-fast); ${_ragValue === opt.value ? opt.style : ""}`;
    btn.textContent = opt.emoji + " " + opt.label;

    btn.addEventListener("click", () => {
      _ragValue = opt.value;
      ragBtns.forEach((b, i) => {
        b.style.cssText = `font-size:var(--font-size-sm); padding:4px 10px; border-radius:var(--radius); border:1px solid var(--border); cursor:pointer; transition: all var(--transition-fast); ${_ragValue === ragOptions[i].value ? ragOptions[i].style : ""}`;
      });
    });

    ragWrap.appendChild(btn);
    return btn;
  });

  ragGroup.appendChild(ragWrap);
  ragRow.appendChild(ragGroup);

  // ── Budget ───────────────────────────────────────────────────────────────
  const budgetRow = el("div", "form-row");
  budgetRow.style.gridTemplateColumns = "1fr 1fr";

  const budgetGroup = _group(`Budget (${_currency()})`);
  const budgetInput = document.createElement("input");
  budgetInput.type = "number";
  budgetInput.id = "tf-budget";
  budgetInput.className = "form-input";
  budgetInput.min = "0";
  budgetInput.step = "0.01";
  budgetInput.placeholder = "0.00";
  budgetInput.value = task?.budget != null ? String(task.budget) : "";
  budgetGroup.appendChild(budgetInput);

  const actualSpendGroup = _group("Actual spend");
  const actualSpendEl = el("div", "");
  actualSpendEl.style.cssText = `
    padding: var(--space-2) var(--space-3);
    background: var(--grey-50);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    min-height: 34px;
    display: flex;
    align-items: center;
    font-weight: 500;
  `;
  const actualSpend = task?.actual_spend ?? 0;
  actualSpendEl.textContent = actualSpend > 0
    ? `${_currency()}${actualSpend.toFixed(2)}`
    : "—";
  actualSpendGroup.appendChild(actualSpendEl);

  budgetRow.appendChild(budgetGroup);
  budgetRow.appendChild(actualSpendGroup);

  // ── Effort (estimated vs logged hours) ────────────────────────────────────
  const effortRow = el("div", "form-row");
  effortRow.style.gridTemplateColumns = "1fr 1fr";

  const estHoursGroup = _group("Est. hours");
  const estHoursInput = document.createElement("input");
  estHoursInput.type = "number";
  estHoursInput.id = "tf-estimated-hours";
  estHoursInput.className = "form-input";
  estHoursInput.min = "0";
  estHoursInput.step = "0.5";
  estHoursInput.placeholder = "—";
  estHoursInput.value = task?.estimated_hours != null ? String(task.estimated_hours) : "";
  estHoursGroup.appendChild(estHoursInput);

  const logHoursGroup = _group("Logged hours");
  const logHoursInput = document.createElement("input");
  logHoursInput.type = "number";
  logHoursInput.id = "tf-logged-hours";
  logHoursInput.className = "form-input";
  logHoursInput.min = "0";
  logHoursInput.step = "0.5";
  logHoursInput.placeholder = "—";
  logHoursInput.value = task?.logged_hours != null ? String(task.logged_hours) : "";
  logHoursGroup.appendChild(logHoursInput);

  effortRow.appendChild(estHoursGroup);
  effortRow.appendChild(logHoursGroup);

  // ── Planned dates ────────────────────────────────────────────────────────
  const plannedHeader = _sectionHeader("Planned dates");

  const row3 = el("div", "form-row form-row--3");

  const startGroup = _group("Planned start");
  const startInput = _input("date", task?.start_date || "", "");
  startInput.id = "tf-start";
  startGroup.appendChild(startInput);

  const endGroup = _group("Planned end");
  const endInput = _input("date", task?.end_date || "", "");
  endInput.id = "tf-end";
  endGroup.appendChild(endInput);

  const durGroup = _group("Duration");
  const durEl = el("div", "");
  durEl.id = "tf-duration";
  durEl.style.cssText = `
    padding: var(--space-2) var(--space-3);
    background: var(--grey-50);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    min-height: 34px;
    display: flex;
    align-items: center;
  `;

  const updateDuration = () => {
    const s = startInput.value;
    const e = endInput.value;
    if (s && e && e >= s) {
      const ms = new Date(e) - new Date(s);
      const days = Math.round(ms / 86400000) + 1;
      durEl.textContent = formatDuration(days);
      durEl.style.color = "var(--text-primary)";
    } else {
      durEl.textContent = "—";
      durEl.style.color = "var(--text-muted)";
    }
  };
  startInput.addEventListener("change", updateDuration);
  endInput.addEventListener("change", updateDuration);
  updateDuration();

  durGroup.appendChild(durEl);
  row3.appendChild(startGroup);
  row3.appendChild(endGroup);
  row3.appendChild(durGroup);

  // ── Actual dates ─────────────────────────────────────────────────────────
  const actualHeader = _sectionHeader("Actual dates");
  actualHeader.style.marginTop = "var(--space-2)";

  const row4 = el("div", "form-row");

  const actualStartGroup = _group("Actual start");
  const actualStartInput = _input("date", task?.actual_start_date || "", "");
  actualStartInput.id = "tf-actual-start";
  actualStartGroup.appendChild(actualStartInput);

  const actualEndGroup = _group("Actual end");
  const actualEndInput = _input("date", task?.actual_end_date || "", "");
  actualEndInput.id = "tf-actual-end";
  actualEndGroup.appendChild(actualEndInput);

  row4.appendChild(actualStartGroup);
  row4.appendChild(actualEndGroup);

  // Group notice (shown when type = group, hides date rows)
  const groupNotice = el("div", "");
  groupNotice.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); background:var(--grey-50); border:1px solid var(--border); border-radius:var(--radius); padding:var(--space-2) var(--space-3);";
  groupNotice.textContent = "Group dates are derived from child tasks — no dates needed here.";

  // ── Notes ────────────────────────────────────────────────────────────────
  const notesGroup = _group("Notes");
  const notesInput = document.createElement("textarea");
  notesInput.className = "form-textarea";
  notesInput.id = "tf-notes";
  notesInput.placeholder = "Any additional notes…";
  notesInput.value = task?.notes || "";
  notesInput.style.minHeight = "64px";
  notesGroup.appendChild(notesInput);

  // ── Assignees ────────────────────────────────────────────────────────────
  const assigneesHeader = _sectionHeader("Assignees");
  const assigneesEl = _buildAssigneeSelector(people, task?.assignees || []);

  // ── Task items ───────────────────────────────────────────────────────────
  const itemsHeader = _sectionHeader("Items");
  const itemsManager = _buildItemsManager(task);

  // ── Dependencies (edit mode only) ────────────────────────────────────────
  const depsHeader  = _sectionHeader("Dependencies");
  const depsManager = isEdit ? _buildDepsManager(task, allTasksFlat) : null;

  // ── Assemble ─────────────────────────────────────────────────────────────
  root.appendChild(row1);
  root.appendChild(row1b);
  root.appendChild(row2);
  root.appendChild(pendingRow);
  root.appendChild(ragRow);
  root.appendChild(budgetRow);
  root.appendChild(effortRow);

  // Date sections — toggled by type
  root.appendChild(plannedHeader);
  root.appendChild(row3);
  root.appendChild(actualHeader);
  root.appendChild(row4);
  root.appendChild(groupNotice);  // hidden unless type=group

  root.appendChild(notesGroup);

  if (people.length > 0) {
    root.appendChild(assigneesHeader);
    root.appendChild(assigneesEl.el);
  }

  root.appendChild(itemsHeader);
  root.appendChild(itemsManager.el);

  if (isEdit && depsManager) {
    root.appendChild(depsHeader);
    root.appendChild(depsManager.el);
  }

  // ── Type change → show/hide date section ─────────────────────────────────
  function _updateDateVisibility() {
    const isGroup = typeSelect.value === "group";
    const showDates = !isGroup;
    plannedHeader.style.display = showDates ? "" : "none";
    row3.style.display         = showDates ? "" : "none";
    actualHeader.style.display = showDates ? "" : "none";
    row4.style.display         = showDates ? "" : "none";
    groupNotice.style.display  = isGroup ? "" : "none";
    firmGroup.style.display    = showDates ? "" : "none";
    budgetRow.style.display    = showDates ? "" : "none";
    effortRow.style.display    = showDates ? "" : "none";
  }

  typeSelect.addEventListener("change", _updateDateVisibility);
  _updateDateVisibility();  // Apply on load

  // ── Submit handler ────────────────────────────────────────────────────────
  async function submit(saveBtn, modal) {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      nameInput.style.borderColor = "var(--status-blocked-text)";
      setTimeout(() => { nameInput.style.borderColor = ""; }, 2000);
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      const progressPct = Math.min(100, Math.max(0, parseInt(progressInput.value, 10) || 0));
      const isGroup = typeSelect.value === "group";

      const budgetVal = budgetInput.value.trim();
      const data = {
        name,
        type:               typeSelect.value,
        status:             statusSelect.value,
        progress:           progressPct / 100,
        parent_id:          parentSelect.value ? parseInt(parentSelect.value, 10) : null,
        wbs_number:         wbsInput.value.trim() || null,
        is_firm_date:       firmCheck.checked,
        notes:              notesInput.value.trim() || null,
        budget:             (!isGroup && budgetVal !== "") ? parseFloat(budgetVal) : null,
        estimated_hours:    estHoursInput.value !== "" ? parseFloat(estHoursInput.value) : null,
        logged_hours:       logHoursInput.value !== "" ? parseFloat(logHoursInput.value) : null,
        rag:                _ragValue,
        pending_until:      statusSelect.value === "pending" ? (pendingUntilInput.value || null) : null,
        // Dates omitted for group tasks
        start_date:         isGroup ? null : (startInput.value || null),
        end_date:           isGroup ? null : (endInput.value || null),
        actual_start_date:  isGroup ? null : (actualStartInput.value || null),
        actual_end_date:    isGroup ? null : (actualEndInput.value || null),
      };

      let savedTask;
      if (isEdit) {
        savedTask = await API.updateTask(task.id, data);
      } else {
        savedTask = await API.createTask(projectId, data);
      }

      // Sync assignees
      const prevIds = new Set((task?.assignees || []).map(a => a.id));
      const nextIds = assigneesEl.getSelectedIds();
      const toAdd    = [...nextIds].filter(id => !prevIds.has(id));
      const toRemove = [...prevIds].filter(id => !nextIds.has(id));

      await Promise.all([
        ...toAdd.map(pid    => API.assignPerson(savedTask.id, pid)),
        ...toRemove.map(pid => API.unassignPerson(savedTask.id, pid)),
      ]);

      // Sync items
      await itemsManager.save(savedTask.id);

      modal.close();
      if (typeof onSaved === "function") onSaved(savedTask);
    } catch (e) {
      console.error("[task-form] Save failed:", e);
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? "Save Changes" : "Create Task";
    }
  }

  return {
    el: root,
    submit,
    focusName: () => nameInput.focus(),
  };
}

// ---------------------------------------------------------------------------
// Assignee selector
// ---------------------------------------------------------------------------

function _buildAssigneeSelector(people, currentAssignees) {
  const selectedIds = new Set(currentAssignees.map(a => a.id));

  const wrap = el("div", "");
  wrap.style.cssText = "display:flex; flex-wrap:wrap; gap:var(--space-2);";

  if (people.length === 0) {
    const msg = el("span", "", "No people added yet — use 'Manage' in the sidebar.");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted);";
    wrap.appendChild(msg);
  }

  for (const person of people) {
    const pill = el("button", "");
    pill.type = "button";
    pill.style.cssText = `
      display: inline-flex; align-items: center; gap: var(--space-1);
      padding: var(--space-1) var(--space-3); border-radius: var(--radius-full);
      border: 2px solid transparent; font-size: var(--font-size-sm);
      cursor: pointer; transition: all var(--transition-fast);
      background: var(--grey-100); color: var(--text-secondary);
    `;

    const dot = el("span", "");
    dot.style.cssText = `width:8px; height:8px; border-radius:50%; background:${person.colour || "#8892a4"}; flex-shrink:0;`;
    const name = el("span", "", person.name);
    pill.appendChild(dot);
    pill.appendChild(name);

    const updatePillStyle = () => {
      if (selectedIds.has(person.id)) {
        pill.style.background   = person.colour || "#8892a4";
        pill.style.color        = "#fff";
        pill.style.borderColor  = person.colour || "#8892a4";
      } else {
        pill.style.background   = "var(--grey-100)";
        pill.style.color        = "var(--text-secondary)";
        pill.style.borderColor  = "transparent";
      }
    };
    updatePillStyle();

    pill.addEventListener("click", () => {
      if (selectedIds.has(person.id)) selectedIds.delete(person.id);
      else selectedIds.add(person.id);
      updatePillStyle();
    });

    wrap.appendChild(pill);
  }

  return {
    el: wrap,
    getSelectedIds: () => new Set(selectedIds),
  };
}

// ---------------------------------------------------------------------------
// Items manager
// ---------------------------------------------------------------------------

/** Item types available in the form. */
const ITEM_TYPE_OPTS = [
  { value: "note",      label: "Note" },
  { value: "component", label: "Component" },
  { value: "expense",   label: "Expense" },
];

/** Returns true when an item type supports a cash value. */
function _itemHasValue(type) {
  return type === "component" || type === "expense";
}

function _buildItemsManager(task) {
  const items = (task?.items || []).map(i => ({ ...i, _delete: false }));

  const wrap = el("div", "");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:var(--space-2);";

  const listEl = el("div", "");
  listEl.style.cssText = "display:flex; flex-direction:column; gap:var(--space-1);";

  // Running total displayed below the list
  const totalEl = el("div", "");
  totalEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-secondary); text-align:right; padding-right:var(--space-1);";

  function _refreshTotal() {
    const total = items
      .filter(i => !i._delete && i.value != null && _itemHasValue(i.item_type))
      .reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0);
    if (total > 0) {
      totalEl.textContent = `Items total: ${_currency()}${total.toFixed(2)}`;
      totalEl.style.display = "";
    } else {
      totalEl.style.display = "none";
    }
  }

  function renderList() {
    listEl.replaceChildren();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item._delete) continue;

      const row = el("div", "");
      row.style.cssText = "display:flex; align-items:center; gap:var(--space-2);";

      // Checkbox
      const checkWrap = el("label", "");
      checkWrap.style.cssText = "display:flex; align-items:center; cursor:pointer; flex-shrink:0;";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = item.is_complete;
      check.style.accentColor = "var(--blue)";
      check.addEventListener("change", () => {
        item.is_complete = check.checked;
        contentInput.style.textDecoration = item.is_complete ? "line-through" : "";
        contentInput.style.color = item.is_complete ? "var(--text-muted)" : "";
      });
      checkWrap.appendChild(check);

      // Content
      const contentInput = document.createElement("input");
      contentInput.type = "text";
      contentInput.className = "form-input";
      contentInput.value = item.content;
      contentInput.style.flex = "1";
      contentInput.style.fontSize = "var(--font-size-sm)";
      if (item.is_complete) {
        contentInput.style.textDecoration = "line-through";
        contentInput.style.color = "var(--text-muted)";
      }
      contentInput.addEventListener("input", () => { item.content = contentInput.value; });

      // Type selector
      const typeSelect = document.createElement("select");
      typeSelect.className = "form-select";
      typeSelect.style.cssText = "width:105px; font-size:var(--font-size-xs); flex-shrink:0;";
      ITEM_TYPE_OPTS.forEach(opt => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        // Remap legacy 'subtask' to 'note' on display
        if ((item.item_type === "subtask" ? "note" : item.item_type) === opt.value) o.selected = true;
        typeSelect.appendChild(o);
      });

      // Value input (shown for component/expense)
      const valueWrap = el("div", "");
      valueWrap.style.cssText = "display:flex; align-items:center; gap:2px; flex-shrink:0;";
      const currencyLabel = el("span", "");
      currencyLabel.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
      currencyLabel.textContent = _currency();
      const valueInput = document.createElement("input");
      valueInput.type = "number";
      valueInput.className = "form-input";
      valueInput.min = "0";
      valueInput.step = "0.01";
      valueInput.placeholder = "0.00";
      valueInput.style.cssText = "width:72px; font-size:var(--font-size-xs);";
      valueInput.value = item.value != null ? String(item.value) : "";
      valueWrap.appendChild(currencyLabel);
      valueWrap.appendChild(valueInput);

      const showValue = _itemHasValue(item.item_type);
      valueWrap.style.display = showValue ? "flex" : "none";

      valueInput.addEventListener("input", () => {
        const v = valueInput.value.trim();
        item.value = v !== "" ? parseFloat(v) : null;
        _refreshTotal();
      });

      typeSelect.addEventListener("change", () => {
        item.item_type = typeSelect.value;
        const hasVal = _itemHasValue(typeSelect.value);
        valueWrap.style.display = hasVal ? "flex" : "none";
        if (!hasVal) { item.value = null; valueInput.value = ""; }
        _refreshTotal();
      });

      // Delete button
      const delBtn = el("button", "btn btn--ghost btn--icon");
      delBtn.type = "button";
      delBtn.innerHTML = "✕";
      delBtn.title = "Remove item";
      delBtn.style.color = "var(--text-muted)";
      delBtn.addEventListener("click", () => {
        item._delete = true;
        renderList();
        _refreshTotal();
      });

      row.appendChild(checkWrap);
      row.appendChild(contentInput);
      row.appendChild(typeSelect);
      row.appendChild(valueWrap);
      row.appendChild(delBtn);
      listEl.appendChild(row);
    }
  }

  renderList();
  _refreshTotal();

  // ── Add row ───────────────────────────────────────────────────────────────
  const addRow = el("div", "");
  addRow.style.cssText = "display:flex; gap:var(--space-2); margin-top:var(--space-1);";

  const newContentInput = document.createElement("input");
  newContentInput.type = "text";
  newContentInput.className = "form-input";
  newContentInput.placeholder = "Add an item…";
  newContentInput.style.flex = "1";
  newContentInput.style.fontSize = "var(--font-size-sm)";

  const newTypeSelect = document.createElement("select");
  newTypeSelect.className = "form-select";
  newTypeSelect.style.cssText = "width:105px; font-size:var(--font-size-xs);";
  ITEM_TYPE_OPTS.forEach(opt => {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    newTypeSelect.appendChild(o);
  });

  const addBtn = el("button", "btn btn--secondary btn--sm", "+ Add");
  addBtn.type = "button";
  addBtn.style.flexShrink = "0";

  const doAdd = () => {
    const content = newContentInput.value.trim();
    if (!content) { newContentInput.focus(); return; }
    items.push({
      id: null,
      content,
      item_type:   newTypeSelect.value,
      is_complete: false,
      value:       null,
      _delete:     false,
    });
    newContentInput.value = "";
    renderList();
    _refreshTotal();
    newContentInput.focus();
  };

  addBtn.addEventListener("click", doAdd);
  newContentInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doAdd(); }
  });

  addRow.appendChild(newContentInput);
  addRow.appendChild(newTypeSelect);
  addRow.appendChild(addBtn);

  wrap.appendChild(listEl);
  wrap.appendChild(totalEl);
  wrap.appendChild(addRow);

  async function save(taskId) {
    const ops = [];
    for (const item of items) {
      if (item._delete && item.id) {
        ops.push(API.deleteItem(item.id));
      } else if (!item._delete && !item.id && item.content.trim()) {
        ops.push(API.createItem(taskId, {
          content:     item.content.trim(),
          item_type:   item.item_type,
          is_complete: item.is_complete,
          value:       _itemHasValue(item.item_type) ? item.value : null,
        }));
      } else if (!item._delete && item.id) {
        ops.push(API.updateItem(item.id, {
          content:     item.content.trim(),
          item_type:   item.item_type,
          is_complete: item.is_complete,
          value:       _itemHasValue(item.item_type) ? item.value : null,
        }));
      }
    }
    await Promise.all(ops);
  }

  return { el: wrap, save };
}

// ---------------------------------------------------------------------------
// Dependencies manager
// ---------------------------------------------------------------------------

const DEP_TYPE_META = {
  FS: { label: "Finish to Start",  short: "FS", cssVar: "--dep-fs" },
  SS: { label: "Start to Start",   short: "SS", cssVar: "--dep-ss" },
  FF: { label: "Finish to Finish", short: "FF", cssVar: "--dep-ff" },
  SF: { label: "Start to Finish",  short: "SF", cssVar: "--dep-sf" },
};

function _buildDepsManager(task, allTasksFlat) {
  const taskId = task.id;
  const deps = Array.isArray(task.dependencies) ? [...task.dependencies] : [];

  const wrap = el("div", "");
  wrap.style.cssText = "display:flex; flex-direction:column; gap:var(--space-3);";

  const listEl = el("div", "");
  listEl.style.cssText = "display:flex; flex-direction:column; gap:var(--space-1);";

  function renderList() {
    listEl.replaceChildren();
    const preds = deps.filter(d => d.successor_id === taskId);
    const succs = deps.filter(d => d.predecessor_id === taskId);

    if (preds.length === 0 && succs.length === 0) {
      const msg = el("div", "");
      msg.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); padding:var(--space-1) 0;";
      msg.textContent = "No dependencies.";
      listEl.appendChild(msg);
      return;
    }

    if (preds.length > 0) {
      const lbl = el("div", "");
      lbl.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px;";
      lbl.textContent = "Depends on";
      listEl.appendChild(lbl);
      preds.forEach(d => listEl.appendChild(_buildDepRow(d, deps, renderList, taskId)));
    }

    if (succs.length > 0) {
      const lbl = el("div", "");
      lbl.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:2px; margin-top:var(--space-2);";
      lbl.textContent = "Blocks";
      listEl.appendChild(lbl);
      succs.forEach(d => listEl.appendChild(_buildDepRow(d, deps, renderList, taskId)));
    }
  }

  renderList();

  const addSection = el("div", "");
  addSection.style.cssText = "display:flex; flex-direction:column; gap:var(--space-2); padding-top:var(--space-2); border-top:1px solid var(--border);";

  const addLabel = el("div", "");
  addLabel.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-secondary);";
  addLabel.textContent = "Add predecessor";

  const addRow = el("div", "");
  addRow.style.cssText = "display:flex; gap:var(--space-2); flex-wrap:wrap;";

  const taskPicker = document.createElement("select");
  taskPicker.className = "form-select";
  taskPicker.style.flex = "1";
  taskPicker.style.minWidth = "160px";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Select a task...";
  taskPicker.appendChild(defaultOpt);

  const otherTasks = allTasksFlat.filter(t => t.id !== taskId);
  const byProject = {};
  otherTasks.forEach(t => {
    if (!byProject[t.project_name]) byProject[t.project_name] = [];
    byProject[t.project_name].push(t);
  });
  Object.entries(byProject).forEach(([projName, tasks]) => {
    const grp = document.createElement("optgroup");
    grp.label = projName;
    tasks.forEach(t => {
      const o = document.createElement("option");
      o.value = String(t.id);
      o.textContent = t.name;
      grp.appendChild(o);
    });
    taskPicker.appendChild(grp);
  });

  const typePicker = document.createElement("select");
  typePicker.className = "form-select";
  typePicker.style.width = "155px";
  Object.entries(DEP_TYPE_META).forEach(([val, meta]) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = meta.short + " — " + meta.label;
    typePicker.appendChild(o);
  });

  const lagInput = document.createElement("input");
  lagInput.type = "number";
  lagInput.className = "form-input";
  lagInput.style.width = "80px";
  lagInput.placeholder = "Lag (d)";
  lagInput.value = "0";
  lagInput.min = "0";

  const addBtn = el("button", "btn btn--secondary btn--sm", "+ Add");
  addBtn.type = "button";
  addBtn.style.flexShrink = "0";

  addBtn.addEventListener("click", async () => {
    const predId = parseInt(taskPicker.value, 10);
    if (!predId) { taskPicker.focus(); return; }
    if (deps.some(d => d.predecessor_id === predId && d.successor_id === taskId)) {
      window.App?.toast?.("That dependency already exists", "error");
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = "Adding...";
    try {
      const created = await API.createDependency({
        predecessor_id: predId,
        successor_id:   taskId,
        type:           typePicker.value,
        lag_days:       parseInt(lagInput.value, 10) || 0,
      });
      const predTask = otherTasks.find(t => t.id === predId);
      created.predecessor_name = predTask ? predTask.name : String(predId);
      created.successor_name   = task.name;
      deps.push(created);
      taskPicker.value = "";
      lagInput.value   = "0";
      renderList();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "+ Add";
    }
  });

  addRow.appendChild(taskPicker);
  addRow.appendChild(typePicker);
  addRow.appendChild(lagInput);
  addRow.appendChild(addBtn);
  addSection.appendChild(addLabel);
  addSection.appendChild(addRow);

  wrap.appendChild(listEl);
  if (otherTasks.length > 0) wrap.appendChild(addSection);

  return { el: wrap };
}

function _buildDepRow(dep, deps, renderList, taskId) {
  const isPred    = dep.successor_id === taskId;
  const otherName = isPred ? dep.predecessor_name : dep.successor_name;
  const meta = DEP_TYPE_META[dep.type] || DEP_TYPE_META["FS"];

  const row = el("div", "");
  row.style.cssText = "display:flex; align-items:center; gap:var(--space-2); padding:var(--space-1) var(--space-2); border-radius:var(--radius); background:var(--grey-50); font-size:var(--font-size-sm);";

  const badge = el("span", "");
  badge.style.cssText = `display:inline-flex; align-items:center; padding:1px 6px; border-radius:var(--radius-full); font-size:var(--font-size-xs); font-weight:600; color:#fff; flex-shrink:0; background:var(${meta.cssVar});`;
  badge.textContent = meta.short;
  badge.title = meta.label;

  const nameEl = el("span", "truncate");
  nameEl.style.cssText = "flex:1; min-width:0; color:var(--text-primary);";
  nameEl.textContent = otherName || "Unknown task";
  nameEl.title = otherName || "";

  row.appendChild(badge);
  row.appendChild(nameEl);

  if (dep.lag_days && dep.lag_days !== 0) {
    const lagEl = el("span", "");
    lagEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted); flex-shrink:0;";
    lagEl.textContent = dep.lag_days > 0 ? "+" + dep.lag_days + "d" : dep.lag_days + "d";
    row.appendChild(lagEl);
  }

  const delBtn = el("button", "btn btn--ghost btn--icon");
  delBtn.type = "button";
  delBtn.innerHTML = "&#x2715;";
  delBtn.title = "Remove dependency";
  delBtn.style.cssText = "color:var(--text-muted); flex-shrink:0;";

  delBtn.addEventListener("click", async () => {
    delBtn.disabled = true;
    try {
      await API.deleteDependency(dep.id);
      const idx = deps.findIndex(d => d.id === dep.id);
      if (idx !== -1) deps.splice(idx, 1);
      renderList();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      delBtn.disabled = false;
    }
  });

  row.appendChild(delBtn);
  return row;
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function _group(labelText, required = false) {
  const g = el("div", "form-group");
  g.style.marginBottom = "0";
  const lbl = el("label", required ? "form-label form-label--required" : "form-label", labelText);
  g.appendChild(lbl);
  return g;
}

function _input(type, value, placeholder) {
  const inp = document.createElement("input");
  inp.type = type;
  inp.className = "form-input";
  inp.value = value;
  if (placeholder) inp.placeholder = placeholder;
  return inp;
}

function _select(id, options, selectedValue) {
  const sel = document.createElement("select");
  sel.id = id;
  sel.className = "form-select";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === selectedValue) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

function _sectionHeader(text) {
  const h = el("div", "");
  h.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.06em; padding-bottom:var(--space-1); border-bottom:1px solid var(--border);";
  h.textContent = text;
  return h;
}

function _escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
