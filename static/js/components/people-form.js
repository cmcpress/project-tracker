/**
 * components/people-form.js — Full people management modal.
 *
 * Features:
 *   - List all people with avatar, name, role, colour swatch
 *   - Add new person (name, role, colour)
 *   - Edit existing person inline
 *   - Delete person with confirmation
 *   - Per-person unavailability: list date ranges, add/edit/delete entries
 *   - State updated after every mutation so the rest of the app stays in sync
 */

import { createModal } from "./modal.js";
import * as API from "../api.js";
import * as State from "../state.js";
import { el, initials } from "../utils.js";

/**
 * Open the people management modal.
 */
export async function openPeopleManager() {
  const modal = createModal({ title: "People", wide: true });

  // The modal body is re-rendered in-place after every mutation
  async function refresh() {
    const people = await API.listPeople();
    State.setPeople(people);
    modal.setBody(_buildBody(people, refresh, modal));
  }

  // Initial render
  await refresh();

  const doneBtn = el("button", "btn btn--primary", "Done");
  doneBtn.addEventListener("click", () => modal.close());
  modal.setFooter(doneBtn);
  modal.open();
}

// ---------------------------------------------------------------------------
// Body builder
// ---------------------------------------------------------------------------

function _buildBody(people, refresh, modal) {
  const root = el("div", "");
  root.style.cssText = "display:flex; flex-direction:column; gap:var(--space-3);";

  // ── People list ────────────────────────────────────────────────────────
  if (people.length === 0) {
    const msg = el("div", "");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); padding:var(--space-2) 0;";
    msg.textContent = "No people added yet.";
    root.appendChild(msg);
  } else {
    const list = el("div", "");
    list.style.cssText = "display:flex; flex-direction:column; gap:var(--space-2);";

    for (const person of people) {
      list.appendChild(_buildPersonBlock(person, refresh));
    }
    root.appendChild(list);
  }

  // ── Divider ────────────────────────────────────────────────────────────
  const divider = el("div", "divider");
  root.appendChild(divider);

  // ── Add new person form ────────────────────────────────────────────────
  const addSection = el("div", "");
  addSection.style.cssText = "display:flex; flex-direction:column; gap:var(--space-3);";

  const addTitle = el("div", "");
  addTitle.style.cssText = "font-size:var(--font-size-sm); font-weight:600; color:var(--text-secondary);";
  addTitle.textContent = "Add person";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "form-input";
  nameInput.placeholder = "Full name";

  const roleInput = document.createElement("input");
  roleInput.type = "text";
  roleInput.className = "form-input";
  roleInput.placeholder = "Role (optional)";

  // Colour row
  const colourRow = el("div", "");
  colourRow.style.cssText = "display:flex; align-items:center; gap:var(--space-2);";
  const colourLabel = el("label", "form-label");
  colourLabel.textContent = "Colour";
  colourLabel.htmlFor = "pm-colour";
  colourLabel.style.flexShrink = "0";
  const colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.id = "pm-colour";
  colourInput.className = "colour-swatch";
  colourInput.value = _randomPersonColour();
  colourRow.appendChild(colourLabel);
  colourRow.appendChild(colourInput);

  const addBtn = el("button", "btn btn--primary btn--sm", "+ Add person");
  addBtn.type = "button";

  addBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }

    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    try {
      await API.createPerson({
        name,
        role:   roleInput.value.trim() || null,
        colour: colourInput.value,
      });
      nameInput.value   = "";
      roleInput.value   = "";
      colourInput.value = _randomPersonColour();
      await refresh();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "+ Add person";
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addBtn.click(); }
  });

  addSection.appendChild(addTitle);
  addSection.appendChild(nameInput);
  addSection.appendChild(roleInput);
  addSection.appendChild(colourRow);
  addSection.appendChild(addBtn);
  root.appendChild(addSection);

  return root;
}

// ---------------------------------------------------------------------------
// Person block (row + collapsible unavailability panel)
// ---------------------------------------------------------------------------

