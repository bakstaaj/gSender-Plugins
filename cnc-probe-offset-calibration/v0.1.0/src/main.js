import { machine, redux, storage } from '@sienci/gsender-plugin-sdk';
import './style.css';

const SAVE_KEY = 'calibrationSettings';
const $ = (id) => document.getElementById(id);
const state = {
  connected: false, activeState: 'Unknown', profile: null, busy: false,
  sensorSource: 'Read gSender preferences or confirm the displayed location.',
  probeSource: 'Read gSender preferences or confirm the displayed probe values.',
  savedOffset: null, result: null, saved: false, probeSignalVerified: false,
  probeParserReady: false, probeReport: null, probeReportSequence: 0, unsubscribeProbe: null,
};
const PROBE_PARSER_ID = 'cnc-probe-offset-calibration-result';

const defaults = {
  sensorX: 6, sensorY: -1, sensorZ: -5,
  bedX: 0, bedY: 0,
  distance: 50, fast: 500, slow: 25, retract: 2,
};

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function number(id) { const value = Number($(id)?.value); return Number.isFinite(value) ? value : NaN; }
function fmt(value) { return Number(value).toFixed(3); }
function updateNotice(message, kind = '') { const node = $('notice'); if (node) { node.textContent = message; node.className = 'notice ' + kind; } }
function inputField(label, id, value, unit, help = '') {
  return `<label class="field"><span>${label}</span><span class="input"><input id="${id}" type="number" step="0.001" value="${esc(value)}"><span>${unit}</span></span>${help ? `<small>${help}</small>` : ''}</label>`;
}

