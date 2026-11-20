// ==UserScript==
// @name         YouTube Audio-Only
// @namespace    https://violentmonkey.github.io/
// @version      1.0.0
// @description  Disables YouTube video display, ambient mode, and hover previews while locking streams to lowest quality (144p) to save bandwidth and iGPU compute.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'yt_audio_only_enabled';
  const ROOT_ATTR = 'data-yt-audio-only';
  const STYLE_ID = 'yt-audio-only-style';
  const BANNER_CLASS = 'yt-audio-only-banner';
  const BUTTON_CLASS = 'yt-audio-only-btn';

  const wiredPlayers = new WeakSet();
  let isEnabled = readSavedState();
  let syncScheduled = false;

  // Apply root state immediately at document-start to prevent visual flash.
  document.documentElement.setAttribute(ROOT_ATTR, String(isEnabled));
  injectStyles();
  wireGlobalListeners();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserverAndSync, { once: true });
  } else {
    startObserverAndSync();
  }

  // --- State & Storage ---

  function readSavedState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === null ? true : saved === 'true';
    } catch {
      return true;
    }
  }

  function writeSavedState(enabled) {
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  function setAudioOnlyEnabled(enabled) {
    isEnabled = Boolean(enabled);
    writeSavedState(isEnabled);
    document.documentElement.setAttribute(ROOT_ATTR, String(isEnabled));
    syncAllPlayers();
  }

  // --- Styles ---

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT_ATTR}="true"] .html5-video-player video.html5-main-video {
        display: none !important;
      }

      /* Disable GPU-heavy Ambient Mode blur canvas & inline feed hover previews */
      html[${ROOT_ATTR}="true"] #cinematics,
      html[${ROOT_ATTR}="true"] #cinematics-container,
      html[${ROOT_ATTR}="true"] .ytp-ambient-mode-canvas,
      html[${ROOT_ATTR}="true"] ytd-video-preview,
      html[${ROOT_ATTR}="true"] #video-preview-container {
        display: none !important;
      }

      .${BANNER_CLASS} {
        display: none;
        position: absolute;
        inset: 0;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 6px;
        background: radial-gradient(circle at center, #1b1b1f 0%, #0d0d10 100%);
        color: #d4d4d8;
        font-family: Roboto, Arial, sans-serif;
        text-align: center;
        pointer-events: none;
        user-select: none;
        z-index: 1;
      }

      html[${ROOT_ATTR}="true"] .${BANNER_CLASS} {
        display: flex;
      }

      .${BANNER_CLASS}-title {
        font-size: 14px;
        font-weight: 500;
        letter-spacing: 0.2px;
        color: #f4f4f5;
      }

      .${BANNER_CLASS}-sub {
        font-size: 12px;
        color: #a1a1aa;
      }

      .${BUTTON_CLASS} {
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        opacity: 0.65;
        transition: opacity 0.15s ease, color 0.15s ease;
      }

      .${BUTTON_CLASS}[aria-pressed="true"] {
        opacity: 1;
        color: #3ea6ff !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  // --- Player Quality & Video Track Control ---

  function getLowestQuality(player) {
    if (typeof player.getAvailableQualityLevels !== 'function') return null;
    const levels = player.getAvailableQualityLevels();
    if (!Array.isArray(levels) || levels.length === 0) return null;

    const concrete = levels.filter((q) => q && q !== 'auto');
    if (concrete.length === 0) return null;
    if (concrete.includes('tiny')) return 'tiny';

    // YouTube orders quality levels highest -> lowest.
    return concrete[concrete.length - 1];
  }

  function applyQualityPolicy(player) {
    if (!player) return;

    if (isEnabled) {
      const lowest = getLowestQuality(player);
      if (!lowest) return;

      const current = typeof player.getPlaybackQuality === 'function'
        ? player.getPlaybackQuality()
        : null;

      if (current === lowest) return;

      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(lowest, lowest);
      }
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(lowest);
      }
      return;
    }

    // Restore automatic quality selection when toggled off.
    if (typeof player.setPlaybackQualityRange === 'function') {
      player.setPlaybackQualityRange('tiny', 'highres');
    }
    if (typeof player.setPlaybackQuality === 'function') {
      player.setPlaybackQuality('auto');
    }
  }

  function applyVideoElementPolicy(video) {
    if (!(video instanceof HTMLVideoElement)) return;

    if (isEnabled) {
      if (video.closest('ytd-video-preview, #video-preview-container')) {
        video.pause();
        return;
      }
      video.disablePictureInPicture = true;
      if (video.videoTracks && video.videoTracks.length > 0) {
        for (const track of video.videoTracks) {
          track.selected = false;
        }
      }
      return;
    }

    video.disablePictureInPicture = false;
    if (video.videoTracks && video.videoTracks.length > 0) {
      video.videoTracks[0].selected = true;
    }
  }

  // --- Player UI (Built via DOM APIs for Trusted Types compatibility) ---

  function createHeadphoneIcon() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute(
      'd',
      'M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-7H5v-2a7 7 0 0 1 14 0v2h-3v7h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z'
    );
    svg.appendChild(path);
    return svg;
  }

  function ensurePlayerBanner(player) {
    if (player.querySelector(`.${BANNER_CLASS}`)) return;

    const banner = document.createElement('div');
    banner.className = BANNER_CLASS;

    const title = document.createElement('div');
    title.className = `${BANNER_CLASS}-title`;
    title.textContent = 'Audio-Only Mode';

    const sub = document.createElement('div');
    sub.className = `${BANNER_CLASS}-sub`;
    sub.textContent = 'Video hidden • Lowest stream quality locked (Alt+Shift+A to toggle)';

    banner.append(title, sub);
    player.appendChild(banner);
  }

  function ensurePlayerToggleButton(player) {
    const controls = player.querySelector('.ytp-right-controls');
    if (!controls) return;

    let btn = controls.querySelector(`.${BUTTON_CLASS}`);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ytp-button ${BUTTON_CLASS}`;
      btn.title = 'Toggle Audio-Only Mode (Alt+Shift+A)';
      btn.setAttribute('aria-label', 'Toggle Audio-Only Mode');
      btn.appendChild(createHeadphoneIcon());

      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        setAudioOnlyEnabled(!isEnabled);
      });

      controls.insertBefore(btn, controls.firstChild);
    }

    btn.setAttribute('aria-pressed', String(isEnabled));
  }

  function syncPlayer(player) {
    if (!player) return;

    ensurePlayerBanner(player);
    ensurePlayerToggleButton(player);

    if (!wiredPlayers.has(player)) {
      wiredPlayers.add(player);
      if (typeof player.addEventListener === 'function') {
        player.addEventListener('onPlaybackQualityChange', () => {
          if (isEnabled) applyQualityPolicy(player);
        });
      }
    }

    const video = player.querySelector('video.html5-main-video');
    if (video) applyVideoElementPolicy(video);
    applyQualityPolicy(player);
  }

  function syncAllPlayers() {
    const players = document.querySelectorAll('.html5-video-player');
    for (const player of players) {
      syncPlayer(player);
    }
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    queueMicrotask(() => {
      syncScheduled = false;
      syncAllPlayers();
    });
  }

  // --- Global Event & DOM Wiring ---

  function wireGlobalListeners() {
    // Catch any <video> starting playback (main player or hover previews).
    document.addEventListener(
      'play',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLVideoElement)) return;
        applyVideoElementPolicy(target);

        const player = target.closest('.html5-video-player');
        if (player) syncPlayer(player);
      },
      true
    );

    // YouTube SPA navigation events.
    window.addEventListener('yt-navigate-finish', scheduleSync);
    window.addEventListener('yt-page-data-updated', scheduleSync);

    // Keyboard shortcut: Alt + Shift + A
    window.addEventListener('keydown', (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code !== 'KeyA') return;

      const active = document.activeElement;
      if (
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return;
      }

      event.preventDefault();
      setAudioOnlyEnabled(!isEnabled);
    });
  }

  function startObserverAndSync() {
    syncAllPlayers();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.matches('.html5-video-player, .ytp-right-controls, video.html5-main-video') ||
            node.querySelector('.html5-video-player, .ytp-right-controls')
          ) {
            scheduleSync();
            return;
          }
        }
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
})();
