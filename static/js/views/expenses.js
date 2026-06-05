/**
 * views/expenses.js — Expenses view: full-page breakdown of project spend.
 *
 * Shows a project picker, a spend-vs-budget summary card, then a
 * per-task list of expense/component items with individual amounts.
 *
 * Implements the view interface: init(container), render(), destroy()
 */

import * as API from "../api.js";
import * as State from "../state.js";
import { el, clearChildren, formatDateShort } from "../utils.js";

let _container       = null;
let _filterProjectId = null;   // which project is being viewed
let _allProjects     = [];

// ---------------------------------------------------------------------------
// View lifecycle
// ---------------------------------------------------------------------------

export async function init(container) {
  _container = container;

  _allProjects = State.getProjects();
  // Pick up the sidebar project selection — initProjectFilter re-inits this
  // view whenever activeProjectId changes, so no internal subscription needed.
  _filterProjectId = State.getActiveProjectId() || null;

  await _render();
}

export async function render() {
  _allProjects = State.getProjects();
  await _render();
}

export function destroy() {
  if (_container) _container.style.cssText = "";
  _filterProjectId = null;
  _allProjects     = [];
  _container       = null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function _render() {
  if (!_container) return;
  clearChildren(_container);

  // ── Filter bar ────────────────────────────────────────────────────────────
  const bar = el("div", "table-filters");
  bar.style.marginBottom = "0";

  const projSel = document.createElement("select");
  projSel.className = "table-filter-select";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a project…";
  if (!_filterProjectId) placeholder.selected = true;
  projSel.appendChild(placeholder);

  _allProjects.forEach(p => {
    const o = document.createElement("option");
    o.value = String(p.id);
    o.textContent = p.name;
    if (p.id === _filterProjectId) o.selected = true;
    projSel.appendChild(o);
  });

  projSel.addEventListener("change", () => {
    _filterProjectId = projSel.value ? parseInt(projSel.value, 10) : null;
    _renderContent();
  });

  bar.appendChild(projSel);
  _container.appendChild(bar);

  // ── Content area ──────────────────────────────────────────────────────────
  const content = el("div", "");
  content.setAttribute("data-expenses-content", "");
  content.style.cssText = "padding:var(--space-4);max-width:800px;";
  _container.appendChild(content);

  await _renderContent();
}

async function _renderContent() {
  const content = _container && _container.querySelector("[data-expenses-content]");
  if (!content) return;

  if (!_filterProjectId) {
    content.innerHTML = `
      <div class="empty-state" style="margin-top:var(--space-8);">
        <div class="empty-state__title">No project selected</div>
        <div class="empty-state__body">Choose a project above to see its expense breakdown.</div>
      </div>`;
    return;
  }

  // Loading spinner
  content.innerHTML = `<div class="empty-state" style="margin-top:var(--space-6);"><div class="spinner"></div></div>`;

  try {
    const data = await API.getProjectExpenses(_filterProjectId);
    clearChildren(content);

    if (!data.tasks || data.tasks.length === 0) {
      content.innerHTML = `
        <div class="empty-state" style="margin-top:var(--space-8);">
          <div class="empty-state__title">No expenses recorded</div>
          <div class="empty-state__body">Add expense or component items to tasks using the task editor to track spend here.</div>
        </div>`;
      return;
    }

    const sym = data.currency_symbol || "£";
    const fmt = (n) => sym + Number(n || 0).toLocaleString("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    // ── Summary card ─────────────────────────────────────────────────────────
    const summary = el("div", "card");
    summary.style.cssText = "margin-bottom:var(--space-5);padding:var(--space-4) var(--space-5);";

    const summaryTitle = el("div", "");
    summaryTitle.style.cssText = "font-size:var(--font-size-sm);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-3);";
    summaryTitle.textContent = "Summary — " + data.project_name;
    summary.appendChild(summaryTitle);

    const summaryRow = el("div", "");
    summaryRow.style.cssText = "display:flex;gap:var(--space-6);flex-wrap:wrap;";

    const totalBudget = data.total_budget || 0;
    const totalSpend  = data.total_spend  || 0;
    const remaining   = totalBudget - totalSpend;
    const spendPct    = totalBudget > 0 ? Math.min(100, (totalSpend / totalBudget) * 100) : 0;
    const overBudget  = totalBudget > 0 && totalSpend > totalBudget;

    const statItems = [
      { label: "Total spend", value: fmt(totalSpend),  highlight: overBudget ? "#ef4444" : null },
      { label: "Budget",      value: fmt(totalBudget), highlight: null },
      { label: totalBudget > 0 ? (overBudget ? "Over budget" : "Remaining") : "Remaining",
        value: overBudget ? fmt(Math.abs(remaining)) : fmt(remaining),
        highlight: overBudget ? "#ef4444" : remaining > 0 ? "#22c55e" : null },
    ];

    statItems.forEach(({ label, value, highlight }) => {
      const stat = el("div", "");
      stat.style.cssText = "display:flex;flex-direction:column;gap:4px;";
      const valEl = el("span", "");
      valEl.style.cssText = `font-size:1.5rem;font-weight:700;color:${highlight || "var(--text-primary)"};line-height:1;`;
      valEl.textContent = value;
      const lblEl = el("span", "");
      lblEl.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);";
      lblEl.textContent = label;
      stat.appendChild(valEl);
      stat.appendChild(lblEl);
      summaryRow.appendChild(stat);
    });

    summary.appendChild(summaryRow);

    // Spend progress bar (only if there's a budget)
    if (totalBudget > 0) {
      const barWrap = el("div", "");
      barWrap.style.cssText = "margin-top:var(--space-4);";
      const track = el("div", "progress-bar");
      track.style.cssText = "height:8px;background:var(--grey-200);border-radius:4px;overflow:hidden;width:100%;";
      const fill = el("div", "");
      fill.style.cssText = `height:100%;width:${spendPct}%;background:${overBudget ? "#ef4444" : "#4a90e2"};border-radius:4px;transition:width 0.4s ease;`;
      track.appendChild(fill);
      const pctLabel = el("div", "");
      pctLabel.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:var(--space-1);";
      pctLabel.textContent = `${spendPct.toFixed(1)}% of budget spent`;
      barWrap.appendChild(track);
      barWrap.appendChild(pctLabel);
      summary.appendChild(barWrap);
    }

    content.appendChild(summary);

    // ── Effort summary (only if any hours have been recorded) ─────────────────
    const totalEst = data.total_est_hours || 0;
    const totalLog = data.total_log_hours || 0;
    if (totalEst > 0 || totalLog > 0) {
      const effortCard = el("div", "card");
      effortCard.style.cssText = "margin-bottom:var(--space-5);padding:var(--space-4) var(--space-5);";

      const effortTitle = el("div", "");
      effortTitle.style.cssText = "font-size:var(--font-size-sm);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-3);";
      effortTitle.textContent = "Effort";
      effortCard.appendChild(effortTitle);

      const effortRow = el("div", "");
      effortRow.style.cssText = "display:flex;gap:var(--space-6);flex-wrap:wrap;align-items:flex-end;";

      const fmtH = (h) => h % 1 === 0 ? h + "h" : h.toFixed(1) + "h";
      const overlogged = totalEst > 0 && totalLog > totalEst;

      [
        { label: "Estimated", value: fmtH(totalEst), color: null },
        { label: "Logged",    value: fmtH(totalLog), color: overlogged ? "#ef4444" : totalLog > 0 ? "#22c55e" : null },
        { label: totalEst > 0 ? (overlogged ? "Over by" : "Remaining") : "Remaining",
          value: totalEst > 0 ? fmtH(Math.abs(totalEst - totalLog)) : "—",
          color: overlogged ? "#ef4444" : totalEst > 0 && totalLog < totalEst ? "#22c55e" : null },
      ].forEach(({ label, value, color }) => {
        const stat = el("div", "");
        stat.style.cssText = "display:flex;flex-direction:column;gap:4px;";
        const valEl = el("span", "");
        valEl.style.cssText = `font-size:1.5rem;font-weight:700;color:${color || "var(--text-primary)"};line-height:1;`;
        valEl.textContent = value;
        const lblEl = el("span", "");
        lblEl.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);";
        lblEl.textContent = label;
        stat.appendChild(valEl);
        stat.appendChild(lblEl);
        effortRow.appendChild(stat);
      });

      // Progress bar (logged vs estimated)
      if (totalEst > 0) {
        const pct = Math.min(100, (totalLog / totalEst) * 100);
        const barWrap = el("div", "");
        barWrap.style.cssText = "margin-top:var(--space-3);";
        const track = el("div", "");
        track.style.cssText = "height:6px;background:var(--grey-200);border-radius:3px;overflow:hidden;";
        const fill = el("div", "");
        fill.style.cssText = `height:100%;width:${pct}%;background:${overlogged ? "#ef4444" : "var(--blue)"};border-radius:3px;transition:width var(--transition-fast);`;
        track.appendChild(fill);
        const pctLabel = el("div", "");
        pctLabel.style.cssText = "font-size:var(--font-size-xs);color:var(--text-muted);margin-top:var(--space-1);";
        pctLabel.textContent = `${pct.toFixed(1)}% of estimated hours logged`;
        barWrap.appendChild(track);
        barWrap.appendChild(pctLabel);
        effortCard.appendChild(effortRow);
        effortCard.appendChild(barWrap);
      } else {
        effortCard.appendChild(effortRow);
      }

      content.appendChild(effortCard);
    }

    // ── Per-task table ────────────────────────────────────────────────────────
    const tableWrap = el("div", "card");
    tableWrap.style.padding = "0";
    tableWrap.style.overflow = "hidden";

    const tableHeader = el("div", "");
    tableHeader.style.cssText = [
      "display:grid;",
      "grid-template-columns:2fr 1fr 1fr;",
      "gap:0;",
      "padding:var(--space-2) var(--space-4);",
      "background:var(--grey-50);",
      "border-bottom:1px solid var(--border);",
      "font-size:var(--font-size-xs);",
      "font-weight:600;",
      "color:var(--text-muted);",
      "text-transform:uppercase;",
      "letter-spacing:0.05em;",
    ].join("");

    ["Item", "Type", "Amount"].forEach((h, i) => {
      const hEl = el("span", "");
      hEl.textContent = h;
      if (i > 0) hEl.style.textAlign = "right";
      tableHeader.appendChild(hEl);
    });

    tableWrap.appendChild(tableHeader);

    data.tasks.forEach((task, tIdx) => {
      // Task group header row
      const taskRow = el("div", "");
      taskRow.style.cssText = [
        "display:grid;",
        "grid-template-columns:2fr 1fr 1fr;",
        "padding:var(--space-3) var(--space-4);",
        "background:var(--grey-50);",
        "border-bottom:1px solid var(--border);",
        tIdx > 0 ? "border-top:2px solid var(--border);" : "",
      ].join("");

      const taskNameEl = el("span", "truncate");
      taskNameEl.style.cssText = "font-weight:600;font-size:var(--font-size-sm);color:var(--text-primary);";
      taskNameEl.textContent = (task.wbs_number ? task.wbs_number + "  " : "") + task.task_name;
      taskNameEl.title = task.task_name;

      const taskTypeEl = el("span", "");
      // empty — this is the task row, not an item row

      const taskSpendEl = el("span", "");
      taskSpendEl.style.cssText = "font-weight:600;font-size:var(--font-size-sm);color:var(--text-primary);text-align:right;";
      taskSpendEl.textContent = fmt(task.task_spend);

      taskRow.appendChild(taskNameEl);
      taskRow.appendChild(taskTypeEl);
      taskRow.appendChild(taskSpendEl);
      tableWrap.appendChild(taskRow);

      // Item rows
      task.items.forEach((item, iIdx) => {
        const itemRow = el("div", "");
        const isLast = iIdx === task.items.length - 1;
        itemRow.style.cssText = [
          "display:grid;",
          "grid-template-columns:2fr 1fr 1fr;",
          "padding:var(--space-2) var(--space-4) var(--space-2) calc(var(--space-4) + var(--space-4));",
          "font-size:var(--font-size-sm);",
          !isLast ? "border-bottom:1px solid var(--border);" : "",
        ].join("");

        const nameEl = el("span", "truncate");
        nameEl.style.cssText = "color:var(--text-secondary);";
        nameEl.textContent = item.content || "—";
        nameEl.title = item.content || "";

        const typeEl = el("span", "");
        typeEl.style.cssText = "color:var(--text-muted);font-size:var(--font-size-xs);align-self:center;text-transform:capitalize;";
        typeEl.textContent = item.item_type || "";

        const valEl = el("span", "");
        valEl.style.cssText = "color:var(--text-primary);font-weight:500;text-align:right;";
        valEl.textContent = fmt(item.value);

        itemRow.appendChild(nameEl);
        itemRow.appendChild(typeEl);
        itemRow.appendChild(valEl);
        tableWrap.appendChild(itemRow);
      });
    });

    // Totals footer
    const footer = el("div", "");
    footer.style.cssText = [
      "display:grid;",
      "grid-template-columns:2fr 1fr 1fr;",
      "padding:var(--space-3) var(--space-4);",
      "background:var(--grey-100);",
      "border-top:2px solid var(--border);",
      "font-size:var(--font-size-sm);",
      "font-weight:700;",
    ].join("");

    const footLabel = el("span", "");
    footLabel.textContent = "Total";
    footLabel.style.color = "var(--text-primary)";

    const footEmpty = el("span", "");

    const footTotal = el("span", "");
    footTotal.style.cssText = "text-align:right;color:var(--text-primary);";
    footTotal.textContent = fmt(totalSpend);

    footer.appendChild(footLabel);
    footer.appendChild(footEmpty);
    footer.appendChild(footTotal);
    tableWrap.appendChild(footer);

    content.appendChild(tableWrap);

  } catch (e) {
    console.error("[expenses] Load failed:", e);
    if (_container) {
      const content2 = _container.querySelector("[data-expenses-content]");
      if (content2) content2.innerHTML = `
        <div class="empty-state" style="margin-top:var(--space-6);">
          <div class="empty-state__title">Failed to load expenses</div>
          <div class="empty-state__body">${e.message}</div>
        </div>`;
    }
  }
}