function render() {
  const p = state.profile || defaults;
  $('app').innerHTML = `<div class="page">
    <header><div><div class="eyebrow">GRBLHAL · Z PROBE CALIBRATION</div><h1>Fixed sensor to bed offset</h1><div class="help">Measure the fixed tool setter, then the bed probe point. Review and save the signed offset in this plugin.</div></div><div class="connection ${state.connected && state.activeState === 'Idle' ? 'ok' : ''}" id="connection">${state.connected ? `Connected · ${esc(state.activeState)}` : 'Not connected'}</div></header>
    <div id="notice" class="notice">Connect to the controller, home the machine, and verify the probe input before starting.</div>
    <section class="panel"><h2>Fixed sensor location</h2><div class="grid">${inputField('X', 'sensorX', p.sensorX, 'mm')}${inputField('Y', 'sensorY', p.sensorY, 'mm')}${inputField('Z start', 'sensorZ', p.sensorZ, 'mm', 'Use the configured fixed sensor location. Z is the safe start height above the setter.')}</div><div class="row"><span class="source" id="sensorSource">${esc(state.sensorSource)}</span><button id="readSettings">Read gSender settings</button></div></section>
    <section class="panel"><h2>Bed touch point</h2><div class="grid two">${inputField('Machine X', 'bedX', p.bedX, 'mm')}${inputField('Machine Y', 'bedY', p.bedY, 'mm')}</div><p class="help">Choose a clear, conductive bed point with room for the probe plate. The tool uses the configured Z start machine coordinate while traveling to this XY point.</p></section>
    <section class="panel"><h2>Probe settings</h2><div class="grid">${inputField('Maximum probe travel', 'distance', p.distance, 'mm')}${inputField('Fast find', 'fast', p.fast, 'mm/min')}${inputField('Slow find', 'slow', p.slow, 'mm/min')}${inputField('Retraction', 'retract', p.retract, 'mm')}</div><div class="row"><span class="source" id="probeSource">${esc(state.probeSource)}</span></div></section>
    <section class="panel"><h2>Saved offset</h2><div class="grid two">${inputField('Offset value', 'offsetValue', state.result ? fmt(state.result.delta) : (state.savedOffset ?? ''), 'mm', 'The measured value is inserted after calibration. Edit it before saving, or enter your own value.')}</div><div class="row"><button id="saveOffset" class="primary" ${state.result || state.savedOffset !== null ? '' : 'disabled'}>Save offset in plugin</button><span id="offsetStatus" class="source">${state.savedOffset !== null ? `Saved offset: ${fmt(state.savedOffset)} mm` : ''}</span></div></section>
    <section class="panel"><h2>Calibration</h2>
      <div class="step"><span class="badge">1</span><div><strong>Verify probe input</strong><p>With the machine idle, release the probe, activate it, then release it. The controller must report Pn:P for both transitions.</p><button id="checkProbe" class="secondary">Check probe signal</button><span id="probeCheck" class="source"></span></div></div>
      <div class="step"><span class="badge">2</span><div><strong>Probe the fixed sensor</strong><p>Use the conductive tool in the spindle. The machine moves to the configured fixed sensor start point and runs fast then slow Z probing.</p></div></div>
      <div class="step"><span class="badge">3</span><div><strong>Probe the bed</strong><p>The machine retracts to the configured Z start machine coordinate, then moves to the selected bed point. Attach the probe clip and touch plate when prompted, then continue the same two-stage Z probe.</p></div></div>
      <div class="step"><span class="badge">4</span><div><strong>Review and save</strong><p>The value is calculated as fixed-sensor trigger Z minus bed trigger Z. Edit or overwrite it, then save it in plugin storage.</p></div></div>
      <label class="check"><input id="homedConfirm" type="checkbox"><span>I have homed the machine and confirmed the fixed sensor coordinates, bed point, tool clearance, and probe wiring.</span></label>
      <div class="row"><button id="startCalibration" class="primary">Start calibration</button><span class="grow"></span><span id="result" class="result">${state.result ? `${fmt(state.result.delta)} mm` : ''}</span></div>
      <div id="resultDetails" class="help">${state.result ? `Setter trigger Z ${fmt(state.result.setterZ)} mm · Bed trigger Z ${fmt(state.result.bedZ)} mm` : ''}</div>
    </section>
    <p class="help">Motion safety: this workflow only runs while connected and Idle. Keep the spindle off. Stay at the machine and be ready to stop it. This plugin has not been validated on a physical machine.</p>
    <dialog id="confirmDialog" class="confirm-dialog"><h2 id="confirmTitle">Confirm calibration</h2><p id="confirmMessage"></p><div class="row"><button id="confirmCancel" type="button">Cancel</button><span class="grow"></span><button id="confirmAccept" class="primary" type="button">Continue</button></div></dialog>
  </div>`;
  bindEvents();
}

function bindEvents() {
  document.querySelectorAll('input').forEach(input => input.addEventListener('change', () => { void saveUiSettings(); }));
  $('readSettings').addEventListener('click', () => void readGsSettings());
  $('checkProbe').addEventListener('click', () => void checkProbeSignal());
  $('startCalibration').addEventListener('click', () => void startCalibration());
  $('saveOffset').addEventListener('click', () => void saveOffset());
  $('offsetValue').addEventListener('input', () => { $('saveOffset').disabled = !Number.isFinite(Number($('offsetValue').value)); });
  $('confirmCancel').addEventListener('click', () => $('confirmDialog').close('cancel'));
  $('confirmAccept').addEventListener('click', () => $('confirmDialog').close('accept'));
}

function askToContinue(title, message, acceptLabel = 'Continue') {
  const dialog = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmAccept').textContent = acceptLabel;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true });
  });
}

