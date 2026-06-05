/**
 * components/db-menu.js — Database dropdown menu in the topbar.
 *
 * Handles:
 *   - Displaying the current database file path
 *   - New Database  — create a fresh db at a chosen location
 *   - Open Database — switch to an existing db file
 *   - Export Database — copy the current db to a backup file
 *   - Import JSON   — import a JSON backup into the current db
 *   - Export JSON   — export all data as a JSON backup
 *   - Export Excel  — export all data as an Excel workbook
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { showToast } from "../toast.js";

// ---------------------------------------------------------------------------
// Download helper (same logic as was in main.js)
// ---------------------------------------------------------------------------

async function _triggerDownload(url, filename) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }

  // pywebview path — use native save dialog
  if (window.pywebview?.api?.save_file) {
    const arrayBuf = await resp.arrayBuffer();
    const bytes    = new Uint8Array(arrayBuf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    const result = await window.pywebview.api.save_file(b64, filename);
    if (!result.ok && result.error !== "cancelled") {
      throw new Error(result.error || "Save failed");
    }
    return;
  }

  // Browser fallback (dev mode)
  const blob    = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href     = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _close() {
  const dropdown = document.getElementById("db-menu-dropdown");
  const trigger  = document.getElementById("db-menu-trigger");
  dropdown?.classList.remove("is-open");
  trigger?.classList.remove("is-active");
}

async function _populateRecent(onDataReload) {
  const sub   = document.getElementById("db-menu-recent-sub");
  const empty = document.getElementById("db-menu-recent-empty");
  if (!sub) return;

  if (!window.pywebview?.api?.get_recent_dbs) {
    // Dev mode — nothing to show
    return;
  }

  try {
    const result = await window.pywebview.api.get_recent_dbs();
    const recents = result?.recents || [];

    // Remove any previously injected items (keep the empty notice node)
    [...sub.querySelectorAll(".db-menu__sub-item")].forEach(el => el.remove());

    if (recents.length === 0) {
      if (empty) empty.style.display = "";
      return;
    }

    if (empty) empty.style.display = "none";

    recents.forEach(({ path, name }) => {
      const btn = document.createElement("button");
      btn.className = "db-menu__sub-item";
      btn.type = "button";

      const nameEl = document.createElement("span");
      nameEl.className = "db-menu__sub-item__name";
      nameEl.textContent = name;

      const pathEl = document.createElement("span");
      pathEl.className = "db-menu__sub-item__path";
      pathEl.textContent = path;

      btn.append(nameEl, pathEl);
      btn.addEventListener("click", async () => {
        _close();
        const res = await window.pywebview.api.open_recent_db(path);
        if (res.ok) {
          showToast("Opened " + name, "success");
          await onDataReload();
        } else if (res.error !== "cancelled") {
          showToast("Failed to open: " + res.error, "error");
        }
      });
      sub.appendChild(btn);
    });
  } catch (e) {
    // Silently fail — recent list is non-critical
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function _onNew(onDataReload) {
  _close();
  if (!window.pywebview?.api?.new_db) {
    showToast("New Database requires the desktop app.", "info");
    return;
  }
  const result = await window.pywebview.api.new_db();
  if (result.ok) {
    showToast("New database created — reloading…", "success");
    await onDataReload();
  } else if (result.error !== "cancelled") {
    showToast("Failed to create database: " + result.error, "error");
  }
}

async function _onOpen(onDataReload) {
  _close();
  if (!window.pywebview?.api?.load_db) {
    showToast("Open Database requires the desktop app.", "info");
    return;
  }
  if (!confirm("Opening a database will switch the app to that file. Any unsaved changes will remain in the current database. Continue?")) return;
  const result = await window.pywebview.api.load_db();
  if (result.ok) {
    showToast("Database opened — reloading…", "success");
    await onDataReload();
  } else if (result.error !== "cancelled") {
    showToast("Failed to open database: " + result.error, "error");
  }
}

async function _onExportDb() {
  _close();
  if (!window.pywebview?.api?.export_db) {
    showToast("Export Database requires the desktop app.", "info");
    return;
  }
  const result = await window.pywebview.api.export_db();
  if (result.ok) {
    showToast("Database exported to " + result.path, "success");
  } else if (result.error !== "cancelled") {
    showToast("Export failed: " + result.error, "error");
  }
}

async function _onImportJson(fileInput, onDataReload) {
  _close();
  fileInput.value = "";   // reset so the same file can be re-selected
  fileInput.click();
}

async function _onExportJson() {
  _close();
  try {
    const ts = new Date().toISOString().slice(0, 10);
    await _triggerDownload(API.exportDataUrl(), `project-tracker-${ts}.json`);
    showToast("JSON exported", "success");
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  }
}

async function _onExportExcel() {
  _close();
  try {
    const ts = new Date().toISOString().slice(0, 10);
    await _triggerDownload(API.exportExcelUrl(), `project-tracker-${ts}.xlsx`);
    showToast("Excel exported", "success");
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Per-project exports
// ---------------------------------------------------------------------------

function _updateProjectExportVisibility() {
  const projectId  = State.getActiveProjectId();
  const section    = document.getElementById("db-menu-project-exports");
  const labelEl    = document.getElementById("db-menu-project-label");
  if (!section) return;

  if (projectId) {
    section.style.display = "";
    const projects = State.getProjects();
    const proj = projects.find(p => p.id === projectId);
    if (labelEl && proj) labelEl.textContent = `Export: ${proj.name}`;
  } else {
    section.style.display = "none";
  }
}

async function _onExportProjectReport() {
  _close();
  const projectId = State.getActiveProjectId();
  if (!projectId) { showToast("Select a project first", "info"); return; }
  try {
    await _triggerDownload(API.exportProjectReportUrl(projectId), `project-report.pdf`);
    showToast("Task report exported", "success");
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  }
}

async function _onExportProjectExcel() {
  _close();
  const projectId = State.getActiveProjectId();
  if (!projectId) { showToast("Select a project first", "info"); return; }
  try {
    await _triggerDownload(API.exportProjectExcelUrl(projectId), `project.xlsx`);
    showToast("Excel exported", "success");
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  }
}

async function _onExportProjectJson() {
  _close();
  const projectId = State.getActiveProjectId();
  if (!projectId) { showToast("Select a project first", "info"); return; }
  try {
    await _triggerDownload(API.exportProjectJsonUrl(projectId), `project.json`);
    showToast("JSON exported", "success");
  } catch (e) {
    showToast("Export failed: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * Initialise the database dropdown menu.
 *
 * @param {Function} onDataReload - async fn that reloads all app data and
 *   re-renders the current view (window.App.reloadData)
 */
