import { machine, redux, storage } from '@sienci/gsender-plugin-sdk';
import { solveSimilarity, transformGcode } from './registration.js';
import './style.css';

const $ = (id) => document.getElementById(id);

document.querySelector('#app').innerHTML = `
  <header class="page-header">
    <div class="eyebrow">Camera setup and visual work zero</div>
    <h1>Camera Align &amp; Print Registration</h1>
    <p>Calibrate the camera-to-spindle offset, set work zero, or align a CNC toolpath to printed artwork.</p>
    <div class="connection"><span id="connectionDot"></span><span id="connectionText">Checking machine…</span><span id="positionText"></span></div>
  </header>

  <nav class="tool-tabs" role="tablist" aria-label="Camera alignment sections">
    <button class="tool-tab" id="tabCamera" role="tab" aria-selected="true" aria-controls="cameraPanel" data-tab="camera">Camera</button>
    <button class="tool-tab" id="tabCalibration" role="tab" aria-selected="false" aria-controls="calibrationPanel" data-tab="calibration">Calibration</button>
    <button class="tool-tab" id="tabPosition" role="tab" aria-selected="false" aria-controls="jogPanel" data-tab="position">Jog &amp; work zero</button>
    <button class="tool-tab" id="tabRegistration" role="tab" aria-selected="false" aria-controls="registrationPanel" data-tab="registration">Print alignment</button>
  </nav>

  <section id="cameraPanel" class="panel camera-panel" data-tab-panel="camera" role="tabpanel" aria-labelledby="tabCamera">
    <div class="section-heading camera-section-heading">
      <button id="cameraDragHandle" class="camera-drag-handle" type="button" aria-label="Move camera window" title="Drag to move the floating camera window" hidden>⠿</button>
      <div class="camera-heading"><div class="step">01 · CAMERA VIEW</div><h2>Live USB camera</h2></div>
      <div class="camera-toolbar"><div class="camera-status" id="cameraStatus">Camera stopped</div><button id="toggleCameraWindow" class="secondary camera-window-toggle" type="button">Pop out</button></div>
    </div>
    <div class="camera-workspace">
      <div class="video-shell" id="videoShell">
        <video id="cameraVideo" autoplay muted playsinline></video>
        <div class="camera-placeholder" id="cameraPlaceholder"><div class="camera-icon">◎</div><strong>Camera preview</strong><span>Choose a USB camera and allow access to start the live view.</span></div>
        <div class="reticle" aria-hidden="true"><i></i><b></b></div>
        <div class="image-label">CROSSHAIR CENTER</div>
      </div>
      <div class="camera-setup">
        <div class="camera-controls">
          <label>Camera device<select id="cameraDevice"><option value="">Choose a camera</option></select></label>
          <button id="startCamera" class="primary">Start camera</button>
          <button id="stopCamera" class="secondary" disabled>Stop camera</button>
        </div>
        <details id="cameraHelp" class="camera-help"><summary>Camera permission help</summary><p>This plugin declares <strong>Camera</strong> for its iframe and <strong>media</strong> for gSender's Electron permission gate. Approve both if they appear during install. The plugin requests video only, not microphone audio. If access is still denied, expand <strong>Camera access diagnostics</strong> below the status message.</p></details>
        <p class="hint">Place the crosshair over the desired work zero. Jog from the Jog &amp; Work Zero tab. Camera images are never recorded.</p>
      </div>
    </div>
  </section>

  <section id="calibrationPanel" class="panel" data-tab-panel="calibration" role="tabpanel" aria-labelledby="tabCalibration" hidden>
    <div class="section-heading"><div><div class="step">02 · CALIBRATION</div><h2>Measure camera-to-spindle offset</h2></div><div class="offset-chip" id="offsetSummary">Not calibrated</div></div>
    <p class="instruction compact-instruction">Set the offset manually or measure it from one reference mark using the spindle and camera.</p>
    <div class="calibration-workspace">
    <div class="calibration-controls">
    <label class="mode-select">Calibration method<select id="calibrationMode"><option value="manual">Enter X/Y offset manually</option><option value="mark">Measure using a reference mark</option></select></label>
    <div id="manualCalibration" class="manual-calibration compact-card">
      <p class="hint">Enter the spindle/tool position relative to the camera crosshair. For example, if the spindle is 42 mm to the right and 18 mm toward +Y from the crosshair, enter X 42 and Y 18.</p>
      <div class="manual-fields">
        <label>Spindle offset X (mm)<input id="manualOffsetX" type="number" step="0.01" min="-500" max="500" placeholder="0.00"></label>
        <label>Spindle offset Y (mm)<input id="manualOffsetY" type="number" step="0.01" min="-500" max="500" placeholder="0.00"></label>
        <button id="saveManualOffset" class="primary">Save manual offset</button>
      </div>
      <p class="formula">Offset convention: spindle/tool XY − camera crosshair XY, in millimeters.</p>
    </div>
    <div id="markCalibration" class="compact-card" hidden>
    <p class="instruction">Make a small mark in scrap. Put the spindle over it and record, then move the camera crosshair over that same mark and record again.</p>
    <div class="calibration-grid">
      <article class="cal-step"><span class="number">A</span><div><h3>Spindle on the reference mark</h3><p id="spindlePointText">No spindle point recorded.</p><button id="recordSpindle" class="secondary">Record spindle at mark</button></div></article>
      <article class="cal-step"><span class="number">B</span><div><h3>Camera crosshair on the same mark</h3><p id="cameraPointText">Record the spindle point first.</p><button id="recordCamera" class="secondary" disabled>Record camera at mark</button></div></article>
    </div>
    <p class="formula">Stored offset = spindle machine XY − camera machine XY. Keep the camera rigidly attached to the spindle carriage.</p>
    </div>
    <button id="clearCalibration" class="text-button">Clear saved offset</button>
    </div>
    <div class="camera-inline-preview calibration-camera-preview" aria-label="Live camera preview during calibration"><video autoplay muted playsinline data-camera-mini-video hidden></video><div class="camera-inline-placeholder" data-camera-mini-placeholder><strong>Camera preview is off</strong><span>Start the camera on the Camera tab to view the crosshair here.</span><button class="secondary" type="button" data-open-camera-tab>Open Camera tab</button></div><div class="reticle" aria-hidden="true"><i></i><b></b></div><div class="image-label">CROSSHAIR CENTER</div></div>
    </div>
  </section>

  <section id="jogPanel" class="panel jog-panel" data-tab-panel="position" role="tabpanel" aria-labelledby="tabPosition" hidden>
    <div class="section-heading"><div><div class="step">03 · POSITION</div><h2>Jog and set work zero</h2></div></div>
    <p class="instruction compact-instruction">Raise Z to safe clearance and confirm clear travel before jogging.</p>
    <div class="jog-workspace">
      <div class="camera-inline-preview jog-camera-preview" aria-label="Live camera preview while jogging"><video autoplay muted playsinline data-camera-mini-video hidden></video><div class="camera-inline-placeholder" data-camera-mini-placeholder><strong>Camera preview is off</strong><span>Start the camera on the Camera tab to keep the crosshair visible.</span><button class="secondary" type="button" data-open-camera-tab>Open Camera tab</button></div><div class="reticle" aria-hidden="true"><i></i><b></b></div><div class="image-label">CROSSHAIR CENTER</div></div>
      <div class="jog-control-zero-row">
        <div class="jog-control-column">
          <label class="safety-check"><input id="safeToJog" type="checkbox"><span>Safe Z and clear XY travel confirmed.</span></label>
          <div class="jog-controls">
            <label>Jog step<select id="jogStep"><option value="0.1">0.1 mm</option><option value="0.5">0.5 mm</option><option value="1" selected>1 mm</option><option value="5">5 mm</option><option value="10">10 mm</option></select></label>
            <div class="jog-pad" aria-label="XY jog controls">
              <span></span><button data-axis="y" data-direction="1" aria-label="Jog Y positive">Y+</button><span></span>
              <button data-axis="x" data-direction="-1" aria-label="Jog X negative">X−</button><span class="pad-center">XY</span><button data-axis="x" data-direction="1" aria-label="Jog X positive">X+</button>
              <span></span><button data-axis="y" data-direction="-1" aria-label="Jog Y negative">Y−</button><span></span>
            </div>
          </div>
        </div>
        <div class="zero-controls">
          <div class="section-heading"><div><div class="step">04 · WORK ZERO</div><h3>Set work zero</h3></div><div class="wcs-chip" id="wcsSummary">WCS not checked</div></div>
          <p class="instruction compact-instruction">Center the crosshair on the origin, then choose its work coordinate system.</p>
          <div class="zero-actions"><label class="wcs-target">Coordinate system<select id="wcsSelect"><option value="G54">G54</option><option value="G55">G55</option><option value="G56">G56</option><option value="G57">G57</option><option value="G58">G58</option><option value="G59">G59</option></select></label><button id="setZero" class="primary large" disabled>Set G54 work zero at crosshair</button></div>
          <p class="hint compact-hint">Writes persistent X/Y offset only. Does not change Z zero, move the machine, or start a job.</p>
        </div>
      </div>
    </div>
    <p id="jogStatus" class="jog-status" aria-live="polite">Connect the CNC and confirm clear travel to enable jogging.</p>
  </section>

  <section id="registrationPanel" class="panel registration-panel" data-tab-panel="registration" role="tabpanel" aria-labelledby="tabRegistration" hidden>
    <div class="section-heading"><div><div class="step">05 · PRINT REGISTRATION</div><h2>Align a toolpath to printed marks</h2></div><div class="offset-chip" id="registrationStatus">No file selected</div></div>
    <p class="instruction compact-instruction">Load G-code, enter XY coordinates for two printed marks, center the crosshair on each, then record. The plugin calculates scale, rotation, and translation for a registered copy.</p>
    <div class="registration-workspace">
      <div class="registration-inputs">
        <div class="registration-file-row">
          <label>G-code file<input id="registrationFile" type="file" accept=".nc,.gcode,.ngc,.tap,.txt,text/plain"></label>
          <div id="registrationFileInfo" class="file-info">The source file stays in this browser and is not uploaded.</div>
        </div>
        <div class="fiducial-grid">
          <article class="fiducial-card">
            <div class="fiducial-title"><span class="number">A</span><div><h3>Printed mark A</h3><p>Source toolpath XY in millimeters.</p></div></div>
            <div class="fiducial-fields"><label>File X (mm)<input id="fileAX" type="number" step="0.001" placeholder="e.g. 10"></label><label>File Y (mm)<input id="fileAY" type="number" step="0.001" placeholder="e.g. 10"></label></div>
            <button id="recordMarkA" class="secondary" disabled>Record camera at mark A</button>
            <p id="markAStatus" class="mark-status">Not recorded</p>
          </article>
          <article class="fiducial-card">
            <div class="fiducial-title"><span class="number">B</span><div><h3>Printed mark B</h3><p>Choose a point well apart from A.</p></div></div>
            <div class="fiducial-fields"><label>File X (mm)<input id="fileBX" type="number" step="0.001" placeholder="e.g. 90"></label><label>File Y (mm)<input id="fileBY" type="number" step="0.001" placeholder="e.g. 10"></label></div>
            <button id="recordMarkB" class="secondary" disabled>Record camera at mark B</button>
            <p id="markBStatus" class="mark-status">Not recorded</p>
          </article>
        </div>
        <div class="registration-result" id="registrationResult" hidden></div>
        <div class="registration-actions"><button id="alignFile" class="primary large" disabled>Align and download G-code</button><button id="clearRegistration" class="text-button" disabled>Clear registration</button></div>
        <p class="hint compact-hint">Requires a saved camera offset, live camera, and idle CNC. This does not move the machine or start a job. Review the downloaded G-code in gSender before running it.</p>
      </div>
      <div class="camera-inline-preview registration-camera-preview" aria-label="Live camera preview while aligning printed marks"><video autoplay muted playsinline data-camera-mini-video hidden></video><div class="camera-inline-placeholder" data-camera-mini-placeholder><strong>Camera preview is off</strong><span>Start the camera on the Camera tab to center each printed mark.</span><button class="secondary" type="button" data-open-camera-tab>Open Camera tab</button></div><div class="reticle" aria-hidden="true"><i></i><b></b></div><div class="image-label">CROSSHAIR CENTER</div></div>
    </div>
  </section>

  <div id="notice" class="notice" role="status" aria-live="polite">Allow camera access, calibrate the offset, and confirm safe clearance before setting zero.</div>
  <details id="cameraDiagnostics" class="camera-help diagnostics" hidden><summary>Camera access diagnostics</summary><pre id="cameraDiagnosticsText"></pre></details>

  <dialog id="confirmDialog"><div class="dialog-icon">!</div><h2>Update work coordinate offset?</h2><p id="confirmText"></p><div class="button-row"><button id="cancelConfirm" class="secondary">Cancel</button><button id="acceptConfirm" class="primary">Write offset</button></div></dialog>
  <footer>Camera view and motion are controlled locally by gSender. Review the machine position before every move.</footer>
`;

