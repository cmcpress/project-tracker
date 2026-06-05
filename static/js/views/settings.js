/**
 * views/settings.js — Settings view.
 *
 * Sections:
 *   - Categories: full CRUD for project categories
 *
 * Implements the view interface: init(container), render(), destroy()
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { el, clearChildren } from "../utils.js";

let _container = null;

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;
  _container.className = "main__content";  // scroll view
  await _loadAndRender();
}

export async function render() {
  await _loadAndRender();
}

export function destroy() {
  _container = null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function _loadAndRender() {
  if (!_container) return;
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  try {
    const [categories, settings] = await Promise.all([
      API.listCategories(),
      API.getSettings().catch(() => ({})),
    ]);
    _render(categories, settings);
  } catch (e) {
    _container.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">Failed to load settings</div>
      <div class="empty-state__body">${e.message}</div></div>`;
  }
}

function _render(categories, settings = {}) {
  clearChildren(_container);

  const page = el("div", "");
  page.style.cssText = "max-width:640px;display:flex;flex-direction:column;gap:var(--space-6);";

  page.appendChild(_buildGeneralSection(settings));
  page.appendChild(_buildCategoriesSection(categories));

  _container.appendChild(page);
}

// ---------------------------------------------------------------------------
// General section (currency symbol, etc.)
// ---------------------------------------------------------------------------

function _buildGeneralSection(settings) {
  const section = el("div", "");

  const heading = el("h2", "");
  heading.style.cssText = "font-size:var(--font-size-lg);font-weight:600;color:var(--text-primary);margin-bottom:var(--space-4);";
  heading.textContent = "General";

  const card = el("div", "card");
  const cardBody = el("div", "card__body");

  // Currency symbol row
  const row = el("div", "");
  row.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;";

  const labelWrap = el("div", "");
  labelWrap.style.cssText = "flex:1;";
  const label = el("div", "");
  label.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  label.textContent = "Currency symbol";
  const hint = el("div", "");
  hint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  hint.textContent = "Displayed next to budget and expense amounts.";
  labelWrap.appendChild(label);
  labelWrap.appendChild(hint);

  const symbolInput = document.createElement("input");
  symbolInput.type = "text";
  symbolInput.className = "form-input";
  symbolInput.maxLength = 4;
  symbolInput.value = settings.currency_symbol || "£";
  symbolInput.style.cssText = "width:64px;text-align:center;font-size:var(--font-size-md);font-weight:600;";

  const saveBtn = el("button", "btn btn--primary btn--sm", "Save");
  saveBtn.type = "button";

  saveBtn.addEventListener("click", async () => {
    const sym = symbolInput.value.trim();
    if (!sym) { symbolInput.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await API.updateSetting("currency_symbol", sym);
      State.setCurrencySymbol(sym);
      window.App?.toast?.("Currency symbol updated", "success");
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
    }
  });

  symbolInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); }
  });

  row.appendChild(labelWrap);
  row.appendChild(symbolInput);
  row.appendChild(saveBtn);

  cardBody.appendChild(row);

  // Divider
  const div1 = el("div", "");
  div1.style.cssText = "height:1px;background:var(--border);margin:0 var(--space-1);";
  cardBody.appendChild(div1);

  // Cards default expanded toggle
  const expandRow = el("div", "");
  expandRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;";

  const expandLabelWrap = el("div", "");
  expandLabelWrap.style.cssText = "flex:1;";
  const expandLabel = el("div", "");
  expandLabel.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  expandLabel.textContent = "Cards view: expand all projects by default";
  const expandHint = el("div", "");
  expandHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  expandHint.textContent = "When off, project cards open collapsed. Click the header or arrow to expand.";
  expandLabelWrap.appendChild(expandLabel);
  expandLabelWrap.appendChild(expandHint);

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.style.cssText = "width:16px;height:16px;cursor:pointer;flex-shrink:0;";
  toggle.checked = (settings.cards_default_expanded ?? localStorage.getItem("cards_default_expanded")) === "true";
  toggle.addEventListener("change", () => {
    const val = toggle.checked ? "true" : "false";
    localStorage.setItem("cards_default_expanded", val);
    API.updateSetting("cards_default_expanded", val).catch(() => {});
    window.App?.toast?.(toggle.checked ? "Cards will expand by default" : "Cards will collapse by default", "success");
  });

  expandRow.appendChild(expandLabelWrap);
  expandRow.appendChild(toggle);
  cardBody.appendChild(expandRow);

  // Divider
  const div2 = el("div", "");
  div2.style.cssText = "height:1px;background:var(--border);margin:0 var(--space-1);";
  cardBody.appendChild(div2);

  // Sidebar categories default expanded toggle
  const catRow = el("div", "");
  catRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;";

  const catLabelWrap = el("div", "");
  catLabelWrap.style.cssText = "flex:1;";
  const catLabel = el("div", "");
  catLabel.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  catLabel.textContent = "Sidebar: expand category groups by default";
  const catHint = el("div", "");
  catHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  catHint.textContent = "When off, category groups in the left pane open collapsed. Click the group header to expand.";
  catLabelWrap.appendChild(catLabel);
  catLabelWrap.appendChild(catHint);

  const catToggle = document.createElement("input");
  catToggle.type = "checkbox";
  catToggle.style.cssText = "width:16px;height:16px;cursor:pointer;flex-shrink:0;";
  catToggle.checked = (settings.sidebar_categories_expanded ?? localStorage.getItem("sidebar_categories_expanded") ?? "true") !== "false";
  catToggle.addEventListener("change", () => {
    const val = catToggle.checked ? "true" : "false";
    localStorage.setItem("sidebar_categories_expanded", val);
    API.updateSetting("sidebar_categories_expanded", val).catch(() => {});
    window.App?.toast?.(catToggle.checked ? "Category groups will expand by default" : "Category groups will collapse by default", "success");
  });

  catRow.appendChild(catLabelWrap);
  catRow.appendChild(catToggle);
  cardBody.appendChild(catRow);

  // Divider
  const div3 = el("div", "");
  div3.style.cssText = "height:1px;background:var(--border);margin:0 var(--space-1);";
  cardBody.appendChild(div3);

  // Show archived projects toggle
  const archRow = el("div", "");
  archRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;";

  const archLabelWrap = el("div", "");
  archLabelWrap.style.cssText = "flex:1;";
  const archLabel = el("div", "");
  archLabel.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  archLabel.textContent = "Show archived projects";
  const archHint = el("div", "");
  archHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  archHint.textContent = "When on, archived projects appear in the sidebar and all views. Changes take effect on next app restart or data reload.";
  archLabelWrap.appendChild(archLabel);
  archLabelWrap.appendChild(archHint);

  const archToggle = document.createElement("input");
  archToggle.type = "checkbox";
  archToggle.style.cssText = "width:16px;height:16px;cursor:pointer;flex-shrink:0;";
  archToggle.checked = (settings.show_archived_projects ?? localStorage.getItem("show_archived_projects")) === "true";
  archToggle.addEventListener("change", async () => {
    const val = archToggle.checked ? "true" : "false";
    localStorage.setItem("show_archived_projects", val);
    try {
      await API.updateSetting("show_archived_projects", val);
      window.App?.toast?.(archToggle.checked ? "Archived projects will now be shown — reload data to see them" : "Archived projects hidden", "success");
      // Reload the project list immediately
      await window.App?.reloadData?.();
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    }
  });

  archRow.appendChild(archLabelWrap);
  archRow.appendChild(archToggle);
  cardBody.appendChild(archRow);

  // Divider
  const div4 = el("div", "");
  div4.style.cssText = "height:1px;background:var(--border);margin:0 var(--space-1);";
  cardBody.appendChild(div4);

  // Dark mode toggle
  const darkRow = el("div", "");
  darkRow.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) 0;";

  const darkLabelWrap = el("div", "");
  darkLabelWrap.style.cssText = "flex:1;";
  const darkLabel = el("div", "");
  darkLabel.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  darkLabel.textContent = "Dark mode";
  const darkHint = el("div", "");
  darkHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  darkHint.textContent = "Switch the app to a dark colour scheme.";
  darkLabelWrap.appendChild(darkLabel);
  darkLabelWrap.appendChild(darkHint);

  const darkToggle = document.createElement("input");
  darkToggle.type = "checkbox";
  darkToggle.style.cssText = "width:16px;height:16px;cursor:pointer;flex-shrink:0;";
  darkToggle.checked = (settings.dark_mode ?? localStorage.getItem("dark_mode")) === "true";
  darkToggle.addEventListener("change", async () => {
    const val = darkToggle.checked ? "true" : "false";
    localStorage.setItem("dark_mode", val);
    // Apply immediately — no reload needed
    document.documentElement.setAttribute("data-theme", darkToggle.checked ? "dark" : "light");
    try {
      await API.updateSetting("dark_mode", val);
    } catch (e) {
      window.App?.toast?.("Error saving preference: " + e.message, "error");
    }
  });

  darkRow.appendChild(darkLabelWrap);
  darkRow.appendChild(darkToggle);
  cardBody.appendChild(darkRow);

  // Divider
  const div5 = el("div", "");
  div5.style.cssText = "height:1px;background:var(--border);margin:0 var(--space-1);";
  cardBody.appendChild(div5);

  // Logging toggle
  const logRow = el("div", "");
  logRow.style.cssText = "display:flex;align-items:flex-start;gap:var(--space-3);padding:var(--space-3) 0;";

  const logLabelWrap = el("div", "");
  logLabelWrap.style.cssText = "flex:1;";
  const logLabel = el("div", "");
  logLabel.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  logLabel.textContent = "Enable logging";
  const logHint = el("div", "");
  logHint.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
  logHint.textContent = "Write diagnostic information to a log file on startup. On by default.";
  logLabelWrap.appendChild(logLabel);
  logLabelWrap.appendChild(logHint);

  // Log file path link (fetched async)
  const logPathRow = el("div", "");
  logPathRow.style.cssText = "margin-top:var(--space-2);font-size:var(--font-size-xs);color:var(--text-muted);";
  if (window.pywebview) {
    window.pywebview.api.get_log_path().then(result => {
      if (result && result.path) {
        const link = el("a", "");
        link.href = "#";
        link.textContent = "Open log folder";
        link.style.cssText = "color:var(--accent);text-decoration:underline;cursor:pointer;";
        link.title = result.path;
        link.addEventListener("click", (e) => {
          e.preventDefault();
          window.pywebview.api.open_log_folder();
        });
        const pathSpan = el("span", "");
        pathSpan.textContent = result.path + " — ";
        logPathRow.appendChild(pathSpan);
        logPathRow.appendChild(link);
      }
    }).catch(() => {});
  }
  logLabelWrap.appendChild(logPathRow);

  const logToggle = document.createElement("input");
  logToggle.type = "checkbox";
  logToggle.style.cssText = "width:16px;height:16px;cursor:pointer;flex-shrink:0;margin-top:2px;";
  // Default is on; only false if explicitly set to "false"
  const logVal = settings.enable_logging ?? localStorage.getItem("enable_logging");
  logToggle.checked = logVal !== "false";
  logToggle.addEventListener("change", async () => {
    const val = logToggle.checked ? "true" : "false";
    localStorage.setItem("enable_logging", val);
    try {
      await API.updateSetting("enable_logging", val);
      window.App?.toast?.(logToggle.checked ? "Logging enabled" : "Logging disabled — takes effect on next restart", "success");
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    }
  });

  logRow.appendChild(logLabelWrap);
  logRow.appendChild(logToggle);
  cardBody.appendChild(logRow);

  card.appendChild(cardBody);

  section.appendChild(heading);
  section.appendChild(card);
  return section;
}

// ---------------------------------------------------------------------------
// Categories section
// ---------------------------------------------------------------------------

function _buildCategoriesSection(categories) {
  const section = el("div", "");

  const heading = el("h2", "");
  heading.style.cssText = "font-size:var(--font-size-lg);font-weight:600;color:var(--text-primary);margin-bottom:var(--space-4);";
  heading.textContent = "Categories";

  const card = el("div", "card");
  const cardBody = el("div", "card__body");
  cardBody.style.padding = "0";

  const list = el("div", "");
  list.id = "category-list";
  _renderCategoryList(list, categories);

  const addArea = _buildAddCategoryForm(list);

  cardBody.appendChild(list);
  cardBody.appendChild(addArea);
  card.appendChild(cardBody);

  section.appendChild(heading);
  section.appendChild(card);
  return section;
}

function _renderCategoryList(listEl, categories) {
  clearChildren(listEl);

  if (categories.length === 0) {
    const empty = el("div", "");
    empty.style.cssText = "padding:var(--space-4);font-size:var(--font-size-sm);color:var(--text-muted);";
    empty.textContent = "No categories yet.";
    listEl.appendChild(empty);
    return;
  }

  categories.forEach(cat => listEl.appendChild(_buildCategoryRow(cat, listEl, categories)));
}

function _buildCategoryRow(cat, listEl, allCategories) {
  const row = el("div", "");
  row.style.cssText = "display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--border);";

  // Colour swatch
  const swatch = el("div", "");
  swatch.style.cssText = `width:14px;height:14px;border-radius:50%;flex-shrink:0;background:${cat.colour || "#8892a4"};`;

  // Name (view mode)
  const nameEl = el("span", "");
  nameEl.style.cssText = "flex:1;font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  nameEl.textContent = cat.name;

  // Edit form (hidden by default)
  const editForm = el("div", "");
  editForm.style.cssText = "display:none;flex:1;display:none;align-items:center;gap:var(--space-2);";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "form-input";
  nameInput.value = cat.name;
  nameInput.style.cssText = "flex:1;padding:var(--space-1) var(--space-2);height:28px;font-size:var(--font-size-sm);";

  const colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.className = "colour-swatch";
  colourInput.value = cat.colour || "#8892a4";
  colourInput.style.cssText = "width:28px;height:28px;padding:2px;flex-shrink:0;";

  const saveEditBtn = el("button", "btn btn--primary btn--sm", "Save");
  const cancelEditBtn = el("button", "btn btn--secondary btn--sm", "Cancel");

  editForm.appendChild(nameInput);
  editForm.appendChild(colourInput);
  editForm.appendChild(saveEditBtn);
  editForm.appendChild(cancelEditBtn);

  // Actions
  const actions = el("div", "");
  actions.style.cssText = "display:flex;align-items:center;gap:var(--space-1);flex-shrink:0;";

  const editBtn = el("button", "btn btn--ghost btn--icon");
  editBtn.title = "Rename / recolour";
  editBtn.innerHTML = "✎";
  editBtn.style.fontSize = "13px";

  const deleteBtn = el("button", "btn btn--ghost btn--icon");
  deleteBtn.title = "Delete category";
  deleteBtn.innerHTML = "🗑";
  deleteBtn.style.fontSize = "12px";

  actions.appendChild(editBtn);
  actions.appendChild(deleteBtn);

  row.appendChild(swatch);
  row.appendChild(nameEl);
  row.appendChild(editForm);
  row.appendChild(actions);

  // --- Toggle edit mode ---
  function enterEdit() {
    nameEl.style.display = "none";
    editForm.style.display = "flex";
    actions.style.display = "none";
    nameInput.value = cat.name;
    colourInput.value = cat.colour || "#8892a4";
    nameInput.focus();
  }
  function exitEdit() {
    editForm.style.display = "none";
    nameEl.style.display = "";
    actions.style.display = "";
  }

  editBtn.addEventListener("click", enterEdit);
  cancelEditBtn.addEventListener("click", exitEdit);

  saveEditBtn.addEventListener("click", async () => {
    const newName = nameInput.value.trim();
    if (!newName) { nameInput.focus(); return; }
    saveEditBtn.disabled = true;
    saveEditBtn.textContent = "Saving…";
    try {
      await API.updateCategory(cat.id, { name: newName, colour: colourInput.value });
      window.App?.toast?.("Category updated", "success");
      await _reloadList(listEl);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = "Save";
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveEditBtn.click();
    if (e.key === "Escape") exitEdit();
  });

  // --- Delete ---
  deleteBtn.addEventListener("click", async () => {
    const total = allCategories.length;
    if (total <= 1) {
      window.App?.toast?.("Cannot delete the last category.", "error");
      return;
    }
    if (!confirm(`Delete category "${cat.name}"? Projects using it will be moved to another category.`)) return;
    try {
      await API.deleteCategory(cat.id);
      window.App?.toast?.(`"${cat.name}" deleted`, "success");
      await _reloadList(listEl);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    }
  });

  return row;
}

async function _reloadList(listEl) {
  try {
    const categories = await API.listCategories();
    _renderCategoryList(listEl, categories);
  } catch (e) {
    window.App?.toast?.("Failed to refresh categories: " + e.message, "error");
  }
}

function _buildAddCategoryForm(listEl) {
  const wrap = el("div", "");
  wrap.style.cssText = "display:flex;align-items:center;gap:var(--space-2);padding:var(--space-3) var(--space-4);";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "form-input";
  nameInput.placeholder = "New category name…";
  nameInput.style.cssText = "flex:1;padding:var(--space-1) var(--space-2);height:28px;font-size:var(--font-size-sm);";

  const colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.className = "colour-swatch";
  colourInput.value = "#4a90e2";
  colourInput.style.cssText = "width:28px;height:28px;padding:2px;flex-shrink:0;";

  const addBtn = el("button", "btn btn--primary btn--sm", "+ Add");

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    addBtn.disabled = true;
    addBtn.textContent = "Adding…";
    try {
      await API.createCategory({ name, colour: colourInput.value });
      nameInput.value = "";
      colourInput.value = "#4a90e2";
      window.App?.toast?.(`"${name}" added`, "success");
      await _reloadList(listEl);
    } catch (e) {
      window.App?.toast?.("Error: " + e.message, "error");
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = "+ Add";
    }
  };

  addBtn.addEventListener("click", submit);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });

  wrap.appendChild(nameInput);
  wrap.appendChild(colourInput);
  wrap.appendChild(addBtn);
  return wrap;
}
