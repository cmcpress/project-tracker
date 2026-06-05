/**
 * link-form.js — Project links modal
 *
 * Opens a modal for managing the URL/file-path shortcuts attached to a project.
 * Each link has a name and a URL (web or local path).  Clicking a link's open
 * button sends it to the server, which launches the appropriate OS application.
 *
 * Usage:
 *   import { openLinkForm } from "./components/link-form.js";
 *   await openLinkForm(project);   // re-renders the caller's link count badge
 */

import { createModal }      from "./modal.js";
import * as API             from "../api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the string looks like a web URL.
 * Used to pick the right icon and tooltip text.
 */
function _isWebUrl(url) {
  return /^(https?|ftps?):\/\//i.test((url || "").trim());
}

/** Escape HTML special characters for safe insertion into innerHTML. */
function _esc(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Open the project-links management modal.
 *
 * @param {object}   project         - Project row object {id, name, …}
 * @param {Function} [onChanged]     - Called (with new link count) after any add/delete
 */
export async function openLinkForm(project, onChanged) {
  // ── Load existing links ──────────────────────────────────────────────────
  let links = [];
  try {
    links = await API.listProjectLinks(project.id);
  } catch (e) {
    window.App?.toast?.("Failed to load links: " + e.message, "error");
    return;
  }

  // ── Modal ────────────────────────────────────────────────────────────────
  const modal = createModal({ title: `Links — ${project.name}`, wide: false });

  // Container that we re-render in-place after mutations
  const body = _el("div");
  body.style.cssText = "display:flex; flex-direction:column; gap:8px; min-width:380px;";
  modal.setBody(body);

  // ── Render helpers ───────────────────────────────────────────────────────

  function _render() {
    body.innerHTML = "";

    if (!links.length) {
      const empty = _el("p");
      empty.style.cssText = "color:var(--text-muted); font-size:var(--font-size-sm); margin:0 0 4px;";
      empty.textContent = "No links yet. Add one below.";
      body.appendChild(empty);
    }

    links.forEach(link => {
      const row = _el("div");
      row.style.cssText = `
        display:flex; align-items:center; gap:8px;
        padding:6px 10px;
        border:1px solid var(--border);
        border-radius:var(--radius);
        background:var(--bg-secondary);
      `;

      // Icon — globe for web, folder for local
      const icon = _el("span");
      icon.style.cssText = "flex-shrink:0; font-size:16px; line-height:1; color:var(--text-muted);";
      icon.textContent = _isWebUrl(link.url) ? "🌐" : "📁";
      icon.title = _isWebUrl(link.url) ? "Web link" : "Local path";

      // Name + URL
      const info = _el("div");
      info.style.cssText = "flex:1; min-width:0;";
      const nameEl = _el("div");
      nameEl.style.cssText = "font-size:var(--font-size-sm); font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
      nameEl.textContent = link.name;
      const urlEl = _el("div");
      urlEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
      urlEl.textContent = link.url;
      info.appendChild(nameEl);
      info.appendChild(urlEl);

      // Open button
      const openBtn = _el("button", "btn btn--ghost btn--sm");
      openBtn.textContent = "Open";
      openBtn.title = _isWebUrl(link.url) ? "Open in browser" : "Open in Explorer";
      openBtn.style.cssText = "flex-shrink:0; font-size:var(--font-size-xs); padding:2px 8px;";
      openBtn.addEventListener("click", async () => {
        try {
          await API.openLink(link.url);
        } catch (e) {
          window.App?.toast?.("Could not open: " + e.message, "error");
        }
      });

      // Delete button
      const delBtn = _el("button", "btn btn--ghost btn--sm");
      delBtn.innerHTML = "&#x2715;";
      delBtn.title = "Remove this link";
      delBtn.style.cssText = "flex-shrink:0; font-size:var(--font-size-xs); padding:2px 7px; color:var(--text-muted);";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Remove "${link.name}"?`)) return;
        try {
          await API.deleteProjectLink(link.id);
          links = links.filter(l => l.id !== link.id);
          _render();
          onChanged?.(links.length);
        } catch (e) {
          window.App?.toast?.("Delete failed: " + e.message, "error");
        }
      });

      row.append(icon, info, openBtn, delBtn);
      body.appendChild(row);
    });

    // ── Add new link form ────────────────────────────────────────────────
    const divider = _el("div");
    divider.style.cssText = "border-top:1px solid var(--border); margin-top:4px; padding-top:10px;";

    const addTitle = _el("div");
    addTitle.style.cssText = "font-size:var(--font-size-sm); font-weight:600; color:var(--text-secondary); margin-bottom:6px;";
    addTitle.textContent = "Add link";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "form-input";
    nameInput.placeholder = "Name (e.g. Output Folder, Spec Doc)";
    nameInput.style.cssText = "margin-bottom:6px; width:100%; box-sizing:border-box;";

    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "form-input";
    urlInput.placeholder = "URL or path  (https://… or C:\\…)";
    urlInput.style.cssText = "margin-bottom:8px; width:100%; box-sizing:border-box;";

    const addBtn = _el("button", "btn btn--primary btn--sm");
    addBtn.textContent = "Add";
    addBtn.style.cssText = "width:100%;";

    addBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const url  = urlInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      if (!url)  { urlInput.focus();  return; }

      addBtn.disabled = true;
      addBtn.textContent = "Adding…";
      try {
        const created = await API.createProjectLink(project.id, { name, url });
        links.push(created);
        nameInput.value = "";
        urlInput.value  = "";
        _render();
        onChanged?.(links.length);
        window.App?.toast?.("Link added", "success");
      } catch (e) {
        window.App?.toast?.("Failed to add: " + e.message, "error");
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = "Add";
      }
    });

    // Allow Enter in URL field to submit
    urlInput.addEventListener("keydown", e => {
      if (e.key === "Enter") addBtn.click();
    });

    divider.append(addTitle, nameInput, urlInput, addBtn);
    body.appendChild(divider);
  }

  _render();
  modal.open();
}
