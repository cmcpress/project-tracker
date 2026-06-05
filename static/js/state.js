/**
 * state.js — Client-side application state.
 *
 * This is a simple observable state container. Components read state through
 * the exported getters and mutate it through the setters. Subscribers are
 * notified via a lightweight event system when specific state keys change.
 *
 * No external dependencies. No framework magic.
 */

// ---------------------------------------------------------------------------
// Internal state object — never exported directly
// ---------------------------------------------------------------------------

const _state = {
  /** @type {string} The currently active view name */
  activeView: "dashboard",

  /** @type {number|null} The currently selected project ID (null = all projects) */
  activeProjectId: null,

  /** @type {Array} Full project list (populated on load and after mutations) */
  projects: [],

  /** @type {Array} Full people list */
  people: [],

  /** @type {boolean} Whether the sidebar is showing search results */
  isSearching: false,

  /** @type {string} Current sidebar search query */
  searchQuery: "",

  // Gantt view toggles
  gantt: {
    showBaseline: false,
    showActuals: true,
    showCriticalPath: false,
    zoomLevel: "month",   // "fit" | "month" | "week"
  },

  // Table view filters
  tableFilters: {
    projectId: null,
    status: null,
    type: null,
    assigneeId: null,
    search: "",
  },

  // Kanban filter
  kanbanProjectId: null,

  /** @type {number|null} Selected group task id (cards view sidebar filter) */
  activeGroupId: null,

  /** @type {Object.<number, Array>} projectId → [{id, name, wbs_number}] group tasks */
  projectGroupTasks: {},

  /** @type {string} Currency symbol loaded from app settings */
  currencySymbol: "£",
};

// ---------------------------------------------------------------------------
// Subscriber registry — maps state key → array of callback functions
// ---------------------------------------------------------------------------

/** @type {Map<string, Function[]>} */
const _subscribers = new Map();

/**
 * Subscribe to changes for a specific state key.
 * Returns an unsubscribe function.
 *
 * @param {string} key - State key to watch (e.g. "activeView", "projects")
 * @param {Function} callback - Called with the new value when the key changes
 * @returns {Function} Unsubscribe function
 */
export function subscribe(key, callback) {
  if (!_subscribers.has(key)) {
    _subscribers.set(key, []);
  }
  _subscribers.get(key).push(callback);
  return () => {
    const subs = _subscribers.get(key) || [];
    const idx = subs.indexOf(callback);
    if (idx !== -1) subs.splice(idx, 1);
  };
}

/**
 * Notify all subscribers for a given key.
 *
 * @param {string} key - State key that changed
 * @param {any} value  - New value
 */
function _notify(key, value) {
  const subs = _subscribers.get(key) || [];
  subs.forEach(cb => {
    try { cb(value); }
    catch (e) { console.error(`[state] Subscriber error for key "${key}":`, e); }
  });
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

/** @returns {string} */
export const getActiveView = () => _state.activeView;

/** @returns {number|null} */
export const getActiveProjectId = () => _state.activeProjectId;

/** @returns {Array} */
export const getProjects = () => _state.projects;

/** @returns {Array} */
export const getPeople = () => _state.people;

/** @returns {string} */
export const getSearchQuery = () => _state.searchQuery;

/** @returns {object} */
export const getGanttSettings = () => ({ ..._state.gantt });

/** @returns {object} */
export const getTableFilters = () => ({ ..._state.tableFilters });

/** @returns {number|null} */
export const getKanbanProjectId = () => _state.kanbanProjectId;

/** @returns {number|null} */
export const getActiveGroupId = () => _state.activeGroupId;

/** @returns {Object.<number, Array>} */
export const getProjectGroupTasks = () => _state.projectGroupTasks;

/** @returns {string} */
export const getCurrencySymbol = () => _state.currencySymbol;

/**
 * Find a single project from the cached project list by ID.
 * @param {number} id
 * @returns {object|undefined}
 */
export const getProjectById = (id) => _state.projects.find(p => p.id === id);

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

/**
 * Switch the active view. Notifies 'activeView' subscribers.
 * @param {string} viewName
 */
export function setActiveView(viewName) {
  if (_state.activeView === viewName) return;
  _state.activeView = viewName;
  _notify("activeView", viewName);
}

/**
 * Set the active project filter. Pass null to show all projects.
 * Notifies 'activeProjectId' subscribers.
 * @param {number|null} id
 */
export function setActiveProjectId(id) {
  _state.activeProjectId = id;
  _notify("activeProjectId", id);
}

/**
 * Replace the full project list. Notifies 'projects' subscribers.
 * @param {Array} projects
 */
export function setProjects(projects) {
  _state.projects = projects;
  _notify("projects", projects);
}

/**
 * Replace a single project in the cached list (by id).
 * Notifies 'projects' subscribers.
 * @param {object} project
 */
export function upsertProject(project) {
  const idx = _state.projects.findIndex(p => p.id === project.id);
  if (idx === -1) {
    _state.projects = [..._state.projects, project];
  } else {
    _state.projects = [
      ..._state.projects.slice(0, idx),
      project,
      ..._state.projects.slice(idx + 1),
    ];
  }
  _notify("projects", _state.projects);
}

/**
 * Remove a project from the cached list.
 * Notifies 'projects' subscribers.
 * @param {number} id
 */
export function removeProject(id) {
  _state.projects = _state.projects.filter(p => p.id !== id);
  if (_state.activeProjectId === id) {
    _state.activeProjectId = null;
    _notify("activeProjectId", null);
  }
  _notify("projects", _state.projects);
}

/**
 * Replace the full people list. Notifies 'people' subscribers.
 * @param {Array} people
 */
export function setPeople(people) {
  _state.people = people;
  _notify("people", people);
}

/**
 * Update the sidebar search query. Notifies 'searchQuery' subscribers.
 * @param {string} query
 */
export function setSearchQuery(query) {
  _state.searchQuery = query;
  _notify("searchQuery", query);
}

/**
 * Update a single Gantt toggle setting.
 * @param {string} key   - Key within gantt settings object
 * @param {any}    value - New value
 */
export function setGanttSetting(key, value) {
  _state.gantt = { ..._state.gantt, [key]: value };
  _notify("gantt", _state.gantt);
}

/**
 * Update one or more table filter values.
 * @param {object} patch - Partial table filters object
 */
export function setTableFilters(patch) {
  _state.tableFilters = { ..._state.tableFilters, ...patch };
  _notify("tableFilters", _state.tableFilters);
}

/**
 * Set the project filter for the Kanban view.
 * @param {number|null} id
 */
export function setKanbanProjectId(id) {
  _state.kanbanProjectId = id;
  _notify("kanbanProjectId", id);
}

/**
 * Set the active group task filter (cards view sidebar).
 * Pass null to clear the group filter.
 * @param {number|null} id
 */
export function setActiveGroupId(id) {
  _state.activeGroupId = id;
  _notify("activeGroupId", id);
}

/**
 * Store the map of group tasks per project (populated by cards view).
 * @param {Object.<number, Array>} map  projectId → [{id, name, wbs_number}]
 */
export function setProjectGroupTasks(map) {
  _state.projectGroupTasks = map;
  _notify("projectGroupTasks", map);
}

/**
 * Set the currency symbol (loaded from app settings at startup).
 * @param {string} symbol
 */
export function setCurrencySymbol(symbol) {
  _state.currencySymbol = symbol || "£";
  _notify("currencySymbol", _state.currencySymbol);
}
