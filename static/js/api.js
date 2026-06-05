/**
 * api.js — Single point of contact for all server communication.
 *
 * All fetch calls go through the request() function, which handles:
 *   - Setting base URL and Content-Type
 *   - Parsing JSON responses
 *   - Normalising error responses into thrown Error objects
 *   - Logging errors to console
 *
 * Consumers of this module never call fetch() directly.
 */

const BASE = "";  // Same origin — Flask serves both the app and the API

/**
 * Core fetch wrapper. Throws an Error with a user-readable message on failure.
 *
 * @param {string} path    - API path, e.g. "/api/projects"
 * @param {object} options - fetch() options (method, body, etc.)
 * @returns {Promise<any>} - Parsed JSON body, or null for 204 responses
 */
async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const fetchOptions = {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...options.headers,
    },
    ...options,
  };

  let response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (networkError) {
    console.error("[api] Network error:", networkError);
    throw new Error("Cannot reach the server. Is it running?");
  }

  // 204 No Content — no body to parse
  if (response.status === 204) {
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    console.error("[api] Failed to parse JSON from", url, response.status);
    throw new Error(`Server returned an unexpected response (${response.status}).`);
  }

  if (!response.ok) {
    const message = body?.error || `Request failed (${response.status})`;
    console.error("[api] API error:", response.status, message, "URL:", url);
    throw new Error(message);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} All projects with task counts */
export const listProjects = ({ includeArchived = false } = {}) =>
  request("/api/projects" + (includeArchived ? "?include_archived=1" : ""));

/** @param {object} data - Project fields */
export const createProject = (data) =>
  request("/api/projects", { method: "POST", body: JSON.stringify(data) });

/** @param {number} id - Project ID */
export const getProject = (id) => request(`/api/projects/${id}`);

/** @param {number} id - Project ID @param {object} data - Fields to update */
export const updateProject = (id, data) =>
  request(`/api/projects/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id - Project ID */
export const deleteProject = (id) =>
  request(`/api/projects/${id}`, { method: "DELETE" });

/** @param {Array<{id, sort_order}>} items - Reorder payload */
export const reorderProjects = (items) =>
  request("/api/projects/reorder", { method: "PUT", body: JSON.stringify(items) });

/** @param {number} id @param {boolean} archived */
export const archiveProject = (id, archived) =>
  request(`/api/projects/${id}/archive`, { method: "PUT", body: JSON.stringify({ archived }) });

/** @param {number} id - Project ID */
export const getEarnedValue = (id) => request(`/api/projects/${id}/earned-value`);

/** @param {number} id - Project ID */
export const getProjectExpenses = (id) => request(`/api/projects/${id}/expenses`);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const listTasks = (projectId) => request(`/api/projects/${projectId}/tasks`);

/** @param {number} projectId @param {object} data */
export const createTask = (projectId, data) =>
  request(`/api/projects/${projectId}/tasks`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id */
export const getTask = (id) => request(`/api/tasks/${id}`);

/** @param {number} id @param {object} data */
export const updateTask = (id, data) =>
  request(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) });

/**
 * Delete a task.
 * Returns null on success (204).
 * Returns {has_children: true, children: [...]} if the task has children and
 * needs a decision before deletion — call deleteTaskCascade or deleteTaskReassign.
 * @param {number} id
 */
export async function deleteTask(id) {
  const resp = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
  if (resp.status === 204) return null;
  const body = await resp.json().catch(() => ({}));
  if (resp.status === 409 && body.has_children) return body;   // caller handles
  if (!resp.ok) throw new Error(body?.error || `Delete failed (${resp.status})`);
  return body;
}

/** Delete task and all its children. @param {number} id */
export const deleteTaskCascade = (id) =>
  request(`/api/tasks/${id}?cascade=true`, { method: "DELETE" });

/** Reassign children to another group then delete. @param {number} id @param {number|null} reassignTo (0 = top-level) */
export const deleteTaskReassign = (id, reassignTo) =>
  request(`/api/tasks/${id}?reassign_to=${reassignTo ?? 0}`, { method: "DELETE" });

/** @param {number} id @param {string} status */
export const updateTaskStatus = (id, status) =>
  request(`/api/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });

