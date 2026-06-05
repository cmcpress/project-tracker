/**
 * main.js — Application bootstrap.
 *
 * Startup sequence:
 *   1. Initialise the router with the view container element
 *   2. Initialise the sidebar
 *   3. Wire up topbar view-switch buttons
 *   4. Load initial data (projects + people) from the API
 *   5. Navigate to the default view (dashboard)
 *   6. Subscribe to state changes that require view re-navigation
 */

import * as API from "./api.js";
import * as State from "./state.js";
import { initRouter, navigateTo, getCurrentView } from "./router.js";
import { initSidebar } from "./components/sidebar.js";
import { initDbMenu } from "./components/db-menu.js";
import { showToast } from "./toast.js";
import { byId } from "./utils.js";

// ---------------------------------------------------------------------------
// Toast helper — attach to window so views can use it without importing
// ---------------------------------------------------------------------------

/**
 * Show a toast notification. Exposed on the App namespace.
 * @param {string} message
 * @param {'success'|'error'|'info'} [type]
 */
window.App = window.App || {};
window.App.toast = showToast;

/**
 * Reload all app data and re-render the current view.
 * Called by the Settings view after a database load.
 */
window.App.reloadData = async () => {
  await loadAppData();
  await navigateTo(State.getActiveView());
};

// ---------------------------------------------------------------------------
// Topbar view switcher
// ---------------------------------------------------------------------------

/**
 * Attach click handlers to all topbar nav buttons.
 * Updates button active state and triggers router navigation.
 */
function initTopbarNav() {
  const nav = byId("view-nav");

  nav.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;

    const viewName = btn.dataset.view;

    // Update active button state
    nav.querySelectorAll(".topbar__nav-btn").forEach(b => {
      b.classList.toggle("is-active", b === btn);
    });

    // Update state and navigate
    State.setActiveView(viewName);
    await navigateTo(viewName);
  });
}

// ---------------------------------------------------------------------------
// "Add Project" button
// ---------------------------------------------------------------------------

/**
 * Wire up the "+ Project" button in the topbar.
 * Opens the project form modal (loaded lazily with the project-form component).
 */
async function initAddProjectButton() {
  const btn = byId("btn-add-project");
  btn.addEventListener("click", async () => {
    const { openProjectForm } = await import("./components/project-form.js");
    openProjectForm(null, async (savedProject) => {
      // Refresh the full project list so task counts are accurate
      const updated = await API.listProjects();
      State.setProjects(updated);
      showToast(`Project "${savedProject.name}" created`, "success");
      // Re-render the current view so the new project appears
      await navigateTo(State.getActiveView());
    });
  });
}


// ---------------------------------------------------------------------------
// "Manage People" button
// ---------------------------------------------------------------------------

/**
 * Wire up the "Manage →" people button in the sidebar footer.
 */
async function initManagePeopleButton() {
  const btn = byId("btn-manage-people");
  btn.addEventListener("click", async () => {
    const { openPeopleManager } = await import("./components/people-form.js");
    openPeopleManager();
  });
}

// ---------------------------------------------------------------------------
// Active project → re-render current view
// ---------------------------------------------------------------------------

/**
 * When the active project changes, re-render the current view.
 * The view module is responsible for reading the new project ID from state.
 */
