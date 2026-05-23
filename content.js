'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let state = 'WAITING'; // WAITING | ENABLING | CAPTURING | ENDED
let transcript = '';
let lastExtractedText = '';
let meetingName = 'Zoom Meeting';
let meetingDate = '';
let meetingId = '';
let lineCount = 0;
let saveInterval = null;
let captionObserver = null;
let urlPollInterval = null;
let finalSaveTimeout = null;

// ─── Entry Point ─────────────────────────────────────────────────────────────

init();

function init() {
  meetingDate = formatDate(new Date());
  meetingId = extractMeetingId(window.location.href) || `mtg-${Date.now()}`;

  // We're on a /wc/ URL — this is always a Zoom meeting page.
  // Skip DOM-based "is meeting active?" checks (Zoom renders video on <canvas>
  // and may use Shadow DOM, making standard querySelector unreliable).
  // Just wait for the meeting UI to finish loading, then start finding the CC button.
  state = 'WAITING';
  setStatus({ sub: 'Waiting for meeting to start…' });
  console.log('[ZoomTranscript] Loaded on Zoom meeting page, waiting for UI…');

  // Refresh meeting name as the page hydrates
  const namePoller = setInterval(() => {
    const name = extractMeetingName();
    if (name && name !== 'Zoom Meeting') {
      meetingName = name;
      clearInterval(namePoller);
    }
  }, 2000);

  // Give Zoom's React/WASM app time to render meeting controls
  setTimeout(beginEnabling, 6000);

  window.addEventListener('beforeunload', triggerFinalSave, { once: true });
  urlPollInterval = setInterval(() => {
    if (!window.location.href.includes('/wc/')) triggerFinalSave();
  }, 5000);
}

// ─── Enable Live Transcript ───────────────────────────────────────────────────

let enableAttempts = 0;
const MAX_ATTEMPTS = 20; // 20 × 5s = 100s of retrying

function beginEnabling() {
  if (state === 'ENDED') return;
  state = 'ENABLING';
  meetingName = extractMeetingName();
  console.log(`[ZoomTranscript] Starting caption enable (meeting: "${meetingName}")`);
  logDOMSnapshot();
  setStatus({ sub: 'Enabling transcription…' });
  tryEnableCaptions();
}

function tryEnableCaptions() {
  if (state === 'ENDED') return;

  // Already active — go straight to capturing
  if (findCaptionContainer()) {
    console.log('[ZoomTranscript] Captions already active');
    startCapturing();
    return;
  }

  enableAttempts++;
  if (enableAttempts > MAX_ATTEMPTS) {
    console.warn('[ZoomTranscript] Could not find the Live Transcript button after 100s.');
    console.warn('[ZoomTranscript] Either the host has disabled it, or the UI selectors need updating.');
    console.warn('[ZoomTranscript] Open DevTools and run: document.querySelectorAll("button") to inspect buttons.');
    setStatus({ sub: 'Live Transcript unavailable — check console for details' });
    return;
  }

  // Path 1: transcript button directly visible
  const directBtn = findTranscriptButton();
  if (directBtn) {
    console.log('[ZoomTranscript] Found transcript button directly, clicking');
    directBtn.click();
    watchForSubmenu();
    return;
  }

  // Path 2: transcript button is inside the "More / ..." overflow menu
  const moreBtn = findMoreButton();
  if (moreBtn) {
    console.log('[ZoomTranscript] Clicking "More" menu to reveal transcript option');
    moreBtn.click();
    setTimeout(() => {
      const btn = findTranscriptButton();
      if (btn) {
        btn.click();
        watchForSubmenu();
      } else {
        // Close menu and retry
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        console.log(`[ZoomTranscript] Transcript not in More menu yet, retry ${enableAttempts}/${MAX_ATTEMPTS}`);
        setTimeout(tryEnableCaptions, 5000);
      }
    }, 800);
    return;
  }

  console.log(`[ZoomTranscript] Controls not ready yet, retry ${enableAttempts}/${MAX_ATTEMPTS}`);
  setTimeout(tryEnableCaptions, 5000);
}

