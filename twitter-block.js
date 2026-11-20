// ==UserScript==
// @name         X (Twitter) One-Click Block
// @namespace    violentmonkey-x-one-click-block
// @version      1.0.0
// @description  Adds a one-click Block button next to the three-dots menu on tweets in x.com
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const BUTTON_ATTR = 'data-ocb-button';
  const HIDE_LAYERS_CLASS = 'x-ocb-hiding-layers';

  const MENU_WAIT_TIMEOUT_MS = 1500;
  const CONFIRM_WAIT_TIMEOUT_MS = 1500;
  const LAYER_UNHIDE_DELAY_MS = 120;

  const SELECTORS = {
    tweet: 'article[data-testid="tweet"]',
    caret: '[data-testid="caret"]',
    menuItem: '[role="menu"] [role="menuitem"]',
    blockMenuItem: '[data-testid="block"]',
    confirmButton: '[data-testid="confirmationSheetConfirm"]',
    openPopup: '[role="menu"], [role="dialog"]',
  };

  let isBlockInProgress = false;

  function assert(condition, message) {
    if (!condition) {
      throw new Error(`[X One-Click Block] ${message}`);
    }
  }

  function injectStyles() {
    const styleId = 'x-ocb-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .x-ocb-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 24px;
        padding: 0 8px;
        margin-right: 6px;
        border-radius: 9999px;
        border: 1px solid rgba(244, 33, 46, 0.45);
        background: transparent;
        color: rgb(244, 33, 46);
        font-family: TwitterChirp, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
        transition: background-color 0.15s ease, opacity 0.15s ease;
      }

      .x-ocb-btn:hover:not(:disabled) {
        background-color: rgba(244, 33, 46, 0.14);
      }

      .x-ocb-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }

      html.${HIDE_LAYERS_CLASS} #layers > div:has([role="menu"], [role="dialog"], [data-testid="Dropdown"]) {
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function waitForValue(getValue, timeoutMs) {
    const immediate = getValue();
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;

      const observer = new MutationObserver(() => {
        const result = getValue();
        if (result && !settled) {
          settled = true;
          clearTimeout(timer);
          observer.disconnect();
          resolve(result);
        }
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          observer.disconnect();
          resolve(null);
        }
      }, timeoutMs);

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function findBlockMenuItem() {
    const byTestId = document.querySelector(SELECTORS.blockMenuItem);
    if (byTestId) return byTestId;

    // Language fallback if data-testid="block" changes or is absent
    const items = Array.from(document.querySelectorAll(SELECTORS.menuItem));
    return items.find((item) => {
      const text = (item.textContent || '').trim();
      if (!text.includes('@')) return false;
      return /^(block\s+@|.*adlı kişiyi engelle)/i.test(text);
    }) || null;
  }

  function dismissOpenPopups() {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      bubbles: true,
    }));

    if (document.querySelector(SELECTORS.openPopup)) {
      document.body.click();
    }
  }

  async function executeOneClickBlock(tweetElement, blockButton) {
    assert(tweetElement, 'Tweet element missing.');
    assert(blockButton, 'Block button element missing.');

    if (isBlockInProgress) return;
    isBlockInProgress = true;

    blockButton.disabled = true;
    blockButton.textContent = '...';
    document.documentElement.classList.add(HIDE_LAYERS_CLASS);

    let blocked = false;

    try {
      const caretButton = tweetElement.querySelector(SELECTORS.caret);
      assert(caretButton, 'Could not find tweet three-dots menu button.');

      caretButton.click();

      const menuItems = await waitForValue(() => {
        const items = document.querySelectorAll(SELECTORS.menuItem);
        return items.length > 0 ? items : null;
      }, MENU_WAIT_TIMEOUT_MS);
      assert(menuItems, 'Tweet options menu did not open in time.');

      const blockMenuItem = findBlockMenuItem();
      if (!blockMenuItem) {
        // Likely your own tweet or an un-blockable item
        dismissOpenPopups();
        return;
      }

      blockMenuItem.click();

      const confirmButton = await waitForValue(
        () => document.querySelector(SELECTORS.confirmButton),
        CONFIRM_WAIT_TIMEOUT_MS
      );
      assert(confirmButton, 'Block confirmation button did not appear.');

      confirmButton.click();
      blocked = true;
    } catch (error) {
      console.error(error);
      dismissOpenPopups();
    } finally {
      if (blocked) {
        blockButton.textContent = 'Blocked';
        blockButton.disabled = true;
      } else {
        blockButton.textContent = 'Block';
        blockButton.disabled = false;
      }

      setTimeout(() => {
        document.documentElement.classList.remove(HIDE_LAYERS_CLASS);
        isBlockInProgress = false;
      }, LAYER_UNHIDE_DELAY_MS);
    }
  }

  function findHorizontalContainerForCaret(caretButton) {
    let current = caretButton.parentElement;
    for (let depth = 0; depth < 3 && current; depth += 1) {
      const style = window.getComputedStyle(current);
      if (style.display.includes('flex') && style.flexDirection === 'row') {
        return { container: current, anchor: depth === 0 ? caretButton : current.lastElementChild };
      }
      current = current.parentElement;
    }
    return { container: caretButton.parentElement, anchor: caretButton };
  }

  function createBlockButton(tweetElement) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'x-ocb-btn';
    button.setAttribute(BUTTON_ATTR, 'true');
    button.title = 'Block this account in one click';
    button.textContent = 'Block';

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      executeOneClickBlock(tweetElement, button);
    });

    return button;
  }

  function injectButtonIntoTweet(tweetElement) {
    const caretButton = tweetElement.querySelector(SELECTORS.caret);
    if (!caretButton) return;

    const { container, anchor } = findHorizontalContainerForCaret(caretButton);
    if (!container || container.querySelector(`[${BUTTON_ATTR}]`)) return;

    const blockButton = createBlockButton(tweetElement);
    container.insertBefore(blockButton, anchor);
  }

  function scanVisibleTweets() {
    const tweets = document.querySelectorAll(SELECTORS.tweet);
    for (const tweet of tweets) {
      injectButtonIntoTweet(tweet);
    }
  }

  function startTweetObserver() {
    let scheduled = false;

    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scanVisibleTweets();
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function main() {
    injectStyles();
    scanVisibleTweets();
    startTweetObserver();
  }

  main();
})();