const jogPanelDock = document.createComment('Jog controls dock position');
$('jogPanel').before(jogPanelDock);
const cameraPanelDock = document.createComment('Camera panel dock position');
$('cameraPanel').before(cameraPanelDock);

const state = {
  stream: null,
  offset: null,
  calibrationMode: 'manual',
  spindlePoint: null,
  cameraPoint: null,
  busy: false,
  connected: false,
  machineIdle: false,
  positionAvailable: false,
  activeTab: 'camera',
  activeWcs: null,
  selectedWcs: null,
  wcsSelectionTouched: false,
  registrationFile: null,
  registrationText: null,
  markA: null,
  markB: null,
  registrationBusy: false,
  cameraPoppedOut: false,
  cameraDrag: null,
};

const setNotice = (message, kind = '') => {
  $('notice').textContent = message;
  $('notice').className = `notice ${kind}`;
};
const round4 = (value) => Number(Number(value).toFixed(4));

function machineXY(snapshot) {
  const p = snapshot?.controller?.mpos;
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {
    throw new Error('Machine XY position is not available yet. Wait for gSender to report position.');
  }
  return { x: Number(p.x), y: Number(p.y) };
}

async function assertIdle() {
  const snapshot = await redux.getState();
  if (!snapshot?.connection?.isConnected) throw new Error('Connect to the CNC before using machine controls.');
  if (snapshot.controller?.workflow?.state !== 'idle') throw new Error('Stop the host job and wait for Idle before using machine controls.');
  if (snapshot.controller?.state?.status?.activeState !== 'Idle') throw new Error('Machine must be Idle and unlocked.');
  const feeder = snapshot.controller?.feeder?.status;
  if (feeder && (feeder.pending || feeder.queue > 0 || feeder.hold)) throw new Error('The host feeder is busy.');
  if (snapshot.pluginState?.busy && !state.busy) throw new Error('Another plugin operation is busy.');
  return { snapshot, xy: machineXY(snapshot) };
}

