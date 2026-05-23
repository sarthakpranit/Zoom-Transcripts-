'use strict';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, status => {
  const el = document.getElementById('content');

  if (!status || (!status.active && !status.label)) {
    el.innerHTML = `
      <div class="row">
        <span class="dot dot-idle"></span>
        <span class="idle-text">No active Zoom meeting</span>
      </div>`;
    return;
  }

  if (status.active) {
    el.innerHTML = `
      <div class="row">
        <span class="dot dot-active"></span>
        <span class="meeting-name">${esc(status.meetingName || status.label)}</span>
      </div>
      <div class="meta">${esc(status.sub || `${status.lineCount} lines captured`)}</div>
      <div class="path">~/Downloads/Zoom Transcripts/${esc(status.folderName)}/transcript.txt</div>`;
    return;
  }

  // Intermediate state (searching / enabling)
  el.innerHTML = `
    <div class="row">
      <span class="dot dot-waiting"></span>
      <span class="meeting-name">${esc(status.label || 'Connecting…')}</span>
    </div>
    ${status.sub ? `<div class="meta">${esc(status.sub)}</div>` : ''}`;
});
