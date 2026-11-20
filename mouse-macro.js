// ==UserScript==
// @name         Universal Mouse Macro Recorder & Player
// @namespace    local.mouse.macro
// @version      1.1.0
// @description  Record (Alt+R), play once (Alt+T), or loop indefinitely (Alt+Y) mouse macros across SPAs, Shadow DOM, Trusted Types sites (Google/YouTube), Canvas/WebGL, and custom UI engines with a rendered cursor.
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  // Run a single controller in the top-level frame; same-origin iframes are pierced dynamically.
  if (window.top !== window.self) {
    return;
  }

  // ============================================================================
  // 1. Constants & Utilities
  // ============================================================================

  const STORAGE_KEY = 'universal_mouse_macro_v1';
  const SYNTHETIC_POINTER_ID = 1;
  const MOVE_SAMPLE_MS_HOVER = 16;
  const MOVE_SAMPLE_MS_DRAG = 8;
  const MOVE_MIN_DIST_PX = 2;
  const MAX_DOM_DEPTH = 32;
  const MIN_LOOP_YIELD_MS = 16;

  const PAGE_WINDOW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  function assert(condition, message) {
    if (!condition) {
      throw new Error(`[MouseMacro] Assertion failed: ${message}`);
    }
  }

  function nowMs() {
    return performance.now();
  }

  function yieldMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function translateClientCoords(clientX, clientY, sourceWin) {
    let x = clientX;
    let y = clientY;
    let currentWin = sourceWin;
    let depth = 0;

    while (currentWin && currentWin !== PAGE_WINDOW && currentWin !== window) {
      assert(depth < MAX_DOM_DEPTH, 'Exceeded maximum iframe nesting depth');
      const frameEl = currentWin.frameElement;
      if (!frameEl) break;
      const rect = frameEl.getBoundingClientRect();
      x += rect.left + (frameEl.clientLeft || 0);
      y += rect.top + (frameEl.clientTop || 0);
      currentWin = currentWin.parent;
      depth += 1;
    }

    return { x, y };
  }

  // ============================================================================
  // 2. Macro Storage
  // ============================================================================

  let memoryMacroCache = null;

  function loadMacro() {
    try {
      const raw = GM_getValue(STORAGE_KEY, '');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && Array.isArray(parsed.events)) {
          memoryMacroCache = parsed;
          return parsed;
        }
      }
    } catch (err) {
      console.warn('[MouseMacro] Failed to read GM storage:', err);
    }
    return memoryMacroCache;
  }

  function saveMacro(macro) {
    assert(macro && macro.version === 1 && Array.isArray(macro.events), 'Invalid macro payload');
    memoryMacroCache = macro;
    try {
      GM_setValue(STORAGE_KEY, JSON.stringify(macro));
    } catch (err) {
      console.warn('[MouseMacro] Failed to write GM storage (kept in memory):', err);
    }
  }

  // ============================================================================
  // 3. Deep DOM, Shadow DOM & Same-Origin Iframe Resolution
  // ============================================================================

  function resolveTargetAtPoint(viewportX, viewportY) {
    assert(Number.isFinite(viewportX) && Number.isFinite(viewportY), 'Coordinates must be finite');

    let doc = document;
    let win = PAGE_WINDOW;
    let localX = viewportX;
    let localY = viewportY;
    let target = null;

    for (let depth = 0; depth < MAX_DOM_DEPTH; depth += 1) {
      let el = doc.elementFromPoint(localX, localY);
      if (!el) {
        target = doc.documentElement || doc.body;
        break;
      }

      // Pierce open Shadow DOM trees.
      while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
        const inner = el.shadowRoot.elementFromPoint(localX, localY);
        if (!inner || inner === el) break;
        el = inner;
      }

      // Pierce same-origin iframes/frames.
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let childDoc = null;
        let childWin = null;
        try {
          childDoc = el.contentDocument;
          childWin = el.contentWindow;
        } catch {
          childDoc = null;
          childWin = null;
        }

        if (childDoc && childWin) {
          const rect = el.getBoundingClientRect();
          localX -= rect.left + (el.clientLeft || 0);
          localY -= rect.top + (el.clientTop || 0);
          doc = childDoc;
          win = childWin;
          target = el;
          continue;
        }
      }

      target = el;
      break;
    }

    return {
      element: target || doc.documentElement || doc.body,
      doc,
      win,
      clientX: localX,
      clientY: localY,
    };
  }

  function getAncestorChain(node) {
    const chain = [];
    let current = node;
    while (current) {
      if (current.nodeType === 1) {
        chain.push(current);
      }
      if (current.parentNode) {
        current = current.parentNode;
      } else if (current.host) {
        current = current.host;
      } else {
        current = null;
      }
    }
    return chain;
  }

  function isElementFocusable(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (el.disabled) return false;

    const tag = el.tagName;
    if (tag === 'INPUT' && el.type === 'hidden') return false;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return true;
    if ((tag === 'A' || tag === 'AREA') && el.hasAttribute('href')) return true;
    if (tag === 'SUMMARY') return true;
    if (el.hasAttribute('tabindex')) {
      const parsed = Number.parseInt(el.getAttribute('tabindex'), 10);
      return Number.isFinite(parsed);
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function findFocusableAncestor(element) {
    let current = element;
    while (current) {
      if (current.nodeType === 1 && isElementFocusable(current)) {
        return current;
      }
      current = current.parentNode || current.host || null;
    }
    return null;
  }

  function findClosestInteractive(element) {
    let current = element;
    while (current) {
      if (current.nodeType === 1) {
        const tag = current.tagName;
        if (
          tag === 'A' ||
          tag === 'AREA' ||
          tag === 'BUTTON' ||
          tag === 'INPUT' ||
          tag === 'SUMMARY' ||
          tag === 'LABEL'
        ) {
          return current;
        }
      }
      current = current.parentNode || current.host || null;
    }
    return null;
  }

  function canScrollOnAxis(el, win, dx, dy) {
    const style = win.getComputedStyle(el);
    const canY =
      dy !== 0 &&
      (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight &&
      ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) ||
        (dy < 0 && el.scrollTop > 0));

    const canX =
      dx !== 0 &&
      (style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay') &&
      el.scrollWidth > el.clientWidth &&
      ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) ||
        (dx < 0 && el.scrollLeft > 0));

    return canX || canY;
  }

  function applyNativeWheelScroll(target, doc, win, evt) {
    let pxX = evt.deltaX;
    let pxY = evt.deltaY;
    if (evt.deltaMode === 1) {
      pxX *= 16;
      pxY *= 16;
    } else if (evt.deltaMode === 2) {
      pxX *= win.innerWidth || 800;
      pxY *= win.innerHeight || 600;
    }

    if (pxX === 0 && pxY === 0) return;

    let current = target;
    while (current) {
      if (current.nodeType === 1 && current !== doc.documentElement && current !== doc.body) {
        if (canScrollOnAxis(current, win, pxX, pxY)) {
          current.scrollBy({ left: pxX, top: pxY, behavior: 'instant' });
          return;
        }
      }
      current = current.parentNode || current.host || null;
    }

    const rootScroller = doc.scrollingElement || doc.documentElement || doc.body;
    if (rootScroller && typeof rootScroller.scrollBy === 'function') {
      rootScroller.scrollBy({ left: pxX, top: pxY, behavior: 'instant' });
    } else {
      win.scrollBy(pxX, pxY);
    }
  }

  // ============================================================================
  // 4. Isolated Overlay UI & Rendered Playback Cursor (Trusted Types Safe)
  // ============================================================================

  const OVERLAY_CSS = `
    * {
      box-sizing: border-box !important;
      pointer-events: none !important;
      user-select: none !important;
    }
    .layer {
      position: fixed;
      inset: 0;
      overflow: hidden;
    }
    .cursor {
      position: fixed;
      top: 0;
      left: 0;
      width: 28px;
      height: 28px;
      margin: 0;
      transform: translate3d(-100px, -100px, 0);
      opacity: 0;
      will-change: transform, opacity;
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
      transition: opacity 80ms linear;
    }
    .cursor.visible {
      opacity: 1;
    }
    .cursor.pressed svg {
      transform: scale(0.88);
      transform-origin: 2px 2px;
    }
    .cursor-dot {
      position: absolute;
      top: -3px;
      left: -3px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(56, 189, 248, 0.9);
      opacity: 0;
      transform: scale(0.6);
      transition: opacity 60ms linear, transform 60ms linear;
    }
    .cursor.pressed .cursor-dot {
      opacity: 1;
      transform: scale(1);
    }
    .ripple {
      position: fixed;
      top: 0;
      left: 0;
      width: 26px;
      height: 26px;
      margin-left: -13px;
      margin-top: -13px;
      border-radius: 50%;
      border: 2.5px solid #38bdf8;
      background: rgba(56, 189, 248, 0.18);
      animation: vm-macro-ripple 380ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .ripple.right {
      border-color: #f59e0b;
      background: rgba(245, 158, 11, 0.2);
    }
    .ripple.middle {
      border-color: #a855f7;
      background: rgba(168, 85, 247, 0.2);
    }
    .ripple.wheel {
      border-color: #22c55e;
      background: rgba(34, 197, 94, 0.14);
      width: 20px;
      height: 20px;
      margin-left: -10px;
      margin-top: -10px;
    }
    @keyframes vm-macro-ripple {
      0% {
        transform: scale(0.35);
        opacity: 0.95;
      }
      100% {
        transform: scale(1.85);
        opacity: 0;
      }
    }
    .badge {
      position: fixed;
      top: 14px;
      right: 14px;
      display: none;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.88);
      color: #f8fafc;
      font: 600 12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      letter-spacing: 0.01em;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(6px);
    }
    .badge.active {
      display: inline-flex;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
    }
    .badge.rec .badge-dot {
      background: #ef4444;
      animation: vm-macro-pulse 1s ease-in-out infinite;
    }
    .badge.play .badge-dot {
      background: #38bdf8;
    }
    @keyframes vm-macro-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    .toast {
      position: fixed;
      bottom: 18px;
      right: 18px;
      padding: 8px 13px;
      border-radius: 8px;
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      font: 500 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 150ms ease, transform 150ms ease;
    }
    .toast.visible {
      opacity: 1;
      transform: translateY(0);
    }
  `;

  const ui = {
    host: null,
    shadow: null,
    cursor: null,
    cursorDot: null,
    rippleLayer: null,
    badge: null,
    badgeText: null,
    toast: null,
    toastTimer: 0,
  };

  function ensureOverlay() {
    const rootTarget = document.documentElement || document.body;
    if (!rootTarget) return false;

    if (ui.host && ui.host.isConnected) {
      return true;
    }

    const host = document.createElement('div');
    host.id = '__vm_mouse_macro_overlay__';
    host.setAttribute(
      'style',
      [
        'position: fixed !important',
        'inset: 0 !important',
        'width: 100vw !important',
        'height: 100vh !important',
        'pointer-events: none !important',
        'z-index: 2147483647 !important',
        'margin: 0 !important',
        'padding: 0 !important',
        'border: 0 !important',
        'background: transparent !important',
        'overflow: visible !important',
      ].join('; ')
    );

    const shadow = host.attachShadow({ mode: 'closed' });

    // Build all overlay nodes without innerHTML so Trusted Types CSP (Google/YouTube) cannot block it.
    const styleEl = document.createElement('style');
    styleEl.textContent = OVERLAY_CSS;

    const layer = document.createElement('div');
    layer.className = 'layer';

    const rippleLayer = document.createElement('div');
    rippleLayer.className = 'ripple-layer';

    const cursor = document.createElement('div');
    cursor.className = 'cursor';

    const cursorDot = document.createElement('div');
    cursorDot.className = 'cursor-dot';

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M2.5 1.8 L2.5 19.6 L7.3 15.1 L10.7 21.8 L13.4 20.5 L10.0 13.8 L16.8 13.6 Z');
    path.setAttribute('fill', '#ffffff');
    path.setAttribute('stroke', '#0f172a');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linejoin', 'round');

    svg.appendChild(path);
    cursor.append(cursorDot, svg);

    const badge = document.createElement('div');
    badge.className = 'badge';
    const badgeDot = document.createElement('span');
    badgeDot.className = 'badge-dot';
    const badgeText = document.createElement('span');
    badgeText.className = 'badge-text';
    badge.append(badgeDot, badgeText);

    const toast = document.createElement('div');
    toast.className = 'toast';

    layer.append(rippleLayer, cursor, badge, toast);
    shadow.append(styleEl, layer);
    rootTarget.appendChild(host);

    ui.host = host;
    ui.shadow = shadow;
    ui.cursor = cursor;
    ui.cursorDot = cursorDot;
    ui.rippleLayer = rippleLayer;
    ui.badge = badge;
    ui.badgeText = badgeText;
    ui.toast = toast;
    return true;
  }

  function renderCursor(x, y, visible, pressed) {
    if (!ensureOverlay()) return;
    ui.cursor.classList.toggle('visible', Boolean(visible));
    ui.cursor.classList.toggle('pressed', Boolean(pressed));
    if (visible) {
      ui.cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
  }

  function showActionRipple(x, y, kind) {
    if (!ensureOverlay()) return;
    const ripple = document.createElement('div');
    ripple.className = `ripple ${kind || ''}`.trim();
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ui.rippleLayer.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    setTimeout(() => {
      if (ripple.isConnected) ripple.remove();
    }, 500);
  }

  function setStatusBadge(mode, text) {
    if (!ensureOverlay()) return;
    ui.badge.classList.remove('active', 'rec', 'play');
    if (mode === 'rec' || mode === 'play') {
      ui.badge.classList.add('active', mode);
      ui.badgeText.textContent = text;
    }
  }

  function showToast(text) {
    if (!ensureOverlay()) return;
    clearTimeout(ui.toastTimer);
    ui.toast.textContent = text;
    ui.toast.classList.add('visible');
    ui.toastTimer = setTimeout(() => {
      if (ui.toast) ui.toast.classList.remove('visible');
    }, 2200);
  }

  // ============================================================================
  // 5. Synthetic Event & Pointer-Capture Engine
  // ============================================================================

  const playbackState = {
    active: false,
    loop: false,
    generation: 0,
    activeButtonsMask: 0,
    lastHoveredElement: null,
    capturedElement: null,
    patchedWindows: new Map(),
  };

  function dispatchPointerCaptureEvent(el, type) {
    if (!el || !el.isConnected) return;
    const doc = el.ownerDocument;
    const win = (doc && doc.defaultView) || PAGE_WINDOW;
    const PointerCtor = win.PointerEvent || PointerEvent;
    const evt = new PointerCtor(type, {
      bubbles: true,
      cancelable: false,
      composed: true,
      view: win,
      pointerId: SYNTHETIC_POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
    });
    el.dispatchEvent(evt);
  }

  function installPointerCaptureShim(win) {
    if (!win || !win.Element || !win.Element.prototype) return;
    if (playbackState.patchedWindows.has(win)) return;

    const proto = win.Element.prototype;
    const origSet = proto.setPointerCapture;
    const origRelease = proto.releasePointerCapture;
    const origHas = proto.hasPointerCapture;

    try {
      proto.setPointerCapture = function patchedSetPointerCapture(pointerId) {
        if (pointerId === SYNTHETIC_POINTER_ID) {
          if (!this.isConnected) {
            throw new win.DOMException('Element is not connected.', 'InvalidStateError');
          }
          if (playbackState.activeButtonsMask === 0) {
            throw new win.DOMException('No active buttons for pointer capture.', 'InvalidStateError');
          }
          if (
            playbackState.capturedElement &&
            playbackState.capturedElement !== this &&
            playbackState.capturedElement.isConnected
          ) {
            dispatchPointerCaptureEvent(playbackState.capturedElement, 'lostpointercapture');
          }
          playbackState.capturedElement = this;
          dispatchPointerCaptureEvent(this, 'gotpointercapture');
          return;
        }
        return origSet.call(this, pointerId);
      };

      proto.releasePointerCapture = function patchedReleasePointerCapture(pointerId) {
        if (pointerId === SYNTHETIC_POINTER_ID) {
          if (playbackState.capturedElement === this) {
            playbackState.capturedElement = null;
            dispatchPointerCaptureEvent(this, 'lostpointercapture');
          }
          return;
        }
        return origRelease.call(this, pointerId);
      };

      proto.hasPointerCapture = function patchedHasPointerCapture(pointerId) {
        if (pointerId === SYNTHETIC_POINTER_ID) {
          return playbackState.capturedElement === this;
        }
        return origHas.call(this, pointerId);
      };

      playbackState.patchedWindows.set(win, { origSet, origRelease, origHas });
    } catch {
      // Ignore if Element.prototype is non-writable/frozen on a hardened site.
    }
  }

  function restorePointerCaptureShims() {
    for (const [win, orig] of playbackState.patchedWindows.entries()) {
      try {
        win.Element.prototype.setPointerCapture = orig.origSet;
        win.Element.prototype.releasePointerCapture = orig.origRelease;
        win.Element.prototype.hasPointerCapture = orig.origHas;
      } catch {
        // Ignore cleanup failure on detached iframes.
      }
    }
    playbackState.patchedWindows.clear();
    playbackState.capturedElement = null;
  }

  function buildMouseInit(win, doc, localX, localY, evt, opts) {
    const related =
      opts.relatedTarget && opts.relatedTarget.isConnected && opts.relatedTarget.ownerDocument === doc
        ? opts.relatedTarget
        : null;

    return {
      bubbles: opts.bubbles !== undefined ? opts.bubbles : true,
      cancelable: opts.cancelable !== undefined ? opts.cancelable : true,
      composed: opts.composed !== undefined ? opts.composed : true,
      view: win,
      detail: opts.detail !== undefined ? opts.detail : evt.detail || 0,
      screenX: Math.round((win.screenX || 0) + localX),
      screenY: Math.round((win.screenY || 0) + localY),
      clientX: localX,
      clientY: localY,
      ctrlKey: Boolean(evt.ctrl),
      shiftKey: Boolean(evt.shift),
      altKey: Boolean(evt.alt),
      metaKey: Boolean(evt.meta),
      button: opts.button !== undefined ? opts.button : evt.button || 0,
      buttons: opts.buttons !== undefined ? opts.buttons : playbackState.activeButtonsMask,
      relatedTarget: related,
    };
  }

  function dispatchPointer(target, win, doc, type, localX, localY, evt, opts = {}) {
    if (!target || !target.isConnected) return null;
    const PointerCtor = win.PointerEvent || win.MouseEvent;
    const init = buildMouseInit(win, doc, localX, localY, evt, opts);
    if (win.PointerEvent) {
      init.pointerId = SYNTHETIC_POINTER_ID;
      init.pointerType = 'mouse';
      init.isPrimary = true;
      init.width = 1;
      init.height = 1;
      init.pressure = opts.pressure !== undefined ? opts.pressure : 0;
    }
    const domEvent = new PointerCtor(type, init);
    target.dispatchEvent(domEvent);
    return domEvent;
  }

  function dispatchMouse(target, win, doc, type, localX, localY, evt, opts = {}) {
    if (!target || !target.isConnected) return null;
    const MouseCtor = win.MouseEvent;
    const init = buildMouseInit(win, doc, localX, localY, evt, opts);
    const domEvent = new MouseCtor(type, init);
    target.dispatchEvent(domEvent);
    return domEvent;
  }

  function syncHoverState(target, win, doc, localX, localY, evt) {
    const prev = playbackState.lastHoveredElement;
    if (prev === target) return;

    const prevChain = prev && prev.isConnected ? getAncestorChain(prev) : [];
    const nextChain = target && target.isConnected ? getAncestorChain(target) : [];
    const nextSet = new Set(nextChain);
    const prevSet = new Set(prevChain);

    if (prev && prev.isConnected) {
      const prevDoc = prev.ownerDocument || doc;
      const prevWin = prevDoc.defaultView || win;
      dispatchPointer(prev, prevWin, prevDoc, 'pointerout', localX, localY, evt, {
        button: 0,
        relatedTarget: target,
      });
      dispatchMouse(prev, prevWin, prevDoc, 'mouseout', localX, localY, evt, {
        button: 0,
        relatedTarget: target,
      });

      for (const el of prevChain) {
        if (nextSet.has(el)) break;
        const elDoc = el.ownerDocument || prevDoc;
        const elWin = elDoc.defaultView || prevWin;
        dispatchPointer(el, elWin, elDoc, 'pointerleave', localX, localY, evt, {
          bubbles: false,
          cancelable: false,
          composed: false,
          button: 0,
          relatedTarget: target,
        });
        dispatchMouse(el, elWin, elDoc, 'mouseleave', localX, localY, evt, {
          bubbles: false,
          cancelable: false,
          composed: false,
          button: 0,
          relatedTarget: target,
        });
      }
    }

    if (target && target.isConnected) {
      dispatchPointer(target, win, doc, 'pointerover', localX, localY, evt, {
        button: 0,
        relatedTarget: prev,
      });
      dispatchMouse(target, win, doc, 'mouseover', localX, localY, evt, {
        button: 0,
        relatedTarget: prev,
      });

      // Enter events fire top-down from LCA child down to target.
      const enterTargets = [];
      for (const el of nextChain) {
        if (prevSet.has(el)) break;
        enterTargets.push(el);
      }
      enterTargets.reverse();

      for (const el of enterTargets) {
        const elDoc = el.ownerDocument || doc;
        const elWin = elDoc.defaultView || win;
        dispatchPointer(el, elWin, elDoc, 'pointerenter', localX, localY, evt, {
          bubbles: false,
          cancelable: false,
          composed: false,
          button: 0,
          relatedTarget: prev,
        });
        dispatchMouse(el, elWin, elDoc, 'mouseenter', localX, localY, evt, {
          bubbles: false,
          cancelable: false,
          composed: false,
          button: 0,
          relatedTarget: prev,
        });
      }
    }

    playbackState.lastHoveredElement = target;
  }

  function applyClickFocus(target, doc) {
    const focusTarget = findFocusableAncestor(target);
    if (focusTarget) {
      if (doc.activeElement !== focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
      }
      return;
    }

    const active = doc.activeElement;
    if (
      active &&
      active !== doc.body &&
      active !== doc.documentElement &&
      typeof active.blur === 'function'
    ) {
      active.blur();
    }
  }

  function applyClickDefaultAction(hitTarget, win, evt, beforeHref) {
    const el = findClosestInteractive(hitTarget);
    if (!el || el.disabled) return;

    const tag = el.tagName;

    if (tag === 'LABEL') {
      const ctrl = el.control;
      if (ctrl && !ctrl.disabled) {
        if (ctrl.tagName === 'INPUT' && (ctrl.type === 'checkbox' || ctrl.type === 'radio')) {
          if (ctrl.type === 'checkbox') {
            ctrl.checked = !ctrl.checked;
          } else if (!ctrl.checked) {
            ctrl.checked = true;
          }
          ctrl.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
          ctrl.dispatchEvent(new win.Event('change', { bubbles: true }));
        } else if (typeof ctrl.focus === 'function') {
          ctrl.focus({ preventScroll: true });
        }
      }
      return;
    }

    if (tag === 'INPUT') {
      if (el.type === 'checkbox') {
        el.checked = !el.checked;
        el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
        return;
      }
      if (el.type === 'radio') {
        if (!el.checked) {
          el.checked = true;
          el.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
          el.dispatchEvent(new win.Event('change', { bubbles: true }));
        }
        return;
      }
      if ((el.type === 'submit' || el.type === 'image') && el.form) {
        if (typeof el.form.requestSubmit === 'function') {
          el.form.requestSubmit(el);
        }
        return;
      }
      if (el.type === 'reset' && el.form) {
        el.form.reset();
        return;
      }
    }

    if (tag === 'BUTTON' && el.form) {
      if (el.type === 'submit') {
        if (typeof el.form.requestSubmit === 'function') {
          el.form.requestSubmit(el);
        }
        return;
      }
      if (el.type === 'reset') {
        el.form.reset();
        return;
      }
    }

    if (tag === 'SUMMARY') {
      const parent = el.parentNode;
      if (parent && parent.tagName === 'DETAILS') {
        parent.open = !parent.open;
      }
      return;
    }

    if ((tag === 'A' || tag === 'AREA') && el.hasAttribute('href') && !el.hasAttribute('download')) {
      const rawHref = (el.getAttribute('href') || '').trim();
      if (!rawHref || rawHref === '#' || /^javascript:/i.test(rawHref)) return;

      // Only perform native navigation if JS handlers did not already change the URL.
      if (win.location.href === beforeHref) {
        if (el.target === '_blank' || evt.ctrl || evt.meta) {
          win.open(el.href, '_blank');
        } else if (!evt.shift) {
          win.location.assign(el.href);
        }
      }
    }
  }

  function replayMouseEvent(evt) {
    const resolved = resolveTargetAtPoint(evt.x, evt.y);
    const { element: hitTarget, doc, win, clientX, clientY } = resolved;
    installPointerCaptureShim(win);

    if (evt.type === 'move') {
      playbackState.activeButtonsMask = evt.buttons || 0;
      const pointerTarget =
        playbackState.capturedElement && playbackState.capturedElement.isConnected
          ? playbackState.capturedElement
          : hitTarget;

      if (!playbackState.capturedElement) {
        syncHoverState(hitTarget, win, doc, clientX, clientY, evt);
      }

      const pDoc = pointerTarget.ownerDocument || doc;
      const pWin = pDoc.defaultView || win;
      const pressure = playbackState.activeButtonsMask !== 0 ? 0.5 : 0;

      dispatchPointer(pointerTarget, pWin, pDoc, 'pointermove', clientX, clientY, evt, {
        button: -1,
        buttons: playbackState.activeButtonsMask,
        pressure,
      });
      dispatchMouse(hitTarget, win, doc, 'mousemove', clientX, clientY, evt, {
        button: 0,
        buttons: playbackState.activeButtonsMask,
      });
      renderCursor(evt.x, evt.y, true, playbackState.activeButtonsMask !== 0);
      return;
    }

    if (evt.type === 'down') {
      syncHoverState(hitTarget, win, doc, clientX, clientY, evt);
      playbackState.activeButtonsMask = evt.buttons !== undefined ? evt.buttons : 1;
      renderCursor(evt.x, evt.y, true, true);

      const rippleKind = evt.button === 2 ? 'right' : evt.button === 1 ? 'middle' : '';
      showActionRipple(evt.x, evt.y, rippleKind);

      dispatchPointer(hitTarget, win, doc, 'pointerdown', clientX, clientY, evt, {
        button: evt.button,
        buttons: playbackState.activeButtonsMask,
        detail: evt.detail || 1,
        pressure: 0.5,
      });
      const mouseDownEvt = dispatchMouse(hitTarget, win, doc, 'mousedown', clientX, clientY, evt, {
        button: evt.button,
        buttons: playbackState.activeButtonsMask,
        detail: evt.detail || 1,
      });

      if (mouseDownEvt && !mouseDownEvt.defaultPrevented) {
        applyClickFocus(hitTarget, doc);
      }
      return;
    }

    if (evt.type === 'up') {
      const pointerTarget =
        playbackState.capturedElement && playbackState.capturedElement.isConnected
          ? playbackState.capturedElement
          : hitTarget;
      const pDoc = pointerTarget.ownerDocument || doc;
      const pWin = pDoc.defaultView || win;

      playbackState.activeButtonsMask = evt.buttons !== undefined ? evt.buttons : 0;
      renderCursor(evt.x, evt.y, true, playbackState.activeButtonsMask !== 0);

      dispatchPointer(pointerTarget, pWin, pDoc, 'pointerup', clientX, clientY, evt, {
        button: evt.button,
        buttons: playbackState.activeButtonsMask,
        detail: evt.detail || 1,
        pressure: 0,
      });

      if (playbackState.capturedElement && playbackState.activeButtonsMask === 0) {
        const prevCap = playbackState.capturedElement;
        playbackState.capturedElement = null;
        dispatchPointerCaptureEvent(prevCap, 'lostpointercapture');
      }

      dispatchMouse(hitTarget, win, doc, 'mouseup', clientX, clientY, evt, {
        button: evt.button,
        buttons: playbackState.activeButtonsMask,
        detail: evt.detail || 1,
      });
      return;
    }

    if (evt.type === 'click' || evt.type === 'auxclick' || evt.type === 'contextmenu') {
      renderCursor(evt.x, evt.y, true, playbackState.activeButtonsMask !== 0);
      const beforeHref = win.location.href;
      // W3C Pointer Events Level 3 defines click/auxclick/contextmenu as PointerEvent (inherits MouseEvent).
      const domEvent = dispatchPointer(hitTarget, win, doc, evt.type, clientX, clientY, evt, {
        button: evt.button || 0,
        buttons: evt.buttons !== undefined ? evt.buttons : 0,
        detail: evt.detail !== undefined ? evt.detail : 1,
        pressure: 0,
      });

      if (evt.type === 'click' && (evt.button || 0) === 0 && domEvent && !domEvent.defaultPrevented) {
        applyClickDefaultAction(hitTarget, win, evt, beforeHref);
      }
      return;
    }

    if (evt.type === 'dblclick') {
      renderCursor(evt.x, evt.y, true, playbackState.activeButtonsMask !== 0);
      dispatchMouse(hitTarget, win, doc, 'dblclick', clientX, clientY, evt, {
        button: evt.button || 0,
        buttons: evt.buttons !== undefined ? evt.buttons : 0,
        detail: evt.detail !== undefined ? evt.detail : 2,
      });
      return;
    }

    if (evt.type === 'wheel') {
      renderCursor(evt.x, evt.y, true, playbackState.activeButtonsMask !== 0);
      showActionRipple(evt.x, evt.y, 'wheel');
      const WheelCtor = win.WheelEvent;
      const wheelInit = buildMouseInit(win, doc, clientX, clientY, evt, {
        button: 0,
        buttons: playbackState.activeButtonsMask,
      });
      wheelInit.deltaX = evt.deltaX || 0;
      wheelInit.deltaY = evt.deltaY || 0;
      wheelInit.deltaZ = evt.deltaZ || 0;
      wheelInit.deltaMode = evt.deltaMode || 0;

      const wheelEvt = new WheelCtor('wheel', wheelInit);
      hitTarget.dispatchEvent(wheelEvt);

      if (!wheelEvt.defaultPrevented) {
        applyNativeWheelScroll(hitTarget, doc, win, evt);
      }
      return;
    }

    assert(false, `Unknown recorded event type: ${evt.type}`);
  }

  // ============================================================================
  // 6. Recorder
  // ============================================================================

  const recordState = {
    active: false,
    startTime: 0,
    lastMoveTime: 0,
    lastX: NaN,
    lastY: NaN,
    events: [],
    attachedWindows: new Set(),
  };

  function pushMoveIfChanged(x, y, t, buttons, modifiers) {
    if (x === recordState.lastX && y === recordState.lastY) return;
    recordState.lastMoveTime = t;
    recordState.lastX = x;
    recordState.lastY = y;
    recordState.events.push({
      type: 'move',
      t,
      x,
      y,
      buttons,
      ...modifiers,
    });
  }

  function extractModifiers(e) {
    return {
      ctrl: e.ctrlKey ? 1 : 0,
      shift: e.shiftKey ? 1 : 0,
      alt: e.altKey ? 1 : 0,
      meta: e.metaKey ? 1 : 0,
    };
  }

  function handleRecordedMouseEvent(e) {
    if (!recordState.active || !e.isTrusted) return;

    const sourceWin = e.view || PAGE_WINDOW;
    const { x, y } = translateClientCoords(e.clientX, e.clientY, sourceWin);
    const t = Math.round((nowMs() - recordState.startTime) * 100) / 100;
    const modifiers = extractModifiers(e);

    if (e.type === 'mousemove') {
      const minMs = e.buttons !== 0 ? MOVE_SAMPLE_MS_DRAG : MOVE_SAMPLE_MS_HOVER;
      const dist = Math.hypot(x - recordState.lastX, y - recordState.lastY);
      if (t - recordState.lastMoveTime < minMs && dist < MOVE_MIN_DIST_PX) {
        return;
      }
      recordState.lastMoveTime = t;
      recordState.lastX = x;
      recordState.lastY = y;
      recordState.events.push({
        type: 'move',
        t,
        x,
        y,
        buttons: e.buttons,
        ...modifiers,
      });
      setStatusBadge('rec', `REC (${recordState.events.length}) · Alt+R to stop`);
      return;
    }

    // Ensure exact pointer coordinates immediately precede any click/wheel action.
    pushMoveIfChanged(x, y, t, e.buttons, modifiers);

    if (e.type === 'mousedown' || e.type === 'mouseup') {
      recordState.events.push({
        type: e.type === 'mousedown' ? 'down' : 'up',
        t,
        x,
        y,
        button: e.button,
        buttons: e.buttons,
        detail: e.detail || 1,
        ...modifiers,
      });
    } else if (
      e.type === 'click' ||
      e.type === 'dblclick' ||
      e.type === 'auxclick' ||
      e.type === 'contextmenu'
    ) {
      recordState.events.push({
        type: e.type,
        t,
        x,
        y,
        button: e.button,
        buttons: e.buttons,
        detail: e.detail || 1,
        ...modifiers,
      });
    } else if (e.type === 'wheel') {
      recordState.events.push({
        type: 'wheel',
        t,
        x,
        y,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        ...modifiers,
      });
    }

    setStatusBadge('rec', `REC (${recordState.events.length}) · Alt+R to stop`);
  }

  const RECORDED_EVENT_TYPES = [
    'mousemove',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'auxclick',
    'contextmenu',
    'wheel',
  ];

  function attachRecorderToWindowTree(win) {
    if (!win || recordState.attachedWindows.has(win)) return;
    recordState.attachedWindows.add(win);

    for (const type of RECORDED_EVENT_TYPES) {
      win.addEventListener(type, handleRecordedMouseEvent, { capture: true, passive: true });
    }

    try {
      const frames = win.document.querySelectorAll('iframe, frame');
      for (const frame of frames) {
        if (frame.contentWindow) {
          attachRecorderToWindowTree(frame.contentWindow);
        }
      }
    } catch {
      // Cross-origin iframe cannot be accessed; ignore safely.
    }
  }

  function detachRecorderFromAllWindows() {
    for (const win of recordState.attachedWindows) {
      try {
        for (const type of RECORDED_EVENT_TYPES) {
          win.removeEventListener(type, handleRecordedMouseEvent, { capture: true });
        }
      } catch {
        // Ignore detached iframe windows.
      }
    }
    recordState.attachedWindows.clear();
  }

  function startRecording() {
    assert(!recordState.active, 'Recording is already active');
    if (playbackState.active) {
      stopPlayback();
    }

    recordState.active = true;
    recordState.startTime = nowMs();
    recordState.lastMoveTime = -Infinity;
    recordState.lastX = NaN;
    recordState.lastY = NaN;
    recordState.events = [];

    attachRecorderToWindowTree(PAGE_WINDOW);
    setStatusBadge('rec', 'REC (0) · Alt+R to stop');
    showToast('Recording started — press Alt+R to stop');
  }

  function stopRecording() {
    assert(recordState.active, 'Recording is not active');
    recordState.active = false;
    detachRecorderFromAllWindows();
    setStatusBadge('off', '');

    const count = recordState.events.length;
    if (count === 0) {
      showToast('Recording stopped (no mouse events captured)');
      return;
    }

    saveMacro({
      version: 1,
      recordedAt: Date.now(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      events: recordState.events,
    });
    showToast(`Saved ${count} mouse events — Alt+T once / Alt+Y loop`);
  }

  // ============================================================================
  // 7. Player
  // ============================================================================

  function waitUntil(targetTimestamp, generation) {
    const remaining = targetTimestamp - nowMs();
    if (remaining <= 1) {
      return Promise.resolve(playbackState.active && playbackState.generation === generation);
    }

    return new Promise((resolve) => {
      const timerId = setTimeout(() => {
        resolve(playbackState.active && playbackState.generation === generation);
      }, remaining);

      // Fast-path wake check if aborted early.
      const checkAbort = () => {
        if (!playbackState.active || playbackState.generation !== generation) {
          clearTimeout(timerId);
          resolve(false);
        } else if (nowMs() < targetTimestamp) {
          requestAnimationFrame(checkAbort);
        }
      };
      if (remaining > 50) {
        requestAnimationFrame(checkAbort);
      }
    });
  }

  function stopPlayback() {
    if (!playbackState.active) return;
    playbackState.active = false;
    playbackState.loop = false;
    playbackState.generation += 1;
    playbackState.activeButtonsMask = 0;
    playbackState.lastHoveredElement = null;
    restorePointerCaptureShims();
    renderCursor(-100, -100, false, false);
    setStatusBadge('off', '');
  }

  function formatPlayBadge(loopCount, index, total) {
    if (playbackState.loop) {
      return `LOOP #${loopCount} (${index}/${total}) · Alt+Y / Esc to stop`;
    }
    return `PLAYING ${index}/${total} · Alt+T / Esc to stop`;
  }

  async function playMacro({ loop = false } = {}) {
    if (recordState.active) {
      showToast('Press Alt+R to stop recording before playing');
      return;
    }

    if (playbackState.active) {
      // Pressing Alt+Y while single playback is running switches it into loop mode seamlessly.
      if (loop && !playbackState.loop) {
        playbackState.loop = true;
        showToast('Switched to loop playback — press Alt+Y or Esc to stop');
        return;
      }
      const wasLooping = playbackState.loop;
      stopPlayback();
      showToast(wasLooping ? 'Loop playback stopped' : 'Playback stopped');
      return;
    }

    const macro = loadMacro();
    if (!macro || macro.events.length === 0) {
      showToast('No macro recorded yet — press Alt+R to record');
      return;
    }

    playbackState.active = true;
    playbackState.loop = Boolean(loop);
    playbackState.generation += 1;
    const gen = playbackState.generation;

    const events = macro.events;
    const total = events.length;
    let loopCount = 0;

    if (playbackState.loop) {
      showToast(`Looping macro (${total} events) — press Alt+Y or Esc to stop`);
    }

    try {
      do {
        loopCount += 1;
        playbackState.activeButtonsMask = 0;
        playbackState.lastHoveredElement = null;
        if (playbackState.capturedElement && playbackState.capturedElement.isConnected) {
          dispatchPointerCaptureEvent(playbackState.capturedElement, 'lostpointercapture');
        }
        playbackState.capturedElement = null;

        const playStart = nowMs();
        renderCursor(events[0].x, events[0].y, true, false);
        setStatusBadge('play', formatPlayBadge(loopCount, 0, total));

        for (let i = 0; i < total; i += 1) {
          const evt = events[i];
          const ok = await waitUntil(playStart + evt.t, gen);
          if (!ok) return;

          replayMouseEvent(evt);

          if (i === total - 1 || evt.type !== 'move' || i % 5 === 0) {
            setStatusBadge('play', formatPlayBadge(loopCount, i + 1, total));
          }
        }

        if (playbackState.loop && playbackState.active && playbackState.generation === gen) {
          // Always yield at least one macrotask frame so short macros cannot freeze the tab.
          await yieldMs(MIN_LOOP_YIELD_MS);
          if (!playbackState.active || playbackState.generation !== gen) return;
        }
      } while (playbackState.loop && playbackState.active && playbackState.generation === gen);

      showToast(`Macro finished (${total} events)`);
    } finally {
      if (playbackState.generation === gen) {
        playbackState.active = false;
        playbackState.loop = false;
        playbackState.activeButtonsMask = 0;
        playbackState.lastHoveredElement = null;
        restorePointerCaptureShims();
        renderCursor(-100, -100, false, false);
        setStatusBadge('off', '');
      }
    }
  }

  // ============================================================================
  // 8. Hotkey Router & Bootstrap
  // ============================================================================

  function isAltLetter(e, code, letter) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return false;
    return e.code === code || (typeof e.key === 'string' && e.key.toLowerCase() === letter);
  }

  function handleKeyDown(e) {
    if (!e.isTrusted || e.repeat) return;

    if (isAltLetter(e, 'KeyR', 'r')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (recordState.active) {
        stopRecording();
      } else {
        startRecording();
      }
      return;
    }

    if (isAltLetter(e, 'KeyT', 't')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      playMacro({ loop: false });
      return;
    }

    if (isAltLetter(e, 'KeyY', 'y')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      playMacro({ loop: true });
      return;
    }

    if (e.key === 'Escape' && playbackState.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      stopPlayback();
      showToast('Playback stopped');
    }
  }

  window.addEventListener('keydown', handleKeyDown, { capture: true });
})();