async function waitForJogCompletion(expected, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let settledReports = 0;
  let latestSnapshot;
  while (Date.now() < deadline) {
    await machine.command('?').catch(() => {});
    latestSnapshot = await redux.getState();
    const status = String(latestSnapshot?.controller?.state?.status?.activeState ?? 'Unknown');
    if (status === 'Alarm' || status === 'Hold' || status === 'Door') {
      throw new Error(`Jog stopped with controller state ${status}. Inspect the machine before jogging again.`);
    }
    let xy;
    try { xy = machineXY(latestSnapshot); } catch { /* Wait for a fresh position report. */ }
    const idle = latestSnapshot?.controller?.workflow?.state === 'idle' && status === 'Idle';
    const atTarget = xy
      && Math.abs(xy.x - expected.x) <= 0.05
      && Math.abs(xy.y - expected.y) <= 0.05;
    settledReports = idle && atTarget ? settledReports + 1 : 0;
    if (settledReports >= 2) return xy;
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  }
  const status = String(latestSnapshot?.controller?.state?.status?.activeState ?? 'Unknown');
  throw new Error(`Jog did not reach its target and return to Idle within ${timeout / 1000} seconds (controller state: ${status}). Check the machine before continuing.`);
}

function controllerIsMoving(snapshot) {
  const status = String(snapshot?.controller?.state?.status?.activeState ?? '').toLowerCase();
  const workflow = String(snapshot?.controller?.workflow?.state ?? '').toLowerCase();
  return ['run', 'jog', 'cycle'].includes(status) || ['running', 'jogging'].includes(workflow);
}

async function query(command, timeout = 7000) {
  const result = await machine.query(command, { until: 'ok-or-error', timeout, maxLines: 100 });
  if (!result?.complete || !result.ok || result.error) {
    throw new Error(result?.error || `Controller did not complete ${command}. ${result?.reason || ''}`);
  }
  return result;
}

async function readModal() {
  const response = await query('$G');
  const line = response.lines.find((entry) => /^\[GC:/i.test(entry));
  const modal = line?.match(/^\[GC:(.*)\]$/i)?.[1] ?? '';
  const wcs = modal.match(/(?:^|\s)(G5[4-9])(?:\s|$)/i)?.[1]?.toUpperCase();
  const units = /(?:^|\s)G20(?:\s|$)/i.test(modal) ? 'G20' : /(?:^|\s)G21(?:\s|$)/i.test(modal) ? 'G21' : null;
  if (!wcs) throw new Error('Could not determine the active work coordinate system from $G.');
  if (!units) throw new Error('Could not determine whether the controller is using G20 or G21 units.');
  return { wcs, units };
}

async function readOffsetTable() {
  const response = await query('$#');
  const lines = (response.lines ?? []).map((entry) => String(entry).trim());
  const offsets = {};
  for (const line of lines) {
    const match = line.match(/^\[\s*(G5[4-9]|G92)\s*:\s*([^\]]+)\]$/i);
    if (!match) continue;
    const values = match[2].split(',').map((entry) => Number(entry.trim()));
    if (values.length >= 2 && values.slice(0, 2).every(Number.isFinite)) {
      offsets[match[1].toUpperCase()] = values;
    }
  }
  return { offsets, lines };
}

async function controllerReportsInches() {
  const response = await query('$$');
  const line = response.lines.find((entry) => /^\s*\$13\s*=/.test(entry));
  const value = line?.match(/^\s*\$13\s*=\s*([01])(?:\s|$)/)?.[1];
  if (value === undefined) throw new Error('Could not determine controller offset-report units from setting $13. No work offset was written.');
  return value === '1';
}

function syncCameraPreviews() {
  document.querySelectorAll('[data-camera-mini-video]').forEach((video) => {
    if (video.srcObject !== state.stream) video.srcObject = state.stream;
    video.hidden = !state.stream;
    if (state.stream && video.paused) video.play().catch(() => {});
  });
  document.querySelectorAll('[data-camera-mini-placeholder]').forEach((placeholder) => {
    placeholder.hidden = Boolean(state.stream);
  });
}

