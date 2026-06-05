/**
 * toast.js — Lightweight toast notification system.
 *
 * Appends dismissible toast messages to the #toast-container element.
 * Auto-dismisses after a configurable duration.
 */

const DEFAULT_DURATION_MS = 3500;

/**
 * Show a toast notification.
 *
 * @param {string} message          - The message to display
 * @param {'success'|'error'|'info'} [type='info'] - Visual style
 * @param {number} [duration]       - Auto-dismiss delay in ms (0 = no auto-dismiss)
 */
export function showToast(message, type = "info", duration = DEFAULT_DURATION_MS) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;

  // Click to dismiss early
  toast.addEventListener("click", () => dismiss(toast));

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismiss(toast), duration);
  }
}

/**
 * Remove a toast element with a brief fade-out.
 * @param {HTMLElement} toast
 */
function dismiss(toast) {
  if (!toast.parentNode) return;
  toast.style.transition = "opacity 200ms ease";
  toast.style.opacity = "0";
  setTimeout(() => toast.remove(), 200);
}
