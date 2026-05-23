'use strict';

// ─── Message handling ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_TRANSCRIPT') {
    handleSave(message)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'UPDATE_STATUS') {
    chrome.storage.local.set({ currentStatus: message.status });
    return false;
  }

  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get('currentStatus', data => sendResponse(data.currentStatus || null));
    return true;
  }

  if (message.type === 'GET_SAVE_DIR_NAME') {
    getSaveDirName().then(name => sendResponse({ name })).catch(() => sendResponse({ name: null }));
    return true;
  }
});

// ─── Save logic ───────────────────────────────────────────────────────────────

async function handleSave({ meetingName, meetingDate, transcript }) {
  const safeName = sanitizeFileName(meetingName);
  const folderName = `${safeName} ${meetingDate}`;
  const content = transcript;

  // Try File System Access API first (user-chosen directory)
  const dirHandle = await getDirectoryHandle();
  if (dirHandle) {
    try {
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await writeViaFSA(dirHandle, folderName, content);
        return { via: 'fsa' };
      }
    } catch (e) {
      console.warn('[ZoomTranscript] FSA write failed, falling back to downloads:', e);
    }
  }

  // Fallback: chrome.downloads → ~/Downloads/Zoom Transcripts/
  await writeViaDownloads(folderName, content);
  return { via: 'downloads' };
}

async function writeViaFSA(rootHandle, folderName, content) {
  const subDir = await rootHandle.getDirectoryHandle(folderName, { create: true });
  const fileHandle = await subDir.getFileHandle('transcript.txt', { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(new TextEncoder().encode(content));
  await writable.close();
}

async function writeViaDownloads(folderName, content) {
  const filename = `Zoom Transcripts/${folderName}/transcript.txt`;
  const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUri, filename, conflictAction: 'overwrite', saveAs: false },
      downloadId => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(downloadId);
      }
    );
  });
}

// ─── IndexedDB — stores the FileSystemDirectoryHandle ────────────────────────
// FileSystemDirectoryHandle cannot be serialized to chrome.storage, so IndexedDB
// is used. Both the popup and service worker share the extension's IndexedDB.

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

async function getDirectoryHandle() {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('saveDir');
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror = e => reject(e.target.error);
    });
  } catch {
    return null;
  }
}

async function getSaveDirName() {
  const handle = await getDirectoryHandle();
  return handle ? handle.name : null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sanitizeFileName(name) {
  return (name || 'Zoom Meeting')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