function render() {
  document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
    const floatsWithCamera = state.cameraPoppedOut && ['cameraPanel', 'jogPanel'].includes(panel.id);
    panel.hidden = panel.dataset.tabPanel !== state.activeTab && !floatsWithCamera;
  });
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.activeTab));
    tab.tabIndex = tab.dataset.tab === state.activeTab ? 0 : -1;
  });
  $('calibrationMode').value = state.calibrationMode;
  $('manualCalibration').hidden = state.calibrationMode !== 'manual';
  $('markCalibration').hidden = state.calibrationMode !== 'mark';
  $('recordCamera').disabled = state.busy || !state.spindlePoint || !state.stream;
  $('recordSpindle').disabled = state.busy;
  $('clearCalibration').disabled = state.busy || !state.offset;
  $('setZero').disabled = state.busy || !state.offset || !state.stream || !state.connected || !state.machineIdle || !state.positionAvailable;
  $('startCamera').disabled = state.busy || Boolean(state.stream);
  $('stopCamera').disabled = state.busy || !state.stream;
  $('cameraStatus').textContent = state.stream ? 'Live camera active' : 'Camera stopped';
  $('cameraStatus').classList.toggle('live', Boolean(state.stream));
  $('videoShell').classList.toggle('active', Boolean(state.stream));
  $('cameraPlaceholder').hidden = Boolean(state.stream);
  $('cameraVideo').hidden = !state.stream;
  $('toggleCameraWindow').textContent = state.cameraPoppedOut ? 'Dock camera' : 'Pop out';
  $('toggleCameraWindow').setAttribute('aria-pressed', String(state.cameraPoppedOut));
  $('cameraDragHandle').hidden = !state.cameraPoppedOut;
  $('cameraDragHandle').tabIndex = state.cameraPoppedOut ? 0 : -1;
  $('cameraPanel').classList.toggle('popped-out', state.cameraPoppedOut);
  $('app').classList.toggle('camera-popped-out', state.cameraPoppedOut);
  syncCameraPreviews();
  $('connectionDot').classList.toggle('connected', state.connected);
  $('connectionText').textContent = state.connected ? 'CNC connected' : 'Not connected';
  $('offsetSummary').textContent = state.offset
    ? `Offset X ${state.offset.x.toFixed(3)} · Y ${state.offset.y.toFixed(3)} mm`
    : 'Not calibrated';
  $('spindlePointText').textContent = state.spindlePoint
    ? `Recorded at machine X${state.spindlePoint.x.toFixed(3)} Y${state.spindlePoint.y.toFixed(3)} mm`
    : 'No spindle point recorded.';
  $('cameraPointText').textContent = state.cameraPoint
    ? `Recorded at machine X${state.cameraPoint.x.toFixed(3)} Y${state.cameraPoint.y.toFixed(3)} mm`
    : state.spindlePoint ? 'Center the crosshair on the same mark, then record.' : 'Record the spindle point first.';
  $('wcsSummary').textContent = state.activeWcs ? `Active ${state.activeWcs}` : 'WCS not checked';
  if (state.selectedWcs) $('wcsSelect').value = state.selectedWcs;
  $('setZero').textContent = `Set ${state.selectedWcs ?? 'G54'} work zero at crosshair`;
  const canRecordMark = Boolean(state.registrationText && state.offset && state.stream && state.connected);
  $('recordMarkA').disabled = state.registrationBusy || !canRecordMark;
  $('recordMarkB').disabled = state.registrationBusy || !canRecordMark;
  $('alignFile').disabled = state.registrationBusy || !state.registrationText || !state.markA || !state.markB || !state.offset || !state.connected;
  $('clearRegistration').disabled = state.registrationBusy || (!state.registrationFile && !state.markA && !state.markB);
  $('registrationStatus').textContent = state.registrationFile ? `${(state.registrationFile.size / 1024).toFixed(1)} KB loaded` : 'No file selected';
  $('markAStatus').textContent = state.markA ? `${state.markA.wcs}: spindle target X${state.markA.x.toFixed(3)} Y${state.markA.y.toFixed(3)} mm` : 'Not recorded';
  $('markBStatus').textContent = state.markB ? `${state.markB.wcs}: spindle target X${state.markB.x.toFixed(3)} Y${state.markB.y.toFixed(3)} mm` : 'Not recorded';
  const jogReady = state.connected && $('safeToJog').checked && !state.busy;
  document.querySelectorAll('[data-axis]').forEach((button) => { button.disabled = !jogReady; });
  $('jogStatus').textContent = !state.connected
    ? 'Connect gSender to the CNC to enable jogging.'
    : !$('safeToJog').checked
      ? 'Confirm safe Z and clear XY travel to enable jogging.'
      : state.busy ? 'Machine command in progress.' : 'Jog ready. The controller state and position are checked again before every move.';
  $('jogStatus').classList.toggle('ready', jogReady);
}

async function recordRegistrationMark(which) {
  if (!state.registrationText) throw new Error('Choose a G-code file first.');
  if (!state.offset) throw new Error('Calibrate and save the camera-to-spindle offset first.');
  if (!state.stream) throw new Error('Start the live camera and center the crosshair on the printed mark.');
  if (!$('safeToJog').checked) throw new Error('Confirm safe Z and clear XY travel before recording the printed mark.');
  const { snapshot } = await assertIdle();
  const modal = await readModal();
  const wpos = snapshot?.controller?.wpos;
  if (!wpos || !Number.isFinite(Number(wpos.x)) || !Number.isFinite(Number(wpos.y))) {
    throw new Error('Work XY position is not available. Wait for gSender to report the active work position.');
  }
  const current = {
    x: round4(Number(wpos.x) + state.offset.x),
    y: round4(Number(wpos.y) + state.offset.y),
    wcs: modal.wcs,
  };
  if (which === 'A') state.markA = current;
  else state.markB = current;
  render();
  setNotice(`Printed mark ${which} recorded in ${modal.wcs}. The mapped tool point includes the saved spindle-to-camera offset.`, 'success');
}

