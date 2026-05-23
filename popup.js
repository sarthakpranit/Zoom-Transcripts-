'use strict';

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Meeting status ───────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, status => {
  const el = document.getElementById('status');

  if (!status || (!status.active && !status.label)) {
    el.innerHTML = `<div class="row"><span class="dot dot-idle"></span><span class="idle-text">No active Zoom meeting</span></div>`;
    return;
  }

  if (status.active) {
    el.innerHTML = `
      <div class="row">
        <span class="dot dot-active"></span>
        <span class="meeting-name">${esc(status.meetingName || status.label)}</span>
      </div>
      <div class="meta">${esc(status.sub || `${status.lineCount} lines captured`)}</div>`;
    return;
  }

  el.innerHTML = `
    <div class="row">
      <span class="dot dot-waiting"></span>
      <span class="meeting-name">${esc(status.label || 'Connecting…')}</span>
    </div>
    ${status.sub ? `<div class="meta">${esc(status.sub)}</div>` : ''}`;
});

// ─── Save folder ──────────────────────────────────────────────────────────────

const DB_NAME = 'ZoomTranscriptDB';
const STORE = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function getStoredHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('saveDir');
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror = e => reject(e.target.error);
  });
}

async function storeHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, 'saveDir');
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

async function loadFolderLabel() {
  const handle = await getStoredHandle();
  const label = document.getElementById('folder-label');
  if (handle) {
    label.textContent = handle.name;
    label.classList.remove('unset');
  }
}

loadFolderLabel().catch(() => {});

document.getElementById('folder-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('folder-error');
  errEl.style.display = 'none';
  try {
    const handle = await window.showDirectoryPicker({
      id: 'zoomTranscripts',
      startIn: 'documents',
      mode: 'readwrite',
    });
    await storeHandle(handle);
    const label = document.getElementById('folder-label');
    label.textContent = handle.name;
    label.classList.remove('unset');
  } catch (e) {
    if (e.name !== 'AbortError') {
      errEl.textContent = 'Could not access folder: ' + e.message;
      errEl.style.display = 'block';
    }
  }
});
