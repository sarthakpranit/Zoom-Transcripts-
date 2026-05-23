'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

let state = 'IDLE'; // IDLE | SEARCHING | ENABLING | CAPTURING | ENDED
let transcript = '';
let lastExtractedText = '';
let meetingName = '';
let meetingDate = '';
let meetingId = '';
let lineCount = 0;
let saveInterval = null;
let captionObserver = null;
let urlPollInterval = null;
let meetingPollInterval = null;
let finalSaveTimeout = null;

// ─── Entry Point ─────────────────────────────────────────────────────────────

init();

function init() {
  meetingDate = formatDate(new Date());
  meetingId = extractMeetingId(window.location.href) || `mtg-${Date.now()}`;

  state = 'SEARCHING';
  setStatus({ label: 'Searching for meeting…' });
  console.log('[ZoomTranscript] Content script loaded, watching for meeting UI');

  // Poll every 2s for meeting presence — more reliable than selector-based observers
  // for SPAs that load React/WASM content asynchronously
  meetingPollInterval = setInterval(pollForMeeting, 2000);
  pollForMeeting(); // run immediately too

  window.addEventListener('beforeunload', triggerFinalSave, { once: true });
  urlPollInterval = setInterval(() => {
    if (!window.location.href.includes('/wc/')) triggerFinalSave();
  }, 5000);
}

// ─── Phase 1: Detect active meeting ──────────────────────────────────────────

function pollForMeeting() {
  if (state !== 'SEARCHING') return;

  if (!isMeetingActive()) return;

  clearInterval(meetingPollInterval);
  meetingPollInterval = null;

  meetingName = extractMeetingName();
  console.log(`[ZoomTranscript] Meeting detected: "${meetingName}"`);
  logDOMSnapshot(); // helps debug selector issues

  state = 'ENABLING';
  setStatus({ label: `Meeting: ${meetingName}`, sub: 'Enabling transcription…' });

  // Small delay so interactive elements are fully hydrated
  setTimeout(tryEnableCaptions, 1500);
}

function isMeetingActive() {
  // Video streams are the most reliable indicator of an active Zoom meeting
  if (document.querySelectorAll('video').length > 0) return true;

  // Zoom-specific container IDs
  if (document.querySelector('#wc-container-left, #wc-container-right, #wc-content')) return true;

  // Mute/camera controls — always present in a live meeting
  for (const btn of document.querySelectorAll('button')) {
    const label = getButtonLabel(btn);
    if (/\b(mute|unmute|start video|stop video|join audio)\b/i.test(label)) return true;
  }

  return false;
}

// ─── Phase 2: Enable live transcript ─────────────────────────────────────────

let enableAttempts = 0;
const MAX_ENABLE_ATTEMPTS = 15; // 15 × 4s = 60s

function tryEnableCaptions() {
  if (state !== 'ENABLING') return;

  // If caption container is already in DOM, skip straight to capturing
  if (findCaptionContainer()) {
    console.log('[ZoomTranscript] Captions already active');
    startCapturing();
    return;
  }

  enableAttempts++;
  if (enableAttempts > MAX_ENABLE_ATTEMPTS) {
    console.warn('[ZoomTranscript] Could not enable captions after 60s. The meeting host may have disabled Live Transcript, or the Zoom UI has changed.');
    setStatus({ label: `Meeting: ${meetingName}`, sub: 'Transcript unavailable (host may have disabled it)' });
    return;
  }

  // Try path 1: direct CC/transcript button visible in toolbar
  const directBtn = findTranscriptButton();
  if (directBtn) {
    console.log('[ZoomTranscript] Found direct transcript button, clicking');
    directBtn.click();
    watchForSubmenu();
    return;
  }

  // Try path 2: open the "More / ..." menu first, then find transcript inside it
  const moreBtn = findMoreButton();
  if (moreBtn) {
    console.log('[ZoomTranscript] Clicking "More" to find transcript option');
    moreBtn.click();
    setTimeout(() => {
      const btn = findTranscriptButton();
      if (btn) {
        btn.click();
        watchForSubmenu();
      } else {
        // Close the menu and retry
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        setTimeout(tryEnableCaptions, 4000);
      }
    }, 800);
    return;
  }

  console.log(`[ZoomTranscript] Waiting for meeting controls (attempt ${enableAttempts}/${MAX_ENABLE_ATTEMPTS})…`);
  setTimeout(tryEnableCaptions, 4000);
}