function readAnchor(prefix) {
  const x = Number($(`file${prefix}X`).value);
  const y = Number($(`file${prefix}Y`).value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Enter valid source-file X and Y coordinates for mark ${prefix}.`);
  return { x, y };
}

async function alignRegistrationFile() {
  if (!state.registrationText || !state.registrationFile) throw new Error('Choose a G-code file first.');
  if (!state.markA || !state.markB) throw new Error('Record both printed registration marks with the camera.');
  if (!state.offset) throw new Error('Calibrate and save the camera-to-spindle offset first.');
  const sourceA = readAnchor('A');
  const sourceB = readAnchor('B');
  if (state.markA.wcs !== state.markB.wcs) throw new Error(`Marks were captured in different work systems (${state.markA.wcs} and ${state.markB.wcs}). Clear and record them again in the same WCS.`);
  await assertIdle();
  const modal = await readModal();
  if (modal.wcs !== state.markA.wcs) throw new Error(`Active work system changed to ${modal.wcs}. The registration marks were captured in ${state.markA.wcs}.`);
  const transform = solveSimilarity(sourceA, sourceB, state.markA, state.markB);
  const aligned = transformGcode(state.registrationText, transform, { units: modal.units, wcs: modal.wcs });
  const blob = new Blob([aligned.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${state.registrationFile.name.replace(/\.[^.]+$/, '')}-registered${state.registrationFile.name.match(/\.[^.]+$/)?.[0] ?? '.nc'}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('registrationResult').hidden = false;
  $('registrationResult').textContent = `Aligned ${aligned.transformedPoints} XY moves for ${modal.wcs}. Scale ${transform.scale.toFixed(5)}× · rotation ${(transform.angle * 180 / Math.PI).toFixed(3)}° · translation X${transform.tx.toFixed(3)} Y${transform.ty.toFixed(3)} mm. Review the downloaded copy before running it.`;
  setNotice('Registered G-code downloaded. Review it in gSender before starting the CNC job.', 'success');
}

function clearRegistration() {
  state.registrationFile = null;
  state.registrationText = null;
  state.markA = null;
  state.markB = null;
  $('registrationFile').value = '';
  ['fileAX', 'fileAY', 'fileBX', 'fileBY'].forEach((id) => { $(id).value = ''; });
  $('registrationFileInfo').textContent = 'The source file stays in this browser and is not uploaded.';
  $('registrationResult').hidden = true;
  $('registrationResult').textContent = '';
  render();
}

async function refreshMachine() {
  let snapshot;
  try {
    snapshot = await redux.getState();
  } catch {
    state.connected = false;
    state.machineIdle = false;
    state.positionAvailable = false;
    state.activeWcs = null;
    $('positionText').textContent = 'Position unavailable';
    render();
    return;
  }
  state.connected = Boolean(snapshot?.connection?.isConnected);
  state.machineIdle = false;
  state.positionAvailable = false;
  state.activeWcs = null;
  if (!state.connected) {
    $('positionText').textContent = '';
    render();
    return;
  }
  try {
    const xy = machineXY(snapshot);
    state.positionAvailable = true;
    $('positionText').textContent = `MPos X${xy.x.toFixed(3)} Y${xy.y.toFixed(3)} mm`;
    state.machineIdle = snapshot.controller?.workflow?.state === 'idle'
      && snapshot.controller?.state?.status?.activeState === 'Idle'
      && !snapshot.pluginState?.busy;
    if (state.machineIdle && !state.busy) {
      const { wcs } = await readModal();
      state.activeWcs = wcs;
      if (!state.wcsSelectionTouched) {
        state.selectedWcs = wcs;
        $('wcsSelect').value = wcs;
      }
    } else {
      state.activeWcs = null;
    }
  } catch {
    $('positionText').textContent = 'Position unavailable';
  }
  render();
}

async function populateCameraDevices() {
  const selector = $('cameraDevice');
  const selected = selector.value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === 'videoinput');
  selector.replaceChildren(new Option(cameras.length ? 'Choose a camera' : 'No camera found', ''));
  for (const [index, camera] of cameras.entries()) {
    selector.add(new Option(camera.label || `Camera ${index + 1}`, camera.deviceId));
  }
  if (cameras.some((camera) => camera.deviceId === selected)) selector.value = selected;
}

async function readCameraDiagnostics(error) {
  const policy = document.permissionsPolicy || document.featurePolicy;
  let policyState = 'not reported by this gSender build';
  try {
    if (policy?.allowsFeature) policyState = policy.allowsFeature('camera') ? 'allowed' : 'blocked for this plugin frame';
  } catch { /* Older Chromium builds may not expose this check. */ }
  let permissionState = 'not reported';
  try {
    permissionState = (await navigator.permissions?.query({ name: 'camera' }))?.state || permissionState;
  } catch { /* Some Electron versions do not implement camera permission queries. */ }
  let cameraCount = 'unavailable';
  try {
    cameraCount = String((await navigator.mediaDevices?.enumerateDevices())?.filter((device) => device.kind === 'videoinput').length ?? 0);
  } catch { /* Device enumeration can be blocked along with camera access. */ }
  const diagnostics = [
    `Request error: ${error.name || 'Error'}${error.message ? ` — ${error.message}` : ''}`,
    `Secure context: ${window.isSecureContext ? 'yes' : 'no'}`,
    `Camera API: ${navigator.mediaDevices?.getUserMedia ? 'available' : 'unavailable'}`,
    `Plugin frame camera policy: ${policyState}`,
    `Browser camera permission state: ${permissionState}`,
    `Visible camera devices: ${cameraCount}`,
  ].join('\n');
  $('cameraDiagnosticsText').textContent = diagnostics;
  $('cameraDiagnostics').hidden = false;
  $('cameraDiagnostics').open = true;
  return { policyState, permissionState };
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  $('cameraVideo').srcObject = null;
  render();
}

function toggleCameraWindow() {
  const panel = $('cameraPanel');
  const jogPanel = $('jogPanel');
  if (!state.cameraPoppedOut) {
    const rect = panel.getBoundingClientRect();
    state.cameraPoppedOut = true;
    document.body.appendChild(panel);
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.appendChild(jogPanel);
    render();
    const floatingRect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - floatingRect.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - floatingRect.height - 8))}px`;
  } else {
    state.cameraPoppedOut = false;
    panel.style.removeProperty('left');
    panel.style.removeProperty('top');
    cameraPanelDock.parentNode.insertBefore(panel, cameraPanelDock.nextSibling);
    jogPanelDock.parentNode.insertBefore(jogPanel, jogPanelDock.nextSibling);
    render();
  }
}

