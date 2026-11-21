// ==UserScript==
// @name         Old Reddit Comment Media Embedder
// @namespace    violentmonkey
// @version      1.0.0
// @description  Embeds <image>, <gif>, <emote>, <sticker>, Giphy, direct media links, and "Processing img ..." placeholders in Old Reddit comments.
// @match        https://old.reddit.com/*
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://np.reddit.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Bail out if this is New Reddit (Shreddit) rather than Old Reddit.
  if (document.querySelector('shreddit-app')) return;

  const rootContainer =
    document.querySelector('.commentarea') ||
    document.querySelector('#siteTable');

  if (!rootContainer) return;

  // On feed/listing pages (no commentarea and no comment items), do nothing.
  const isCommentContext = Boolean(
    document.querySelector('.commentarea') ||
    rootContainer.querySelector('.thing.comment')
  );
  if (!isCommentContext) return;

  const PLACEHOLDER_LINK_RE = /^<(image|gif|emote|sticker)>$/i;
  const PROCESSING_IMG_RE = /^Processing img ([a-zA-Z0-9|_]+)\.{0,3}$/;
  const DIRECT_MEDIA_EXT_RE = /\.(png|jpe?g|gif|webp|avif|mp4|webm|gifv)$/i;
  const COMMENT_BODY_SELECTOR = '.thing.comment .usertext-body .md';

  const processedNodes = new WeakSet();
  const metadataCache = new Map(); // fullname -> media_metadata object | null
  let scanScheduled = false;

  injectStyles();
  scanContainer(rootContainer);

  const observer = new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      scanContainer(rootContainer);
    });
  });

  observer.observe(rootContainer, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('vm-old-reddit-embed-styles')) return;

    const style = document.createElement('style');
    style.id = 'vm-old-reddit-embed-styles';
    style.textContent = `
      .vm-embed-container {
        display: block;
        margin: 6px 0;
      }
      .vm-embed-media {
        display: block;
        max-width: min(400px, 100%);
        max-height: 400px;
        width: auto;
        height: auto;
        border-radius: 4px;
        object-fit: contain;
        cursor: zoom-in;
      }
      .vm-embed-media.vm-expanded {
        max-width: 100%;
        max-height: none;
        cursor: zoom-out;
      }
      .vm-embed-actions {
        display: inline-flex;
        gap: 8px;
        margin-top: 2px;
        font-size: 10px;
        opacity: 0.7;
      }
      .vm-embed-actions:hover {
        opacity: 1;
      }
      .vm-embed-actions a {
        color: inherit;
        text-decoration: none;
      }
      .vm-embed-actions a:hover {
        text-decoration: underline;
      }
      .vm-embed-toggle {
        margin-left: 4px;
        font-size: 11px;
        cursor: pointer;
        opacity: 0.8;
        text-decoration: none;
      }
      .vm-embed-toggle:hover {
        opacity: 1;
        text-decoration: underline;
      }
      .md-spoiler-text:not(.revealed) .vm-embed-container {
        filter: blur(18px);
        opacity: 0.05;
        pointer-events: none;
      }
      .md-spoiler-text.revealed .vm-embed-container {
        filter: none;
        opacity: 1;
        pointer-events: auto;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Main Scan
  // ---------------------------------------------------------------------------

  function scanContainer(container) {
    const markdownBodies = container.querySelectorAll(COMMENT_BODY_SELECTOR);
    const pendingProcessing = [];

    for (const md of markdownBodies) {
      // 1. Process <a> tags (<image>, <gif>, Giphy, bare media links, etc.)
      const anchors = md.querySelectorAll('a[href]');
      for (const anchor of anchors) {
        if (processedNodes.has(anchor)) continue;
        if (anchor.closest('.vm-embed-container')) continue;
        processedNodes.add(anchor);

        const mediaInfo = classifyAnchor(anchor);
        if (!mediaInfo) continue;

        if (mediaInfo.mode === 'replace') {
          replaceAnchorWithEmbed(anchor, mediaInfo);
        } else if (mediaInfo.mode === 'toggle') {
          attachToggleToAnchor(anchor, mediaInfo);
        }
      }

      // 2. Collect "Processing img <id>..." placeholders (both <em> and plain text)
      const emNodes = md.querySelectorAll('em');
      for (const em of emNodes) {
        if (processedNodes.has(em)) continue;
        const match = em.textContent.trim().match(PROCESSING_IMG_RE);
        if (!match) continue;

        const commentThing = em.closest('.thing.comment[data-fullname]');
        if (!commentThing) continue;

        processedNodes.add(em);
        pendingProcessing.push({
          targetNode: em,
          mediaId: match[1],
          commentThing,
        });
      }

      const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (processedNodes.has(textNode)) continue;
        const parentEl = textNode.parentElement;
        if (!parentEl || parentEl.closest('a, code, pre, em, .vm-embed-container')) {
          continue;
        }
        const match = textNode.nodeValue.trim().match(PROCESSING_IMG_RE);
        if (!match) continue;

        const commentThing = parentEl.closest('.thing.comment[data-fullname]');
        if (!commentThing) continue;

        processedNodes.add(textNode);
        pendingProcessing.push({
          targetNode: textNode,
          mediaId: match[1],
          commentThing,
        });
      }
    }

    if (pendingProcessing.length > 0) {
      resolveProcessingPlaceholders(pendingProcessing);
    }
  }

  // ---------------------------------------------------------------------------
  // Link Classification & Media Resolution
  // ---------------------------------------------------------------------------

  function parseSafeUrl(rawUrl) {
    try {
      const parsed = new URL(rawUrl, location.origin);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  function extractGiphyId(url) {
    const host = url.hostname.toLowerCase();
    if (host !== 'giphy.com' && !host.endsWith('.giphy.com')) return null;

    // Direct CDN asset: media*.giphy.com/... or i.giphy.com/...
    if (host.startsWith('media') || host === 'i.giphy.com') {
      return null; // Already a direct asset URL
    }

    // Webpage URL: /gifs/slug-<id> or /gifs/<id> or /embed/<id>
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;

    if (segments[0] === 'gifs' || segments[0] === 'embed') {
      const last = segments[segments.length - 1];
      const parts = last.split('-');
      const id = parts[parts.length - 1];
      return /^[a-zA-Z0-9]+$/.test(id) ? id : null;
    }

    return null;
  }

  function resolveMediaDescriptor(url) {
    const host = url.hostname.toLowerCase();
    const giphyId = extractGiphyId(url);

    if (giphyId) {
      return {
        kind: 'image',
        mediaUrl: `https://i.giphy.com/media/${giphyId}/giphy.gif`,
        sourceUrl: url.href,
      };
    }

    // Reddit preview.redd.it mp4-formatted gifs
    if (host === 'preview.redd.it' && url.searchParams.get('format') === 'mp4') {
      return {
        kind: 'video',
        mediaUrl: url.href,
        sourceUrl: url.href,
      };
    }

    // Imgur .gifv -> .mp4
    if ((host === 'i.imgur.com' || host === 'imgur.com') && /\.gifv$/i.test(url.pathname)) {
      const mp4Url = new URL(url.href);
      mp4Url.hostname = 'i.imgur.com';
      mp4Url.pathname = mp4Url.pathname.replace(/\.gifv$/i, '.mp4');
      return {
        kind: 'video',
        mediaUrl: mp4Url.href,
        sourceUrl: url.href,
      };
    }

    // Direct video extensions
    if (/\.(mp4|webm)$/i.test(url.pathname)) {
      return {
        kind: 'video',
        mediaUrl: url.href,
        sourceUrl: url.href,
      };
    }

    // Direct image / animated gif / webp extensions
    if (DIRECT_MEDIA_EXT_RE.test(url.pathname)) {
      return {
        kind: 'image',
        mediaUrl: url.href,
        sourceUrl: url.href,
      };
    }

    // Reddit / Giphy / Tenor image CDN URLs even if extension is omitted
    if (
      host === 'i.redd.it' ||
      host === 'preview.redd.it' ||
      host === 'external-preview.redd.it' ||
      host === 'i.giphy.com' ||
      /^media\d*\.giphy\.com$/.test(host) ||
      /^media\d*\.tenor\.com$/.test(host) ||
      host === 'c.tenor.com'
    ) {
      return {
        kind: 'image',
        mediaUrl: url.href,
        sourceUrl: url.href,
      };
    }

    return null;
  }

  function classifyAnchor(anchor) {
    const url = parseSafeUrl(anchor.href);
    if (!url) return null;

    const label = anchor.textContent.trim();
    const isPlaceholder = PLACEHOLDER_LINK_RE.test(label);

    // Avoid duplicating links that RES has already turned into an expando
    const hasResExpando = Boolean(
      anchor.nextElementSibling &&
      anchor.nextElementSibling.classList.contains('expando-button')
    );
    if (!isPlaceholder && hasResExpando) return null;

    const descriptor = resolveMediaDescriptor(url);

    // For <image>, <gif>, <emote>, <sticker>, always embed inline
    if (isPlaceholder) {
      if (descriptor) {
        return { ...descriptor, label, mode: 'replace' };
      }
      // Fallback: treat unknown placeholder href as an image
      return {
        kind: 'image',
        mediaUrl: url.href,
        sourceUrl: url.href,
        label,
        mode: 'replace',
      };
    }

    if (!descriptor) return null;

    const normalizedHref = url.href.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const normalizedLabel = label.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const isRawUrlLabel = normalizedHref === normalizedLabel;

    // Bare media URLs or bare Giphy links get replaced inline
    if (isRawUrlLabel) {
      return { ...descriptor, label, mode: 'replace' };
    }

    // Links with custom text get a subtle inline [embed] toggle so prose stays readable
    return { ...descriptor, label, mode: 'toggle' };
  }

  // ---------------------------------------------------------------------------
  // DOM Rendering
  // ---------------------------------------------------------------------------

  function createMediaElement(mediaInfo, onFallback) {
    const container = document.createElement('span');
    container.className = 'vm-embed-container';

    let mediaEl;
    if (mediaInfo.kind === 'video') {
      const video = document.createElement('video');
      video.src = mediaInfo.mediaUrl;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.controls = false;
      mediaEl = video;
    } else {
      const img = document.createElement('img');
      img.src = mediaInfo.mediaUrl;
      img.alt = mediaInfo.label || 'Embedded comment media';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      mediaEl = img;
    }

    mediaEl.className = 'vm-embed-media';
    mediaEl.title = 'Click to toggle size';
    mediaEl.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      mediaEl.classList.toggle('vm-expanded');
    });

    mediaEl.addEventListener('error', () => {
      if (typeof onFallback === 'function') {
        onFallback(container);
      }
    });

    container.appendChild(mediaEl);

    if (mediaInfo.sourceUrl) {
      const actions = document.createElement('span');
      actions.className = 'vm-embed-actions';

      const srcLink = document.createElement('a');
      srcLink.href = mediaInfo.sourceUrl;
      srcLink.target = '_blank';
      srcLink.rel = 'noopener noreferrer';
      srcLink.textContent = '[source]';

      actions.appendChild(srcLink);
      container.appendChild(actions);
    }

    return container;
  }

  function replaceAnchorWithEmbed(anchor, mediaInfo) {
    const embed = createMediaElement(mediaInfo, (failedContainer) => {
      // Restore original anchor if the media fails to load
      if (failedContainer.parentNode) {
        failedContainer.replaceWith(anchor);
      }
    });
    anchor.replaceWith(embed);
  }

  function attachToggleToAnchor(anchor, mediaInfo) {
    const toggle = document.createElement('a');
    toggle.href = '#';
    toggle.className = 'vm-embed-toggle';
    toggle.textContent = '[+]';
    toggle.title = 'Toggle inline embed';

    let embedContainer = null;

    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      if (embedContainer) {
        embedContainer.remove();
        embedContainer = null;
        toggle.textContent = '[+]';
        return;
      }

      embedContainer = createMediaElement(
        { ...mediaInfo, sourceUrl: null },
        (failedContainer) => {
          failedContainer.remove();
          embedContainer = null;
          toggle.textContent = '[failed]';
        }
      );
      toggle.insertAdjacentElement('afterend', embedContainer);
      toggle.textContent = '[-]';
    });

    anchor.insertAdjacentElement('afterend', toggle);
  }

  // ---------------------------------------------------------------------------
  // "Processing img <id>..." Resolution via Reddit JSON API
  // ---------------------------------------------------------------------------

  async function resolveProcessingPlaceholders(items) {
    const uncachedIds = new Set();
    for (const item of items) {
      const fullname = item.commentThing.dataset.fullname;
      if (fullname && !metadataCache.has(fullname)) {
        uncachedIds.add(fullname);
      }
    }

    if (uncachedIds.size > 0) {
      await fetchMetadataBatch(Array.from(uncachedIds));
    }

    for (const item of items) {
      const fullname = item.commentThing.dataset.fullname;
      let metadata = metadataCache.get(fullname) || null;

      if (!metadata && item.commentThing.dataset.permalink) {
        metadata = await fetchMetadataByPermalink(
          item.commentThing.dataset.permalink,
          fullname
        );
        metadataCache.set(fullname, metadata);
      }

      const mediaInfo = extractMediaFromMetadata(metadata, item.mediaId);
      if (!mediaInfo) continue;

      const embed = createMediaElement(mediaInfo, (failedContainer) => {
        failedContainer.remove();
      });

      if (item.targetNode.parentNode) {
        item.targetNode.parentNode.replaceChild(embed, item.targetNode);
      }
    }
  }

  async function fetchMetadataBatch(fullnames) {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < fullnames.length; i += CHUNK_SIZE) {
      const chunk = fullnames.slice(i, i + CHUNK_SIZE);
      const endpoint = `${location.origin}/api/info.json?id=${encodeURIComponent(chunk.join(','))}&raw_json=1`;

      try {
        const response = await fetch(endpoint, { credentials: 'same-origin' });
        if (!response.ok) continue;

        const payload = await response.json();
        const children = payload?.data?.children || [];
        for (const child of children) {
          if (child?.data?.name) {
            metadataCache.set(child.data.name, child.data.media_metadata || null);
          }
        }
      } catch {
        // Ignore transient network failures; permalink fallback handles misses
      }
    }
  }

  async function fetchMetadataByPermalink(permalink, fullname) {
    const cleanPath = permalink.replace(/\/$/, '');
    const endpoint = `${location.origin}${cleanPath}.json?raw_json=1`;

    try {
      const response = await fetch(endpoint, { credentials: 'same-origin' });
      if (!response.ok) return null;

      const payload = await response.json();
      if (!Array.isArray(payload)) return null;

      return findCommentMetadataInTree(payload, fullname);
    } catch {
      return null;
    }
  }

  function findCommentMetadataInTree(node, targetFullname) {
    if (!node || typeof node !== 'object') return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findCommentMetadataInTree(item, targetFullname);
        if (found) return found;
      }
      return null;
    }

    if (node.data?.name === targetFullname) {
      return node.data.media_metadata || null;
    }

    if (node.data?.children) {
      const found = findCommentMetadataInTree(node.data.children, targetFullname);
      if (found) return found;
    }

    if (node.data?.replies) {
      const found = findCommentMetadataInTree(node.data.replies, targetFullname);
      if (found) return found;
    }

    return null;
  }

  function extractMediaFromMetadata(metadata, mediaId) {
    if (metadata && typeof metadata === 'object') {
      let entry = metadata[mediaId];
      if (!entry) {
        for (const [key, value] of Object.entries(metadata)) {
          if (key === mediaId || key.endsWith(`|${mediaId}`)) {
            entry = value;
            break;
          }
        }
      }

      if (entry && entry.status === 'valid' && entry.s) {
        if (entry.s.mp4) {
          const url = unescapeRedditUrl(entry.s.mp4);
          return { kind: 'video', mediaUrl: url, sourceUrl: url };
        }
        if (entry.s.gif) {
          const url = unescapeRedditUrl(entry.s.gif);
          return { kind: 'image', mediaUrl: url, sourceUrl: url };
        }
        if (entry.s.u) {
          const url = unescapeRedditUrl(entry.s.u);
          return { kind: 'image', mediaUrl: url, sourceUrl: url };
        }
      }
    }

    if (mediaId.startsWith('giphy|')) {
      const giphyId = mediaId.slice('giphy|'.length);
      if (/^[a-zA-Z0-9]+$/.test(giphyId)) {
        const gifUrl = `https://i.giphy.com/media/${giphyId}/giphy.gif`;
        return { kind: 'image', mediaUrl: gifUrl, sourceUrl: gifUrl };
      }
    }

    return null;
  }

  function unescapeRedditUrl(raw) {
    return String(raw).replace(/&amp;/g, '&');
  }
})();
