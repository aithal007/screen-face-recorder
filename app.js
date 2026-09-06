/* =========================================================================
   Screen & Face Recorder
   Composites a screen capture + a webcam "face cam" onto a single canvas,
   mixes mic + system audio, and records the result as one video file.
   ========================================================================= */

const $ = (id) => document.getElementById(id);

/* ---------- elements ---------- */
const canvas    = $('canvas');
const ctx       = canvas.getContext('2d', { alpha: false });
const stage     = $('stage');
const camHandle = $('camHandle');
const camGrip   = $('camGrip');
const recBadge  = $('recBadge');
const statusEl  = $('status');
const toastEl   = $('toast');

/* hidden <video> elements act as the decode targets for each stream */
const screenVideo = makeVideo();
const camVideo    = makeVideo();

function makeVideo() {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  return v;
}

/* ---------- state ---------- */
const S = {
  screenStream: null,
  camStream: null,
  micStream: null,

  audioCtx: null,
  audioDest: null,
  micNode: null,
  sysNode: null,
  analyser: null,

  recorder: null,
  chunks: [],
  mime: '',

  recording: false,
  paused: false,
  startedAt: 0,
  pausedMs: 0,
  pauseStartedAt: 0,
  bytes: 0,

  rafId: 0,
  clock: null,       // Worker driving the frame clock
  ticking: false,
  lastDraw: 0,
  camRect: null,     // last drawn face-cam rect, in canvas pixels
};

/* face-cam geometry, normalized to canvas size (0..1) */
const cam = {
  x: 0.74, y: 0.70, w: 0.22,
  shape: 'rounded',
  radius: 0.18,      // fraction of the box's shorter side
  border: 4,
  mirror: true,
  shadow: true,
  visible: true,
};

const settings = { fps: 30, maxHeight: 1080, bitrate: 8_000_000 };

/* =========================================================================
   Helpers
   ========================================================================= */

function toast(msg, isErr = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', isErr);
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

const fmtSize = (b) => b < 1048576
  ? (b / 1024).toFixed(0) + ' KB'
  : (b / 1048576).toFixed(1) + ' MB';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

/* =========================================================================
   Canvas sizing — driven by the screen source (or camera if screen-only off)
   ========================================================================= */

function resizeCanvas() {
  let w = 1280, h = 720;

  if (screenVideo.videoWidth) {
    w = screenVideo.videoWidth;
    h = screenVideo.videoHeight;
  } else if (camVideo.videoWidth) {
    w = camVideo.videoWidth;
    h = camVideo.videoHeight;
  }

  if (settings.maxHeight && h > settings.maxHeight) {
    w = Math.round((w * settings.maxHeight) / h);
    h = settings.maxHeight;
  }

  // even dimensions keep encoders happy
  w -= w % 2;
  h -= h % 2;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  layoutHandle();
}

/* =========================================================================
   Drawing / compositing
   ========================================================================= */

function camBox() {
  const W = canvas.width, H = canvas.height;
  const dw = Math.round(cam.w * W);
  const aspect = camVideo.videoWidth
    ? camVideo.videoHeight / camVideo.videoWidth
    : 0.75;

  const dh = cam.shape === 'circle' ? dw : Math.round(dw * aspect);
  return { x: Math.round(cam.x * W), y: Math.round(cam.y * H), w: dw, h: dh };
}

/** Draw a video into a rect using "cover" fit (crop, never stretch). */
function drawCover(video, dx, dy, dw, dh) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(dw / vw, dh / vh);
  const sw = dw / scale, sh = dh / scale;
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, dx, dy, dw, dh);
}

function shapePath(x, y, w, h) {
  ctx.beginPath();
  if (cam.shape === 'circle') {
    ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2);
  } else if (cam.shape === 'square') {
    ctx.rect(x, y, w, h);
  } else {
    const r = Math.min(w, h) * cam.radius;
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }
}