function watchForSubmenu() {
  const deadline = Date.now() + 8000;

  const observer = new MutationObserver(() => {
    if (tryClickEnableTranscription()) {
      observer.disconnect();
      return;
    }
    if (findCaptionContainer()) {
      observer.disconnect();
      startCapturing();
      return;
    }
    if (Date.now() > deadline) {
      observer.disconnect();
      waitForCaptionContainer();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (tryClickEnableTranscription() || findCaptionContainer()) {
    observer.disconnect();
    if (findCaptionContainer()) startCapturing();
  }
}

function tryClickEnableTranscription() {
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], [role="listitem"], ' +
    '[class*="menu-item"], [class*="dropdown-item"], [class*="action-item"]'
  );
  for (const el of candidates) {
    const text = el.textContent || '';
    if (/enable.*(transcri|caption)/i.test(text) ||
        /auto.?transcri/i.test(text) ||
        (/enable/i.test(text) && /transcript/i.test(text))) {
      console.log('[ZoomTranscript] Clicking "Enable Auto-Transcription"');
      el.click();
      waitForCaptionContainer();
      return true;
    }
  }
  return false;
}

function waitForCaptionContainer() {
  const deadline = Date.now() + 15000;

  const observer = new MutationObserver(() => {
    if (findCaptionContainer()) {
      observer.disconnect();
      startCapturing();
    } else if (Date.now() > deadline) {
      observer.disconnect();
      setTimeout(tryEnableCaptions, 3000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (findCaptionContainer()) {
    observer.disconnect();
    startCapturing();
  }
}

// ─── Capture ──────────────────────────────────────────────────────────────────

function startCapturing() {
  if (state === 'ENDED') return;
  state = 'CAPTURING';

  const container = findCaptionContainer();
  if (!container) {
    setTimeout(waitForCaptionContainer, 2000);
    return;
  }

  console.log('[ZoomTranscript] Caption observer active — transcribing');
  setStatus({ sub: '0 lines captured', active: true });

  const watchTarget = container.parentElement || document.body;
  captionObserver = new MutationObserver(onCaptionMutation);
  captionObserver.observe(watchTarget, { childList: true, subtree: true, characterData: true });

  saveInterval = setInterval(saveTranscript, 60_000);
}

function onCaptionMutation() {
  const container = findCaptionContainer();
  if (!container) return;

  const entry = extractCaptionEntry(container);
  if (!entry) return;

  transcript += entry + '\n';
  lineCount++;
  lastExtractedText = entry;

  setStatus({ sub: `${lineCount} line${lineCount === 1 ? '' : 's'} captured`, active: true });
}

function extractCaptionEntry(container) {
  const speakerEl = container.querySelector('[class*="speaker"], [class*="name"], [class*="avatar"]');
  const textEl = container.querySelector(
    '[class*="text-content"], [class*="subtitle-text"], [class*="caption-text"], [class*="sentence"]'
  );

  const speaker = speakerEl?.textContent?.trim().replace(/:$/, '') || '';
  const rawText = (textEl || container).textContent?.trim() || '';
  const text = speaker && rawText.startsWith(speaker)
    ? rawText.slice(speaker.length).replace(/^[:\s]+/, '')
    : rawText;

  if (!text || text === lastExtractedText) return null;

  const time = new Date().toTimeString().slice(0, 8);
  return speaker ? `[${time}] ${speaker}: ${text}` : `[${time}] ${text}`;
}

// ─── Saving ───────────────────────────────────────────────────────────────────

function saveTranscript() {
  if (!transcript) return;
  chrome.runtime.sendMessage({
    type: 'SAVE_TRANSCRIPT',
    meetingId,
    meetingName,
    meetingDate,
    transcript: buildFileContent(),
  });
}

function buildFileContent() {
  return [
    `Meeting: ${meetingName}`,
    `Date:    ${meetingDate}`,
    `Lines:   ${lineCount}`,
    '─'.repeat(60),
    '',
    transcript,
  ].join('\n');
}

// ─── Meeting end ──────────────────────────────────────────────────────────────

function triggerFinalSave() {
  if (state === 'ENDED') return;
  state = 'ENDED';
  clearTimeout(finalSaveTimeout);
  finalSaveTimeout = setTimeout(() => {
    cleanup();
    saveTranscript();
    chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', status: { active: false } });
    console.log('[ZoomTranscript] Meeting ended — final save done');
  }, 300);
}

function cleanup() {
  clearInterval(saveInterval);
  clearInterval(urlPollInterval);
  captionObserver?.disconnect();
}

// ─── Element finders ──────────────────────────────────────────────────────────

function findCaptionContainer() {
  const selectors = [
    '.live-transcription-subtitle-container',
    '.subtitle-container',
    '[class*="live-transcription-subtitle"]',
    '[class*="subtitle-container"]',
    '[class*="transcription-subtitle"]',
    '[class*="live-transcription"]',
    '[class*="caption-container"]',
    '[class*="closed-caption"]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findTranscriptButton() {
  const attrSelectors = [
    'button[aria-label*="Live Transcript"]',
    'button[aria-label*="live transcript"]',
    'button[aria-label*="Transcript"]',
    'button[aria-label="CC"]',
    'button[aria-label*="Caption"]',
    'button[title*="Live Transcript"]',
    'button[title*="Transcript"]',
    '[class*="live-transcript"] button',
    '[class*="closed-caption"] button',
    '[class*="cc-button"]',
  ];
  for (const sel of attrSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  for (const btn of document.querySelectorAll('button')) {
    const label = getLabel(btn);
    if (/live.?transcript|closed.?caption|\bcc\b/i.test(label)) return btn;
  }
  return null;
}

function findMoreButton() {
  const attrSelectors = [
    'button[aria-label="More"]',
    'button[aria-label="more"]',
    'button[aria-label="More options"]',
    'button[title="More"]',
    'button[title="More options"]',
    '[class*="more-button"] button',
    '[class*="btn-more"]',
    '[class*="toolbar-more"] button',
  ];
  for (const sel of attrSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  for (const btn of document.querySelectorAll('button')) {
    const label = getLabel(btn).trim();
    if (/^(more|more options|…|\.{3})$/i.test(label)) return btn;
  }
  return null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getLabel(btn) {
  return (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').trim();
}

function extractMeetingName() {
  const selectors = [
    '[class*="meeting-topic"]',
    '[class*="meeting-info"] [class*="title"]',
    '[class*="topic"]',
    'div.meeting-title',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el?.textContent?.trim()) return el.textContent.trim();
  }
  return (document.title || 'Zoom Meeting').replace(/\s*[-–|]\s*Zoom\s*/i, '').trim() || 'Zoom Meeting';
}

function extractMeetingId(url) {
  const m = url.match(/\/wc\/([^/?#]+)/);
  return m ? m[1] : '';
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitizeFileName(name) {
  return (name || 'Zoom Meeting').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function setStatus(opts) {
  const safeName = sanitizeFileName(meetingName);
  chrome.runtime.sendMessage({
    type: 'UPDATE_STATUS',
    status: {
      active: opts.active || false,
      meetingName,
      label: meetingName,
      sub: opts.sub || '',
      lineCount,
      folderName: `${safeName} ${meetingDate}`,
    },
  });
}

function logDOMSnapshot() {
  const buttons = Array.from(document.querySelectorAll('button'))
    .map(b => getLabel(b))
    .filter(Boolean)
    .slice(0, 40);
  console.log('[ZoomTranscript] All buttons in DOM:', buttons);
  console.log('[ZoomTranscript] <video> count:', document.querySelectorAll('video').length);
  console.log('[ZoomTranscript] <canvas> count:', document.querySelectorAll('canvas').length);
  console.log('[ZoomTranscript] Page title:', document.title);
  console.log('[ZoomTranscript] URL:', window.location.href);
}