function _buildPersonBlock(person, refresh) {
  const block = el("div", "");
  block.style.cssText = `
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  `;

  // ── Person row ────────────────────────────────────────────────────────
  const row = el("div", "");
  row.style.cssText = `
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface);
  `;

  // View mode
  const viewMode = el("div", "");
  viewMode.style.cssText = "display:flex; align-items:center; gap:var(--space-2); flex:1; min-width:0;";

  const avatar = el("div", "avatar");
  avatar.style.background = person.colour || "#8892a4";
  avatar.textContent = initials(person.name);

  const info = el("div", "");
  info.style.cssText = "flex:1; min-width:0;";
  const nameLine = el("div", "truncate");
  nameLine.style.cssText = "font-size:var(--font-size-sm); font-weight:600; color:var(--text-primary);";
  nameLine.textContent = person.name;
  const roleLine = el("div", "truncate");
  roleLine.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
  roleLine.textContent = person.role || "";
  info.appendChild(nameLine);
  info.appendChild(roleLine);

  viewMode.appendChild(avatar);
  viewMode.appendChild(info);

  // Action buttons
  const actions = el("div", "");
  actions.style.cssText = "display:flex; gap:var(--space-1); flex-shrink:0;";

  const editBtn = el("button", "btn btn--ghost btn--icon");
  editBtn.title = "Edit person";
  editBtn.innerHTML = "✎";
  editBtn.style.fontSize = "13px";

  const delBtn = el("button", "btn btn--ghost btn--icon");
  delBtn.title = "Delete";
  delBtn.innerHTML = "🗑";
  delBtn.style.cssText += "color:var(--status-blocked-text);";

  // Toggle for unavailability panel
  const unavailToggle = el("button", "btn btn--ghost btn--sm");
  unavailToggle.title = "Manage unavailability";
  unavailToggle.style.cssText = "font-size:var(--font-size-xs); padding:2px 6px; white-space:nowrap;";
  unavailToggle.textContent = "📅 Unavailability";

  actions.appendChild(unavailToggle);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  // ── Edit mode (inline) ─────────────────────────────────────────────────
  const editMode = el("div", "");
  editMode.style.cssText = "display:none; flex:1; gap:var(--space-2); flex-direction:column;";

  const editNameInput = document.createElement("input");
  editNameInput.type = "text";
  editNameInput.className = "form-input";
  editNameInput.value = person.name;

  const editRoleInput = document.createElement("input");
  editRoleInput.type = "text";
  editRoleInput.className = "form-input";
  editRoleInput.value = person.role || "";
  editRoleInput.placeholder = "Role (optional)";

  const editColourRow = el("div", "");
  editColourRow.style.cssText = "display:flex; align-items:center; gap:var(--space-2);";
  const editColourLabel = el("label", "form-label", "Colour");
  editColourLabel.style.flexShrink = "0";
  const editColourInput = document.createElement("input");
  editColourInput.type = "color";
  editColourInput.className = "colour-swatch";
  editColourInput.value = person.colour || "#8892a4";
  editColourRow.appendChild(editColourLabel);
  editColourRow.appendChild(editColourInput);

  const editBtns = el("div", "");
  editBtns.style.cssText = "display:flex; gap:var(--space-2);";

  const saveEditBtn = el("button", "btn btn--primary btn--sm", "Save");
  saveEditBtn.type = "button";
  const cancelEditBtn = el("button", "btn btn--secondary btn--sm", "Cancel");
  cancelEditBtn.type = "button";

  editBtns.appendChild(saveEditBtn);
  editBtns.appendChild(cancelEditBtn);
  editMode.appendChild(editNameInput);
  editMode.appendChild(editRoleInput);
  editMode.appendChild(editColourRow);
  editMode.appendChild(editBtns);

  row.appendChild(viewMode);
  row.appendChild(editMode);
  row.appendChild(actions);
  block.appendChild(row);

  // ── Unavailability panel (collapsible) ─────────────────────────────────
  const unavailPanel = el("div", "");
  unavailPanel.style.cssText = `
    display: none;
    padding: var(--space-3);
    border-top: 1px solid var(--border);
    background: var(--grey-50, #f9fafb);
  `;
  block.appendChild(unavailPanel);

  // Toggle panel
  let panelOpen = false;
  unavailToggle.addEventListener("click", async () => {
    panelOpen = !panelOpen;
    unavailPanel.style.display = panelOpen ? "block" : "none";
    unavailToggle.style.background = panelOpen ? "var(--primary-subtle, #eff6ff)" : "";
    if (panelOpen) {
      await _renderUnavailPanel(unavailPanel, person);
    }
  });

  // ── Edit / delete person ───────────────────────────────────────────────
  editBtn.addEventListener("click", () => {
    viewMode.style.display = "none";
    actions.style.display  = "none";
    editMode.style.display = "flex";
    editNameInput.focus();
    editNameInput.select();
  });

  cancelEditBtn.addEventListener("click", () => {
    editMode.style.display = "none";
    viewMode.style.display = "flex";
    actions.style.display  = "flex";
  });

  saveEditBtn.addEventListener("click", async () => {
    const name = editNameInput.value.trim();
    if (!name) { editNameInput.focus(); return; }
    saveEditBtn.disabled = true;
    saveEditBtn.textContent = "Saving…";
    try {
      await API.updatePerson(person.id, {
        name,
        role:   editRoleInput.value.trim() || null,
        colour: editColourInput.value,
      });
      await refresh();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = "Save";
    }
  });

  delBtn.addEventListener("click", async () => {
    if (!confirm(`Delete "${person.name}"?\nThis removes them from all task assignments.`)) return;
    try {
      await API.deletePerson(person.id);
      await refresh();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    }
  });

  return block;
}