function startCameraWindowDrag(event) {
  if (!state.cameraPoppedOut || event.button !== 0) return;
  const panel = $('cameraPanel');
  const rect = panel.getBoundingClientRect();
  state.cameraDrag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
  $('cameraDragHandle').setPointerCapture(event.pointerId);
  event.preventDefault();
}

function moveCameraWindow(event) {
  if (!state.cameraDrag || event.pointerId !== state.cameraDrag.pointerId) return;
  const panel = $('cameraPanel');
  const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
  panel.style.left = `${Math.max(8, Math.min(maxLeft, event.clientX - state.cameraDrag.dx))}px`;
  panel.style.top = `${Math.max(8, Math.min(maxTop, event.clientY - state.cameraDrag.dy))}px`;
}

function stopCameraWindowDrag(event) {
  if (!state.cameraDrag || event.pointerId !== state.cameraDrag.pointerId) return;
  state.cameraDrag = null;
  if ($('cameraDragHandle').hasPointerCapture(event.pointerId)) $('cameraDragHandle').releasePointerCapture(event.pointerId);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This gSender build does not expose browser camera access. Use gSender Edge 1.7.0-Edge-2 or newer.');
  }
  stopCamera();
  const deviceId = $('cameraDevice').value;
  const video = deviceId ? { deviceId: { exact: deviceId } } : true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
      $('cameraHelp').open = true;
      const diagnostic = await readCameraDiagnostics(error);
      if (diagnostic.policyState === 'blocked for this plugin frame') {
        throw new Error('Camera is blocked by the gSender plugin-frame policy. This cannot be changed in Windows; gSender must allow camera access for this plugin.');
      }
      throw new Error(`Camera access was rejected (${error.name}). See Camera access diagnostics below; they show whether the browser permission or gSender frame policy is blocking it.`);
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      throw new Error('No camera was found. Connect the USB camera, then refresh the camera list or restart the plugin.');
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      throw new Error('The camera is unavailable or in use by another app. Close other camera apps and try again.');
    }
    if (error.name === 'OverconstrainedError') {
      throw new Error('The selected camera is unavailable. Choose another camera or select the default camera.');
    }
    throw error;
  }
  state.stream = stream;
  $('cameraVideo').srcObject = stream;
  await $('cameraVideo').play();
  await populateCameraDevices();
  render();
}

function confirmOffset(message) {
  const dialog = $('confirmDialog');
  $('confirmText').textContent = message;
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (accepted) => {
      dialog.close();
      dialog.oncancel = null;
      resolve(accepted);
    };
    $('acceptConfirm').onclick = () => finish(true);
    $('cancelConfirm').onclick = () => finish(false);
    dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
  });
}

async function recordSpindlePoint() {
  const { xy } = await assertIdle();
  state.spindlePoint = xy;
  state.cameraPoint = null;
  render();
  setNotice('Spindle point recorded. Keep the same reference mark, raise Z safely, and jog until the camera crosshair is centered on it.');
}

async function recordCameraPoint() {
  if (!state.stream) throw new Error('Start the camera before recording the camera position.');
  if (!state.spindlePoint) throw new Error('Record the spindle position at the reference mark first.');
  const { xy } = await assertIdle();
  const offset = {
    x: round4(state.spindlePoint.x - xy.x),
    y: round4(state.spindlePoint.y - xy.y),
  };
  if (Math.hypot(offset.x, offset.y) < 0.05) throw new Error('The measured offset is almost zero. Check that the spindle and camera were aligned to the same physical mark in both steps.');
  if (Math.hypot(offset.x, offset.y) > 500) throw new Error('The measured offset exceeds 500 mm. Check the recorded points and machine units before saving.');
  state.cameraPoint = xy;
  state.offset = offset;
  state.calibrationMode = 'mark';
  await storage.set('cameraOffset', { ...offset, method: 'mark', calibratedAt: new Date().toISOString() });
  render();
  setNotice(`Offset saved: spindle is ${offset.x.toFixed(3)} mm in X and ${offset.y.toFixed(3)} mm in Y from the camera crosshair.`, 'success');
}

