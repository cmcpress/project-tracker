/**
 * components/project-form.js — Add/Edit project modal.
 * Full implementation in Phase 2.
 */

import { createModal } from "./modal.js";
import * as API from "../api.js";
import { el } from "../utils.js";

// ---------------------------------------------------------------------------
// Category dropdown helpers (shared with settings view)
// ---------------------------------------------------------------------------

/**
 * Build a <select> populated with categories from the API.
 * Falls back to a plain text input if the fetch fails.
 * @param {string} currentValue - Category name to pre-select
 * @returns {Promise<HTMLElement>} The select element (or input as fallback)
 */
export async function buildCategorySelect(currentValue = "General") {
  let categories = [];
  try {
    categories = await API.listCategories();
  } catch (_) {
    // Fall back to a plain text input
    const input = document.createElement("input");
    input.type = "text";
    input.className = "form-input";
    input.value = currentValue;
    return input;
  }

  const sel = document.createElement("select");
  sel.className = "form-select";

  categories.forEach(cat => {
    const opt = document.createElement("option");
    opt.value = cat.name;
    opt.textContent = cat.name;
    if (cat.name === currentValue) opt.selected = true;
    sel.appendChild(opt);
  });

  // If currentValue isn't in the list (legacy data), add it
  if (currentValue && !categories.find(c => c.name === currentValue)) {
    const opt = document.createElement("option");
    opt.value = currentValue;
    opt.textContent = currentValue;
    opt.selected = true;
    sel.insertBefore(opt, sel.firstChild);
  }

  return sel;
}

/**
 * Open the project creation/edit form in a modal.
 *
 * @param {object|null} project   - Existing project to edit, or null for create
 * @param {Function}    onSaved   - Called with the saved project object
 */
export async function openProjectForm(project, onSaved) {
  const isEdit = !!project;
  const modal = createModal({ title: isEdit ? "Edit Project" : "New Project" });

  // Show modal immediately with a spinner while categories load
  modal.setBody(el("div", "empty-state", ""));
  modal.getBody().innerHTML = `<div class="spinner" style="margin:var(--space-4) auto;"></div>`;
  modal.open();

  // Load category dropdown async
  const catSelect = await buildCategorySelect(project?.category || "General");
  catSelect.id = "pf-category";

  const form = document.createElement("form");
  form.id = "project-form";
  form.style.display = "flex";
  form.style.flexDirection = "column";
  form.style.gap = "var(--space-4)";

  // Name
  const nameGroup = el("div", "form-group");
  const nameLabel = el("label", "form-label form-label--required");
  nameLabel.textContent = "Project name";
  nameLabel.htmlFor = "pf-name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "pf-name";
  nameInput.className = "form-input";
  nameInput.placeholder = "e.g. SSL-9000";
  nameInput.value = project?.name || "";
  nameInput.required = true;
  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);

  // Category
  const catGroup = el("div", "form-group");
  const catLabel = el("label", "form-label");
  catLabel.textContent = "Category";
  catLabel.htmlFor = "pf-category";
  catGroup.appendChild(catLabel);
  catGroup.appendChild(catSelect);

  // Status
  const statusGroup = el("div", "form-group");
  const statusLabel = el("label", "form-label");
  statusLabel.textContent = "Status";
  statusLabel.htmlFor = "pf-status";
  const statusSelect = document.createElement("select");
  statusSelect.id = "pf-status";
  statusSelect.className = "form-select";
  const statuses = [
    { value: "not-started", label: "Not Started" },
    { value: "planning",    label: "Planning" },
    { value: "in-progress", label: "In Progress" },
    { value: "blocked",     label: "Blocked" },
    { value: "complete",    label: "Complete" },
  ];
  for (const s of statuses) {
    const opt = document.createElement("option");
    opt.value = s.value;
    opt.textContent = s.label;
    if (project?.status === s.value) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  statusGroup.appendChild(statusLabel);
  statusGroup.appendChild(statusSelect);

  // Colour
  const colourGroup = el("div", "form-group");
  const colourLabel = el("label", "form-label");
  colourLabel.textContent = "Colour";
  colourLabel.htmlFor = "pf-colour";
  const colourInput = document.createElement("input");
  colourInput.type = "color";
  colourInput.id = "pf-colour";
  colourInput.className = "colour-swatch";
  colourInput.value = project?.colour || "#4a90e2";
  colourGroup.appendChild(colourLabel);
  colourGroup.appendChild(colourInput);

  // Description
  const descGroup = el("div", "form-group");
  const descLabel = el("label", "form-label");
  descLabel.textContent = "Description";
  descLabel.htmlFor = "pf-desc";
  const descInput = document.createElement("textarea");
  descInput.id = "pf-desc";
  descInput.className = "form-textarea";
  descInput.placeholder = "Optional project description…";
  descInput.value = project?.description || "";
  descGroup.appendChild(descLabel);
  descGroup.appendChild(descInput);

  form.appendChild(nameGroup);
  form.appendChild(catGroup);
  form.appendChild(statusGroup);
  form.appendChild(colourGroup);
  form.appendChild(descGroup);

  modal.setBody(form);

  // Footer buttons
  const cancelBtn = el("button", "btn btn--secondary", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => modal.close());

  const saveBtn = el("button", "btn btn--primary", isEdit ? "Save Changes" : "Create Project");
  saveBtn.type = "button";

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";

    try {
      const data = {
        name,
        category: catSelect.value || "General",
        status: statusSelect.value,
        colour: colourInput.value,
        description: descInput.value.trim() || null,
      };

      const saved = isEdit
        ? await API.updateProject(project.id, data)
        : await API.createProject(data);

      modal.close();
      if (typeof onSaved === "function") onSaved(saved);
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? "Save Changes" : "Create Project";
      window.App?.toast?.("Error: " + e.message, "error");
    }
  });

  // Archive button — edit mode only
  if (isEdit) {
    const isArchived = !!project.archived;
    const archiveBtn = el("button", "btn btn--ghost btn--sm");
    archiveBtn.type = "button";
    archiveBtn.style.cssText = "margin-right:auto;color:var(--text-muted);";
    archiveBtn.textContent = isArchived ? "📦 Unarchive" : "📦 Archive";
    archiveBtn.title = isArchived
      ? "Restore this project to active status"
      : "Archive this project — it will be hidden from all views";

    archiveBtn.addEventListener("click", async () => {
      const action = isArchived ? "unarchive" : "archive";
      if (!confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} "${project.name}"? ${isArchived ? "It will reappear in all views." : "It will be hidden from all views. You can restore it from Settings."}`)) return;
      archiveBtn.disabled = true;
      archiveBtn.textContent = "Saving…";
      try {
        await API.archiveProject(project.id, !isArchived);
        modal.close();
        if (typeof onSaved === "function") onSaved({ ...project, archived: !isArchived });
      } catch (e) {
        window.App?.toast?.("Error: " + e.message, "error");
        archiveBtn.disabled = false;
        archiveBtn.textContent = isArchived ? "📦 Unarchive" : "📦 Archive";
      }
    });

    modal.setFooter(archiveBtn, cancelBtn, saveBtn);
  } else {
    modal.setFooter(cancelBtn, saveBtn);
  }

  // Focus the name field
  setTimeout(() => nameInput.focus(), 50);
}
