/**
 * router.js — View lifecycle manager.
 *
 * Each view module must export three functions:
 *   init(container, state)  — Called once when the view first activates.
 *   render(data)            — Called to (re-)render with fresh data.
 *   destroy()               — Called before switching away; clean up listeners.
 *
 * The router keeps track of which view is active and calls destroy() before
 * switching, preventing stale event listeners from accumulating.
 */

import * as State from "./state.js";

// ---------------------------------------------------------------------------
// View registry — maps view name → lazy-loaded module
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, () => Promise<object>>}
 * Values are functions that return a Promise<module>.
 * Using dynamic import() keeps each view's code separate.
 */
const VIEW_REGISTRY = new Map([
  ["dashboard", () => import("./views/dashboard.js")],
  ["cards",     () => import("./views/cards.js")],
  ["gantt",     () => import("./views/gantt.js")],
  ["table",     () => import("./views/table.js")],
  ["kanban",    () => import("./views/kanban.js")],
  ["calendar",  () => import("./views/calendar.js")],
  ["timeline",  () => import("./views/timeline.js")],
  ["resource",  () => import("./views/resource.js")],
  ["expenses",  () => import("./views/expenses.js")],
  ["settings",  () => import("./views/settings.js")],
]);

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {object|null} Currently active view module */
let _currentModule = null;

/** @type {string|null} Name of the currently active view */
let _currentViewName = null;

/** @type {HTMLElement|null} The main content container */
let _container = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the router. Must be called once at startup.
 * @param {HTMLElement} container - The DOM element views will render into
 */
export function initRouter(container) {
  _container = container;
}

/**
 * Switch to the named view. Destroys the current view first.
 * Loads the view module if not already loaded.
 *
 * @param {string} viewName - One of the keys in VIEW_REGISTRY
 * @returns {Promise<void>}
 */
export async function navigateTo(viewName) {
  if (!VIEW_REGISTRY.has(viewName)) {
    console.error(`[router] Unknown view: "${viewName}"`);
    return;
  }

  // Destroy the current view if one is active
  if (_currentModule && typeof _currentModule.destroy === "function") {
    try {
      _currentModule.destroy();
    } catch (e) {
      console.error("[router] Error destroying view:", _currentViewName, e);
    }
  }

  _currentModule = null;
  _currentViewName = null;

  // Show a loading state while the module loads
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  try {
    const loader = VIEW_REGISTRY.get(viewName);
    const mod = await loader();

    _currentModule = mod;
    _currentViewName = viewName;

    // Give the view module the container and current state
    if (typeof mod.init === "function") {
      await mod.init(_container, State);
    }
  } catch (e) {
    console.error(`[router] Failed to load view "${viewName}":`, e);
    _container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__title">Failed to load view</div>
        <div class="empty-state__body">${e.message}</div>
      </div>`;
  }
}

/**
 * Re-render the current view with fresh data.
 * Safe to call at any time; does nothing if no view is active.
 *
 * @param {any} data - Data to pass to the view's render() function
 */
export async function refreshCurrentView(data) {
  if (_currentModule && typeof _currentModule.render === "function") {
    try {
      await _currentModule.render(data);
    } catch (e) {
      console.error(`[router] Error rendering view "${_currentViewName}":`, e);
    }
  }
}

/** @returns {string|null} The currently active view name */
export const getCurrentView = () => _currentViewName;