function initProjectFilter() {
  State.subscribe("activeProjectId", async () => {
    // Use the router's own current view name — definitive source of truth.
    const viewName = getCurrentView();
    if (viewName) await navigateTo(viewName);
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Load projects and people from the API and push them into state.
 * Called once at startup and can be called again to refresh.
 * @returns {Promise<void>}
 */
export async function loadAppData() {
  try {
    const settings = await API.getSettings().catch(() => ({}));
    const includeArchived = (settings.show_archived_projects ?? localStorage.getItem("show_archived_projects")) === "true";
    const [projects, people] = await Promise.all([
      API.listProjects({ includeArchived }),
      API.listPeople(),
    ]);
    State.setProjects(projects);
    State.setPeople(people);
    if (settings.currency_symbol) {
      State.setCurrencySymbol(settings.currency_symbol);
    }
    // Sync UI preferences from the database into localStorage so they survive
    // app restarts (pywebview's localStorage is not persistent by default).
    if (settings.cards_default_expanded !== undefined) {
      localStorage.setItem("cards_default_expanded", settings.cards_default_expanded);
    }
    if (settings.sidebar_categories_expanded !== undefined) {
      localStorage.setItem("sidebar_categories_expanded", settings.sidebar_categories_expanded);
    }
    if (settings.show_archived_projects !== undefined) {
      localStorage.setItem("show_archived_projects", settings.show_archived_projects);
    }
    if (settings.dark_mode !== undefined) {
      localStorage.setItem("dark_mode", settings.dark_mode);
    }
    // Apply dark mode now that settings are loaded (in case it changed on another machine)
    _applyDarkMode(localStorage.getItem("dark_mode") === "true");
  } catch (e) {
    console.error("[main] Failed to load initial data:", e);
    showToast("Failed to load data: " + e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------

function _applyDarkMode(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const btn = document.getElementById("btn-dark-mode");
  if (btn) btn.textContent = dark ? "☽" : "☀";
}

function initDarkMode() {
  // Apply immediately from localStorage so there's no flash on load.
  // The Settings view handles the toggle UI and saves changes.
  const isDark = localStorage.getItem("dark_mode") === "true";
  _applyDarkMode(isDark);
}

// ---------------------------------------------------------------------------
// Startup: overdue pending task notification
// ---------------------------------------------------------------------------

/**
 * After the app loads, check for any pending tasks past their expected date.
 * If any exist, show a dismissable modal so the user knows what needs chasing.
 * Fires once per launch; costs nothing — no polling, no background process.
 */
async function _checkOverduePending() {
  let tasks;
  try {
    tasks = await API.getOverduePendingTasks();
  } catch {
    return; // Silently skip — don't block startup on a notification
  }
  if (!tasks || tasks.length === 0) return;

  // Build overlay
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Chase Required");

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.maxWidth = "480px";

  // Header
  const header = document.createElement("div");
  header.className = "modal__header";
  header.style.background = "#fef3c7";
  header.style.borderBottom = "1px solid #fde68a";

  const titleEl = document.createElement("h2");
  titleEl.className = "modal__title";
  titleEl.style.color = "#92400e";
  titleEl.textContent = `⚠ Chase Required — ${tasks.length} task${tasks.length !== 1 ? "s" : ""} overdue`;

  const closeBtn = document.createElement("button");
  closeBtn.className = "modal__close";
  closeBtn.innerHTML = "✕";
  closeBtn.setAttribute("aria-label", "Dismiss");

  header.append(titleEl, closeBtn);

  // Body — task list
  const body = document.createElement("div");
  body.className = "modal__body";
  body.style.padding = "var(--space-4)";

  const intro = document.createElement("p");
  intro.style.cssText = "font-size:var(--font-size-sm);color:var(--text-secondary);margin-bottom:var(--space-3);";
  intro.textContent = "The following tasks are pending and past their expected date:";
  body.appendChild(intro);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:var(--space-2);";

  const fmtDate = (iso) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };

  tasks.forEach(t => {
    const row = document.createElement("div");
    row.style.cssText = [
      "display:flex;align-items:flex-start;gap:var(--space-3);",
      "padding:var(--space-2) var(--space-3);",
      "background:var(--grey-50);border-radius:var(--radius);",
      "border:1px solid var(--border);",
    ].join("");

    const icon = document.createElement("span");
    icon.textContent = "⚠";
    icon.style.cssText = "color:#f59e0b;flex-shrink:0;margin-top:1px;";

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";

    const name = document.createElement("div");
    name.style.cssText = "font-size:var(--font-size-sm);font-weight:600;color:var(--text-primary);";
    name.textContent = t.name;

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:2px;";
    meta.textContent = `${t.project_name} · Expected ${fmtDate(t.pending_until)}`;

    info.append(name, meta);
    row.append(icon, info);
    list.appendChild(row);
  });

  body.appendChild(list);

  // Footer
  const footer = document.createElement("div");
  footer.className = "modal__footer";

  const dashBtn = document.createElement("button");
  dashBtn.className = "btn btn--primary";
  dashBtn.textContent = "Go to Dashboard";

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "btn btn--secondary";
  dismissBtn.textContent = "Dismiss";

  footer.append(dashBtn, dismissBtn);

  modal.append(header, body, footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  closeBtn.addEventListener("click", close);
  dismissBtn.addEventListener("click", close);
  dashBtn.addEventListener("click", async () => {
    close();
    await navigateTo("dashboard");
    State.setActiveView("dashboard");
    document.querySelectorAll(".topbar__nav-btn").forEach(b => {
      b.classList.toggle("is-active", b.dataset.view === "dashboard");
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // 1. Set up the router
  const container = byId("view-container");
  initRouter(container);

  // 2. Apply dark mode from localStorage immediately (before any render)
  initDarkMode();

  // 3. Set up the sidebar
  initSidebar();

  // 4. Wire topbar, buttons, filters
  initTopbarNav();
  await initAddProjectButton();
  await initManagePeopleButton();
  initDbMenu(window.App.reloadData);
  initProjectFilter();

  // 5. Load data
  await loadAppData();

  // 6. Navigate to the default view
  await navigateTo("dashboard");

  // 7. Check for overdue pending tasks and notify
  await _checkOverduePending();
}

// Run on DOMContentLoaded (the script tag has type="module" so it's already deferred)
boot().catch(e => {
  console.error("[main] Boot failed:", e);
});