// ---------------------------------------------------------------------------
// Unavailability panel
// ---------------------------------------------------------------------------

async function _renderUnavailPanel(panel, person) {
  panel.innerHTML = "";

  let entries = [];
  try {
    entries = await API.listUnavailability(person.id);
  } catch (e) {
    panel.textContent = "Failed to load unavailability.";
    return;
  }

  const heading = el("div", "");
  heading.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.04em; margin-bottom:var(--space-2);";
  heading.textContent = "Blocked Dates";
  panel.appendChild(heading);

  // ── Entry list ──────────────────────────────────────────────────────────
  if (entries.length === 0) {
    const empty = el("div", "");
    empty.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); margin-bottom:var(--space-3);";
    empty.textContent = "No blocked dates set.";
    panel.appendChild(empty);
  } else {
    const list = el("div", "");
    list.style.cssText = "display:flex; flex-direction:column; gap:var(--space-1); margin-bottom:var(--space-3);";

    for (const entry of entries) {
      list.appendChild(_buildEntryRow(entry, person, panel));
    }
    panel.appendChild(list);
  }

  // ── Add form ────────────────────────────────────────────────────────────
  const addForm = _buildAddUnavailForm(person, panel);
  panel.appendChild(addForm);
}

function _buildEntryRow(entry, person, panel) {
  const row = el("div", "");
  row.style.cssText = `
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--border);
  `;

  // Amber blocked indicator
  const dot = el("span", "");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#f59e0b;flex-shrink:0;";

  // Date range label
  const info = el("div", "");
  info.style.cssText = "flex:1; min-width:0;";

  const dateStr = entry.start_date === entry.end_date
    ? _fmtDate(entry.start_date)
    : `${_fmtDate(entry.start_date)} – ${_fmtDate(entry.end_date)}`;

  const dateEl = el("div", "");
  dateEl.style.cssText = "font-size:var(--font-size-sm); color:var(--text-primary); font-weight:500;";
  dateEl.textContent = dateStr;

  const labelEl = el("div", "");
  labelEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
  labelEl.textContent = entry.label;

  info.appendChild(dateEl);
  info.appendChild(labelEl);

  // Edit / delete buttons
  const editBtn = el("button", "btn btn--ghost btn--icon");
  editBtn.title = "Edit";
  editBtn.innerHTML = "✎";
  editBtn.style.fontSize = "12px";

  const delBtn = el("button", "btn btn--ghost btn--icon");
  delBtn.title = "Delete";
  delBtn.innerHTML = "✕";
  delBtn.style.cssText += "font-size:12px; color:var(--status-blocked-text);";

  row.append(dot, info, editBtn, delBtn);

  // Inline edit mode
  editBtn.addEventListener("click", () => {
    _openInlineEdit(entry, person, panel, row);
  });

  delBtn.addEventListener("click", async () => {
    delBtn.disabled = true;
    try {
      await API.deleteUnavailability(entry.id);
      await _renderUnavailPanel(panel, person);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      delBtn.disabled = false;
    }
  });

  return row;
}

