'use strict';

// ─── Selectors ──────────────────────────────────────────────────────────────

const TOOLBAR_SELECTORS = [
  '.footer-toolbar',
  '.meeting-footer',
  '.meeting-toolbar',
  '[class*="footer-toolbar"]',
  '[class*="meeting-footer"]',
  '[class*="bottom-bar"]',
  '[class*="toolbar"]',
];

const CC_BUTTON_SELECTORS = [
  'button[aria-label*="Live Transcript"]',
  'button[aria-label*="live transcript"]',
  'button[aria-label="CC"]',
  'button[aria-label*="Caption"]',
  'button[title*="Live Transcript"]',
  '[class*="live-transcript"] button',
  '[class*="closed-caption"] button',
  '[class*="cc-button"] button',
  '[class*="caption"] button',
];

const CAPTION_CONTAINER_SELECTORS = [
  '.live-transcription-subtitle-container',
  '.subtitle-container',
  '[class*="live-transcription-subtitle"]',
  '[class*="subtitle-container"]',
  '[class*="transcription-subtitle"]',
  '[class*="live-transcription"]',
];

const MEETING_TITLE_SELECTORS = [
  '[class*="meeting-topic"]',
  '[class*="meeting-info"] [class*="title"]',
  'div.meeting-title',
  '[class*="topic"]',
];

// ─── State ───────────────────────────────────────────────────────────────────

let state = 'IDLE'; // IDLE | WAITING_FOR_UI | ENABLING_CAPTIONS | CAPTURING | ENDED
let transcript = '';
let lastExtractedText = '';
let meetingName = '';
let meetingDate = '';
let meetingId = '';
let lineCount = 0;
let saveInterval = null;
let captionObserver = null;
let toolbarObserver = null;
let urlPollInterval = null;
let finalSaveTimeout = null;
let captionContainerParent = null;

// ─── Entry Point ─────────────────────────────────────────────────────────────

init();

function init() {
  meetingId = extractMeetingId(window.location.href);
  meetingDate = formatDate(new Date());

  if (!meetingId) return; // Not a meeting page

  state = 'WAITING_FOR_UI';
  waitForToolbar();
  watchForMeetingEnd();
}

// ─── Phase 1: Wait for Zoom UI to render ─────────────────────────────────────