export function initDbMenu(onDataReload) {
  const trigger   = document.getElementById("db-menu-trigger");
  const dropdown  = document.getElementById("db-menu-dropdown");
  const fileInput = document.getElementById("import-file-input");

  if (!trigger || !dropdown) return;

  // Toggle open / close — populate recent list and project exports each time
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.toggle("is-open");
    trigger.classList.toggle("is-active", isOpen);
    if (isOpen) {
      _populateRecent(onDataReload);
      _updateProjectExportVisibility();
    }
  });

  // Close when clicking anywhere outside the menu
  document.addEventListener("click", _close);

  // Prevent clicks inside the dropdown from closing it
  dropdown.addEventListener("click", (e) => e.stopPropagation());

  // Wire individual items
  document.getElementById("db-menu-new")
    ?.addEventListener("click", () => _onNew(onDataReload));

  document.getElementById("db-menu-open")
    ?.addEventListener("click", () => _onOpen(onDataReload));

  document.getElementById("db-menu-export-db")
    ?.addEventListener("click", _onExportDb);

  document.getElementById("db-menu-import-json")
    ?.addEventListener("click", () => _onImportJson(fileInput, onDataReload));

  document.getElementById("db-menu-export-json")
    ?.addEventListener("click", _onExportJson);

  document.getElementById("db-menu-export-excel")
    ?.addEventListener("click", _onExportExcel);

  // Per-project exports
  document.getElementById("db-menu-export-project-report")
    ?.addEventListener("click", _onExportProjectReport);
  document.getElementById("db-menu-export-project-excel")
    ?.addEventListener("click", _onExportProjectExcel);
  document.getElementById("db-menu-export-project-json")
    ?.addEventListener("click", _onExportProjectJson);

  // Handle file selected for JSON import
  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON.");
      }

      const result = await API.importData(parsed);
      showToast(
        `Imported ${result.projects_imported} project(s) and ${result.tasks_imported} task(s).`,
        "success"
      );
      await onDataReload();
    } catch (e) {
      showToast("Import failed: " + e.message, "error");
    }
  });
}
