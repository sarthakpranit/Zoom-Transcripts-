'use strict';

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, status => {
  const el = document.getElementById('content');

  if (!status || !status.active) {
    el.innerHTML = `
      <div class="row">
        <span class="dot dot-idle"></span>
        <span class="idle-text">No active meeting</span>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="row">
      <span class="dot dot-active"></span>
      <span class="meeting-name">${esc(status.meetingName)}</span>
    </div>
    <div class="meta">
      ${esc(status.lineCount)} line${status.lineCount === 1 ? '' : 's'} captured
    </div>
    <div class="path">
      ~/Downloads/Zoom Transcripts/${esc(status.folderName)}/transcript.txt
    </div>`;
});
