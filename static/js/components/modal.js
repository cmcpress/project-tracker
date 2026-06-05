/**
 * components/modal.js — Generic reusable modal component.
 *
 * Usage:
 *   const m = createModal({ title: "Edit Task", wide: false });
 *   m.setBody(myFormElement);
 *   m.setFooter(okBtn, cancelBtn);
 *   m.open();
 *   m.close();
 *
 * Only one modal can be open at a time. The overlay is appended to
 * document.body and removed on close.
 */

/** @type {HTMLElement|null} The currently open overlay element */
let _activeOverlay = null;

/**
 * Create and return a modal controller object.
 *
 * @param {object} options
 * @param {string} options.title  - Modal heading text
 * @param {boolean} [options.wide] - Use the wider modal variant
 * @param {Function} [options.onClose] - Called when the modal is closed
 * @returns {{ open: Function, close: Function, setBody: Function, setFooter: Function, getBody: Function }}
 */
export function createModal({ title, wide = false, xl = false, onClose } = {}) {
  let _overlay = null;
  let _modal = null;
  let _bodyEl = null;
  let _footerEl = null;

  function _build() {
    // Overlay
    _overlay = document.createElement("div");
    _overlay.className = "modal-overlay";
    _overlay.setAttribute("role", "dialog");
    _overlay.setAttribute("aria-modal", "true");
    _overlay.setAttribute("aria-label", title || "Dialog");

    // Modal box
    _modal = document.createElement("div");
    _modal.className = xl ? "modal modal--xl" : wide ? "modal modal--wide" : "modal";

    // Header
    const header = document.createElement("div");
    header.className = "modal__header";

    const titleEl = document.createElement("h2");
    titleEl.className = "modal__title";
    titleEl.textContent = title || "";

    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__close btn btn--ghost btn--icon";
    closeBtn.setAttribute("aria-label", "Close dialog");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", close);

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    // Body
    _bodyEl = document.createElement("div");
    _bodyEl.className = "modal__body";

    // Footer
    _footerEl = document.createElement("div");
    _footerEl.className = "modal__footer";

    _modal.appendChild(header);
    _modal.appendChild(_bodyEl);
    _modal.appendChild(_footerEl);
    _overlay.appendChild(_modal);

    // Intentionally no backdrop-click-to-close: accidental clicks outside
    // the modal would discard partially entered data.

    // Close on Escape key
    _overlay._escHandler = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", _overlay._escHandler);
  }

  /**
   * Open the modal. Closes any previously open modal first.
   */
  function open() {
    if (_activeOverlay) {
      // Close the previous modal cleanly
      _activeOverlay.remove();
      _activeOverlay = null;
    }

    if (!_overlay) _build();

    document.body.appendChild(_overlay);
    _activeOverlay = _overlay;

    // Focus trap: focus the first focusable element
    requestAnimationFrame(() => {
      const focusable = _modal.querySelector(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable) focusable.focus();
    });
  }

  /**
   * Close and remove the modal from the DOM.
   */
  function close() {
    if (_overlay && _overlay.parentNode) {
      document.removeEventListener("keydown", _overlay._escHandler);
      _overlay.remove();
      if (_activeOverlay === _overlay) _activeOverlay = null;
    }
    if (typeof onClose === "function") onClose();
  }

  /**
   * Replace the modal body content.
   * @param {HTMLElement|string} content
   */
  function setBody(content) {
    if (!_bodyEl) _build();
    if (typeof content === "string") {
      _bodyEl.innerHTML = content;
    } else {
      _bodyEl.replaceChildren(content);
    }
  }

  /**
   * Replace the modal footer content.
   * @param {...HTMLElement} buttons
   */
  function setFooter(...buttons) {
    if (!_footerEl) _build();
    _footerEl.replaceChildren(...buttons);
  }

  /**
   * Access the body element directly (e.g. to read form values).
   * @returns {HTMLElement}
   */
  function getBody() {
    if (!_bodyEl) _build();
    return _bodyEl;
  }

  /**
   * Update the modal title after creation.
   * @param {string} newTitle
   */
  function setTitle(newTitle) {
    if (!_modal) _build();
    const titleEl = _modal.querySelector(".modal__title");
    if (titleEl) titleEl.textContent = newTitle;
  }

  /**
   * Append a button to the modal footer.
   * @param {string}   label     - Button text
   * @param {string}   className - Extra CSS class(es), e.g. "btn--primary"
   * @param {Function} onClick   - Click handler
   * @returns {HTMLButtonElement}
   */
  function addButton(label, className, onClick) {
    if (!_footerEl) _build();
    const btn = document.createElement("button");
    btn.className = "btn " + className;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    _footerEl.appendChild(btn);
    return btn;
  }

  return { open, close, setBody, setFooter, getBody, setTitle, addButton };
}

/**
 * Close the currently active modal, if any.
 */
export function closeActiveModal() {
  if (_activeOverlay) {
    _activeOverlay.remove();
    _activeOverlay = null;
  }
}
