'use strict';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_TRANSCRIPT') {
    handleSave(message).then(id => sendResponse({ success: true, downloadId: id }))
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
});

async function handleSave({ meetingId, meetingName, meetingDate, transcript }) {
  const safeName = sanitizeFileName(meetingName);
  const folder = `Zoom Transcripts/${safeName} ${meetingDate}`;
  const filename = `${folder}/transcript.txt`;

  const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(transcript);

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUri, filename, conflictAction: 'overwrite', saveAs: false },
      downloadId => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(downloadId);
        }
      }
    );
  });
}

function sanitizeFileName(name) {
  return name
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
