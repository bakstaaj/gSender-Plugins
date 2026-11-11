const storagePromise = import('@sienci/gsender-plugin-sdk').then((sdk) => sdk.storage).catch(() => ({
  get: async (key) => JSON.parse(localStorage.getItem(key) || 'null'),
  set: async (key, value) => localStorage.setItem(key, JSON.stringify(value)),
}));
import './style.css';

const $ = (id) => document.getElementById(id);
const defaults = { sourceType: 'usb', protocol: 'http', host: '', port: '', path: '/video', startMessage: 'start_stream', refreshMs: '500', deviceId: '' };
const state = { stream: null, socket: null, snapshotTimer: null, healthTimer: null, frameTimer: null, objectUrl: null, running: false, profile: 'primary', sourceType: '', connectedAt: 0, lastFrameAt: 0, frameTimes: [], zoom: 1, flipped: false, rotation: 0, activeSettings: null, toolbarCollapsed: false };

function id(profile, key) { return profile === 'primary' ? key : `second${key[0].toUpperCase()}${key.slice(1)}`; }
function readForm(profile = 'primary') {
  return { sourceType: $(id(profile, 'sourceType')).value, protocol: $(id(profile, 'protocol')).value, host: $(id(profile, 'host')).value.trim(), port: $(id(profile, 'port')).value.trim(), path: $(id(profile, 'path')).value.trim() || '/', startMessage: $(id(profile, 'startMessage')).value, refreshMs: $(id(profile, 'refreshMs')).value, deviceId: $(id(profile, 'device')).value };
}
function buildUrl(s) {
  const host = s.host.trim(), port = s.port.trim();
  if (!host) throw new Error('Enter the camera IP address or host name.');
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Enter a camera port from 1 to 65535.');
  const path = s.path.startsWith('/') ? s.path : `/${s.path}`;
  const url = new URL(`${s.protocol}://${host}${port ? `:${port}` : ''}${path}`);
  if (url.username || url.password) throw new Error('Do not put credentials in the host field.');
  return url.toString();
}
function setMessage(text, kind = '') { $('message').textContent = text; $('message').className = `message ${kind}`; }
function setStatus(text, kind = '') { $('status').textContent = text; $('status').className = `status ${kind}`; }
function setHealth(text, kind = '') { const el = $('feedHealth'); el.className = `feed-health ${kind}`; el.querySelector('span').textContent = text; }
function updateToolbar() {
  $('previewToolbar').classList.toggle('toolbar-collapsed', state.toolbarCollapsed);
  $('togglePreviewToolbar').innerHTML = state.toolbarCollapsed
    ? '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 9 7 7 7-7" /></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 15 7-7 7 7" /></svg>';
  $('togglePreviewToolbar').setAttribute('aria-expanded', String(!state.toolbarCollapsed));
  $('togglePreviewToolbar').setAttribute('aria-label', state.toolbarCollapsed ? 'Show camera controls' : 'Hide camera controls');
  $('togglePreviewToolbar').title = state.toolbarCollapsed ? 'Show camera controls' : 'Hide camera controls';
}
function updateForm(profile = 'primary') {
  const source = $(id(profile, 'sourceType')), protocol = $(id(profile, 'protocol'));
  const type = source.value, usb = type === 'usb', ws = type === 'websocket';
  for (const key of ['protocolWrap', 'hostWrap', 'portWrap', 'pathWrap']) $(profile === 'primary' ? key : `second${key[0].toUpperCase()}${key.slice(1)}`).hidden = usb;
  $(id(profile, 'deviceWrap')).hidden = !usb;
  $(profile === 'primary' ? 'wsOptions' : 'secondWsOptions').hidden = !ws;
  $(profile === 'primary' ? 'snapshotOptions' : 'secondSnapshotOptions').hidden = type !== 'snapshot';
  $(profile === 'primary' ? 'bridgeLinks' : 'secondBridgeLinks').hidden = type !== 'bridge';
  const urlEl = $(profile === 'primary' ? 'urlPreview' : 'secondUrlPreview');
  urlEl.hidden = usb;
  if (ws && ['http', 'https'].includes(protocol.value)) protocol.value = 'ws';
  if (!ws && ['ws', 'wss'].includes(protocol.value)) protocol.value = 'http';
  if (!usb) { try { urlEl.textContent = `Stream URL: ${buildUrl(readForm(profile))}`; } catch { urlEl.textContent = 'Enter a host and stream path to build the stream URL.'; } }
  updateCameraSwitch();
}
async function populateDevices(profile = 'primary') {
  try {
    const select = $(id(profile, 'device'));
    const devices = await navigator.mediaDevices?.enumerateDevices?.() || [];
    const cams = devices.filter((d) => d.kind === 'videoinput'), previous = select.value;
    select.replaceChildren(new Option(cams.length ? 'Choose a camera' : 'No camera found', ''));
    cams.forEach((d, i) => select.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    if (cams.some((d) => d.deviceId === previous)) select.value = previous;
  } catch { /* Device names may be hidden before permission. */ }
}
function secondConfigured() {
  if (!$('secondEnabled').checked) return false;
  const s = readForm('second');
  if (s.sourceType === 'usb') return Boolean(s.deviceId);
  try { buildUrl(s); return true; } catch { return false; }
}
function updateCameraSwitch() {
  const configured = secondConfigured();
  $('cameraSwitcher').hidden = !configured;
  $('secondCameraConfig').hidden = !$('secondEnabled').checked;
}
function applyPictureSettings() {
  const transform = `rotate(${state.rotation}deg) scale(${state.zoom}) scaleX(${state.flipped ? -1 : 1})`;
  for (const el of [$('image'), $('video'), $('bridgeFrame')]) el.style.transform = transform;
}
function resetPictureSettings() { state.zoom = 1; state.flipped = false; state.rotation = 0; applyPictureSettings(); }
function showPreview(kind) { $('placeholder').hidden = true; $('frameBadge').hidden = false; $('image').hidden = kind !== 'image'; $('video').hidden = kind !== 'video'; $('bridgeFrame').hidden = kind !== 'bridge'; }
async function openUsbCamera(settings) {
  const deviceId = settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {};
  const profiles = [
    { ...deviceId, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 15, max: 30 } },
    { ...deviceId, width: { ideal: 640, max: 640 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 10, max: 15 } },
  ];
  let lastError;
  for (let index = 0; index < profiles.length; index += 1) {
    try { return await navigator.mediaDevices.getUserMedia({ video: profiles[index], audio: false }); }
    catch (error) {
      lastError = error;
      if (index === profiles.length - 1 || !['AbortError', 'NotReadableError'].includes(error?.name)) throw error;
    }
  }
  throw lastError;
}
function explainCameraError(error) {
  if (error?.name === 'AbortError' && /Timeout starting video source/i.test(error.message || '')) {
    return 'Windows timed out starting this camera. Close other apps using it, then retry. If it still fails, test it in the Windows Camera app and check Settings > Privacy & security > Camera > Let desktop apps access your camera.';
  }
  if (error?.name === 'NotReadableError') return 'The camera could not be opened. Close other apps using it and retry; if it persists, check Windows camera privacy settings or the camera driver.';
  if (error?.name === 'NotAllowedError') return 'Camera access was denied. Allow Camera access for gSender and desktop apps in Windows Settings, then connect again.';
  return error?.message || String(error);
}
function stopTimers() { if (state.snapshotTimer) clearInterval(state.snapshotTimer); if (state.healthTimer) clearInterval(state.healthTimer); if (state.frameTimer) clearTimeout(state.frameTimer); state.snapshotTimer = state.healthTimer = state.frameTimer = null; }
function clearPreview() {
  stopTimers();
  if (state.socket) { state.socket.onclose = null; try { state.socket.close(); } catch { /* Already closed. */ } }
  state.socket = null;
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  $('image').removeAttribute('src'); $('video').pause(); $('video').removeAttribute('src'); $('video').srcObject = null; $('video').load(); $('bridgeFrame').removeAttribute('src');
  $('image').hidden = true; $('video').hidden = true; $('bridgeFrame').hidden = true; $('placeholder').hidden = false; $('frameBadge').hidden = true;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null; state.running = false; state.connectedAt = 0; state.lastFrameAt = 0; state.frameTimes = [];
  $('connect').disabled = false; $('disconnect').disabled = true; $('quickConnect').hidden = false; $('quickDisconnect').hidden = true; setStatus('Not connected'); setHealth('Camera off');
}
function recordFrame() {
  const now = Date.now(); state.lastFrameAt = now; state.frameTimes.push(now); state.frameTimes = state.frameTimes.filter((t) => now - t < 5000);
  const el = $('video').hidden ? $('image') : $('video');
  const w = el === $('video') ? el.videoWidth : el.naturalWidth, h = el === $('video') ? el.videoHeight : el.naturalHeight;
  const fps = state.frameTimes.length > 1 ? Math.round((state.frameTimes.length - 1) / ((state.frameTimes.at(-1) - state.frameTimes[0]) / 1000)) : 0;
  const dimensions = w && h ? ` · ${w}×${h}` : '';
  setHealth(`Live${fps > 0 ? ` · ${fps} fps` : ''}${dimensions}`, 'live');
  if (state.frameTimer) clearTimeout(state.frameTimer);
  const timeout = state.sourceType === 'snapshot' ? Math.max(3500, (Number(state.activeSettings?.refreshMs) || 500) * 4) : 4000;
  state.frameTimer = setTimeout(() => { if (state.running) setHealth('No recent frame', 'stale'); }, timeout);
}
function startHealth() {
  state.healthTimer = setInterval(() => {
    if (!state.running) return;
    if (state.sourceType === 'bridge') {
      setHealth('Bridge viewer open · check video', 'live');
    } else if (state.sourceType === 'mjpeg') {
      if (!state.lastFrameAt) setHealth('Connected · frame timing unavailable', 'live');
    } else if (Date.now() - (state.lastFrameAt || state.connectedAt) > 4000) setHealth('No recent frame', 'stale');
  }, 1000);
}
function showJpeg(data) {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
  state.objectUrl = URL.createObjectURL(blob); $('image').src = state.objectUrl;
}
async function connectWs(url, message) {
  const ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; state.socket = ws;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The camera did not open the WebSocket connection within 8 seconds.')), 8000);
    ws.onopen = () => { clearTimeout(timer); if (message) ws.send(message); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed. Check IP, port, path, camera network access, and browser policy.')); };
  });
  ws.onmessage = (event) => { if (event.data instanceof Blob || event.data instanceof ArrayBuffer) showJpeg(event.data); };
  ws.onclose = () => { if (state.running) { clearPreview(); setStatus('Connection closed', 'error'); setMessage('The camera connection closed. Check the camera and reconnect.', 'error'); } };
}
async function saveSettings(show = true, autoConnect = false) {
  const settings = { ...readForm(), secondEnabled: $('secondEnabled').checked, secondCamera: readForm('second'), autoConnect, activeProfile: state.profile };
  try { await (await storagePromise).set('camera-monitor.settings', settings); if (show) setMessage('Camera settings saved in gSender.', 'success'); }
  catch (error) { if (show) setMessage(`Could not save settings in gSender: ${error?.message || error}`, 'error'); }
}
async function connectCamera(profile = 'primary', persist = true) {
  clearPreview();
  if (profile === 'second' && !secondConfigured()) { setMessage('Configure and save the second camera before switching to it.', 'error'); return; }
  state.profile = profile; state.activeSettings = readForm(profile); state.sourceType = state.activeSettings.sourceType;
  const s = state.activeSettings;
  $('connect').disabled = true; setStatus('Connecting', 'connecting'); setHealth('Connecting'); setMessage(`Opening ${profile === 'second' ? 'second' : 'primary'} camera feed…`);
  try {
    if (s.sourceType === 'usb') {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('USB camera access is unavailable in this gSender view.');
      state.stream = await openUsbCamera(s); $('video').srcObject = state.stream; showPreview('video'); await $('video').play(); await Promise.all([populateDevices('primary'), populateDevices('second')]); updateCameraSwitch();
    } else {
      const url = buildUrl(s);
      if (s.sourceType === 'bridge') { const target = new URL(url); if (!['http:', 'https:'].includes(target.protocol)) throw new Error('The local bridge viewer must use HTTP or HTTPS.'); $('bridgeFrame').src = url; showPreview('bridge'); }
      else if (s.sourceType === 'websocket') { if (!['ws:', 'wss:'].includes(new URL(url).protocol)) throw new Error('Select ws or wss for a WebSocket camera.'); await connectWs(url, s.startMessage); showPreview('image'); }
      else if (s.sourceType === 'mjpeg') { $('image').src = url; showPreview('image'); }
      else if (s.sourceType === 'snapshot') { const frame = () => { const u = new URL(url); u.searchParams.set('_camera_frame', String(Date.now())); $('image').src = u.toString(); }; frame(); state.snapshotTimer = setInterval(frame, Number(s.refreshMs) || 500); showPreview('image'); }
      else { $('video').src = url; showPreview('video'); await $('video').play().catch(() => {}); if ($('video').error) throw new Error('This Chromium build could not play the supplied video URL or codec.'); }
    }
    state.running = true; state.connectedAt = Date.now(); $('disconnect').disabled = false; $('quickConnect').hidden = true; $('quickDisconnect').hidden = false; resetPictureSettings(); startHealth();
    if (s.sourceType === 'bridge') { setStatus('Opening local viewer', 'connecting'); setMessage('Local bridge viewer opened. Confirm the live image and status inside the preview.', 'success'); setHealth('Bridge viewer open · check video', 'live'); }
    else if (s.sourceType === 'mjpeg') { setStatus('Connected', 'connecting'); setHealth('Connected · frame timing unavailable', 'live'); setMessage('Camera connected. MJPEG frame timing is not exposed by this browser.'); }
    else { setStatus('Live', 'live'); setMessage('Camera connected. The view does not send commands to the CNC.', 'success'); setHealth(['websocket', 'snapshot', 'bridge'].includes(s.sourceType) ? 'Connected · stream status shown by bridge' : 'Waiting for video frames'); }
    $('showPrimary').classList.toggle('active', profile === 'primary'); $('showSecondary').classList.toggle('active', profile === 'second');
    if (persist) await saveSettings(false, true);
  } catch (error) {
    clearPreview(); setStatus('Connection failed', 'error'); setHealth('Feed unavailable', 'stale');
    setMessage(explainCameraError(error), 'error');
  }
}
function restoreProfile(profile, settings) {
  const s = { ...defaults, ...(settings || {}) };
  for (const [key, value] of Object.entries(s)) { const element = $(id(profile, key)); if (element) element.value = value ?? ''; }
}
async function loadSettings() {
  const storage = await storagePromise;
  let saved = null; try { saved = await storage.get('camera-monitor.settings'); } catch { /* First run. */ }
  const oldDevice = await storage.get('camera-monitor.deviceId').catch(() => '');
  const primary = saved?.primary || saved || {};
  restoreProfile('primary', { ...primary, deviceId: primary.deviceId || oldDevice });
  restoreProfile('second', saved?.secondCamera || {});
  $('secondEnabled').checked = Boolean(saved?.secondEnabled);
  state.profile = saved?.activeProfile === 'second' && $('secondEnabled').checked ? 'second' : 'primary';
  await Promise.all([populateDevices('primary'), populateDevices('second')]);
  if (primary.deviceId) $('device').value = primary.deviceId;
  updateForm('primary'); updateForm('second');
  if (saved?.autoConnect) await connectCamera(saved.activeProfile === 'second' && secondConfigured() ? 'second' : 'primary', false);
}