/** @param {Array<{id, sort_order}>} items */
export const reorderTasks = (items) =>
  request("/api/tasks/reorder", { method: "PUT", body: JSON.stringify(items) });

/** Tasks that are pending and past their pending_until date. Used by startup notification. */
export const getOverduePendingTasks = () =>
  request("/api/tasks/overdue-pending");

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** @param {number} taskId */
export const listDependencies = (taskId) => request(`/api/tasks/${taskId}/dependencies`);

/** @param {object} data - {predecessor_id, successor_id, type, lag_days} */
export const createDependency = (data) =>
  request("/api/dependencies", { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updateDependency = (id, data) =>
  request(`/api/dependencies/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deleteDependency = (id) =>
  request(`/api/dependencies/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} All people */
export const listPeople = () => request("/api/people");

/** @param {object} data */
export const createPerson = (data) =>
  request("/api/people", { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updatePerson = (id, data) =>
  request(`/api/people/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deletePerson = (id) =>
  request(`/api/people/${id}`, { method: "DELETE" });

/** @param {number} taskId @param {number} personId */
export const assignPerson = (taskId, personId) =>
  request(`/api/tasks/${taskId}/people/${personId}`, { method: "POST" });

/** @param {number} taskId @param {number} personId */
export const unassignPerson = (taskId, personId) =>
  request(`/api/tasks/${taskId}/people/${personId}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Task items
// ---------------------------------------------------------------------------

/** @param {number} taskId */
export const listItems = (taskId) => request(`/api/tasks/${taskId}/items`);

/** @param {number} taskId @param {object} data */
export const createItem = (taskId, data) =>
  request(`/api/tasks/${taskId}/items`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updateItem = (id, data) =>
  request(`/api/items/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deleteItem = (id) =>
  request(`/api/items/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const listBaselines = (projectId) => request(`/api/projects/${projectId}/baselines`);

/** @param {number} projectId @param {object} data - {name, notes} */
export const createBaseline = (projectId, data) =>
  request(`/api/projects/${projectId}/baselines`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id */
export const getBaseline = (id) => request(`/api/baselines/${id}`);

/** @param {number} id */
export const deleteBaseline = (id) =>
  request(`/api/baselines/${id}`, { method: "DELETE" });

/** @param {number} projectId @param {number} baselineId */
export const restoreBaseline = (projectId, baselineId) =>
  request(`/api/projects/${projectId}/baselines/${baselineId}/restore`, { method: "POST" });

// ---------------------------------------------------------------------------
// Critical path
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const getCriticalPath = (projectId) =>
  request(`/api/projects/${projectId}/critical-path`);

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} All categories */
export const listCategories = () => request("/api/categories");

/** @param {object} data - {name, colour} */
export const createCategory = (data) =>
  request("/api/categories", { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updateCategory = (id, data) =>
  request(`/api/categories/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deleteCategory = (id) =>
  request(`/api/categories/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const listPhases = (projectId) =>
  request(`/api/projects/${projectId}/phases`);

/** @param {number} projectId @param {object} data - {name, start_date, end_date, colour} */
export const createPhase = (projectId, data) =>
  request(`/api/projects/${projectId}/phases`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updatePhase = (id, data) =>
  request(`/api/phases/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deletePhase = (id) =>
  request(`/api/phases/${id}`, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Unavailability
// ---------------------------------------------------------------------------

/** @param {number} personId */
export const listUnavailability = (personId) =>
  request(`/api/people/${personId}/unavailability`);

/** @param {number} personId @param {object} data - {start_date, end_date, label} */
export const createUnavailability = (personId, data) =>
  request(`/api/people/${personId}/unavailability`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {object} data */
export const updateUnavailability = (id, data) =>
  request(`/api/unavailability/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deleteUnavailability = (id) =>
  request(`/api/unavailability/${id}`, { method: "DELETE" });

/** All entries for people assigned to tasks in a project (for Gantt) */
export const listProjectUnavailability = (projectId) =>
  request(`/api/projects/${projectId}/unavailability`);

/** Every unavailability entry across all people (for Calendar + Timeline) */
export const listAllUnavailability = () =>
  request(`/api/unavailability/all`);

// ---------------------------------------------------------------------------
// Database info (dev-mode fallback — desktop app uses pywebview.api.get_db_path)
// ---------------------------------------------------------------------------

/** @returns {Promise<{path: string}>} Current database file path */
export const getDbInfo = () => request("/api/db/info");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** @returns {Promise<Object>} All settings as a key → value dict */
export const getSettings = () => request("/api/settings");

/**
 * Update a single setting value.
 * @param {string} key   - Setting key (e.g. "currency_symbol")
 * @param {string} value - New value
 */
export const updateSetting = (key, value) =>
  request(`/api/settings/${key}`, { method: "PUT", body: JSON.stringify({ value }) });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** @returns {Promise<Array>} All templates (summary) */
export const listTemplates = () => request("/api/templates");

/**
 * Save a group task as a new template.
 * @param {object} data - { group_task_id, name, description? }
 */
export const saveTemplate = (data) =>
  request("/api/templates", { method: "POST", body: JSON.stringify(data) });

/** @param {number} id */
export const getTemplate = (id) => request(`/api/templates/${id}`);

/** @param {number} id */
export const deleteTemplate = (id) =>
  request(`/api/templates/${id}`, { method: "DELETE" });

/**
 * Apply a template to a project.
 * @param {number} id   - Template ID
 * @param {object} data - { project_id, start_date }
 */
export const applyTemplate = (id, data) =>
  request(`/api/templates/${id}/apply`, { method: "POST", body: JSON.stringify(data) });

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const exportProjectPdf = (projectId) =>
  `${BASE}/api/export/project/${projectId}/pdf`;

/** @param {number} projectId */
export const exportProjectGantt = (projectId) =>
  `${BASE}/api/export/project/${projectId}/gantt`;

/** Per-project exports (return URL strings for _triggerDownload) */
export const exportProjectJsonUrl   = (projectId) => `${BASE}/api/export/project/${projectId}/json`;
export const exportProjectExcelUrl  = (projectId) => `${BASE}/api/export/project/${projectId}/excel`;
export const exportProjectReportUrl = (projectId) => `${BASE}/api/export/project/${projectId}/report`;

/** @returns URL string for full JSON data export */
export const exportDataUrl = () => `${BASE}/api/export/data`;

/** @returns URL string for full Excel data export */
export const exportExcelUrl = () => `${BASE}/api/export/data/excel`;

/** @param {object} data - Full JSON backup */
export const importData = (data) =>
  request("/api/import/data", { method: "POST", body: JSON.stringify(data) });

// ---------------------------------------------------------------------------
// Project links
// ---------------------------------------------------------------------------

/** @param {number} projectId */
export const listProjectLinks = (projectId) =>
  request(`/api/projects/${projectId}/links`);

/** @param {number} projectId @param {{name: string, url: string}} data */
export const createProjectLink = (projectId, data) =>
  request(`/api/projects/${projectId}/links`, { method: "POST", body: JSON.stringify(data) });

/** @param {number} id @param {{name?: string, url?: string}} data */
export const updateProjectLink = (id, data) =>
  request(`/api/links/${id}`, { method: "PUT", body: JSON.stringify(data) });

/** @param {number} id */
export const deleteProjectLink = (id) =>
  request(`/api/links/${id}`, { method: "DELETE" });

/**
 * Ask the server to open a URL or file path in the OS default application.
 * Web URLs (http/https) open in the system browser.
 * Local paths (C:\..., \\server\...) open in Explorer / default app.
 * @param {string} url
 */
export const openLink = (url) =>
  request("/api/open-link", { method: "POST", body: JSON.stringify({ url }) });