async function saveManualOffset() {
  if ($('manualOffsetX').value.trim() === '' || $('manualOffsetY').value.trim() === '') {
    throw new Error('Enter both X and Y offset values in millimeters. Use 0 when an axis has no offset.');
  }
  const x = Number($('manualOffsetX').value);
  const y = Number($('manualOffsetY').value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Enter valid X and Y offset values in millimeters.');
  if (Math.hypot(x, y) > 500) throw new Error('The offset must be within 500 mm of the camera crosshair.');
  state.offset = { x: round4(x), y: round4(y) };
  state.calibrationMode = 'manual';
  state.spindlePoint = null;
  state.cameraPoint = null;
  await storage.set('cameraOffset', { ...state.offset, method: 'manual', calibratedAt: new Date().toISOString() });
  render();
  setNotice(`Manual offset saved: spindle is ${state.offset.x.toFixed(3)} mm in X and ${state.offset.y.toFixed(3)} mm in Y from the camera crosshair.`, 'success');
}

async function jog(axis, direction) {
  const { xy } = await assertIdle();
  const step = Number($('jogStep').value) * Number(direction);
  const { units } = await readModal();
  const expected = { ...xy, [axis]: xy[axis] + step };
  state.busy = true;
  render();
  let busySet = false;
  let motionMayBeActive = false;
  try {
    await machine.setBusy(true, 'Camera alignment jog');
    busySet = true;
    motionMayBeActive = true;
    await query(`G21 G91 G0 ${axis.toUpperCase()}${step.toFixed(4)}`);
    const after = await waitForJogCompletion(expected);
    motionMayBeActive = false;
    await query('G90');
    if (units === 'G20') await query('G20');
    if (Math.abs(after[axis] - expected[axis]) > 0.05 || Math.abs(after[axis === 'x' ? 'y' : 'x'] - expected[axis === 'x' ? 'y' : 'x']) > 0.05) {
      throw new Error(`Jog was acknowledged, but position readback did not match the requested ${axis.toUpperCase()} step. Check the machine before continuing.`);
    }
    setNotice(`Jog complete. Machine position X${after.x.toFixed(3)} Y${after.y.toFixed(3)} mm.`, 'success');
  } catch (error) {
    if (motionMayBeActive) {
      const snapshot = await redux.getState().catch(() => null);
      if (controllerIsMoving(snapshot)) await machine.command('feedhold').catch(() => {});
    }
    await query('G90').catch(() => {});
    if (units === 'G20') await query('G20').catch(() => {});
    throw error;
  } finally {
    if (busySet) await machine.setBusy(false).catch(() => {});
    state.busy = false;
    await refreshMachine();
  }
}

async function setWorkZero() {
  if (!state.offset) throw new Error('Calibrate and save the camera-to-spindle offset first.');
  if (!state.stream) throw new Error('Start the camera and center the crosshair on the desired zero point.');
  const { xy } = await assertIdle();
  const initialModal = await readModal();
  const selectedWcs = $('wcsSelect').value;
  // G54-G59 map to G10 P1-P6 respectively. The final digit of the WCS
  // token alone is not the P index (for example, G54 is P1, not P4).
  const p = Number(selectedWcs.slice(1)) - 53;
  if (!Number.isInteger(p) || p < 1 || p > 6) {
    throw new Error(`Cannot map selected coordinate system ${selectedWcs} to a G10 P1-P6 index.`);
  }
  const workX = round4(state.offset.x);
  const workY = round4(state.offset.y);
  const confirmation = selectedWcs === initialModal.wcs
    ? `This will update active ${selectedWcs} so the point under the camera crosshair is X0 Y0. At the current spindle position the expected work position will be X${workX.toFixed(4)} Y${workY.toFixed(4)} mm.`
    : `This will update ${selectedWcs} so the point under the camera crosshair is X0 Y0. Active ${initialModal.wcs} will remain active; select ${selectedWcs} in gSender before using this zero.`;
  const confirmed = await confirmOffset(
    `${confirmation} Current machine position is X${xy.x.toFixed(3)} Y${xy.y.toFixed(3)} mm. This change persists in the controller.`,
  );
  if (!confirmed) {
    setNotice('Canceled. No work offset was changed.');
    return;
  }

  state.busy = true;
  render();
  let metricApplied = false;
  try {
    const currentModal = await readModal();
    if (currentModal.wcs !== initialModal.wcs) throw new Error(`Active work system changed from ${initialModal.wcs} to ${currentModal.wcs}. No offset was written.`);
    const { xy: currentXY } = await assertIdle();
    if (Math.hypot(currentXY.x - xy.x, currentXY.y - xy.y) > 0.05) throw new Error('Machine moved after confirmation. No offset was written; center the crosshair and try again.');
    const { offsets: previousOffsets, lines: previousLines } = await readOffsetTable();
    const previousWcsOffset = previousOffsets[selectedWcs];
    if (!previousWcsOffset) {
      const reply = previousLines.filter(Boolean).slice(0, 12).join(' | ') || '(empty response)';
      throw new Error(`Could not read ${selectedWcs} from the controller offset table ($#). No offset was written. Controller reply: ${reply}`);
    }
    const reportInches = await controllerReportsInches();
    const reportScale = reportInches ? 25.4 : 1;
    const g92Offset = previousOffsets.G92 ?? [0, 0, 0];
    const expectedWcsOffsetX = currentXY.x - g92Offset[0] * reportScale - workX;
    const expectedWcsOffsetY = currentXY.y - g92Offset[1] * reportScale - workY;
    await machine.setBusy(true, 'Setting camera work zero');
    metricApplied = true;
    await query(`G21 G10 L20 P${p} X${workX.toFixed(4)} Y${workY.toFixed(4)}`);
    if (initialModal.units === 'G20') await query('G20');
    const { offsets: updatedOffsets, lines: updatedLines } = await readOffsetTable();
    const updatedWcsOffset = updatedOffsets[selectedWcs];
    if (!updatedWcsOffset) {
      const reply = updatedLines.filter(Boolean).slice(0, 12).join(' | ') || '(empty response)';
      throw new Error(`The controller acknowledged the ${selectedWcs} write, but its offset row is missing from ($#). Review the controller before continuing. Reply: ${reply}`);
    }
    const updatedOffsetMmX = updatedWcsOffset[0] * reportScale;
    const updatedOffsetMmY = updatedWcsOffset[1] * reportScale;
    if (Math.abs(updatedOffsetMmX - expectedWcsOffsetX) > 0.05
      || Math.abs(updatedOffsetMmY - expectedWcsOffsetY) > 0.05) {
      throw new Error(`The controller acknowledged the ${selectedWcs} write, but its persistent offset table did not match. Expected ${selectedWcs} X${expectedWcsOffsetX.toFixed(3)} Y${expectedWcsOffsetY.toFixed(3)} mm; table reports X${updatedOffsetMmX.toFixed(3)} Y${updatedOffsetMmY.toFixed(3)} mm. Review the controller's offset table ($#) before continuing.`);
    }

    if (selectedWcs === initialModal.wcs) {
      // Reload an active WCS by selecting another and restoring it; these
      // modal changes do not move the machine.
      const temporaryWcs = selectedWcs === 'G54' ? 'G55' : 'G54';
      await query(temporaryWcs);
      await query(selectedWcs);
      await machine.command('?').catch(() => {});
      let snapshot = await redux.getState();
      let actualX = Number(snapshot?.controller?.wpos?.x);
      let actualY = Number(snapshot?.controller?.wpos?.y);
      const deadline = Date.now() + 3000;
      while ((!Number.isFinite(actualX) || !Number.isFinite(actualY)
        || Math.abs(actualX - workX) > 0.05 || Math.abs(actualY - workY) > 0.05)
        && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        snapshot = await redux.getState();
        actualX = Number(snapshot?.controller?.wpos?.x);
        actualY = Number(snapshot?.controller?.wpos?.y);
      }
      const positionCurrent = Number.isFinite(actualX) && Number.isFinite(actualY)
        && Math.abs(actualX - workX) <= 0.05 && Math.abs(actualY - workY) <= 0.05;
      if (!positionCurrent) {
        throw new Error(`The ${selectedWcs} offset was written and reloaded, but the live position still does not match. Expected work position X${workX.toFixed(3)} Y${workY.toFixed(3)} mm; latest report is X${Number.isFinite(actualX) ? actualX.toFixed(3) : 'unavailable'} Y${Number.isFinite(actualY) ? actualY.toFixed(3) : 'unavailable'} mm. Do not repeat the write. Check the active WCS, controller offset table ($#), and status report before continuing.`);
      }
      setNotice(`${selectedWcs} offset stored, reloaded, and verified. The camera crosshair is now work X0 Y0.`, 'success');
    } else {
      setNotice(`${selectedWcs} offset stored and verified. Active ${initialModal.wcs} was left unchanged; select ${selectedWcs} in gSender before using this origin.`, 'success');
    }
  } finally {
    if (metricApplied) await machine.setBusy(false).catch(() => {});
    state.busy = false;
    await refreshMachine();
  }
}

async function initialize() {
  try {
    const saved = await storage.get('cameraOffset');
    if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
      state.offset = { x: Number(saved.x), y: Number(saved.y), calibratedAt: saved.calibratedAt };
      state.calibrationMode = saved.method === 'manual' || saved.method === 'mark' ? saved.method : 'mark';
      if (state.calibrationMode === 'manual') {
        $('manualOffsetX').value = state.offset.x;
        $('manualOffsetY').value = state.offset.y;
      }
    }
  } catch (error) {
    setNotice(`Could not load saved camera calibration: ${error.message}`);
  }
  if (navigator.mediaDevices?.enumerateDevices) {
    await populateCameraDevices().catch(() => {});
    navigator.mediaDevices.addEventListener?.('devicechange', () => populateCameraDevices().catch(() => {}));
  }
  await refreshMachine();
  render();
  window.addEventListener('beforeunload', stopCamera, { once: true });
  window.setInterval(refreshMachine, 2000);
}

