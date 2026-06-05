/**
 * components/context-menu.js — Right-click context menu component.
 *
 * Usage:
 *   showContextMenu(event, [
 *     { label: "Edit",          action: () => openEdit() },
 *     { label: "Mark complete", action: () => markDone() },
 *     { type: "divider" },
 *     { label: "Delete",        action: () => del(), danger: true },
 *   ]);
 *
 * Only one context menu can be open at a time. The menu is appended to
 * document.body and removed when the user clicks anywhere or presses Escape.
 * Position is adjusted automatically so it never overflows the viewport.
 */

/** @type {HTMLElement|null} */
let _activeMenu = null;

/**
 * Show a context menu at the position of a mouse event.
 *
 * @param {MouseEvent} event  - The contextmenu event that triggered this call
 * @param {Array}      items  - Menu item descriptors:
 *   { label: string, action: Function, danger?: boolean }
 *   { type: "divider" }
 */
export function showContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();

  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  for (const item of items) {
    if (item.type === "divider") {
      menu.appendChild(document.createElement("div")).className = "context-menu__divider";
      continue;
    }

    const btn = document.createElement("div");
    btn.className = item.danger
      ? "context-menu__item context-menu__item--danger"
      : "context-menu__item";
    btn.setAttribute("role", "menuitem");
    btn.tabIndex = 0;
    btn.textContent = item.label;

    if (item.icon) {
      btn.textContent = "";
      const iconSpan = document.createElement("span");
      iconSpan.textContent = item.icon;
      iconSpan.style.cssText = "width:16px; text-align:center; flex-shrink:0;";
      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label;
      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      if (typeof item.action === "function") item.action();
    });

    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        btn.click();
      }
    });

    menu.appendChild(btn);
  }

  // Initial render off-screen to measure dimensions
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);

  // Position: default to mouse coordinates, nudge if it would overflow viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;

  let x = event.clientX;
  let y = event.clientY;

  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  if (x < 8) x = 8;
  if (y < 8) y = 8;

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.visibility = "";

  _activeMenu = menu;

  // Close on any click outside
  const onOutsideClick = (e) => {
    if (!menu.contains(e.target)) closeContextMenu();
  };

  // Close on Escape
  const onKeyDown = (e) => {
    if (e.key === "Escape") closeContextMenu();
  };

  // Use setTimeout so this listener doesn't catch the triggering click
  setTimeout(() => {
    document.addEventListener("click", onOutsideClick, { once: false });
    document.addEventListener("keydown", onKeyDown, { once: true });
    menu._cleanup = () => {
      document.removeEventListener("click", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, 0);

  // Focus first item
  const firstItem = menu.querySelector("[role=menuitem]");
  if (firstItem) firstItem.focus();
}

/**
 * Close the currently open context menu, if any.
 */
export function closeContextMenu() {
  if (_activeMenu) {
    if (typeof _activeMenu._cleanup === "function") _activeMenu._cleanup();
    _activeMenu.remove();
    _activeMenu = null;
  }
}