function waitForToolbar() {
  const delays = [2000, 2000, 4000, 8000, 10000, 10000, 10000, 10000]; // 60s total
  let attempt = 0;

  function check() {
    const toolbar = findElement(TOOLBAR_SELECTORS);
    if (toolbar) {
      onToolbarReady(toolbar);
      return;
    }
    if (attempt >= delays.length) {
      console.warn('[ZoomTranscript] Toolbar not found after 60s — giving up');
      return;
    }
    setTimeout(check, delays[attempt++]);
  }

  // Also use MutationObserver in parallel for faster detection
  const bodyObserver = new MutationObserver(() => {
    const toolbar = findElement(TOOLBAR_SELECTORS);
    if (toolbar) {
      bodyObserver.disconnect();
      onToolbarReady(toolbar);
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true });

  check();
}

function onToolbarReady(toolbar) {
  if (state !== 'WAITING_FOR_UI') return;
  state = 'ENABLING_CAPTIONS';

  meetingName = extractMeetingName();
  console.log(`[ZoomTranscript] Meeting detected: "${meetingName}"`);

  watchToolbarRemoval(toolbar);

  // Give React a moment to fully hydrate interactive elements
  setTimeout(() => tryEnableCaptions(), 1500);
}

// ─── Phase 2: Auto-enable Live Transcript ────────────────────────────────────

function tryEnableCaptions() {
  if (state === 'ENDED') return;

  // If captions already active, skip straight to observing
  if (findElement(CAPTION_CONTAINER_SELECTORS)) {
    console.log('[ZoomTranscript] Captions already active');
    startCapturing();
    return;
  }

  const ccButton = findCCButton();
  if (!ccButton) {
    console.warn('[ZoomTranscript] CC button not found — retrying in 5s');
    setTimeout(tryEnableCaptions, 5000);
    return;
  }

  if (ccButton.getAttribute('aria-pressed') === 'true' ||
      ccButton.classList.contains('active') ||
      ccButton.classList.contains('pressed')) {
    console.log('[ZoomTranscript] CC already enabled');
    waitForCaptionContainer();
    return;
  }

  console.log('[ZoomTranscript] Clicking CC button');
  ccButton.click();

  // Watch for the submenu that appears after clicking
  watchForSubmenu();
}

function watchForSubmenu() {
  const deadline = Date.now() + 8000;

  const observer = new MutationObserver(() => {
    if (tryClickEnableTranscription()) {
      observer.disconnect();
      return;
    }
    if (Date.now() > deadline) {
      observer.disconnect();
      // No submenu appeared — captions may have toggled directly
      waitForCaptionContainer();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Also try immediately in case menu was already open
  if (tryClickEnableTranscription()) {
    observer.disconnect();
  }
}

function tryClickEnableTranscription() {
  // Look for menu items containing "Enable" or "Transcription"
  const menuItems = document.querySelectorAll(
    '[role="menuitem"], [role="option"], [class*="menu-item"], [class*="dropdown-item"]'
  );

  for (const item of menuItems) {
    const text = item.textContent || '';
    if (/enable.*(auto.?transcri|caption)/i.test(text) ||
        /auto.?transcri/i.test(text) ||
        (text.toLowerCase().includes('enable') && text.toLowerCase().includes('transcript'))) {
      console.log('[ZoomTranscript] Clicking "Enable Auto-Transcription"');
      item.click();
      waitForCaptionContainer();
      return true;
    }
  }
  return false;
}

function waitForCaptionContainer() {
  const deadline = Date.now() + 15000;

  const observer = new MutationObserver(() => {
    if (findElement(CAPTION_CONTAINER_SELECTORS)) {
      observer.disconnect();
      startCapturing();
    } else if (Date.now() > deadline) {
      observer.disconnect();
      console.warn('[ZoomTranscript] Caption container never appeared');
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Check immediately too
  if (findElement(CAPTION_CONTAINER_SELECTORS)) {
    observer.disconnect();
    startCapturing();
  }
}

// ─── Phase 3: Observe captions ───────────────────────────────────────────────

function startCapturing() {
  if (state === 'ENDED') return;
  state = 'CAPTURING';

  const container = findElement(CAPTION_CONTAINER_SELECTORS);
  if (!container) {
    console.warn('[ZoomTranscript] Caption container lost — retrying in 3s');
    setTimeout(() => waitForCaptionContainer(), 3000);
    return;
  }

  // Observe the parent so we survive React replacing the container node
  captionContainerParent = container.parentElement || document.body;
  console.log('[ZoomTranscript] Caption observer active');

  captionObserver = new MutationObserver(() => onCaptionMutation());
  captionObserver.observe(captionContainerParent, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Start incremental saves
  saveInterval = setInterval(saveTranscript, 60_000);

  updatePopupStatus();
}

function onCaptionMutation() {
  const container = findElement(CAPTION_CONTAINER_SELECTORS);
  if (!container) return;

  const entry = extractCaptionEntry(container);
  if (!entry) return;

  transcript += entry + '\n';
  lineCount++;
  lastExtractedText = entry;

  updatePopupStatus();
}

function extractCaptionEntry(container) {
  // Try to find speaker and text spans separately
  const speakerEl = container.querySelector(
    '[class*="speaker"], [class*="name"], [class*="avatar-name"]'
  );
  const textEl = container.querySelector(
    '[class*="text-content"], [class*="subtitle-text"], [class*="caption-text"]'
  );

  const speaker = speakerEl?.textContent?.trim().replace(/:$/, '') || '';
  const rawText = (textEl || container).textContent?.trim() || '';

  // Strip the speaker name from rawText if it's embedded at the start
  const text = speaker && rawText.startsWith(speaker)
    ? rawText.slice(speaker.length).replace(/^[:\s]+/, '')
    : rawText;

  if (!text || text === lastExtractedText) return null;

  const time = new Date().toTimeString().slice(0, 8);
  return speaker ? `[${time}] ${speaker}: ${text}` : `[${time}] ${text}`;
}

// ─── Phase 4: Saving ─────────────────────────────────────────────────────────

function saveTranscript() {
  if (!transcript) return;

  const safeName = sanitizeFileName(meetingName);
  const folderName = `${safeName} ${meetingDate}`;

  chrome.runtime.sendMessage({
    type: 'SAVE_TRANSCRIPT',
    meetingId,
    meetingName,
    meetingDate,
    transcript: buildFileContent(),
  });

  chrome.runtime.sendMessage({
    type: 'UPDATE_STATUS',
    status: { active: true, meetingName, lineCount, folderName },
  });
}

function buildFileContent() {
  const header = [
    `Meeting: ${meetingName}`,
    `Date: ${meetingDate}`,
    `Lines: ${lineCount}`,
    '─'.repeat(60),
    '',
  ].join('\n');
  return header + transcript;
}

function updatePopupStatus() {
  const safeName = sanitizeFileName(meetingName);
  chrome.runtime.sendMessage({
    type: 'UPDATE_STATUS',
    status: {
      active: state === 'CAPTURING',
      meetingName,
      lineCount,
      folderName: `${safeName} ${meetingDate}`,
    },
  });
}

// ─── Phase 5: Meeting end ────────────────────────────────────────────────────

function watchForMeetingEnd() {
  window.addEventListener('beforeunload', triggerFinalSave, { once: true });

  urlPollInterval = setInterval(() => {
    if (!window.location.href.includes('/wc/')) {
      triggerFinalSave();
    }
  }, 5000);
}

function watchToolbarRemoval(toolbar) {
  toolbarObserver = new MutationObserver(() => {
    if (!document.contains(toolbar)) {
      triggerFinalSave();
    }
  });
  toolbarObserver.observe(document.body, { childList: true, subtree: true });
}

function triggerFinalSave() {
  if (state === 'ENDED') return;
  state = 'ENDED';

  clearTimeout(finalSaveTimeout);
  finalSaveTimeout = setTimeout(() => {
    cleanup();
    saveTranscript();
    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', status: { active: false } });
    console.log('[ZoomTranscript] Final save triggered');
  }, 300);
}

function cleanup() {
  clearInterval(saveInterval);
  clearInterval(urlPollInterval);
  captionObserver?.disconnect();
  toolbarObserver?.disconnect();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findCCButton() {
  for (const sel of CC_BUTTON_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  // Fallback: scan all buttons for matching text/title
  for (const btn of document.querySelectorAll('button')) {
    const label = (btn.getAttribute('aria-label') || btn.title || btn.textContent || '').toLowerCase();
    if (/live.?transcript|closed.?caption|\bcc\b/.test(label)) {
      return btn;
    }
  }
  return null;
}

function extractMeetingName() {
  for (const sel of MEETING_TITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  // Fallback to browser tab title
  return (document.title || 'Zoom Meeting')
    .replace(/\s*[-–|]\s*Zoom\s*/i, '')
    .trim() || 'Zoom Meeting';
}

function extractMeetingId(url) {
  const m = url.match(/\/wc\/([^/?#]+)/);
  return m ? m[1] : '';
}

function formatDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function sanitizeFileName(name) {
  return (name || 'Zoom Meeting')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
