/**
 * components/sidebar.js — Project list sidebar.
 *
 * Responsibilities:
 *   - Render projects grouped by category
 *   - Handle project selection (click to filter, click again to deselect)
 *   - Category collapse/expand
 *   - Search filtering
 *   - React to state changes (project list, active project, search query)
 */

import * as State from "../state.js";
import * as API from "../api.js";
import { initials, hexToRgba, debounce } from "../utils.js";
import { navigateTo } from "../router.js";

// Remember which projects have their group sub-items collapsed between renders
const _collapsedProjects = new Set();

// Remember per-category expanded/collapsed state across re-renders.
// Key = category name, value = boolean (true = expanded).
// If a category isn't in this Map, the localStorage default is used.
const _categoryStates = new Map();

/** @type {HTMLElement} */
let _listEl = null;

/** @type {Function[]} Unsubscribe functions for state subscriptions */
const _unsubs = [];

/**
 * Initialise the sidebar. Must be called once at startup.
 * Attaches event listeners and subscribes to state changes.
 */
export function initSidebar() {
  _listEl = document.getElementById("sidebar-project-list");
  const searchInput = document.getElementById("sidebar-search");

  if (!_listEl || !searchInput) {
    console.error("[sidebar] Required DOM elements not found.");
    return;
  }

  // Search input
  const handleSearch = debounce((query) => {
    State.setSearchQuery(query);
  }, 200);

  searchInput.addEventListener("input", (e) => {
    handleSearch(e.target.value.trim());
  });

  // Subscribe to state changes that require re-rendering
  _unsubs.push(State.subscribe("projects",          () => render()));
  _unsubs.push(State.subscribe("activeProjectId",   () => render()));
  _unsubs.push(State.subscribe("activeGroupId",     () => render()));
  _unsubs.push(State.subscribe("searchQuery",       () => render()));
  _unsubs.push(State.subscribe("activeView",        () => render()));
  _unsubs.push(State.subscribe("projectGroupTasks", () => render()));

  render();
}

/**
 * Tear down sidebar subscriptions. Call when the sidebar is unmounted.
 */
export function destroySidebar() {
  _unsubs.forEach(unsub => unsub());
  _unsubs.length = 0;
}

/**
 * Re-render the project list from current state.
 */
function render() {
  if (!_listEl) return;

  const projects        = State.getProjects();
  const activeId        = State.getActiveProjectId();
  const activeGroupId   = State.getActiveGroupId();
  const activeView      = State.getActiveView();
  const groupsByProject = State.getProjectGroupTasks();
  const query           = State.getSearchQuery().toLowerCase();

  // Filter by search query
  const filtered = query
    ? projects.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.category.toLowerCase().includes(query)
      )
    : projects;

  if (filtered.length === 0) {
    _listEl.innerHTML = `
      <div class="empty-state" style="padding: var(--space-4) var(--space-3);">
        <div class="empty-state__body">No projects yet</div>
      </div>`;
    return;
  }

  // Group by category
  /** @type {Map<string, Array>} */
  const byCategory = new Map();
  for (const p of filtered) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(p);
  }

  // Sort categories alphabetically
  const sortedCategories = [...byCategory.keys()].sort();

  const fragment = document.createDocumentFragment();

  // "All Projects" shortcut at the top
  const allEl = document.createElement("div");
  allEl.className = "sidebar__all-projects" + (!activeId ? " is-active" : "");
  allEl.setAttribute("role", "button");
  allEl.tabIndex = 0;
  allEl.title = "Show all projects";
  allEl.innerHTML = `<span class="sidebar__all-projects__icon">⊞</span><span>All Projects</span>`;
  allEl.addEventListener("click", () => {
    State.setActiveGroupId(null);
    State.setActiveProjectId(null);  // initProjectFilter re-renders the current view with no filter
  });
  allEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); allEl.click(); }
  });
  fragment.appendChild(allEl);

  for (const category of sortedCategories) {
    const projectsInCategory = byCategory.get(category);
    const groupEl = buildCategoryGroup(
      category, projectsInCategory, activeId, activeGroupId, activeView, groupsByProject
    );
    fragment.appendChild(groupEl);
  }

  _listEl.replaceChildren(fragment);
}

/**
 * Build a category group element containing all its project items.
 */
function buildCategoryGroup(category, projects, activeId, activeGroupId, activeView, groupsByProject) {
  const groupEl = document.createElement("div");
  groupEl.className = "sidebar__category";

  // Determine expanded state: use remembered state if user has touched this
  // category before, otherwise fall back to the localStorage default.
  const defaultCatsExpanded = localStorage.getItem("sidebar_categories_expanded") !== "false";
  const isExpanded = _categoryStates.has(category)
    ? _categoryStates.get(category)
    : defaultCatsExpanded;

  // Header (collapse/expand toggle)
  const headerEl = document.createElement("div");
  headerEl.className = "sidebar__category-header";
  headerEl.setAttribute("role", "button");
  headerEl.setAttribute("aria-expanded", String(isExpanded));
  headerEl.tabIndex = 0;

  const chevronEl = document.createElement("span");
  chevronEl.className = "sidebar__category-chevron";
  chevronEl.textContent = "▾";
  chevronEl.setAttribute("aria-hidden", "true");

  headerEl.appendChild(chevronEl);
  headerEl.appendChild(document.createTextNode(category));

  // Items container
  const itemsEl = document.createElement("div");
  itemsEl.className = "sidebar__category-items";

  for (const project of projects) {
    itemsEl.appendChild(
      buildProjectItem(project, activeId, activeGroupId, activeView, groupsByProject)
    );
  }

  groupEl.appendChild(headerEl);
  groupEl.appendChild(itemsEl);

  // Apply initial state
  if (!isExpanded) {
    groupEl.classList.add("is-collapsed");
    chevronEl.style.transform = "rotate(-90deg)";
  }

  // Collapse toggle — remember the new state so re-renders preserve it
  const toggleCollapse = () => {
    const collapsed = groupEl.classList.toggle("is-collapsed");
    const nowExpanded = !collapsed;
    headerEl.setAttribute("aria-expanded", String(nowExpanded));
    chevronEl.style.transform = collapsed ? "rotate(-90deg)" : "";
    _categoryStates.set(category, nowExpanded);
  };

  headerEl.addEventListener("click", toggleCollapse);
  headerEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleCollapse();
    }
  });

  return groupEl;
}