function drawFrame(now) {
  const interval = 1000 / settings.fps;
  if (now - S.lastDraw < interval - 1) return;
  S.lastDraw = now;

  const W = canvas.width, H = canvas.height;
  const hasScreen = screenVideo.videoWidth > 0;
  const hasCam    = camVideo.videoWidth > 0;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (!hasScreen && !hasCam) {
    ctx.fillStyle = '#4a5670';
    ctx.font = `${Math.round(W / 42)}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('Share your screen or turn on the camera to begin',
                 W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }

  if (hasScreen) {
    ctx.drawImage(screenVideo, 0, 0, W, H);
  } else {
    // camera-only mode: the webcam fills the whole frame
    drawCover(camVideo, 0, 0, W, H);
    S.camRect = null;
    return;
  }

  if (!hasCam || !cam.visible) { S.camRect = null; return; }

  /* ---- face-cam overlay ---- */
  const b = camBox();
  S.camRect = b;

  ctx.save();

  if (cam.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(8, b.w * 0.09);
    ctx.shadowOffsetY = Math.max(3, b.w * 0.025);
    ctx.fillStyle = '#000';
    shapePath(b.x, b.y, b.w, b.h);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  shapePath(b.x, b.y, b.w, b.h);
  ctx.clip();

  if (cam.mirror) {
    ctx.translate(2 * b.x + b.w, 0);
    ctx.scale(-1, 1);
  }
  drawCover(camVideo, b.x, b.y, b.w, b.h);

  ctx.restore();

  if (cam.border > 0) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = cam.border;
    shapePath(b.x + cam.border / 2, b.y + cam.border / 2,
              b.w - cam.border, b.h - cam.border);
    ctx.stroke();
    ctx.restore();
  }
}

/* ---------------------------------------------------------------------------
   The frame clock.

   requestAnimationFrame stops firing entirely when the window is minimised or
   the tab is hidden — which is exactly when you switch away to record
   something, so the video would freeze on its last frame. The clock therefore
   lives in a Worker instead: worker timers keep firing while the page is not
   being rendered, and a page that is actively capturing media is exempt from
   Chrome's background timer throttling. rAF is kept only as a fallback for
   browsers where the Worker cannot be created.

   The worker just polls; drawFrame() does the throttling down to target fps.
   --------------------------------------------------------------------------- */
function startLoop() {
  if (S.ticking) return;
  S.ticking = true;

  const tick = () => drawFrame(performance.now());

  try {
    const src = 'let id=null;onmessage=function(e){clearInterval(id);' +
                'if(e.data>0){id=setInterval(function(){postMessage(0);},e.data);}};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    S.clock = new Worker(url);
    URL.revokeObjectURL(url);
    S.clock.onmessage = tick;
    S.clock.postMessage(8);
  } catch (err) {
    const raf = () => { tick(); S.rafId = requestAnimationFrame(raf); };
    S.rafId = requestAnimationFrame(raf);
  }
}

/* =========================================================================
   Drag & resize the face cam directly on the preview
   ========================================================================= */

function layoutHandle() {
  const show = cam.visible && camVideo.videoWidth > 0 && screenVideo.videoWidth > 0;
  camHandle.hidden = !show;
  if (!show) return;

  const b = camBox();
  camHandle.style.left   = (b.x / canvas.width) * 100 + '%';
  camHandle.style.top    = (b.y / canvas.height) * 100 + '%';
  camHandle.style.width  = (b.w / canvas.width) * 100 + '%';
  camHandle.style.height = (b.h / canvas.height) * 100 + '%';
}

let drag = null;

camHandle.addEventListener('pointerdown', (e) => {
  if (e.target === camGrip) return;
  const r = canvas.getBoundingClientRect();
  drag = { mode: 'move', px: e.clientX, py: e.clientY, ox: cam.x, oy: cam.y, r };
  camHandle.setPointerCapture(e.pointerId);
  e.preventDefault();
});

camGrip.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  drag = { mode: 'size', px: e.clientX, ow: cam.w, r };
  camGrip.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
});

function onDragMove(e) {
  if (!drag) return;
  const { r } = drag;

  if (drag.mode === 'move') {
    const dx = (e.clientX - drag.px) / r.width;
    const dy = (e.clientY - drag.py) / r.height;
    const b = camBox();
    cam.x = clamp(drag.ox + dx, 0, 1 - b.w / canvas.width);
    cam.y = clamp(drag.oy + dy, 0, 1 - b.h / canvas.height);
  } else {
    const dx = (e.clientX - drag.px) / r.width;
    cam.w = clamp(drag.ow + dx, 0.08, 0.6);
    cam.x = clamp(cam.x, 0, 1 - cam.w);
    $('rngSize').value = Math.round(cam.w * 100);
    $('valSize').textContent = Math.round(cam.w * 100) + '%';
  }
  clearCornerSelection();
  layoutHandle();
}

window.addEventListener('pointermove', onDragMove);
window.addEventListener('pointerup', () => { drag = null; });

/* =========================================================================
   Sources
   ========================================================================= */

async function toggleScreen() {
  if (S.screenStream) {
    stopStream(S.screenStream);
    S.screenStream = null;
    screenVideo.srcObject = null;
    disconnectSystemAudio();
    markSource('screen', false, 'Not shared');
    resizeCanvas();
    updateButtons();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: settings.fps }, cursor: 'always' },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    S.screenStream = stream;
    screenVideo.srcObject = stream;
    await screenVideo.play().catch(() => {});

    const vTrack = stream.getVideoTracks()[0];
    markSource('screen', true, vTrack.label || 'Screen');

    // the browser's own "Stop sharing" bar
    vTrack.addEventListener('ended', () => {
      if (S.recording) stopRecording();
      S.screenStream = null;
      screenVideo.srcObject = null;
      disconnectSystemAudio();
      markSource('screen', false, 'Not shared');
      resizeCanvas();
      updateButtons();
      toast('Screen sharing ended');
    });

    if (stream.getAudioTracks().length) connectSystemAudio(stream);

    screenVideo.addEventListener('loadedmetadata', resizeCanvas, { once: true });
    resizeCanvas();
    startLoop();
    updateButtons();
    setStatus('Ready to record', 'live');
  } catch (err) {
    if (err.name !== 'NotAllowedError') {
      toast('Could not capture the screen: ' + err.message, true);
    }
  }
}

async function toggleCam() {
  if (S.camStream) {
    stopStream(S.camStream);
    S.camStream = null;
    camVideo.srcObject = null;
    markSource('cam', false, 'Off');
    layoutHandle();
    resizeCanvas();
    updateButtons();
    return;
  }

  try {
    const id = $('selCam').value;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: id
        ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    S.camStream = stream;
    camVideo.srcObject = stream;
    await camVideo.play().catch(() => {});

    markSource('cam', true, stream.getVideoTracks()[0].label || 'Camera');
    camVideo.addEventListener('loadedmetadata', () => {
      resizeCanvas();
      layoutHandle();
    }, { once: true });

    resizeCanvas();
    layoutHandle();
    startLoop();
    listDevices();
    updateButtons();
  } catch (err) {
    toast('Could not open the camera: ' + err.message, true);
  }
}

async function toggleMic() {
  if (S.micStream) {
    stopStream(S.micStream);
    S.micStream = null;
    if (S.micNode) { S.micNode.disconnect(); S.micNode = null; }
    S.analyser = null;
    $('meterFill').style.width = '0%';
    markSource('mic', false, 'Off');
    return;
  }

  try {
    const id = $('selMic').value;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: id ? { deviceId: { exact: id } } : true,
      video: false,
    });

    S.micStream = stream;
    ensureAudio();

    S.micNode = S.audioCtx.createMediaStreamSource(stream);
    S.micNode.connect(S.audioDest);

    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 512;
    S.micNode.connect(S.analyser);
    pumpMeter();

    markSource('mic', true, stream.getAudioTracks()[0].label || 'Microphone');
    listDevices();
  } catch (err) {
    toast('Could not open the microphone: ' + err.message, true);
  }
}

function markSource(kind, on, label) {
  const btn = { screen: $('btnScreen'), cam: $('btnCam'), mic: $('btnMic') }[kind];
  btn.classList.toggle('on', on);
  $(kind + 'State').textContent = on ? 'on' : 'off';
  $(kind + 'Label').textContent = label;
}

/* =========================================================================
   Audio graph:  mic ─┐
                      ├─> MediaStreamDestination ─> recorder
       system audio ─┘
   ========================================================================= */

function ensureAudio() {
  if (!S.audioCtx) {
    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.audioDest = S.audioCtx.createMediaStreamDestination();
  }
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
}

function connectSystemAudio(stream) {
  ensureAudio();
  disconnectSystemAudio();
  S.sysNode = S.audioCtx.createMediaStreamSource(stream);
  S.sysNode.connect(S.audioDest);
}

function disconnectSystemAudio() {
  if (S.sysNode) { S.sysNode.disconnect(); S.sysNode = null; }
}

function pumpMeter() {
  const buf = new Uint8Array(256);
  const tick = () => {
    if (!S.analyser) return;
    S.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    $('meterFill').style.width = Math.min(100, (peak / 128) * 220) + '%';
    requestAnimationFrame(tick);
  };
  tick();
}

/* =========================================================================
   Recording
   ========================================================================= */

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (!S.screenStream && !S.camStream) {
    toast('Turn on the screen or camera first', true);
    return;
  }

  resizeCanvas();

  const mixed = canvas.captureStream(settings.fps);
  if (S.audioDest) {
    S.audioDest.stream.getAudioTracks().forEach((t) => mixed.addTrack(t));
  }

  S.mime = pickMime();
  const opts = { videoBitsPerSecond: settings.bitrate };
  if (S.mime) opts.mimeType = S.mime;

  try {
    S.recorder = new MediaRecorder(mixed, opts);
  } catch (err) {
    toast('Recorder could not start: ' + err.message, true);
    return;
  }

  S.chunks = [];
  S.bytes = 0;

  S.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      S.chunks.push(e.data);
      S.bytes += e.data.size;
      $('size').textContent = fmtSize(S.bytes);
    }
  };
  S.recorder.onstop = finalize;
  S.recorder.onerror = (e) =>
    toast('Recording error: ' + (e.error?.message || 'unknown'), true);

  S.recorder.start(1000);   // emit a chunk every second so size updates live

  S.recording = true;
  S.paused = false;
  S.startedAt = performance.now();
  S.pausedMs = 0;
  recBadge.hidden = false;
  tickTimer();
  lockSettings(true);
  updateButtons();
  setStatus('Recording…', 'live');
}

function pauseRecording() {
  if (!S.recording) return;
  if (!S.paused) {
    S.recorder.pause();
    S.paused = true;
    S.pauseStartedAt = performance.now();
    recBadge.hidden = true;
    setStatus('Paused');
  } else {
    S.recorder.resume();
    S.paused = false;
    S.pausedMs += performance.now() - S.pauseStartedAt;
    recBadge.hidden = false;
    setStatus('Recording…', 'live');
  }
  updateButtons();
}

function stopRecording() {
  if (!S.recording) return;
  S.recording = false;
  S.paused = false;
  recBadge.hidden = true;
  try { S.recorder.stop(); } catch {}
  lockSettings(false);
  updateButtons();
  setStatus('Saving…');
}

function finalize() {
  const type = (S.mime || 'video/webm').split(';')[0];
  const blob = new Blob(S.chunks, { type });
  S.chunks = [];

  const ext = type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const name = `recording-${stamp}.${ext}`;
  const url = URL.createObjectURL(blob);
  const dur = elapsed();

  addTake({ name, url, size: blob.size, dur });

  // hand the file straight to the browser's downloads
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();

  setStatus('Saved ' + name, 'live');
  toast('Saved ' + name + ' (' + fmtSize(blob.size) + ')');
}

function addTake({ name, url, size, dur }) {
  $('takes').hidden = false;
  const li = document.createElement('li');

  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;

  const m = document.createElement('span');
  m.className = 'meta';
  m.textContent = `${fmtTime(dur)} · ${fmtSize(size)}`;

  const play = document.createElement('a');
  play.href = url; play.target = '_blank'; play.textContent = 'Play';

  const dl = document.createElement('a');
  dl.href = url; dl.download = name; dl.textContent = 'Download';

  li.append(n, m, play, dl);
  $('takesList').prepend(li);
}

const elapsed = () =>
  S.startedAt
    ? performance.now() - S.startedAt - S.pausedMs -
      (S.paused ? performance.now() - S.pauseStartedAt : 0)
    : 0;

function tickTimer() {
  if (!S.recording) return;
  $('timer').textContent = fmtTime(elapsed());
  setTimeout(tickTimer, 200);
}

/* =========================================================================
   UI wiring
   ========================================================================= */

function updateButtons() {
  const any = !!(S.screenStream || S.camStream);
  $('btnRecord').disabled = S.recording || !any;
  $('btnPause').disabled = !S.recording;
  $('btnStop').disabled = !S.recording;
  $('btnPause').textContent = S.paused ? 'Resume' : 'Pause';
}

function lockSettings(locked) {
  ['selRes', 'selFps', 'selQual'].forEach((id) => { $(id).disabled = locked; });
}

$('btnScreen').onclick = toggleScreen;
$('btnCam').onclick    = toggleCam;
$('btnMic').onclick    = toggleMic;
$('btnRecord').onclick = startRecording;
$('btnPause').onclick  = pauseRecording;
$('btnStop').onclick   = stopRecording;

/* shape */
$('segShape').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  [...$('segShape').children].forEach((x) => x.classList.toggle('on', x === b));
  cam.shape = b.dataset.shape;
  $('rngRadius').disabled = cam.shape !== 'rounded';
  layoutHandle();
});

/* sliders */
$('rngSize').oninput = (e) => {
  cam.w = +e.target.value / 100;
  cam.x = clamp(cam.x, 0, 1 - cam.w);
  $('valSize').textContent = e.target.value + '%';
  layoutHandle();
};
$('rngBorder').oninput = (e) => {
  cam.border = +e.target.value;
  $('valBorder').textContent = e.target.value + ' px';
};
$('rngRadius').oninput = (e) => {
  cam.radius = +e.target.value / 100;
  $('valRadius').textContent = e.target.value + '%';
};

/* corner snapping */
function clearCornerSelection() {
  document.querySelectorAll('.corner-grid button')
    .forEach((b) => b.classList.remove('on'));
}
document.querySelector('.corner-grid').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  clearCornerSelection();
  b.classList.add('on');

  const pad = 0.025;
  const box = camBox();
  const hFrac = box.h / canvas.height;
  const c = b.dataset.corner;
  cam.x = c[1] === 'l' ? pad : 1 - cam.w - pad;
  cam.y = c[0] === 't' ? pad : 1 - hFrac - pad;
  layoutHandle();
});

/* checkboxes */
$('chkMirror').onchange  = (e) => { cam.mirror = e.target.checked; };
$('chkShadow').onchange  = (e) => { cam.shadow = e.target.checked; };
$('chkShowCam').onchange = (e) => { cam.visible = e.target.checked; layoutHandle(); };

/* quality */
$('selRes').onchange  = (e) => { settings.maxHeight = +e.target.value; resizeCanvas(); };
$('selFps').onchange  = (e) => { settings.fps = +e.target.value; };
$('selQual').onchange = (e) => { settings.bitrate = +e.target.value; };

/* device pickers — restart the stream on change if it's already live */
$('selCam').onchange = async () => { if (S.camStream) { await toggleCam(); await toggleCam(); } };
$('selMic').onchange = async () => { if (S.micStream) { await toggleMic(); await toggleMic(); } };

/* keyboard */
window.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') { e.preventDefault(); S.recording ? stopRecording() : startRecording(); }
  if (k === 'p') { e.preventDefault(); pauseRecording(); }
});

window.addEventListener('beforeunload', (e) => {
  if (S.recording) { e.preventDefault(); e.returnValue = ''; }
});

/* =========================================================================
   Device enumeration + boot
   ========================================================================= */

async function listDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    fill($('selCam'), devs.filter((d) => d.kind === 'videoinput'), 'Default camera');
    fill($('selMic'), devs.filter((d) => d.kind === 'audioinput'), 'Default microphone');
  } catch {}

  function fill(sel, list, placeholder) {
    const keep = sel.value;
    sel.innerHTML = '';
    sel.append(new Option(placeholder, ''));
    list.forEach((d, i) =>
      sel.append(new Option(d.label || `Device ${i + 1}`, d.deviceId)));
    sel.value = keep;
  }
}

function boot() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('This browser cannot capture the screen — use Chrome or Edge', 'err');
    $('btnScreen').disabled = true;
  }

  const mime = pickMime();
  $('fmtHint').textContent = mime
    ? 'Output format: ' + mime
    : 'No supported recording format found in this browser.';

  $('rngRadius').disabled = cam.shape !== 'rounded';

  resizeCanvas();
  startLoop();
  listDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);
  updateButtons();
}

boot();