$('calibrationMode').onchange = () => {
  state.calibrationMode = $('calibrationMode').value;
  if (state.calibrationMode === 'manual' && state.offset) {
    $('manualOffsetX').value = state.offset.x;
    $('manualOffsetY').value = state.offset.y;
  }
  render();
};
$('saveManualOffset').onclick = async () => {
  try { await saveManualOffset(); }
  catch (error) { setNotice(error.message, 'error'); }
};

$('startCamera').onclick = async () => {
  try {
    await startCamera();
    setNotice('Live camera started. Center the crosshair over the reference mark or work-zero point.');
  } catch (error) {
    setNotice(`Could not start the camera: ${error.message}`, 'error');
  }
};
$('stopCamera').onclick = () => { stopCamera(); setNotice('Camera stopped.'); };
$('toggleCameraWindow').onclick = toggleCameraWindow;
document.querySelectorAll('[data-tab]').forEach((tab) => {
  tab.onclick = () => { state.activeTab = tab.dataset.tab; render(); };
  tab.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-tab]')];
    const index = tabs.indexOf(tab);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  };
});
document.querySelectorAll('[data-open-camera-tab]').forEach((button) => {
  button.onclick = () => { state.activeTab = 'camera'; render(); };
});
$('cameraDragHandle').addEventListener('pointerdown', startCameraWindowDrag);
$('cameraDragHandle').addEventListener('pointermove', moveCameraWindow);
$('cameraDragHandle').addEventListener('pointerup', stopCameraWindowDrag);
$('cameraDragHandle').addEventListener('pointercancel', stopCameraWindowDrag);
$('cameraDragHandle').addEventListener('keydown', (event) => {
  if (!state.cameraPoppedOut || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const panel = $('cameraPanel');
  const rect = panel.getBoundingClientRect();
  const step = event.shiftKey ? 40 : 12;
  const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
  const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
  const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
  const maxTop = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
  panel.style.left = `${Math.max(8, Math.min(maxLeft, rect.left + dx))}px`;
  panel.style.top = `${Math.max(8, Math.min(maxTop, rect.top + dy))}px`;
});
$('cameraDevice').onchange = async () => {
  if (!state.stream) return;
  try { await startCamera(); setNotice('Camera device changed.'); }
  catch (error) { stopCamera(); setNotice(`Could not open that camera: ${error.message}`, 'error'); }
};
$('recordSpindle').onclick = async () => {
  try { await recordSpindlePoint(); }
  catch (error) { setNotice(error.message, 'error'); }
};
$('recordCamera').onclick = async () => {
  try { await recordCameraPoint(); }
  catch (error) { setNotice(error.message, 'error'); }
};
$('clearCalibration').onclick = async () => {
  await storage.delete('cameraOffset');
  state.offset = null;
  state.spindlePoint = null;
  state.cameraPoint = null;
  render();
  setNotice('Saved camera offset cleared.');
};
$('safeToJog').onchange = render;
$('wcsSelect').onchange = () => {
  state.selectedWcs = $('wcsSelect').value;
  state.wcsSelectionTouched = true;
  render();
};
document.querySelectorAll('[data-axis]').forEach((button) => {
  button.onclick = async () => {
    try { await jog(button.dataset.axis, button.dataset.direction); }
    catch (error) { setNotice(error.message, 'error'); }
  };
});
$('setZero').onclick = async () => {
  try { await setWorkZero(); }
  catch (error) { setNotice(error.message, 'error'); }
};

$('registrationFile').onchange = async () => {
  try {
    const file = $('registrationFile').files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) throw new Error('G-code files larger than 25 MB are not supported.');
    const text = await file.text();
    if (!text.trim()) throw new Error('The selected file is empty.');
    state.registrationFile = file;
    state.registrationText = text;
    state.markA = null;
    state.markB = null;
    $('registrationFileInfo').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · source stays on this device`;
    $('registrationResult').hidden = true;
    render();
    setNotice('File loaded locally. Enter the XY coordinates of two matching registration points, then record their printed positions with the camera.');
  } catch (error) {
    clearRegistration();
    setNotice(error.message, 'error');
  }
};
$('recordMarkA').onclick = async () => {
  try { await recordRegistrationMark('A'); }
  catch (error) { setNotice(error.message, 'error'); }
};
$('recordMarkB').onclick = async () => {
  try { await recordRegistrationMark('B'); }
  catch (error) { setNotice(error.message, 'error'); }
};
$('alignFile').onclick = async () => {
  state.registrationBusy = true;
  render();
  try { await alignRegistrationFile(); }
  catch (error) { setNotice(error.message, 'error'); }
  finally { state.registrationBusy = false; render(); }
};
$('clearRegistration').onclick = clearRegistration;

initialize();
