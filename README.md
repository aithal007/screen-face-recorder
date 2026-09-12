# Screen & Face Recorder

Records your screen and your webcam **into a single video file**, with your face
shown in a small movable box on top of the screen — like Loom.

No installation, no build step, no dependencies. It's three files and a browser.

## Run it

Double-click **`start.bat`**, or from a terminal in this folder:

```
python -m http.server 8000
```

then open <http://localhost:8000/>.

> **Don't open `index.html` by double-clicking it.** Chrome only grants camera,
> microphone and screen access on a *secure context*. `http://localhost` counts
> as one; `file://` does not, so the camera would silently fail.

Use **Chrome or Edge**. Firefox works but has no system-audio capture; Safari
does not support `getDisplayMedia` with audio at all.

## How to record

1. Click **Screen** and choose a screen, window, or browser tab.
   Tick *"Also share system audio"* in the picker if you want computer sound.
2. Click **Camera**, then **Microphone**.
3. Position the face cam — drag it anywhere on the preview, or drag the blue
   grip at its corner to resize. The corner buttons snap it into place.
4. Hit **Record**. Use **Pause / Resume** freely; paused time is not recorded.
5. **Stop** — the file downloads automatically and also appears under
   *Recordings this session* so you can replay it.

Shortcuts: `Alt+R` start/stop, `Alt+P` pause/resume.

## Reading a script while you record — without it being in the video

Paste your talking points into the **Script** box in the sidebar and click
**Open floating teleprompter**. It opens in its own window with autoscroll
(`Space` to play/pause, drag it anywhere, resize the text with `A−`/`A+`).

The one rule that makes it invisible in the recording: **when you share your
screen, pick a Window or a Chrome Tab — never Entire Screen.**

Window and tab capture read pixels directly from that one surface's own
render buffer, not from the monitor, so a separate window floating on top —
the teleprompter included — was never part of that buffer and can't appear in
the recording, no matter where you place it. *Entire Screen* capture is the
one mode where this doesn't hold, because that really does grab everything
visible on the monitor, teleprompter included.

## How it works

The preview you see **is** the recording — there is no separate render step.

```
screen  ──> <video> ─┐
                     ├─> <canvas> ──> captureStream(fps) ──┐
camera  ──> <video> ─┘                                     ├─> MediaRecorder ──> .webm
                                                           │
mic     ──> MediaStreamSource ─┐                           │
                               ├─> MediaStreamDestination ─┘
system  ──> MediaStreamSource ─┘
```

Every frame, `drawFrame()` paints the screen video across the whole canvas, then
clips the webcam into the face-cam shape and draws it on top. Audio is a
separate graph: mic and system audio are summed into one destination node, whose
track is attached to the same recorder. Because both come off one `MediaRecorder`,
video and audio stay in sync — this is why the app composites rather than
recording two files and merging them later.

### Files

| File | What's in it |
| --- | --- |
| [index.html](index.html) | Markup and the control panel |
| [styles.css](styles.css) | Dark theme, layout, the drag handle |
| [app.js](app.js) | Capture, compositing, audio mixing, recording |

Worth knowing in `app.js`:

- `drawFrame()` — the compositor; throttled to the chosen frame rate.
- `camBox()` — face-cam rect. Position and size are stored **normalized (0–1)**,
  so the overlay lands identically whether you record at 480p or 4K.
- `resizeCanvas()` — canvas matches the shared screen's aspect ratio, capped to
  the chosen resolution and forced to even dimensions for the encoder.
- `pickMime()` — picks the best container the browser supports, VP9 first.

## Settings

**Resolution** and **frame rate** set the canvas and capture rate.
**Bitrate** trades file size against quality — 8 Mbps is good for 1080p text.
Resolution/fps/bitrate lock while recording, since resizing the canvas
mid-recording would break the capture stream.

Face cam: rounded / circle / square, size, border width, corner radius, drop
shadow, and a **mirror** toggle (on by default — mirrored looks natural to you,
but turn it off if you're showing text on camera).

## Known limits

- Output is `.webm` (VP9/Opus). Chrome cannot record `.mp4` directly. To convert:
  `ffmpeg -i recording.webm -c:v libx264 -c:a aac recording.mp4`
- **System audio** only comes through if you tick that box in Chrome's picker,
  and Chrome only offers it for a *tab* or *entire screen*, not a single window.
- The recording lives in memory until you stop, so extremely long sessions can
  get heavy. For hour-plus recordings, lower the bitrate.
- The webcam box is drawn onto the video permanently — it can't be moved after
  the fact. Position it before you hit Record.

## Deploying

The app is three static files with no backend, no build step and no API keys,
so any static host works. The only hard requirement is **HTTPS** — browsers
refuse camera, microphone and screen capture outside a secure context.

Nothing is uploaded when someone records: capture, compositing and encoding all
happen in the visitor's browser, and the file is saved straight to their
downloads. The server only ever hands out the three files.

### GitHub Pages

```
gh auth login                        # once, interactive
gh repo create screen-face-recorder --public --source=. --push
gh api -X POST repos/:owner/screen-face-recorder/pages \
  -f build_type=legacy -f 'source[branch]=main' -f 'source[path]=/'
```

Live at `https://<user>.github.io/screen-face-recorder/` after a minute or so.
To update, just `git push` — Pages redeploys itself.

Note that Pages on a free account requires a **public** repo, so the source is
visible to anyone. That is fine here — there are no secrets in it.

### Anything else

Netlify, Cloudflare Pages, Vercel and friends all take this folder as-is;
point them at the repo, leave the build command blank, and set the publish
directory to the project root. The [`_headers`](_headers) file sets a
permissive `Permissions-Policy` for camera, microphone and display capture on
hosts that read it (Netlify, Cloudflare). GitHub Pages ignores that file but
sends no restrictive policy of its own, so capture works there regardless.

[`start.bat`](start.bat) is only for local development and is harmless in a
deploy — it is never served as anything but a static file.

## Next steps

The compositing code here is exactly what an Electron renderer would run, so
wrapping this into a real `.exe` later means adding a main process and swapping
`getDisplayMedia` for `desktopCapturer` — the drawing and recording stay as they are.