function _openInlineEdit(entry, person, panel, row) {
  const editRow = el("div", "");
  editRow.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius);
    background: var(--surface);
    border: 1px solid var(--primary, #4a90e2);
  `;

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "form-input";
  labelInput.value = entry.label;
  labelInput.placeholder = "Label (e.g. Annual Leave)";

  const dateRow = el("div", "");
  dateRow.style.cssText = "display:flex; gap:var(--space-2);";

  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.className = "form-input";
  startInput.value = entry.start_date;
  startInput.style.flex = "1";

  const sep = el("span", "");
  sep.style.cssText = "align-self:center; color:var(--text-muted); font-size:var(--font-size-sm);";
  sep.textContent = "to";

  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = "form-input";
  endInput.value = entry.end_date;
  endInput.style.flex = "1";

  dateRow.append(startInput, sep, endInput);

  const btns = el("div", "");
  btns.style.cssText = "display:flex; gap:var(--space-2);";

  const saveBtn = el("button", "btn btn--primary btn--sm", "Save");
  const cancelBtn = el("button", "btn btn--ghost btn--sm", "Cancel");
  btns.append(saveBtn, cancelBtn);

  editRow.append(labelInput, dateRow, btns);

  row.replaceWith(editRow);

  cancelBtn.addEventListener("click", () => {
    editRow.replaceWith(row);
  });

  saveBtn.addEventListener("click", async () => {
    const sd = startInput.value;
    const ed = endInput.value;
    if (!sd || !ed) { window.App?.toast?.("Both dates are required.", "error"); return; }
    if (ed < sd) { window.App?.toast?.("End date must be on or after start date.", "error"); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await API.updateUnavailability(entry.id, {
        label:      labelInput.value.trim() || "Unavailable",
        start_date: sd,
        end_date:   ed,
      });
      await _renderUnavailPanel(panel, person);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });
}

function _buildAddUnavailForm(person, panel) {
  const form = el("div", "");
  form.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius);
    border: 1px dashed var(--border);
    background: var(--surface);
  `;

  const title = el("div", "");
  title.style.cssText = "font-size:var(--font-size-xs); font-weight:600; color:var(--text-muted);";
  title.textContent = "Add blocked date(s)";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "form-input";
  labelInput.placeholder = "Label (e.g. Annual Leave, Bank Holiday)";

  const dateRow = el("div", "");
  dateRow.style.cssText = "display:flex; gap:var(--space-2); align-items:center;";

  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.className = "form-input";
  startInput.style.flex = "1";

  const sep = el("span", "");
  sep.style.cssText = "color:var(--text-muted); font-size:var(--font-size-sm); white-space:nowrap;";
  sep.textContent = "to";

  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = "form-input";
  endInput.style.flex = "1";

  // When start changes, default end to same day if end is empty
  startInput.addEventListener("change", () => {
    if (!endInput.value) endInput.value = startInput.value;
  });

  dateRow.append(startInput, sep, endInput);

  const addBtn = el("button", "btn btn--primary btn--sm", "+ Add");
  addBtn.type = "button";
  addBtn.style.alignSelf = "flex-start";

  addBtn.addEventListener("click", async () => {
    const sd = startInput.value;
    const ed = endInput.value || sd;
    if (!sd) { window.App?.toast?.("Start date is required.", "error"); return; }
    if (ed < sd) { window.App?.toast?.("End date must be on or after start date.", "error"); return; }
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    try {
      await API.createUnavailability(person.id, {
        label:      labelInput.value.trim() || "Unavailable",
        start_date: sd,
        end_date:   ed,
      });
      labelInput.value = "";
      startInput.value = "";
      endInput.value   = "";
      await _renderUnavailPanel(panel, person);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "+ Add";
    }
  });

  form.append(title, labelInput, dateRow, addBtn);
  return form;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function _fmtDate(iso) {
  if (!iso) return "";
  try {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${parseInt(d)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m)-1]} ${y}`;
  } catch { return iso; }
}

/** Return a random colour from a tasteful palette for new people. */
function _randomPersonColour() {
  const palette = [
    "#4a90e2", "#7e57c2", "#00897b", "#e67e22",
    "#e53935", "#43a047", "#1e88e5", "#8d6e63",
    "#039be5", "#d81b60",
  ];
  return palette[Math.floor(Math.random() * palette.length)];
}
