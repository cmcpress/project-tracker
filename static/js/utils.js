/**
 * utils.js — Shared utility functions: dates, colours, DOM helpers, formatting.
 * No imports from other app modules — this is a pure utility layer.
 */

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO date string (YYYY-MM-DD) into a human-readable form.
 * Returns "" for null/undefined.
 * @param {string|null} iso - ISO date string
 * @param {object} [opts]   - Intl.DateTimeFormat options
 * @returns {string}
 */
export function formatDate(iso, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!iso) return "";
  try {
    const date = new Date(`${iso}T00:00:00`);
    return new Intl.DateTimeFormat("en-GB", opts).format(date);
  } catch {
    return iso;
  }
}

/**
 * Format an ISO date string as "Apr 1" (short month + day, no year).
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDateShort(iso) {
  return formatDate(iso, { day: "numeric", month: "short" });
}

/**
 * Return today's date as a YYYY-MM-DD string.
 * @returns {string}
 */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Return true if an ISO date string is strictly in the past (before today).
 * @param {string|null} iso
 * @returns {boolean}
 */
export function isOverdue(iso) {
  if (!iso) return false;
  return iso < today();
}

/**
 * Calculate the number of calendar days between two ISO date strings.
 * Returns null if either date is missing.
 * @param {string} startIso
 * @param {string} endIso
 * @returns {number|null}
 */
export function daysBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(`${endIso}T00:00:00`) - new Date(`${startIso}T00:00:00`);
  return Math.round(ms / 86400000) + 1;  // inclusive
}

/**
 * Parse a YYYY-MM-DD string into a Date object (at midnight local time).
 * @param {string} iso
 * @returns {Date}
 */
export function parseDate(iso) {
  return new Date(`${iso}T00:00:00`);
}

// ---------------------------------------------------------------------------
// Colour utilities
// ---------------------------------------------------------------------------

/**
 * Convert a hex colour string to an RGBA string with the given alpha.
 * Supports both #rrggbb and #rgb forms.
 * @param {string} hex   - e.g. "#4a90e2"
 * @param {number} alpha - 0–1
 * @returns {string}     - e.g. "rgba(74, 144, 226, 0.2)"
 */
export function hexToRgba(hex, alpha = 1) {
  const clean = hex.replace("#", "");
  const expanded = clean.length === 3
    ? clean.split("").map(c => c + c).join("")
    : clean;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Return the initials of a person's name (up to 2 characters).
 * "Simeon Aston" → "SA", "Jeremy" → "J"
 * @param {string} name
 * @returns {string}
 */
export function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// RAG status helpers
// ---------------------------------------------------------------------------

/** Colour map for RAG values. */
export const RAG_COLORS = { red: "#ef4444", amber: "#f59e0b", green: "#22c55e" };

/** Human-readable labels for RAG values. */
export const RAG_TITLES = { red: "Off track (Red)", amber: "At risk (Amber)", green: "On track (Green)" };

/**
 * Compute the effective RAG status for a task, applying automatic date rules:
 *
 *   • Completed tasks  → stored rag, never auto-overridden
 *   • Overdue tasks    → "red"   (end_date is before today)
 *   • Due ≤ 7 days     → "amber" (unless stored value is already "red")
 *   • Otherwise        → stored task.rag value (may be null)
 *
 * This is display-only — the database value is never changed.
 *
 * @param {object} task  Task with .end_date, .status, .rag fields
 * @returns {"red"|"amber"|"green"|null}
 */
export function effectiveRag(task) {
  if (task.status === "complete") return task.rag || null;

  if (task.end_date) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const end = new Date(`${task.end_date}T00:00:00`);
    const diffDays = Math.floor((end - now) / 86_400_000);

    if (diffDays < 0)  return "red";                           // overdue
    if (diffDays <= 7 && task.rag !== "red") return "amber";   // at risk (never downgrade red)
  }

  return task.rag || null;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/** Canonical status labels for display. */
const STATUS_LABELS = {
  "not-started": "Not Started",
  "planning":    "Planning",
  "in-progress": "In Progress",
  "blocked":     "Blocked",
  "pending":     "Pending",
  "complete":    "Complete",
};

/**
 * Convert a status slug to a display label.
 * @param {string} status
 * @returns {string}
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

/**
 * Return the CSS class suffix for a status badge.
 * @param {string} status
 * @returns {string}  e.g. "not-started" → "not-started"
 */
export function statusClass(status) {
  return status || "not-started";
}

/**
 * Return true if a task is pending and has passed its expected date.
 * @param {object} task - Task with .status and .pending_until fields
 * @returns {boolean}
 */
export function isPendingOverdue(task) {
  if (task.status !== "pending") return false;
  if (!task.pending_until) return false;
  return task.pending_until < today();
}

/**
 * Return the pending visual indicator for a task:
 *   "⚠"  — pending and past the expected date (needs chasing)
 *   "💤" — pending but still within the expected date window
 *   null  — not a pending task
 * @param {object} task
 * @returns {string|null}
 */
export function pendingIndicator(task) {
  if (task.status !== "pending") return null;
  return isPendingOverdue(task) ? "⚠" : "💤";
}

/** Canonical task type labels. */
const TYPE_LABELS = {
  task:      "Task",
  group:     "Group",
  milestone: "Milestone",
  phase:     "Phase",
};

/**
 * @param {string} type
 * @returns {string}
 */
export function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

/**
 * Unicode icon for a task type.
 * @param {string} type
 * @returns {string}
 */
export function typeIcon(type) {
  if (type === "milestone") return "◆";
  if (type === "phase")     return "▬";
  if (type === "group")     return "▸";
  return "●";
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element with optional className and text content.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function el(tag, className, text) {
  const elem = document.createElement(tag);
  if (className) elem.className = className;
  if (text !== undefined) elem.textContent = text;
  return elem;
}

/**
 * Remove all children from a DOM node.
 * @param {HTMLElement} node
 */
export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Find element by ID — throws if not found (helps surface wiring bugs early).
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const elem = document.getElementById(id);
  if (!elem) throw new Error(`Element #${id} not found in DOM`);
  return elem;
}

/**
 * Create and return an SVG element with the given tag name.
 * @param {string} tag
 * @returns {SVGElement}
 */
export function svgEl(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in days as a compact string.
 * @param {number|null} days
 * @returns {string}
 */
export function formatDuration(days) {
  if (days === null || days === undefined) return "—";
  if (days === 1) return "1d";
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  if (rem === 0) return `${weeks}w`;
  return `${weeks}w ${rem}d`;
}

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay - ms
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
