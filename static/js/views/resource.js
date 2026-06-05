/**
 * views/resource.js — Resource view: SVG swimlane one row per person.
 *
 * Each assigned person gets a horizontal lane. Tasks they're assigned to
 * are drawn as colour-coded bars (coloured by project). Unassigned tasks
 * are NOT shown here — use Gantt for those.
 *
 * Toolbar: project filter + zoom (week / month / quarter)
 *
 * Implements the view interface: init(container), render(), destroy()
 */

import * as API   from "../api.js";
import * as State from "../state.js";
import { el, clearChildren, formatDateShort } from "../utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_H    = 44;     // px per person row
const HDR_H    = 48;     // px for date header
const LABEL_W  = 160;    // px for person name column
const PAD_DAYS = 7;
const MS_DAY   = 86_400_000;
const SVG_NS   = "http://www.w3.org/2000/svg";

const ZOOM_LEVELS = {
  week:    { dayPx: 28 },
  month:   { dayPx: 8  },
  quarter: { dayPx: 3  },
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _container = null;
let _zoom      = "month";
let _projectId = null;   // null = all
const _unsubs  = [];

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;
  _container.className = "main__content main__content--fill";
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

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function _loadAndRender() {
  if (!_container) return;
  _container.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  try {
    const projects = State.getProjects();
    _projectId = State.getActiveProjectId();
    const toShow = _projectId ? projects.filter(p => p.id === _projectId) : projects;

    if (toShow.length === 0) {
      _container.innerHTML = `<div class="empty-state">
        <div class="empty-state__icon">👥</div>
        <div class="empty-state__title">No projects</div>
        <div class="empty-state__body">Add a project to see resource allocation.</div>
      </div>`;
      return;
    }

    // Fetch full project data (includes tasks + assignees)
    const projectsData = await Promise.all(toShow.map(p => API.getProject(p.id)));

    // Build person → tasks mapping
    const personMap = new Map();   // personId → { person, tasks[] }

    for (const proj of projectsData) {
      for (const task of (proj.tasks || [])) {
        if (!task.assignees || task.assignees.length === 0) continue;
        if (!task.start_date && !task.end_date) continue;
        for (const assignee of task.assignees) {
          if (!personMap.has(assignee.id)) {
            personMap.set(assignee.id, {
              person: assignee,
              tasks: [],
            });
          }
          personMap.get(assignee.id).tasks.push({
            ...task,
            _projectColour: proj.colour || "#4a90e2",
            _projectName:   proj.name,
          });
        }
      }
    }

    if (personMap.size === 0) {
      _container.innerHTML = `<div class="empty-state">
        <div class="empty-state__icon">👤</div>
        <div class="empty-state__title">No assigned tasks</div>
        <div class="empty-state__body">Assign people to tasks with dates to see them here.</div>
      </div>`;
      return;
    }

    // Sort people alphabetically
    const rows = [...personMap.values()].sort((a, b) =>
      a.person.name.localeCompare(b.person.name)
    );

    _renderView(rows, projects);
  } catch (e) {
    console.error("[resource] Load failed:", e);
    if (_container) _container.innerHTML = `<div class="empty-state">
      <div class="empty-state__title">Failed to load</div>
      <div class="empty-state__body">${e.message}</div>
    </div>`;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function _renderView(rows, allProjects) {
  if (!_container) return;
  clearChildren(_container);

  const wrap = el("div", "");
  wrap.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;";

  wrap.appendChild(_buildToolbar(allProjects, rows));

  const chartWrap = el("div", "");
  chartWrap.style.cssText = "display:flex;flex:1;overflow:hidden;";

  // Labels panel (fixed left)
  const labelsPanel = el("div", "");
  labelsPanel.style.cssText = `
    width:${LABEL_W}px;
    flex-shrink:0;
    border-right:2px solid var(--border);
    background:var(--gantt-label-bg);
    display:flex;
    flex-direction:column;
    overflow:hidden;
  `;

  // Labels header spacer (matches HDR_H)
  const labelHdr = el("div", "");
  labelHdr.style.cssText = `
    height:${HDR_H}px;
    flex-shrink:0;
    border-bottom:2px solid var(--border);
    display:flex;
    align-items:center;
    padding:0 var(--space-3);
    font-size:var(--font-size-xs);
    font-weight:600;
    color:var(--text-muted);
    text-transform:uppercase;
    letter-spacing:0.04em;
  `;
  labelHdr.textContent = "Person";
  labelsPanel.appendChild(labelHdr);

  const labelBody = el("div", "");
  labelBody.style.cssText = "overflow:hidden;flex:1;";
  labelsPanel.appendChild(labelBody);

  // Chart scroll area
  const scrollArea = el("div", "");
  scrollArea.style.cssText = "flex:1;overflow:auto;";

  chartWrap.appendChild(labelsPanel);
  chartWrap.appendChild(scrollArea);
  wrap.appendChild(chartWrap);

  _container.appendChild(wrap);

  _buildChart(rows, labelBody, scrollArea);
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function _buildToolbar(allProjects, rows) {
  const bar = el("div", "gantt-toolbar");

  // Zoom controls
  const zoomGroup = el("div", "");
  zoomGroup.style.cssText = "display:flex;gap:4px;";
  for (const [key, _] of Object.entries(ZOOM_LEVELS)) {
    const btn = el("button", "btn btn--sm " + (_zoom === key ? "btn--primary" : "btn--secondary"), key.charAt(0).toUpperCase() + key.slice(1));
    btn.addEventListener("click", () => {
      _zoom = key;
      if (!_container) return;
      // Re-render chart without full reload
      const labelBody  = _container.querySelector("[data-resource-labels]");
      const scrollArea = _container.querySelector("[data-resource-scroll]");
      if (labelBody && scrollArea) _buildChart(rows, labelBody, scrollArea);
      // Update button states
      bar.querySelectorAll(".btn").forEach(b => {
        const isZoom = Object.keys(ZOOM_LEVELS).some(z => b.textContent.toLowerCase() === z);
        if (isZoom) {
          b.className = "btn btn--sm " + (b.textContent.toLowerCase() === key ? "btn--primary" : "btn--secondary");
        }
      });
    });
    zoomGroup.appendChild(btn);
  }

  bar.appendChild(zoomGroup);
  return bar;
}

// ---------------------------------------------------------------------------
// Chart (SVG)
// ---------------------------------------------------------------------------

function _buildChart(rows, labelBody, scrollArea) {
  // Tag for toolbar re-render
  labelBody.dataset.resourceLabels = "1";
  scrollArea.dataset.resourceScroll = "1";

  const dayPx = ZOOM_LEVELS[_zoom]?.dayPx || 8;

  // Compute date range across all tasks
  let minMs = Infinity, maxMs = -Infinity;
  for (const { tasks } of rows) {
    for (const t of tasks) {
      if (t.start_date) { const d = new Date(t.start_date); if (d) minMs = Math.min(minMs, d.getTime()); }
      if (t.end_date)   { const d = new Date(t.end_date);   if (d) maxMs = Math.max(maxMs, d.getTime()); }
    }
  }
  if (!isFinite(minMs) || !isFinite(maxMs)) return;

  const origin    = new Date(minMs - PAD_DAYS * MS_DAY);
  origin.setHours(0, 0, 0, 0);
  const totalDays = Math.ceil((maxMs - origin.getTime()) / MS_DAY) + PAD_DAYS + 1;
  const chartW    = totalDays * dayPx;
  const chartH    = rows.length * ROW_H;

  // ── Label rows ───────────────────────────────────────────────────────────
  clearChildren(labelBody);
  for (const { person } of rows) {
    const row = el("div", "");
    row.style.cssText = `
      height:${ROW_H}px;
      display:flex;
      align-items:center;
      padding:0 var(--space-3);
      gap:var(--space-2);
      border-bottom:1px solid var(--border);
      box-sizing:border-box;
      overflow:hidden;
    `;

    // Avatar dot
    const dot = el("span", "");
    dot.style.cssText = `
      width:24px;height:24px;border-radius:50%;flex-shrink:0;
      background:${person.colour || "#8892a4"};
      display:flex;align-items:center;justify-content:center;
      font-size:10px;font-weight:600;color:#fff;
    `;
    dot.textContent = _initials(person.name);

    const nameEl = el("span", "truncate");
    nameEl.style.cssText = "font-size:var(--font-size-sm);font-weight:500;color:var(--text-primary);";
    nameEl.textContent = person.name;
    nameEl.title = person.name;

    row.appendChild(dot);
    row.appendChild(nameEl);
    labelBody.appendChild(row);
  }

  // ── SVG chart ────────────────────────────────────────────────────────────
  clearChildren(scrollArea);

  const svgWrap = el("div", "");
  svgWrap.style.cssText = `width:${chartW}px;`;

  // Date header
  const hdrSvg = _svgEl(chartW, HDR_H);
  hdrSvg.style.cssText = `display:block;position:sticky;top:0;z-index:4;background:var(--gantt-label-bg);border-bottom:2px solid var(--border);`;
  _drawDateHeader(hdrSvg, origin, totalDays, dayPx, chartW);
  svgWrap.appendChild(hdrSvg);

  // Main SVG
  const mainSvg = _svgEl(chartW, chartH);
  mainSvg.style.display = "block";

  // Row backgrounds + grid lines
  for (let i = 0; i < rows.length; i++) {
    const bg = _svgRect(0, i * ROW_H, chartW, ROW_H,
      i % 2 ? "var(--gantt-row-alt)" : "var(--gantt-bg)");
    mainSvg.appendChild(bg);
  }

  // Today line
  const todayX = Math.round((Date.now() - origin.getTime()) / MS_DAY) * dayPx;
  if (todayX >= 0 && todayX <= chartW) {
    const todayLine = _svgEl2("line");
    todayLine.setAttribute("x1", todayX); todayLine.setAttribute("x2", todayX);
    todayLine.setAttribute("y1", 0);      todayLine.setAttribute("y2", chartH);
    todayLine.setAttribute("stroke", "#ef4444");
    todayLine.setAttribute("stroke-width", "1.5");
    todayLine.setAttribute("stroke-dasharray", "4 3");
    mainSvg.appendChild(todayLine);
  }

  // Task bars per person row
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const { tasks } = rows[rowIdx];
    const y0 = rowIdx * ROW_H;
    const barH  = 20;
    const barY  = y0 + (ROW_H - barH) / 2;

    for (const task of tasks) {
      if (!task.start_date && !task.end_date) continue;
      const s = task.start_date ? new Date(task.start_date) : new Date(task.end_date);
      const e = task.end_date   ? new Date(task.end_date)   : new Date(task.start_date);
      const x1 = Math.round((s.getTime() - origin.getTime()) / MS_DAY) * dayPx;
      const x2 = Math.round((e.getTime() - origin.getTime()) / MS_DAY) * dayPx + dayPx;
      const w  = Math.max(dayPx, x2 - x1);

      const bar = _svgEl2("rect");
      bar.setAttribute("x", x1);
      bar.setAttribute("y", barY);
      bar.setAttribute("width",  w);
      bar.setAttribute("height", barH);
      bar.setAttribute("rx", 3);
      bar.setAttribute("fill", task._projectColour || "#4a90e2");
      bar.setAttribute("opacity", task.status === "complete" ? "0.45" : "0.85");
      mainSvg.appendChild(bar);

      // Label text if wide enough
      if (w >= 36) {
        const lbl = _svgEl2("text");
        lbl.setAttribute("x", x1 + 5);
        lbl.setAttribute("y", barY + barH / 2 + 4);
        lbl.setAttribute("fill", "#fff");
        lbl.setAttribute("font-size", "10");
        lbl.setAttribute("font-family", "var(--font-sans)");
        lbl.setAttribute("clip-path", `inset(0 ${Math.max(0, x1 + w - chartW)}px 0 0)`);
        lbl.textContent = _truncate(task.name, Math.floor((w - 10) / 5.5));
        mainSvg.appendChild(lbl);
      }

      // Tooltip title
      const title = _svgEl2("title");
      title.textContent = `${task.name}\n${task._projectName}\n${formatDateShort(task.start_date)} – ${formatDateShort(task.end_date)}`;
      bar.appendChild(title);
    }
  }

  svgWrap.appendChild(mainSvg);
  scrollArea.appendChild(svgWrap);

  // Scroll today into view
  const todayOffset = todayX - scrollArea.clientWidth / 2;
  if (todayOffset > 0) scrollArea.scrollLeft = todayOffset;

  // Sync label scroll with chart scroll
  scrollArea.addEventListener("scroll", () => {
    labelBody.style.transform = `translateY(-${scrollArea.scrollTop}px)`;
  });
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

function _svgEl(w, h) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("width",  w);
  s.setAttribute("height", h);
  s.setAttribute("xmlns",  SVG_NS);
  return s;
}

function _svgEl2(tag) {
  return document.createElementNS(SVG_NS, tag);
}

function _svgRect(x, y, w, h, fill) {
  const r = _svgEl2("rect");
  r.setAttribute("x", x); r.setAttribute("y", y);
  r.setAttribute("width", w); r.setAttribute("height", h);
  r.setAttribute("fill", fill);
  return r;
}

function _drawDateHeader(svg, origin, totalDays, dayPx, chartW) {
  const TOP_H = 24;
  const BOT_H = HDR_H - TOP_H;

  svg.appendChild(_svgRect(0, 0, chartW, HDR_H, "var(--gantt-label-bg)"));

  // Months in top band
  let cur = new Date(origin);
  cur.setDate(1);
  while (true) {
    const x = Math.round((cur.getTime() - origin.getTime()) / MS_DAY) * dayPx;
    if (x > chartW) break;
    const lbl = _svgEl2("text");
    lbl.setAttribute("x", Math.max(4, x + 4));
    lbl.setAttribute("y", TOP_H - 7);
    lbl.setAttribute("fill", "var(--text-secondary)");
    lbl.setAttribute("font-size", "10");
    lbl.setAttribute("font-family", "var(--font-sans)");
    lbl.setAttribute("font-weight", "600");
    lbl.textContent = cur.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    svg.appendChild(lbl);

    const line = _svgEl2("line");
    line.setAttribute("x1", x); line.setAttribute("x2", x);
    line.setAttribute("y1", 0); line.setAttribute("y2", HDR_H);
    line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "1");
    svg.appendChild(line);

    cur.setMonth(cur.getMonth() + 1);
  }

  // Week ticks in bottom band (only for week/month zoom)
  if (dayPx >= 5) {
    let d = new Date(origin);
    // advance to Monday
    const dow = d.getDay() || 7;
    if (dow !== 1) d.setDate(d.getDate() + (8 - dow));
    while (true) {
      const x = Math.round((d.getTime() - origin.getTime()) / MS_DAY) * dayPx;
      if (x > chartW) break;
      const line = _svgEl2("line");
      line.setAttribute("x1", x); line.setAttribute("x2", x);
      line.setAttribute("y1", TOP_H); line.setAttribute("y2", HDR_H);
      line.setAttribute("stroke", "var(--border)"); line.setAttribute("stroke-width", "0.5");
      svg.appendChild(line);
      if (dayPx >= 14) {
        const lbl = _svgEl2("text");
        lbl.setAttribute("x", x + 2);
        lbl.setAttribute("y", HDR_H - 5);
        lbl.setAttribute("fill", "var(--text-muted)");
        lbl.setAttribute("font-size", "9");
        lbl.setAttribute("font-family", "var(--font-sans)");
        lbl.textContent = d.getDate();
        svg.appendChild(lbl);
      }
      d.setDate(d.getDate() + 7);
    }
  }

  // Divider line between top and bottom of header
  const div = _svgEl2("line");
  div.setAttribute("x1", 0); div.setAttribute("x2", chartW);
  div.setAttribute("y1", TOP_H); div.setAttribute("y2", TOP_H);
  div.setAttribute("stroke", "var(--border)"); div.setAttribute("stroke-width", "1");
  svg.appendChild(div);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _initials(name) {
  return (name || "?")
    .split(/\s+/)
    .map(w => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function _truncate(str, maxChars) {
  if (!str) return "";
  if (maxChars <= 0) return "";
  return str.length <= maxChars ? str : str.slice(0, maxChars - 1) + "…";
}