function collectInputs() {
  return Object.fromEntries(['sensorX', 'sensorY', 'sensorZ', 'bedX', 'bedY', 'distance', 'fast', 'slow', 'retract']
    .map(id => [id, $(id)?.value ?? defaults[id]]));
}
async function saveUiSettings() {
  state.profile = collectInputs();
  try { await storage.set(SAVE_KEY, { ...state.profile, offsetValue: state.savedOffset }); } catch (error) { updateNotice(`Could not save plugin settings: ${error.message || error}`, 'error'); }
}
function walkObjects(root, visit, path = '', seen = new WeakSet()) {
  if (!root || typeof root !== 'object' || seen.has(root)) return;
  seen.add(root); visit(root, path);
  for (const [key, value] of Object.entries(root)) walkObjects(value, visit, path ? `${path}.${key}` : key, seen);
}
function objectXYZ(value) {
  if (!value || typeof value !== 'object') return null;
  const entries = new Map(Object.entries(value).map(([key, v]) => [norm(key), Number(v)]));
  const x = entries.get('x'), y = entries.get('y'), z = entries.get('z');
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}
function findSettingObject(snapshot) {
  let found = null;
  walkObjects(snapshot, (obj, path) => {
    if (found) return;
    for (const [key, value] of Object.entries(obj)) {
      const nk = norm(key);
      if (['fixedsensorlocation', 'fixedtoolsensorlocation', 'toolsensorlocation'].includes(nk)) {
        const xyz = objectXYZ(value);
        if (xyz) { found = { xyz, path: `${path}.${key}` }; return; }
      }
    }
  });
  return found;
}
function findProbeValues(snapshot) {
  const found = {};
  const aliases = {
    distance: ['zprobedistance', 'probedistance', 'probetravel'],
    fast: ['fastfind', 'zprobefastfind', 'probefastfeedrate'],
    slow: ['slowfind', 'zprobeslowfind', 'probeslowfeedrate'],
    retract: ['retraction', 'proberetraction', 'zproberetraction'],
  };
  walkObjects(snapshot, obj => {
    for (const [key, value] of Object.entries(obj)) {
      const nk = norm(key);
      for (const [field, candidates] of Object.entries(aliases)) {
        if (found[field] === undefined && candidates.includes(nk) && Number.isFinite(Number(value))) found[field] = Number(value);
      }
    }
  });
  return found;
}
async function readGsSettings() {
  try {
    const snapshot = await redux.getState();
    const sensor = findSettingObject(snapshot);
    const probe = findProbeValues(snapshot);
    let changed = false;
    if (sensor) {
      state.profile.sensorX = sensor.xyz.x; state.profile.sensorY = sensor.xyz.y; state.profile.sensorZ = sensor.xyz.z;
      state.sensorSource = `Loaded from gSender: ${sensor.path}`; changed = true;
    }
    for (const field of ['distance', 'fast', 'slow', 'retract']) {
      if (probe[field] !== undefined) { state.profile[field] = probe[field]; changed = true; }
    }
    if (Object.keys(probe).length) state.probeSource = `Loaded ${Object.keys(probe).join(', ')} from gSender settings.`;
    else state.probeSource = 'gSender did not expose probe values to this plugin; confirm or edit the displayed values.';
    if (!sensor) state.sensorSource = 'gSender did not expose the fixed sensor location; confirm or edit the displayed coordinates.';
    await storage.set(SAVE_KEY, { ...state.profile, offsetValue: state.savedOffset }); render();
    updateNotice(changed ? 'gSender settings read. Review all coordinates and probe values before moving.' : 'Could not read those gSender settings through the plugin API. Review the displayed values and enter the current settings manually.', changed ? '' : 'error');
  } catch (error) { updateNotice(`Could not read gSender settings: ${error.message || error}`, 'error'); }
}

