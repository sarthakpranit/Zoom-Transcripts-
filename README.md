# Zoom Transcript Saver

We've all been there — a great meeting, solid decisions made, and then you realize nobody saved the transcript. This Chrome extension fixes that by doing it automatically, every single time, without you ever having to think about it.

Just install it once and forget about it. Every Zoom meeting you join in the browser gets its own transcript file, saved to your Mac while the meeting is still happening.

---

## What it does

The moment you join a Zoom meeting in your browser, the extension quietly:

- Enables live transcription on your behalf (no clicks needed from you)
- Captures everything said, with timestamps and speaker names
- Saves it to `~/Downloads/Zoom Transcripts/[Meeting Name] [Date]/transcript.txt`
- Keeps saving every 60 seconds so nothing is lost if your browser crashes
- Writes a final save the moment you leave

The transcript file looks like this:

```
Meeting: Weekly Team Sync
Date: 2026-05-23
Lines: 47
────────────────────────────────────────────────────────────

[09:02:11] Sarah: Morning everyone, let's get started.
[09:02:18] Marcus: Quick note — the deploy went out last night without issues.
[09:02:34] Sarah: Perfect. So the main thing on the agenda today...
```

---

## Installation

This extension isn't on the Chrome Web Store — you load it directly. It takes about 60 seconds.

1. Download or clone this repository to your Mac
2. Open Chrome and go to `chrome://extensions`
3. Toggle on **Developer Mode** in the top-right corner
4. Click **Load unpacked** and select the folder you just downloaded
5. You're done

The extension icon will appear in your toolbar. You don't need to touch it — it just works in the background.

---

## How it works under the hood

When you land on a Zoom meeting page (`zoom.us/wc/...`), a content script wakes up and watches for the meeting interface to finish loading. Once it detects the toolbar, it automatically clicks the **Live Transcript** button and the **Enable Auto-Transcription** option in the menu that follows — the same steps you'd take manually, just done for you.

From there, it watches Zoom's caption elements using a `MutationObserver`. Every time a new line of text appears in the captions, it gets appended to the transcript with a timestamp. The file is saved via Chrome's downloads API, which writes directly to your filesystem without any popups or permission prompts.

---

## A few things worth knowing

**It only works with Zoom in the browser.** The Zoom desktop app runs outside of Chrome, so this extension can't reach it. If you typically use `zoom.us` links that open in the browser, you're good.

**The host controls Live Transcript.** Zoom's transcription feature can be disabled by the meeting host at the account level. If a host has turned it off for their organization, the extension won't be able to enable it — that's a Zoom restriction, not something we can work around. For most standard meetings, it's available.

**Transcripts land in your Downloads folder.** Specifically at `~/Downloads/Zoom Transcripts/`. Chrome extensions can't write to arbitrary locations on your filesystem without a permission prompt each time, so the Downloads folder is the cleanest automatic option. You can always move the folder to wherever you prefer after the fact.

---

## Debugging

If something seems off, open DevTools on the Zoom meeting tab and check the console — all log messages from the extension are prefixed with `[ZoomTranscript]`. You'll see when it detects the meeting, finds the CC button, and starts capturing.

The extension popup (click the icon in your toolbar) shows the current meeting name and how many lines have been captured so far.

---

## Contributing

Pull requests are welcome. If Zoom updates their web client and the selectors break, the relevant ones are at the top of `content.js` — they're organized into labeled arrays so they're easy to update.