/**
 * Build a single project list item, plus optional group sub-items (cards view only).
 *
 * @param {object}     project
 * @param {number|null} activeId
 * @param {number|null} activeGroupId
 * @param {string}      activeView
 * @param {Object}      groupsByProject  projectId → [{id, name, wbs_number}]
 * @returns {HTMLElement}  wrapper div containing the project row + optional group list
 */
function buildProjectItem(project, activeId, activeGroupId, activeView, groupsByProject) {
  const wrapper = document.createElement("div");

  // Group tasks for this project (only meaningful in cards view)
  const groups = (activeView === "cards" && groupsByProject[project.id]) || [];
  const hasGroups = groups.length > 0;
  const groupsCollapsed = _collapsedProjects.has(project.id);

  // ── Project row ──────────────────────────────────────────────────────────
  const itemEl = document.createElement("div");
  itemEl.className = "sidebar__project-item";
  if (project.id === activeId) itemEl.classList.add("is-active");
  itemEl.setAttribute("role", "button");
  itemEl.setAttribute("aria-pressed", String(project.id === activeId));
  itemEl.tabIndex = 0;
  itemEl.dataset.projectId = String(project.id);

  // Disclosure chevron (only when there are group tasks)
  if (hasGroups) {
    const chevronEl = document.createElement("span");
    chevronEl.className = "sidebar__project-chevron";
    chevronEl.textContent = "▾";
    chevronEl.style.transform = groupsCollapsed ? "rotate(-90deg)" : "";
    chevronEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_collapsedProjects.has(project.id)) {
        _collapsedProjects.delete(project.id);
      } else {
        _collapsedProjects.add(project.id);
      }
      // Re-render sidebar without triggering a full state change
      render();
    });
    itemEl.appendChild(chevronEl);
  }

  // Colour dot
  const dotEl = document.createElement("span");
  dotEl.className = "sidebar__project-dot";
  dotEl.style.background = project.colour || "#4a90e2";

  // Name
  const nameEl = document.createElement("span");
  nameEl.className = "truncate";
  nameEl.textContent = project.name;
  nameEl.title = project.name;

  itemEl.appendChild(dotEl);
  itemEl.appendChild(nameEl);

  // Click: select project, clear any group filter
  const handleClick = () => {
    const currentGroupId = State.getActiveGroupId();
    const activeView     = State.getActiveView();
    if (currentGroupId) {
      // Group was selected within this project — step back to project level
      State.setActiveGroupId(null);
      State.setActiveProjectId(project.id);
    } else {
      // In table view always select (never deselect on second click —
      // clicking a project should reliably show its tasks)
      const canDeselect = activeView !== "table";
      const newId = (canDeselect && project.id === State.getActiveProjectId()) ? null : project.id;
      State.setActiveProjectId(newId);
      State.setActiveGroupId(null);
    }
  };

  itemEl.addEventListener("click", handleClick);
  itemEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  });

  wrapper.appendChild(itemEl);

  // ── Group sub-items ───────────────────────────────────────────────────────
  if (hasGroups) {
    const groupListEl = document.createElement("div");
    groupListEl.className = "sidebar__group-items";
    if (groupsCollapsed) groupListEl.style.display = "none";

    for (const group of groups) {
      const groupEl = document.createElement("div");
      groupEl.className = "sidebar__group-item";
      if (group.id === activeGroupId) groupEl.classList.add("is-active");
      groupEl.setAttribute("role", "button");
      groupEl.tabIndex = 0;
      groupEl.title = group.name;

      const dashEl = document.createElement("span");
      dashEl.className = "sidebar__group-dash";

      const gnameEl = document.createElement("span");
      gnameEl.className = "truncate";
      gnameEl.textContent = group.wbs_number
        ? group.wbs_number + "  " + group.name
        : group.name;

      groupEl.appendChild(dashEl);
      groupEl.appendChild(gnameEl);

      const handleGroupClick = () => {
        State.setActiveProjectId(project.id);
        State.setActiveGroupId(group.id);
      };

      groupEl.addEventListener("click", (e) => { e.stopPropagation(); handleGroupClick(); });
      groupEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleGroupClick(); }
      });

      groupListEl.appendChild(groupEl);
    }

    wrapper.appendChild(groupListEl);
  }

  return wrapper;
}