async function query(command, timeout = 10000, maxLines = 1000) {
  const result = await machine.query(command, { until: 'ok-or-error', timeout, maxLines });
  if (!result?.complete || result.error || !result.ok) throw new Error(`${command} failed: ${result?.error || result?.reason || (result?.lines || []).join(' ')}`);
  return (result.lines || []).map(String);
}
async function refreshConnection() {
  try {
    const snapshot = await redux.getState();
    state.connected = !!snapshot?.connection?.isConnected;
    state.activeState = snapshot?.controller?.state?.status?.activeState || 'Unknown';
    if (!state.connected || state.activeState !== 'Idle') state.probeSignalVerified = false;
    const node = $('connection');
    if (node) { node.textContent = state.connected ? `Connected · ${state.activeState}` : 'Not connected'; node.className = `connection ${state.connected && state.activeState === 'Idle' ? 'ok' : ''}`; }
  } catch { state.connected = false; state.activeState = 'Unknown'; }
}
async function waitForIdle(timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await refreshConnection();
    if (!state.connected) throw new Error('Controller disconnected while moving to the bed point.');
    if (state.activeState === 'Idle') return;
    if (state.activeState !== 'Run' && state.activeState !== 'Jog') {
      throw new Error(`Controller entered ${state.activeState} while moving to the bed point.`);
    }
    updateNotice('Moving to the bed touch point… waiting for motion to finish.');
    await pause(200);
  }
  throw new Error('Timed out waiting for the bed-point move to finish. Check the controller before continuing.');
}
async function readProbePin() {
  const result = await machine.query('?', { until: /^<[^>]+>$/, timeout: 1500, maxLines: 10, allowDuringJob: false, includeStatusReports: true });
  const line = (result.lines || []).map(String).find(item => /^\s*</.test(item));
  if (!line) return null;
  const match = line.match(/\|Pn:([^|>]*)/i);
  return match ? new Set(match[1].toUpperCase().match(/[A-Z]/g) || []).has('P') : false;
}
async function checkProbeSignal() {
  if (!state.connected || state.activeState !== 'Idle') { updateNotice('The probe signal check requires a connected, Idle controller.', 'error'); return; }
  const node = $('probeCheck'); const button = $('checkProbe'); button.disabled = true;
  try {
    updateNotice('Release the probe and leave it clear. Checking controller status…');
    let clear = false; let active = false; let released = false;
    for (let i = 0; i < 20 && !clear; i++) { clear = (await readProbePin()) === false; if (!clear) await pause(300); }
    if (!clear) throw new Error('No clear Pn report was received. Confirm the controller reports pin states, then retry.');
    node.textContent = 'Clear state detected. Activate the probe now.';
    for (let i = 0; i < 40 && !active; i++) { active = (await readProbePin()) === true; if (!active) await pause(300); }
    if (!active) throw new Error('No Pn:P activation was reported. Calibration motion is blocked until the controller detects the probe.');
    node.textContent = 'Probe activation detected. Release it now.';
    for (let i = 0; i < 40 && !released; i++) { released = (await readProbePin()) === false; if (!released) await pause(300); }
    if (!released) throw new Error('The probe did not return to a clear state.');
    node.textContent = 'Probe activation and release confirmed.'; node.className = 'source'; state.probeSignalVerified = true;
    updateNotice('Probe input passed the activation and release check.', 'success');
  } catch (error) { state.probeSignalVerified = false; node.textContent = error.message || String(error); node.className = 'source'; updateNotice(error.message || String(error), 'error'); }
  finally { button.disabled = false; }
}
function pause(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function validate() {
  const fields = ['sensorX', 'sensorY', 'sensorZ', 'bedX', 'bedY', 'distance', 'fast', 'slow', 'retract'];
  const values = Object.fromEntries(fields.map(id => [id, number(id)]));
  if (fields.some(id => !Number.isFinite(values[id]))) throw new Error('Enter a valid number for every coordinate and probe setting.');
  if (values.distance <= 0 || values.fast <= 0 || values.slow <= 0 || values.retract <= 0 || values.retract >= values.distance) throw new Error('Probe distance, feeds, and retraction must be positive; retraction must be shorter than probe travel.');
  if (!state.connected || state.activeState !== 'Idle') throw new Error('The controller must be connected and Idle.');
  if (!$('homedConfirm').checked) throw new Error('Confirm the machine is homed and the displayed locations are safe.');
  return values;
}
async function runProbe(label, distance, fast, slow, retract) {
  const fastPos = await executeProbe(`G91 G38.2 Z-${fmt(distance)} F${fmt(fast)}`, `${label} fast probe`);
  await query(`G91 G0 Z${fmt(retract)}`, 30000, 20);
  // Retract already provides the return distance to the first contact. Add only
  // a small margin so the slow pass can re-touch without extending needlessly
  // toward the machine's soft-limit boundary.
  const slowTravel = Math.min(distance, Math.max(retract + 0.25, 1));
  const slowPos = await executeProbe(`G91 G38.2 Z-${fmt(slowTravel)} F${fmt(slow)}`, `${label} slow probe`);
  return slowPos;
}
async function executeProbe(command, stage) {
  if (!state.probeParserReady) throw new Error('The controller probe-result listener is not ready; no probe motion was sent.');
  const previousSequence = state.probeReportSequence;
  const result = await machine.query(command, { until: 'ok-or-error', timeout: 120000, maxLines: 40 });
  const directLine = (result?.lines || []).map(line => String(line).trim()).find(line => /^\[PRB:/i.test(line));
  let reportLine = directLine;
  if (!reportLine && result?.complete && result.ok && !result.error) {
    const deadline = Date.now() + 5000;
    while (!reportLine && state.probeReportSequence === previousSequence && Date.now() < deadline) await pause(25);
    if (state.probeReportSequence > previousSequence) reportLine = state.probeReport;
  }
  return parseProbeResult(result, stage, reportLine);
}
function parseProbeResult(result, stage, reportLine) {
  const lines = (result?.lines || []).map(line => String(line).trim());
  const alarm = lines.find(line => /^ALARM\s*:/i.test(line));
  if (alarm) throw new Error(`${stage} stopped with ${alarm}. Stop and inspect the machine before continuing.`);
  const report = reportLine || lines.find(line => /^\[PRB:/i.test(line));
  if (!result?.complete || !result.ok || result.error || !report) throw new Error(`${stage} did not return a successful [PRB:...] result. Response: ${lines.join(' ') || result?.reason || 'no response'}`);
  const match = report.match(/^\[PRB:([-+\d.]+),([-+\d.]+),([-+\d.]+)(?:,[-+\d.]+)*:([01])\]$/i);
  if (!match || match[4] !== '1') throw new Error(`${stage} did not detect contact. No delta was saved.`);
  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}
async function startCalibration() {
  if (state.busy) return;
  if (!state.probeSignalVerified) { updateNotice('Run and pass Check probe signal before starting. The plugin will not move until clear, active, and release states are confirmed.', 'error'); return; }
  let v;
  try { v = validate(); } catch (error) { updateNotice(error.message, 'error'); return; }
  updateNotice('Waiting for calibration confirmation.');
  if (!await askToContinue('Start calibration?', 'This runs two Z probe cycles at the fixed sensor and two at the bed point. Confirm the bitsetter is clear, the probe travel is safe, and you can stop the machine if needed.', 'Start calibration')) {
    updateNotice('Calibration canceled. No motion was sent.'); return;
  }
  state.busy = true; $('startCalibration').disabled = true;
  let originalInches = false;
  try {
    const modes = await query('$G', 5000, 30);
    originalInches = modes.some(line => /\bG20\b/.test(line));
    await query('G21 G90 G94', 10000, 20);
    updateNotice('Moving to the fixed sensor start location…');
    await query(`G53 G90 G0 Z${fmt(v.sensorZ)}`, 60000, 20);
    await query(`G53 G0 X${fmt(v.sensorX)} Y${fmt(v.sensorY)}`, 60000, 20);
    const setter = await runProbe('Fixed sensor', v.distance, v.fast, v.slow, v.retract);
    await query(`G90 G53 G0 Z${fmt(v.sensorZ)}`, 60000, 20);
    updateNotice('Moving to the bed touch point…');
    await query(`G53 G0 X${fmt(v.bedX)} Y${fmt(v.bedY)}`, 60000, 20);
    await waitForIdle();
    const continueBed = await askToContinue('Attach bed probe', 'Fixed sensor probe completed. Attach the electrical probe to the tool and place its plate at the selected bed touch point. Confirm the probe is clear and attached, then continue.', 'Probe bed');
    if (!continueBed) throw new Error('Calibration stopped at the bed probe prompt. The fixed sensor reading was not saved.');
    const pin = await readProbePin();
    if (pin !== false) throw new Error('Probe input is not clear at the bed point. Check the clip/plate connection and try again.');
    const bed = await runProbe('Bed', v.distance, v.fast, v.slow, v.retract);
    await query(`G90 G53 G0 Z${fmt(v.sensorZ)}`, 60000, 20);
    const delta = setter.z - bed.z;
    state.result = { setterZ: setter.z, bedZ: bed.z, delta };
    state.saved = false;
    $('result').textContent = `${fmt(delta)} mm`;
    $('resultDetails').textContent = `Fixed sensor trigger Z ${fmt(setter.z)} mm · Bed trigger Z ${fmt(bed.z)} mm · Fixed sensor minus bed`;
    $('offsetValue').value = fmt(delta); $('saveOffset').disabled = false;
    updateNotice('Both probe cycles completed. Review or edit the offset, then save it in plugin storage.', 'success');
  } catch (error) {
    updateNotice(error.message || String(error), 'error');
  } finally {
    try { await query('G90', 5000, 10); if (originalInches) await query('G20', 5000, 10); }
    catch { /* Keep the controller in absolute mode if the cleanup command cannot be acknowledged. */ }
    state.busy = false; $('startCalibration').disabled = false;
  }
}
async function saveOffset() {
  if (state.busy) return;
  const value = Number($('offsetValue').value);
  if (!Number.isFinite(value)) { updateNotice('Enter a valid numeric offset before saving.', 'error'); return; }
  state.busy = true; $('saveOffset').disabled = true;
  try {
    state.savedOffset = value;
    await storage.set(SAVE_KEY, { ...collectInputs(), offsetValue: value });
    $('offsetStatus').textContent = `Saved offset: ${fmt(value)} mm`;
    updateNotice(`Offset ${fmt(value)} mm saved in this plugin's gSender storage. No controller setting was changed.`, 'success');
  } catch (error) { $('offsetStatus').textContent = error.message || String(error); updateNotice(error.message || String(error), 'error'); $('saveOffset').disabled = false; }
  finally { state.busy = false; }
}

async function initialize() {
  try {
    const saved = await storage.get(SAVE_KEY, null);
    state.profile = { ...defaults, ...(saved && typeof saved === 'object' ? saved : {}) };
    const offset = Number(saved?.offsetValue);
    state.savedOffset = saved?.offsetValue !== undefined && Number.isFinite(offset) ? offset : null;
  } catch { state.profile = { ...defaults }; }
  try {
    const registration = await machine.registerParser({
      id: PROBE_PARSER_ID,
      mode: 'line',
      match: /^\[PRB:(?<x>[-+\d.]+),(?<y>[-+\d.]+),(?<z>[-+\d.]+)(?:,[-+\d.]+)*:(?<success>[01])\]\s*$/i,
    });
    if (!registration?.registered?.includes(PROBE_PARSER_ID) || registration.errors?.length) throw new Error(registration?.errors?.map(item => item.error || item.message).join('; ') || 'Parser registration was not confirmed.');
    state.probeParserReady = true;
    state.unsubscribeProbe = machine.onParsed(PROBE_PARSER_ID, report => {
      state.probeReport = String(report?.line || '').trim();
      state.probeReportSequence++;
    });
  } catch (error) {
    state.probeParserReady = false;
    state.sensorSource = `Probe report listener error: ${error.message || error}`;
  }
  render(); await refreshConnection();
  const timer = window.setInterval(() => { void refreshConnection(); }, 1000);
  window.addEventListener('beforeunload', () => {
    window.clearInterval(timer); state.unsubscribeProbe?.();
    void machine.unregisterParser(PROBE_PARSER_ID).catch(() => {});
  });
}

void initialize();