function watchForSubmenu() {
  const deadline = Date.now() + 8000;

  const observer = new MutationObserver(() => {
    if (tryClickEnableTranscription()) {
      observer.disconnect();
      return;
    }
    // No submenu — might have toggled directly; check for caption container
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
      // Retry the whole enable flow
      setTimeout(tryEnableCaptions, 3000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  if (findCaptionContainer()) {
    observer.disconnect();
    startCapturing();
  }
}

// ─── Phase 3: Observe captions ───────────────────────────────────────────────

function startCapturing() {
  if (state === 'ENDED') return;
  state = 'CAPTURING';

  const container = findCaptionContainer();
  if (!container) {
    setTimeout(waitForCaptionContainer, 2000);
    return;
  }

  console.log('[ZoomTranscript] Caption observer active');
  setStatus({ label: meetingName, sub: '0 lines captured', active: true });

  // Observe the parent to survive React replacing the container node itself
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

  setStatus({ label: meetingName, sub: `${lineCount} line${lineCount === 1 ? '' : 's'} captured`, active: true });
}

function extractCaptionEntry(container) {
  const speakerEl = container.querySelector(
    '[class*="speaker"], [class*="name"], [class*="avatar"]'
  );
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

// ─── Meeting end ─────────────────────────────────────────────────────────────

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
  clearInterval(meetingPollInterval);
  captionObserver?.disconnect();
}

// ─── Finding elements ─────────────────────────────────────────────────────────

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
  // Aria-label / title based (most reliable across Zoom versions)
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

  // Fallback: scan all buttons
  for (const btn of document.querySelectorAll('button')) {
    const label = getButtonLabel(btn);
    if (/live.?transcript|closed.?caption|\bcc\b/i.test(label)) return btn;
  }
  return null;
}

function findMoreButton() {
  // "More" / "..." button that hides additional toolbar items
  const attrSelectors = [
    'button[aria-label="More"]',
    'button[aria-label="more"]',
    'button[aria-label="..."]',
    'button[title="More"]',
    '[class*="more-button"] button',
    '[class*="btn-more"] button',
    '[class*="toolbar-more"] button',
  ];
  for (const sel of attrSelectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }

  for (const btn of document.querySelectorAll('button')) {
    const label = getButtonLabel(btn);
    if (/^(more|…|\.{3})$/i.test(label.trim())) return btn;
  }
  return null;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function getButtonLabel(btn) {
  return (
    btn.getAttribute('aria-label') ||
    btn.getAttribute('title') ||
    btn.textContent ||
    ''
  ).trim();
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
  return (document.title || 'Zoom Meeting')
    .replace(/\s*[-–|]\s*Zoom\s*/i, '')
    .trim() || 'Zoom Meeting';
}

function extractMeetingId(url) {
  const m = url.match(/\/wc\/([^/?#]+)/);
  return m ? m[1] : '';
}

function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sanitizeFileName(name) {
  return (name || 'Zoom Meeting')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function setStatus(opts) {
  const safeName = sanitizeFileName(meetingName || 'Zoom Meeting');
  chrome.runtime.sendMessage({
    type: 'UPDATE_STATUS',
    status: {
      active: opts.active || false,
      meetingName: meetingName || opts.label || '',
      label: opts.label || '',
      sub: opts.sub || '',
      lineCount,
      folderName: `${safeName} ${meetingDate}`,
    },
  });
}

// Logs a snapshot of what's in the DOM — helps debug selector issues
function logDOMSnapshot() {
  const buttons = Array.from(document.querySelectorAll('button'))
    .slice(0, 30)
    .map(b => getButtonLabel(b))
    .filter(Boolean);
  console.log('[ZoomTranscript] Buttons found in DOM:', buttons);
  console.log('[ZoomTranscript] Video elements:', document.querySelectorAll('video').length);
  console.log('[ZoomTranscript] Page title:', document.title);
}
