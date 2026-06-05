/**
 * components/phase-form.js — Create / edit phase banner modal.
 *
 * Usage:
 *   openPhaseForm(null, projectId, onSaved)   // create
 *   openPhaseForm(phase, projectId, onSaved)  // edit
 *
 * onSaved(savedPhase) is called after a successful save.
 * openDeletePhaseModal(phase, onDeleted) handles deletion with confirmation.
 */

import * as API from "../api.js";
import { createModal } from "./modal.js";

// Preset colour swatches for quick selection
const COLOUR_SWATCHES = [
  "#6366f1", // indigo  (default)
  "#3b82f6", // blue
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#ec4899", // pink
  "#8b5cf6", // violet
  "#64748b", // slate
  "#f97316", // orange
];

/**
 * Open the create/edit modal for a phase.
 *
 * @param {object|null} phase     - Existing phase object for editing, or null to create.
 * @param {number}      projectId - Project the phase belongs to.
 * @param {Function}    onSaved   - Callback receiving the saved phase object.
 */
export function openPhaseForm(phase, projectId, onSaved) {
  const isEdit = !!phase;
  const modal  = createModal({ title: isEdit ? "Edit Phase" : "Add Phase" });
  const body   = modal.getBody();

  body.style.cssText = "display:flex;flex-direction:column;gap:var(--space-4);min-width:360px;";

  // ── Name ──────────────────────────────────────────────────────────────────
  const nameLabel = _label("Phase name");
  const nameInput = _input("text", phase?.name || "", "e.g. Pre-production");
  nameLabel.appendChild(nameInput);
  body.appendChild(nameLabel);

  // ── Date row ──────────────────────────────────────────────────────────────
  const dateRow = document.createElement("div");
  dateRow.style.cssText = "display:flex;gap:var(--space-3);";

  const startLabel = _label("Start date");
  const startInput = _input("date", phase?.start_date || "");
  startLabel.style.flex = "1";
  startLabel.appendChild(startInput);

  const endLabel = _label("End date");
  const endInput = _input("date", phase?.end_date || "");
  endLabel.style.flex = "1";
  endLabel.appendChild(endInput);

  dateRow.append(startLabel, endLabel);
  body.appendChild(dateRow);

  // ── Colour ────────────────────────────────────────────────────────────────
  const colourLabel = _label("Colour");
  body.appendChild(colourLabel);

  const swatchRow = document.createElement("div");
  swatchRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;";

  let selectedColour = phase?.colour || COLOUR_SWATCHES[0];

  const swatches = COLOUR_SWATCHES.map(hex => {
    const sw = document.createElement("button");
    sw.type  = "button";
    sw.title = hex;
    sw.style.cssText = `
      width:24px;height:24px;border-radius:50%;background:${hex};
      border:2px solid transparent;cursor:pointer;flex-shrink:0;
      transition:border-color 0.12s;
    `;
    if (hex === selectedColour) sw.style.borderColor = "var(--text-primary)";

    sw.addEventListener("click", () => {
      selectedColour = hex;
      swatches.forEach(s => { s.style.borderColor = "transparent"; });
      sw.style.borderColor = "var(--text-primary)";
      customColour.value = hex;
    });
    return sw;
  });

  // Custom hex input
  const customColour = document.createElement("input");
  customColour.type  = "color";
  customColour.value = selectedColour;
  customColour.style.cssText = "width:28px;height:24px;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:1px;background:var(--surface);";
  customColour.addEventListener("input", () => {
    selectedColour = customColour.value;
    swatches.forEach(s => { s.style.borderColor = "transparent"; });
  });

  swatchRow.append(...swatches, customColour);
  colourLabel.appendChild(swatchRow);

  // ── Error message area ────────────────────────────────────────────────────
  const errorEl = document.createElement("p");
  errorEl.style.cssText = "color:var(--red);font-size:var(--font-size-sm);display:none;margin:0;";
  body.appendChild(errorEl);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }

  // ── Save button ───────────────────────────────────────────────────────────
  modal.addButton(isEdit ? "Save changes" : "Add phase", "btn--primary", async () => {
    const name      = nameInput.value.trim();
    const startDate = startInput.value.trim() || null;
    const endDate   = endInput.value.trim()   || null;

    if (!name) { showError("Phase name is required."); nameInput.focus(); return; }

    const payload = { name, start_date: startDate, end_date: endDate, colour: selectedColour };

    try {
      let saved;
      if (isEdit) {
        saved = await API.updatePhase(phase.id, payload);
      } else {
        saved = await API.createPhase(projectId, payload);
      }
      modal.close();
      onSaved(saved);
    } catch (err) {
      showError(err.message || "Save failed.");
    }
  });

  if (isEdit) {
    modal.addButton("Delete phase", "btn--danger", () => {
      modal.close();
      openDeletePhaseModal(phase, () => onSaved(null));
    });
  }

  modal.addButton("Cancel", "btn--ghost", () => modal.close());
  modal.open();
  setTimeout(() => nameInput.focus(), 50);
}

/**
 * Open a confirmation modal to delete a phase.
 *
 * @param {object}   phase      - Phase to delete.
 * @param {Function} onDeleted  - Callback invoked after deletion.
 */
export async function openDeletePhaseModal(phase, onDeleted) {
  const modal = createModal({ title: "Delete phase?" });
  const body  = modal.body;

  const msg = document.createElement("p");
  msg.style.cssText = "font-size:var(--font-size-sm);color:var(--text-secondary);margin:0;";
  msg.textContent = `"${phase.name}" will be permanently removed from the Gantt chart.`;
  body.appendChild(msg);

  modal.addButton("Delete", "btn--danger", async () => {
    try {
      await API.deletePhase(phase.id);
      modal.close();
      onDeleted();
    } catch (err) {
      window.App?.toast?.(err.message || "Delete failed.", "error");
      modal.close();
    }
  });

  modal.addButton("Cancel", "btn--ghost", () => modal.close());
  modal.open();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _label(text) {
  const lbl = document.createElement("label");
  lbl.style.cssText = "display:flex;flex-direction:column;gap:4px;font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
  const span = document.createElement("span");
  span.textContent = text;
  lbl.appendChild(span);
  return lbl;
}

function _input(type, value, placeholder) {
  const inp = document.createElement("input");
  inp.type        = type;
  inp.value       = value;
  inp.className   = "form-input";
  if (placeholder) inp.placeholder = placeholder;
  inp.style.width = "100%";
  return inp;
}
