/**
 * views/dashboard.js — Dashboard view.
 *
 * Grid of project cards with progress, edit/delete actions,
 * plus overdue, up-next, and people panels.
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { navigateTo } from "../router.js";
import { openProjectForm } from "../components/project-form.js";
import { openLinkForm } from "../components/link-form.js";
import { openTaskForm } from "../components/task-form.js";
import { createModal } from "../components/modal.js";
import { el, formatDateShort, statusLabel, statusClass, isOverdue, initials, pendingIndicator } from "../utils.js";

let _container = null;
const _unsubs = [];

export async function init(container) {
  _container = container;
  _container.className = "main__content";  // restore scroll-view styles
  _unsubs.push(State.subscribe("activeProjectId", () => _loadAndRender()));
  await _loadAndRender();
}

export async function render() {
  await _loadAndRender();
}

export function destroy() {
  _unsubs.forEach(fn => fn());
  _unsubs.length = 0;
  _container = null;
}

async function _loadAndRender() {
  if (!_container) return;
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  try {
    const projects = State.getProjects();
    const activeId = State.getActiveProjectId();
    const toShow = activeId ? projects.filter(p => p.id === activeId) : projects;
    const full = await Promise.all(toShow.map(p => API.getProject(p.id)));

    _container.innerHTML = "";
    const wrapper = el("div", "");
    wrapper.style.cssText = "display:grid; grid-template-columns:1fr 340px; gap:var(--space-5); align-items:start;";

    const gridWrap = el("div", "");

    if (full.length === 0) {
      gridWrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📋</div>
          <div class="empty-state__title">No projects yet</div>
          <div class="empty-state__body">Click "+ Project" to create your first project.</div>
        </div>`;
    } else {
      const grid = el("div", "");
      grid.style.cssText = "display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:var(--space-4);";
      for (const p of full) grid.appendChild(_buildProjectCard(p));
      gridWrap.appendChild(grid);
    }

    const panels = el("div", "");
    panels.style.cssText = "display:flex; flex-direction:column; gap:var(--space-4);";
    panels.appendChild(_buildOverduePanel(full));
    panels.appendChild(_buildUpNextPanel(full));
    panels.appendChild(_buildOverduePendingPanel(full));
    panels.appendChild(_buildPeoplePanel());

    wrapper.appendChild(gridWrap);
    wrapper.appendChild(panels);
    _container.appendChild(wrapper);
  } catch (e) {
    _container.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">Failed to load dashboard</div>
      <div class="empty-state__body">${e.message}</div></div>`;
  }
}

// ---------------------------------------------------------------------------
// Project card
// ---------------------------------------------------------------------------

function _buildProjectCard(project) {
  const card = el("div", "card");
  card.style.overflow = "hidden";

  const accent = el("div", "card__accent");
  accent.style.background = project.colour || "#4a90e2";

  const body = el("div", "");
  body.style.cssText = "padding:var(--space-4) var(--space-4) var(--space-3);";

  // Top row: name + action buttons
  const top = el("div", "");
  top.style.cssText = "display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-2); margin-bottom:var(--space-2);";

  const name = el("div", "truncate");
  name.style.cssText = [
    "font-size:var(--font-size-md);font-weight:600;color:var(--text-primary);",
    "flex:1;min-width:0;cursor:pointer;",
    "text-decoration:none;",
  ].join("");
  name.textContent = project.name;
  name.title = "Open in Cards view";
  name.addEventListener("click", async () => {
    State.setActiveProjectId(project.id);
    State.setActiveView("cards");
    await navigateTo("cards");
    document.querySelectorAll(".topbar__nav-btn").forEach(b => {
      b.classList.toggle("is-active", b.dataset.view === "cards");
    });
  });

  // Action buttons
  const actions = el("div", "");
  actions.style.cssText = "display:flex; gap:2px; flex-shrink:0; align-items:center;";

  // Links button
  const linkCount = project.link_count || 0;
  const linksBtn = el("button", "btn btn--ghost btn--sm");
  linksBtn.title = "Manage project links";
  linksBtn.style.cssText = "font-size:var(--font-size-xs);padding:2px 6px;display:flex;align-items:center;gap:3px;";
  const linkIcon = el("span", "", "🔗");
  linkIcon.style.fontSize = "11px";
  const linkLabel = el("span", "", linkCount > 0 ? `Links (${linkCount})` : "Links");
  linksBtn.appendChild(linkIcon);
  linksBtn.appendChild(linkLabel);
  linksBtn.addEventListener("click", () => {
    openLinkForm(project, (newCount) => {
      linkLabel.textContent = newCount > 0 ? `Links (${newCount})` : "Links";
      project.link_count = newCount;
    });
  });

  const editBtn = el("button", "btn btn--ghost btn--icon");
  editBtn.title = "Edit project";
  editBtn.innerHTML = "✎";
  editBtn.style.fontSize = "13px";
  editBtn.addEventListener("click", () => {
    openProjectForm(project, async (saved) => {
      State.upsertProject(saved);
      window.App?.toast?.(`Project "${saved.name}" updated`, "success");
      await _loadAndRender();
    });
  });

  const delBtn = el("button", "btn btn--ghost btn--icon");
  delBtn.title = "Delete project";
  delBtn.innerHTML = "🗑";
  delBtn.style.fontSize = "12px";
  delBtn.addEventListener("click", () => _confirmDeleteProject(project));

  actions.appendChild(linksBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  top.appendChild(name);
  top.appendChild(actions);

  // Status badge + category
  const meta = el("div", "");
  meta.style.cssText = "display:flex; align-items:center; gap:var(--space-2); margin-bottom:var(--space-3);";

  const badge = el("span", `badge badge--${statusClass(project.status)}`);
  badge.textContent = statusLabel(project.status);

  const catEl = el("span", "");
  catEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
  catEl.textContent = project.category;

  meta.appendChild(badge);
  meta.appendChild(catEl);

  // Progress
  const pct = project.completion_pct || 0;
  const total = project.task_count || 0;
  const complete = project.completed_task_count || 0;

  const progressBar = el("div", "progress-bar");
  progressBar.style.marginBottom = "var(--space-1)";
  const fill = el("div", "progress-bar__fill" + (pct === 100 ? " progress-bar__fill--complete" : ""));
  fill.style.width = pct + "%";
  progressBar.appendChild(fill);

  const stats = el("div", "");
  stats.style.cssText = "display:flex; justify-content:space-between; font-size:var(--font-size-xs); color:var(--text-muted);";
  const tasksStat = el("span", "", complete + "/" + total + " tasks");
  const overdue = project.overdue_count || 0;
  const overdueStat = el("span", "");
  overdueStat.textContent = overdue > 0 ? overdue + " overdue" : "";
  overdueStat.style.color = overdue > 0 ? "var(--status-blocked-text)" : "";
  stats.appendChild(tasksStat);
  stats.appendChild(overdueStat);

  body.appendChild(top);
  body.appendChild(meta);
  body.appendChild(progressBar);
  body.appendChild(stats);

  card.appendChild(accent);
  card.appendChild(body);
  return card;
}

// ---------------------------------------------------------------------------
// Delete confirmation modal
// ---------------------------------------------------------------------------

function _confirmDeleteProject(project) {
  const modal = createModal({ title: "Delete Project" });
  const msg = document.createElement("p");
  msg.style.cssText = "margin:0; line-height:1.5;";
  msg.innerHTML = 'Delete <strong>' + project.name + '</strong> and all its tasks? This cannot be undone.';
  modal.setBody(msg);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => modal.close());

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn--danger";
  deleteBtn.textContent = "Delete Project";
  deleteBtn.addEventListener("click", async () => {
    deleteBtn.disabled = true;
    deleteBtn.textContent = "Deleting…";
    try {
      await API.deleteProject(project.id);
      modal.close();
      State.removeProject(project.id);
      window.App?.toast?.('"' + project.name + '" deleted', "success");
      await _loadAndRender();
    } catch (err) {
      window.App?.toast?.("Error: " + err.message, "error");
      deleteBtn.disabled = false;
      deleteBtn.textContent = "Delete Project";
    }
  });

  modal.setFooter(cancelBtn, deleteBtn);
  modal.open();
}

// ---------------------------------------------------------------------------
// Sidebar panels
// ---------------------------------------------------------------------------

function _buildOverduePanel(projects) {
  const panel = el("div", "card");
  const header = el("div", "card__header");
  header.style.padding = "var(--space-3) var(--space-4)";
  const title = el("span", "section-title", "⚠ Overdue");
  title.style.color = "var(--status-blocked-text)";
  header.appendChild(title);

  const body = el("div", "");
  body.style.cssText = "padding:0 var(--space-4) var(--space-3);";

  const overdueTasks = [];
  for (const p of projects) {
    for (const t of (p.tasks || [])) {
      if (t.end_date && isOverdue(t.end_date) && t.status !== "complete") {
        overdueTasks.push({ task: t, project: p });
      }
    }
  }

  if (overdueTasks.length === 0) {
    const msg = el("div", "", "No overdue tasks ✓");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--status-complete-text); padding:var(--space-2) 0;";
    body.appendChild(msg);
  } else {
    for (const { task, project } of overdueTasks.slice(0, 8)) {
      const row = el("div", "");
      row.style.cssText = "display:flex; flex-direction:column; gap:2px; padding:var(--space-2) 0; border-bottom:1px solid var(--border);";
      const taskName = el("span", "truncate");
      taskName.style.cssText = "font-size:var(--font-size-sm); font-weight:500; color:var(--text-primary);";
      taskName.textContent = task.name;
      const meta = el("span", "");
      meta.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
      meta.textContent = project.name + " · due " + formatDateShort(task.end_date);
      row.appendChild(taskName);
      row.appendChild(meta);
      body.appendChild(row);
    }
  }

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function _buildUpNextPanel(projects) {
  const panel = el("div", "card");
  const header = el("div", "card__header");
  header.style.padding = "var(--space-3) var(--space-4)";
  header.appendChild(el("span", "section-title", "▶ Up Next"));

  const body = el("div", "");
  body.style.cssText = "padding:0 var(--space-4) var(--space-3);";

  const nextTasks = [];
  for (const p of projects) {
    const incomplete = (p.tasks || [])
      .filter(t => t.status !== "complete" && t.start_date)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (incomplete.length > 0) nextTasks.push({ task: incomplete[0], project: p });
  }
  nextTasks.sort((a, b) => a.task.start_date.localeCompare(b.task.start_date));

  if (nextTasks.length === 0) {
    const msg = el("div", "", "No upcoming tasks");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); padding:var(--space-2) 0;";
    body.appendChild(msg);
  } else {
    for (const { task, project } of nextTasks.slice(0, 6)) {
      const row = el("div", "");
      row.style.cssText = "display:flex; flex-direction:column; gap:2px; padding:var(--space-2) 0; border-bottom:1px solid var(--border);";
      const taskName = el("span", "truncate");
      taskName.style.cssText = "font-size:var(--font-size-sm); font-weight:500; color:var(--text-primary);";
      taskName.textContent = task.name;
      const dot = el("span", "");
      dot.style.cssText = "display:inline-block; width:7px; height:7px; border-radius:50%; background:" + project.colour + "; margin-right:4px;";
      const meta = el("span", "");
      meta.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted); display:flex; align-items:center;";
      meta.appendChild(dot);
      meta.appendChild(document.createTextNode(project.name + " · " + formatDateShort(task.start_date)));
      row.appendChild(taskName);
      row.appendChild(meta);
      body.appendChild(row);
    }
  }

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function _buildOverduePendingPanel(projects) {
  const panel = el("div", "card");
  const header = el("div", "card__header");
  header.style.padding = "var(--space-3) var(--space-4)";
  const title = el("span", "section-title", "⚠ Chase Required");
  title.style.color = "#f59e0b";
  header.appendChild(title);

  const body = el("div", "");
  body.style.cssText = "padding:0 var(--space-4) var(--space-3);";

  const overduePending = [];
  for (const p of projects) {
    for (const t of (p.tasks || [])) {
      if (t.status === "pending" && t.pending_until && t.pending_until < new Date().toISOString().slice(0, 10)) {
        overduePending.push({ task: t, project: p });
      }
    }
  }

  if (overduePending.length === 0) {
    const msg = el("div", "", "No pending tasks overdue ✓");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--status-complete-text); padding:var(--space-2) 0;";
    body.appendChild(msg);
  } else {
    for (const { task, project } of overduePending.slice(0, 8)) {
      const row = el("div", "");
      row.style.cssText = [
        "display:flex; flex-direction:column; gap:2px;",
        "padding:var(--space-2) var(--space-1);",
        "border-bottom:1px solid var(--border);",
        "cursor:pointer; border-radius:var(--radius-sm);",
        "transition:background var(--transition-fast);",
      ].join("");
      row.title = "Click to open task";
      row.addEventListener("mouseenter", () => { row.style.background = "var(--grey-100)"; });
      row.addEventListener("mouseleave", () => { row.style.background = ""; });
      row.addEventListener("click", () => {
        openTaskForm(task, task.project_id, async (saved) => {
          // Re-render dashboard to reflect any status change
          const updated = await API.listProjects();
          State.setProjects(updated);
        });
      });

      const taskName = el("span", "truncate");
      taskName.style.cssText = "font-size:var(--font-size-sm); font-weight:500; color:var(--text-primary);";
      taskName.textContent = "⚠ " + task.name;
      const meta = el("span", "");
      meta.style.cssText = "font-size:var(--font-size-xs); color:#f59e0b;";
      meta.textContent = project.name + " · expected " + formatDateShort(task.pending_until);
      row.appendChild(taskName);
      row.appendChild(meta);
      body.appendChild(row);
    }
  }

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

function _buildPeoplePanel() {
  const people = State.getPeople();
  const panel = el("div", "card");
  const header = el("div", "card__header");
  header.style.padding = "var(--space-3) var(--space-4)";
  header.appendChild(el("span", "section-title", "👤 People"));

  const body = el("div", "");
  body.style.cssText = "padding:0 var(--space-4) var(--space-3);";

  if (people.length === 0) {
    const msg = el("div", "", "No people added yet");
    msg.style.cssText = "font-size:var(--font-size-sm); color:var(--text-muted); padding:var(--space-2) 0;";
    body.appendChild(msg);
  } else {
    for (const person of people) {
      const row = el("div", "");
      row.style.cssText = "display:flex; align-items:center; gap:var(--space-2); padding:var(--space-2) 0; border-bottom:1px solid var(--border);";
      const avatar = el("div", "avatar avatar--sm");
      avatar.style.background = person.colour || "#8892a4";
      avatar.textContent = initials(person.name);
      const nameEl = el("span", "truncate");
      nameEl.style.cssText = "font-size:var(--font-size-sm); color:var(--text-primary); flex:1;";
      nameEl.textContent = person.name;
      const roleEl = el("span", "");
      roleEl.style.cssText = "font-size:var(--font-size-xs); color:var(--text-muted);";
      roleEl.textContent = person.role || "";
      row.appendChild(avatar);
      row.appendChild(nameEl);
      row.appendChild(roleEl);
      body.appendChild(row);
    }
  }

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}