$('sourceType').addEventListener('change', () => updateForm('primary'));
$('protocol').addEventListener('change', () => updateForm('primary'));
$('secondSourceType').addEventListener('change', () => updateForm('second'));
$('secondProtocol').addEventListener('change', () => updateForm('second'));
$('secondEnabled').addEventListener('change', updateCameraSwitch);
 $('image').addEventListener('load', () => { if (state.running) { if (state.sourceType === 'mjpeg') setHealth('Connected · frame timing unavailable', 'live'); else recordFrame(); setStatus('Live', 'live'); } });
$('image').addEventListener('error', () => { if (state.running) { setStatus('Stream error', 'error'); setHealth('Feed unavailable', 'stale'); setMessage('No image was received. Check the camera URL, permissions, network access, and stream format.', 'error'); } });
$('video').addEventListener('playing', () => { if (state.running) recordFrame(); });
$('bridgeFrame').addEventListener('load', () => { if (state.running && state.sourceType === 'bridge') { setStatus('Viewer open · verify video', 'connecting'); setHealth('Bridge viewer open · check video', 'live'); } });
$('video').addEventListener('timeupdate', () => { if (state.running) recordFrame(); });
$('video').addEventListener('error', () => { if (state.running) { setStatus('Stream error', 'error'); setHealth('Feed unavailable', 'stale'); setMessage('The video URL or codec could not be played by this gSender build.', 'error'); } });
for (const profile of ['primary', 'second']) for (const field of ['host', 'port', 'path']) $(id(profile, field)).addEventListener('input', () => updateForm(profile));
$('makeraPreset').addEventListener('click', () => { $('sourceType').value = 'websocket'; $('protocol').value = 'ws'; $('host').value = '192.168.68.146'; $('port').value = '82'; $('path').value = '/ws_video'; $('startMessage').value = 'start_stream'; updateForm('primary'); setMessage('Makera Z1 settings loaded. Confirm the current camera IP, then connect.'); });
function setBridgePreset(profile = 'primary') { $(id(profile, 'sourceType')).value = 'bridge'; $(id(profile, 'protocol')).value = 'http'; $(id(profile, 'host')).value = '127.0.0.1'; $(id(profile, 'port')).value = '1984'; $(id(profile, 'path')).value = '/stream.html?src=cam&mode=webrtc&background=false'; updateForm(profile); if (profile === 'primary') setMessage('Local RTSP bridge viewer URL filled in. Start the separate bridge and create a go2rtc stream named cam before connecting.'); }
$('bridgePreset').addEventListener('click', () => setBridgePreset('primary'));
$('secondBridgePreset').addEventListener('click', () => setBridgePreset('second'));
function toggleBridgeStartInstructions(profile = 'primary') {
  const toggle = $(profile === 'primary' ? 'bridgeStartToggle' : 'secondBridgeStartToggle');
  const instructions = $(profile === 'primary' ? 'bridgeStartInstructions' : 'secondBridgeStartInstructions');
  instructions.hidden = !instructions.hidden;
  toggle.setAttribute('aria-expanded', String(!instructions.hidden));
  toggle.textContent = instructions.hidden ? 'Install / start steps' : 'Hide install instructions';
}
$('bridgeStartToggle').addEventListener('click', () => toggleBridgeStartInstructions('primary'));
$('secondBridgeStartToggle').addEventListener('click', () => toggleBridgeStartInstructions('second'));
for (const profile of ['primary', 'second']) {
  const startToggle = $(profile === 'primary' ? 'bridgeStartToggle' : 'secondBridgeStartToggle');
  const startInstructions = $(profile === 'primary' ? 'bridgeStartInstructions' : 'secondBridgeStartInstructions');
  startToggle.textContent = 'Install / start steps';
  startInstructions.innerHTML = '<strong>Install or start the bridge</strong><p>After extracting the Local Bridge ZIP, double-click <strong>Install Camera Bridge.cmd</strong>. It installs the bridge in <code>C:\\rtsp_bridge</code>, creates a Desktop shortcut, and starts the bridge. To start it later, double-click the Desktop shortcut.</p><p>Keep the bridge console window open, then choose <strong>Configure cameras</strong> to discover or save streams such as <code>cam1</code>.</p>';
}
for (const link of document.querySelectorAll('#bridgeLinks .bridge-actions a, #secondBridgeLinks .bridge-actions a')) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'subtle open-bridge-config'; button.textContent = 'Configure cameras';
  link.replaceWith(button);
}
document.body.insertAdjacentHTML('beforeend', '<div id="bridgeConfigDialog" class="bridge-config-dialog" role="dialog" aria-modal="true" aria-labelledby="bridgeConfigTitle" hidden><div class="bridge-config-card"><div class="bridge-config-heading"><strong id="bridgeConfigTitle">Configure bridge cameras</strong><button id="closeBridgeConfig" class="mini-button" type="button" aria-label="Close camera configuration">×</button></div><p class="bridge-config-message">The bridge setup page appears here when the bridge is running. If it does not load, use the CNC Camera Bridge Desktop shortcut to start the bridge.</p><iframe id="bridgeConfigFrame" title="go2rtc camera configuration" src="about:blank"></iframe><div class="bridge-config-footer">Local setup page: <code>http://127.0.0.1:1984/</code></div></div></div>');
const bridgeConfigDialog = $('bridgeConfigDialog'), bridgeConfigFrame = $('bridgeConfigFrame');
function closeBridgeConfig() { bridgeConfigDialog.hidden = true; bridgeConfigFrame.src = 'about:blank'; }
for (const button of document.querySelectorAll('.open-bridge-config')) button.addEventListener('click', () => { bridgeConfigDialog.hidden = false; bridgeConfigFrame.src = 'http://127.0.0.1:1984/'; });
$('closeBridgeConfig').addEventListener('click', closeBridgeConfig);
bridgeConfigDialog.addEventListener('click', (event) => { if (event.target === bridgeConfigDialog) closeBridgeConfig(); });
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !bridgeConfigDialog.hidden) closeBridgeConfig(); });
$('connect').addEventListener('click', () => connectCamera('primary'));
$('quickConnect').addEventListener('click', () => connectCamera(state.profile));
$('connectSecond').addEventListener('click', async () => { await saveSettings(false, false); await connectCamera('second'); });
$('disconnect').addEventListener('click', async () => { clearPreview(); await saveSettings(false, false); setMessage('Camera disconnected.'); });
$('quickDisconnect').addEventListener('click', async () => { clearPreview(); await saveSettings(false, false); setMessage('Camera disconnected.'); });
$('save').addEventListener('click', () => saveSettings(true, false));
$('device').addEventListener('change', async () => { try { await (await storagePromise).set('camera-monitor.deviceId', $('device').value); } catch { /* Optional convenience. */ } updateCameraSwitch(); });
$('secondDevice').addEventListener('change', updateCameraSwitch);
$('showPrimary').addEventListener('click', () => connectCamera('primary'));
$('showSecondary').addEventListener('click', () => connectCamera('second'));
$('zoomOut').addEventListener('click', () => { state.zoom = Math.max(1, +(state.zoom - 0.25).toFixed(2)); applyPictureSettings(); });
$('zoomIn').addEventListener('click', () => { state.zoom = Math.min(3, +(state.zoom + 0.25).toFixed(2)); applyPictureSettings(); });
$('flipImage').addEventListener('click', () => { state.flipped = !state.flipped; applyPictureSettings(); });
$('rotateImage').addEventListener('click', () => { state.rotation = (state.rotation + 90) % 360; applyPictureSettings(); });
$('togglePreviewToolbar').addEventListener('click', () => { state.toolbarCollapsed = !state.toolbarCollapsed; updateToolbar(); });
window.addEventListener('beforeunload', clearPreview);
updateForm('primary'); updateForm('second'); applyPictureSettings(); updateToolbar(); loadSettings().catch((error) => setMessage(`Could not load saved camera settings: ${error.message}`, 'error'));
