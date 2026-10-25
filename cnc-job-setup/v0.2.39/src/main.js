import { machine, redux, storage, workspace } from '@sienci/gsender-plugin-sdk';
import './style.css';

const KEY = 'jobSetupProfile';
const steps = ['Load File', 'Home', 'Assists', 'Stock', 'Origin', 'Probe', 'Run'];
const isVisualizerOverlay = (() => {
  try {
    let ancestor = window.frameElement && window.frameElement.parentElement;
    while (ancestor) {
      const classes = ancestor.classList;
      if (classes && ['absolute', 'right-4', 'top-4', 'bottom-4', 'w-80'].every(name => classes.contains(name))) return true;
      ancestor = ancestor.parentElement;
    }
  } catch { /* Keep the full configuration page if the host frame is inaccessible. */ }
  return false;
})();
const defaults = {
  profileName: 'Makera Z1', stockMode: 'anchor1', stockX: 200, stockY: 200, stockZ: 10,
  playbackMode: 'upload-run', localStartCommands: 'M32 {filePath}',
  uploadBridgeUrl: 'http://127.0.0.1:2324',
  // These are the Front-Left work coordinates assigned when the machine is at its home position.
  originRelative: 'Front-Left', originX: 189.620, originY: 192.790, customOriginX: 0, customOriginY: 0,
  originCommands: 'G10 L20 P0 X189.62 Y192.79',
  leveling: false, levelingCommands: 'M495 X{originX} Y{originY} A{stockX} B{stockY} I{levelingX} J{levelingY} H{levelingClearance} P1', levelingClearance: 5, levelingX: 5, levelingY: 5,
  zProbe: true, zProbeCommands: 'M495 X{jobCenterX} Y{jobCenterY} O{probeOffsetX} F{probeOffsetY} P1', probeRelative: 'NC File Center', probeOffsetX: 0, probeOffsetY: 0,
  probePointMode: 'Probe Stock Center', customProbeX: 0, customProbeY: 0,
  probePrepareCommands: 'M493.2 T-1',
  jobToolNumber: 1, jobToolChangeCommands: 'M493.2 T-1\nM6 T{jobToolNumber}',
  assists: [
    { name: 'Auto Vacuum', enabled: true, on: 'M331.0', off: 'M332.0' },
    { name: 'Auto Blow', enabled: true, on: 'M331.1', off: 'M332.1' },
    { name: 'Auto Bed Clean', enabled: true, on: 'M331.2', off: 'M332.2' },
    { name: 'Anti-Static', enabled: false, on: 'M331.4', off: 'M332.4' },
    { name: 'Auto Time-Lapse', enabled: false, on: '', off: '' },
  ],
};

const state = { profile: { ...structuredClone(defaults), id: 'makera-z1' }, profiles: [], profileId: 'makera-z1', step: 0, connected: false, status: 'Unknown', controllerType: '', busy: false, emergencyStopInProgress: false, operationGeneration: 0, homed: false, homing: false, toolInstalledConfirmed: false, toolChangePending: false, toolChangeMessage: '', toolChangeStatusDismissed: false, runStarted: false, runPlaybackMode: null, localRunStartedAt: 0, localRunSawActive: false, localRunSawProgress: false, localRunProgress: null, localRunPollAt: 0, localRunPollBusy: false, localRunFinishBusy: false, notice: '', noticeType: 'info', job: null, jobCenter: null, workflowPhase: 'idle', motion: { probeSent: false, probeDone: false, jobToolSent: false, jobToolDone: false } };
const app = document.querySelector('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;

function field(label, key, value, type = 'number', suffix = '') {
  return `<label class="field"><span>${label}</span><span class="input-wrap"><input data-field="${key}" type="${type}" value="${esc(value)}" ${type === 'number' ? 'step="any"' : ''}>${suffix ? `<i>${suffix}</i>` : ''}</span></label>`;
}
function toggle(label, key, checked) {
  return `<label class="toggle-row"><span>${label}</span><input data-field="${key}" type="checkbox" ${checked ? 'checked' : ''}><b></b></label>`;
}
function textarea(label, key, value, hint = '') {
  return `<label class="field full"><span>${label}</span><textarea data-field="${key}" rows="3" spellcheck="false" placeholder="${esc(hint)}">${esc(value)}</textarea></label>`;
}
function computeJobCenter(gcode) {
  let absolute = true, scale = 1, x = 0, y = 0, motion = null;
  const xs = [], ys = [];
  for (const raw of String(gcode || '').split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)/g, '').split(';', 1)[0].toUpperCase();
    const words = [...line.matchAll(/([A-Z])\s*([-+]?(?:\d+\.?\d*|\.\d+))/g)].map(m => [m[1], Number(m[2])]);
    if (!words.length) continue;
    const codes = words.filter(([letter]) => letter === 'G').map(([, value]) => value);
    if (codes.some(code => [10, 28, 30, 53, 92].includes(code))) continue;
    if (words.some(([letter]) => letter === 'M')) continue;
    for (const code of codes) {
      if (code === 90) absolute = true;
      else if (code === 91) absolute = false;
      else if (code === 20) scale = 25.4;
      else if (code === 21) scale = 1;
      else if ([0, 1, 2, 3].includes(code)) motion = code;
    }
    if (motion === null) continue;
    const values = Object.fromEntries(words.filter(([letter]) => letter === 'X' || letter === 'Y'));
    if (Object.hasOwn(values, 'X')) x = absolute ? values.X * scale : x + values.X * scale;
    if (Object.hasOwn(values, 'Y')) y = absolute ? values.Y * scale : y + values.Y * scale;
    if (Object.hasOwn(values, 'X') || Object.hasOwn(values, 'Y')) { xs.push(x); ys.push(y); }
  }
  if (!xs.length || !ys.length) return null;
  const format = value => Number(value.toFixed(3));
  const minX = format(Math.min(...xs)), minY = format(Math.min(...ys));
  return { x: format((Math.min(...xs) + Math.max(...xs)) / 2), y: format((Math.min(...ys) + Math.max(...ys)) / 2), minX, minY };
}
function loadedFileFromState(...snapshots) {
  const candidates = [];
  const seen = new Set();
  const queue = snapshots.filter(value => value && typeof value === 'object').map(value => [value, 0]);
  while (queue.length && candidates.length < 500) {
    const [value, depth] = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      if (depth < 5) for (const child of value) if (child && typeof child === 'object') queue.push([child, depth + 1]);
      continue;
    }
    candidates.push(value);
    if (depth < 5) {
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === 'object' && /file|job|gcode|program|visual|workspace/i.test(key)) queue.push([child, depth + 1]);
      }
    }
  }
  const contentOf = file => {
    for (const key of ['content', 'gcode', 'fileContent', 'text']) {
      if (typeof file?.[key] === 'string' && file[key].trim()) return file[key];
    }
    if (Array.isArray(file?.lines) && file.lines.length) return file.lines.map(line => typeof line === 'string' ? line : line?.line || line?.text || '').join('\n');
    return '';
  };
  const hasContent = file => !!contentOf(file);
  const file = candidates.find(candidate => candidate.fileLoaded && hasContent(candidate)) ||
    candidates.find(hasContent) || candidates.find(candidate => candidate.fileLoaded) || null;
  return file ? { ...file, content: contentOf(file) } : null;
}
function detectJobToolNumber(gcode, fallback) {
  for (const raw of String(gcode || '').split(/\r?\n/)) {
    const line = raw.replace(/\([^)]*\)/g, '').split(';', 1)[0].toUpperCase();
    if (!/\bM0?6\b/.test(line)) continue;
    const match = line.match(/\bT\s*(\d+)\b/);
    if (match) return Number(match[1]);
  }
  return Number(fallback) || 1;
}
function notice() {
  const msg = state.notice || (state.connected ? `Connected · ${state.status}` : 'Connect gSender to the machine before applying setup commands.');
  return `<div class="notice ${state.notice ? state.noticeType : state.connected ? 'ok' : 'info'}">${esc(msg)}</div>`;
}
function isToolChangeState(status) {
  return /^(?:tool|tool\s*change)$/i.test(String(status || '').trim());
}
function legacyStepContent() {
  const p = state.profile;
  if (state.step === 0) return `
    <h2>Set Stock</h2><p class="intro">Confirm the stock dimensions and how it is fixed for this job.</p>
    <div class="job-file">${state.job ? `<strong>${esc(state.job.name)}</strong><span>${state.jobCenter ? `G-code XY center: X${esc(state.jobCenter.x)} · Y${esc(state.jobCenter.y)} mm` : 'Could not determine an XY center from the loaded G-code.'}</span>` : 'Load an NC file in gSender before starting this workflow.'}</div>
    <div class="choice-row"><label><input type="radio" name="stockMode" value="anchor1" ${p.stockMode === 'anchor1' ? 'checked' : ''}> Anchor1 fixture</label><label><input type="radio" name="stockMode" value="custom" ${p.stockMode === 'custom' ? 'checked' : ''}> Custom placement</label></div>
    <div class="form-grid">${field('Stock X', 'stockX', p.stockX, 'number', 'mm')}${field('Stock Y', 'stockY', p.stockY, 'number', 'mm')}${field('Stock thickness', 'stockZ', p.stockZ, 'number', 'mm')}</div>
    <p class="step-help">Place and secure the stock. Confirm there is clearance for the full toolpath before continuing.</p>`;
  if (state.step === 1) return `
    <h2>Set Origin</h2><p class="intro">Set the work origin for this job. The profile stores your coordinates and command.</p>
    <div class="form-grid origin-grid"><label class="field"><span>Relative to</span><select data-field="originRelative"><option ${p.originRelative === 'Anchor1' ? 'selected' : ''}>Anchor1</option><option ${p.originRelative === 'Custom' ? 'selected' : ''}>Custom</option></select></label>${field('X offset', 'originX', p.originX, 'number', 'mm')}${field('Y offset', 'originY', p.originY, 'number', 'mm')}</div>
    ${textarea('Apply origin command(s)', 'originCommands', p.originCommands, 'One G-code command per line')}
    <div class="button-row"><button class="secondary" data-action="apply-origin" ${!state.connected || state.status !== 'Idle' || state.busy ? 'disabled' : ''}>Apply Settings</button></div>
    <p class="step-help">For the Makera Z1 Anchor1 fixture, the included profile uses the Studio reference values X189.620 / Y192.790 mm at the far-right home corner. Apply only when the spindle is physically at the intended reference point. G10 L20 assigns the entered work coordinates to the current machine position.</p>`;
  if (state.step === 2) return `
    <h2>Auto Probe</h2><p class="intro">Run optional surface leveling or Z-height probing before machining.</p>
    <section class="option-card">${toggle('Auto Workpiece Leveling (Before Machining)', 'leveling', p.leveling)}
      <div class="form-grid compact">${field('Clearance height', 'levelingClearance', p.levelingClearance, 'number', 'mm')}${field('X points', 'levelingX', p.levelingX)}${field('Y points', 'levelingY', p.levelingY)}</div>
      ${textarea('Leveling G-code sequence', 'levelingCommands', p.levelingCommands, 'Makera Z1: M495 ... (editable; one command per line)')}
      <div class="button-row"><button class="secondary" data-action="run-level" ${!p.leveling || !p.levelingCommands.trim() || !state.connected || state.status !== 'Idle' || state.busy ? 'disabled' : ''}>Run leveling</button><span class="operation-state">${state.motion.levelDone ? 'Leveling complete' : state.motion.levelSent ? `Controller: ${esc(state.status)} · confirm completion at Idle` : 'Not run'}</span><button class="secondary" data-action="confirm-level" ${!state.motion.levelSent || state.status !== 'Idle' || state.motion.levelDone ? 'disabled' : ''}>Confirm complete</button></div>
    </section>
    <section class="option-card">${toggle('Auto Z-Height Probing (Before Machining)', 'zProbe', p.zProbe)}
      <div class="probe-center">Probe point from loaded file: <strong>${state.jobCenter ? `X${esc(state.jobCenter.x)} · Y${esc(state.jobCenter.y)} mm` : 'XY center unavailable'}</strong></div>
      <div class="form-grid compact">${field('Probe X offset', 'probeOffsetX', p.probeOffsetX, 'number', 'mm')}${field('Probe Y offset', 'probeOffsetY', p.probeOffsetY, 'number', 'mm')}</div>
      ${textarea('Before every Z probe (manual tool change only)', 'probePrepareCommands', p.probePrepareCommands, 'M493.2 T-1')}
      ${textarea('Z-probe G-code sequence', 'zProbeCommands', p.zProbeCommands, 'Makera Z1: M495 ... (editable; one command per line)')}
      <p class="step-help">The preparation command marks the active tool unknown so Z1 firmware prompts for the wired probe and repeats tool-height calibration. Use this only with manual tool changing; ATC machines must retain the actual active-tool identity.</p>
      <div class="button-row"><button class="secondary" data-action="run-zprobe" ${!p.zProbe || !p.zProbeCommands.trim() || !state.connected || state.status !== 'Idle' || state.busy || !state.jobCenter ? 'disabled' : ''}>Run Z probe</button><span class="operation-state">${state.motion.probeDone ? 'Z probe complete' : state.motion.probeSent ? `Controller: ${esc(state.status)} · confirm completion at Idle` : `Not run · ${esc(probeBlockReason())}`}</span><button class="secondary" data-action="confirm-zprobe" ${!state.motion.probeSent || state.status !== 'Idle' || state.motion.probeDone ? 'disabled' : ''}>Confirm complete</button></div>
      ${state.confirmProbe ? `<div class="inline-confirm"><strong>Confirm before probing</strong><span>Verify the machine is homed, the probe is installed, and the displayed XY point and offsets are safe.</span><div><button class="primary" data-action="confirm-run-zprobe">Run probe now</button><button class="secondary" data-action="cancel-probe-confirm">Cancel</button></div></div>` : ''}
    </section><p class="step-help">The Z1 firmware supports these operations through M495. Home the machine, verify the path origin and stock bounds, and check the probe tool and offsets before running either motion sequence. Other controllers need their own G-code.</p>`;
  if (state.step === 3) return `
    <h2>Assist Options</h2><p class="intro">Choose machine assists to enable for the job. Add the machine’s on/off G-code in the saved profile.</p>
    <div class="assist-list">${p.assists.map((a, i) => `<div class="assist">${toggle(a.name, `assist:${i}`, a.enabled)}<div class="assist-cmd"><input aria-label="${esc(a.name)} on command" data-field="assist:${i}:on" placeholder="On command" value="${esc(a.on)}"><input aria-label="${esc(a.name)} off command" data-field="assist:${i}:off" placeholder="Off command" value="${esc(a.off)}"></div></div>`).join('')}</div>
    <p class="step-help">Only assists with a configured command will be sent. Verify each command against your controller profile.</p>`;
  const jobToolNumber = detectJobToolNumber(state.job?.content, p.jobToolNumber);
  return `
    <h2>Review &amp; Run</h2><p class="intro">Confirm the setup before starting the loaded gSender job.</p>
    <div class="review-grid"><div><h3>Stock &amp; origin</h3><p>${esc(p.stockX)} × ${esc(p.stockY)} × ${esc(p.stockZ)} mm</p><p>Origin: ${esc(p.originRelative)} (${esc(p.originX)}, ${esc(p.originY)}) mm</p><p>Auto leveling: ${p.leveling ? 'On' : 'Off'}</p><p>Z-height probe: ${p.zProbe ? 'On' : 'Off'}</p></div><div><h3>Assist options</h3>${p.assists.map(a => `<p>${esc(a.name)} <strong>${a.enabled ? 'On' : 'Off'}</strong></p>`).join('')}</div></div>
    <section class="option-card"><h3>Cutting tool: T${esc(jobToolNumber)}</h3><p>The job tool change is forced before every run. The loaded file's first M6 T number is used when present; otherwise the profile tool number is used.</p>${textarea('Before every job run (manual tool change only)', 'jobToolChangeCommands', p.jobToolChangeCommands, 'M493.2 T-1 then M6 T{jobToolNumber}')}<div class="button-row"><button class="secondary" data-action="change-job-tool" ${!p.jobToolChangeCommands.trim() || !state.connected || state.status !== 'Idle' || state.busy || state.motion.jobToolSent ? 'disabled' : ''}>Change to job tool</button><span class="operation-state">${state.motion.jobToolDone ? `T${esc(jobToolNumber)} calibrated and confirmed` : state.motion.jobToolResumed ? `Tool-change wait released · controller ${esc(state.status)} · wait for height check to finish` : state.motion.jobToolSent ? 'Install the cutting tool, then continue the controller sequence' : 'Required before Run Job'}</span><button class="secondary" data-action="continue-job-tool" ${!state.motion.jobToolSent || state.motion.jobToolResumed || state.status !== 'Idle' || state.busy ? 'disabled' : ''}>Tool installed · continue</button><button class="secondary" data-action="confirm-job-tool" ${!state.motion.jobToolResumed || state.status !== 'Idle' || state.motion.jobToolDone ? 'disabled' : ''}>Confirm height check complete</button></div><p class="step-help">After installing the cutter, click “Tool installed · continue” to send M490.2 and resume the firmware. Wait until the machine finishes its height check, then confirm it here. gSender may continue to show Idle during the tool-change prompt. Manual tool change only; do not use with an ATC.</p></section>
    <label class="confirm"><input type="checkbox" id="confirmReady" ${state.confirmReady ? 'checked' : ''}> I have secured the stock, verified the origin, and cleared the machine travel area.</label>
    <p class="step-help">Run is enabled after the cutting-tool change is confirmed. The configured assist commands are then sent before gSender starts the currently loaded job.</p>`;
}
function probeBlockReason() {
  if (!state.profile.zProbe) return 'Enable Z probing in the profile.';
  if (!state.connected) return 'Connect gSender to the machine.';
  if (state.status !== 'Idle') return `Waiting for controller Idle (currently ${state.status}).`;
  if (!state.job) return 'Load an NC file in gSender.';
  if (!state.jobCenter) return 'The loaded file does not provide a readable XY path center.';
  if (!state.profile.zProbeCommands.trim()) return 'Configure a probe command.';
  if (state.busy) return 'Another command is in progress.';
  return 'Ready';
}
function legacyConfigurationContent() {
  const p = state.profile;
  return `<h2>Machine profile configuration</h2><p class="intro">Configure the machine-specific values and commands used by the Carve job setup workflow.</p>
    <div class="config-section"><h3>Profile and stock defaults</h3><div class="form-grid">${field('Profile name', 'profileName', p.profileName, 'text')}${field('Stock X', 'stockX', p.stockX, 'number', 'mm')}${field('Stock Y', 'stockY', p.stockY, 'number', 'mm')}${field('Stock thickness', 'stockZ', p.stockZ, 'number', 'mm')}</div>
    <div class="choice-row"><label><input type="radio" name="stockMode" value="anchor1" ${p.stockMode === 'anchor1' ? 'checked' : ''}> Anchor1 fixture</label><label><input type="radio" name="stockMode" value="custom" ${p.stockMode === 'custom' ? 'checked' : ''}> Custom placement</label></div></div>
    <div class="config-section"><h3>Origin</h3><div class="form-grid">${field('Origin reference', 'originRelative', p.originRelative, 'text')}${field('X offset', 'originX', p.originX, 'number', 'mm')}${field('Y offset', 'originY', p.originY, 'number', 'mm')}</div>${textarea('Origin G-code', 'originCommands', p.originCommands)}</div>
    <div class="config-section"><h3>Automatic probing</h3>${toggle('Enable workpiece leveling', 'leveling', p.leveling)}<div class="form-grid">${field('Leveling clearance', 'levelingClearance', p.levelingClearance, 'number', 'mm')}${field('Leveling X points', 'levelingX', p.levelingX)}${field('Leveling Y points', 'levelingY', p.levelingY)}</div>${textarea('Leveling G-code', 'levelingCommands')}<hr>${toggle('Enable Z-height probing', 'zProbe', p.zProbe)}<div class="form-grid">${field('Probe X offset', 'probeOffsetX', p.probeOffsetX, 'number', 'mm')}${field('Probe Y offset', 'probeOffsetY', p.probeOffsetY, 'number', 'mm')}</div>${textarea('Before every Z probe (manual tool change only)', 'probePrepareCommands', p.probePrepareCommands)}<p class="step-help">For the Makera Z1 manual tool changer, M493.2 T-1 marks the active tool unknown so M495 asks for the probe and recalibrates it. Do not use this preparation command with an ATC.</p>${field('Default cutting tool number', 'jobToolNumber', p.jobToolNumber)}${textarea('Before every job run (manual tool change only)', 'jobToolChangeCommands', p.jobToolChangeCommands)}<p class="step-help">The default run sequence forces a fresh tool change and height calibration using M493.2 T-1 followed by M6 T{jobToolNumber}. Do not use with an ATC.</p>${textarea('Z-height probe G-code', 'zProbeCommands')}</div>
    <div class="config-section"><h3>Job assists</h3>${p.assists.map((a, i) => `<div class="assist">${toggle(a.name, `assist:${i}`, a.enabled)}<div class="assist-cmd"><input aria-label="${esc(a.name)} on command" data-field="assist:${i}:on" placeholder="On command" value="${esc(a.on)}"><input aria-label="${esc(a.name)} off command" data-field="assist:${i}:off" placeholder="Off command" value="${esc(a.off)}"></div></div>`).join('')}</div>
    <div class="button-row"><button class="primary" data-action="save">Save Profile</button><span class="operation-state">The Carve overlay uses the selected saved profile.</span></div>`;
}
function legacyRender() {
  document.body.classList.toggle('overlay-mode', isVisualizerOverlay);
  const content = isVisualizerOverlay ? `<header><div><span class="eyebrow">CNC JOB SETUP</span><h1>Prepare this job</h1></div><div class="head-actions"><label class="profile-select">Profile<select id="profile">${state.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === state.profileId ? 'selected' : ''}>${esc(p.profileName)}</option>`).join('')}</select></label><span class="connection ${state.connected ? 'ok' : ''}">${state.connected ? `Connected · ${esc(state.status)}` : 'Not connected'}</span></div></header>
    ${notice()}<nav class="steps">${steps.map((s,i) => `<button data-step="${i}" class="${i === state.step ? 'selected' : i < state.step ? 'done' : ''}"><span>${i+1}</span>${s}</button>${i < 4 ? '<i>›</i>' : ''}`).join('')}</nav>
    <section class="panel">${stepContent()}</section><footer><button class="danger" data-action="stop" ${!state.connected || state.emergencyStopInProgress ? 'disabled' : ''}>Stop</button><div class="footer-right"><button class="secondary" data-action="cancel">Cancel</button>${state.step ? '<button class="secondary" data-action="back">‹ Back</button>' : ''}${state.step < 4 ? '<button class="primary" data-action="next">Next ›</button>' : `<button class="primary" data-action="start" id="startJob" ${!state.confirmReady || !state.connected || state.status !== 'Idle' || state.busy || (p.jobToolChangeCommands.trim() && !state.motion.jobToolDone) ? 'disabled' : ''}>Run Job</button>`}</div></footer>`
    : `<header><div><span class="eyebrow">CNC JOB SETUP</span><h1>Machine profiles</h1></div><div class="head-actions"><label class="profile-select">Machine profile<select id="profile">${state.profiles.map(p => `<option value="${esc(p.id)}" ${p.id === state.profileId ? 'selected' : ''}>${esc(p.profileName)}</option>`).join('')}</select></label><button class="secondary" data-action="new-profile">New Profile</button><span class="connection ${state.connected ? 'ok' : ''}">${state.connected ? `Connected · ${esc(state.status)}` : 'Not connected'}</span></div></header>${notice()}<section class="panel">${configurationContent()}</section>`;
  app.innerHTML = content;
  bind();
}
function setNotice(message, type = 'info') { state.notice = message; state.noticeType = type; render(); }
async function emergencyStopChecklist() {
  if (state.emergencyStopInProgress) return;
  // Invalidate pending home/probe workflows before issuing the realtime stop.
  // Otherwise their eventual responses can restore stale UI state after Stop.
  state.operationGeneration += 1;
  state.emergencyStopInProgress = true;
  state.busy = true;
  state.homed = false;
  state.homing = false;
  state.runStarted = false;
  state.runPlaybackMode = null;
  state.toolChangePending = false;
  state.toolChangeStatusDismissed = true;
  state.toolInstalledConfirmed = false;
  state.confirmReady = false;
  state.workflowPhase = 'idle';
  state.motion = { probeSent: false, probeDone: false, jobToolSent: false, jobToolDone: false };
  state.step = 0;
  state.notice = 'Sending the controller real-time reset. Home the machine before continuing.';
  state.noticeType = 'error';
  render();
  try {
    // gSender recognizes this escape in G-code and writes the GRBL Ctrl-X
    // reset byte immediately, bypassing the queued probe/motion commands.
    await machine.command('gcode', '[\\x18]');
  }
  catch (e) { state.notice = 'Emergency stop signal failed: ' + (e.message || e); state.noticeType = 'error'; }
  finally { state.busy = false; state.emergencyStopInProgress = false; render(); }
}
function readForm(target) {
  const key = target.dataset.field;
  if (!key) return;
  const value = target.type === 'checkbox' ? target.checked : target.type === 'number' ? num(target.value) : target.value;
  if (key.startsWith('assist:')) {
    const [_, idx, prop] = key.split(':');
    if (prop) state.profile.assists[Number(idx)][prop] = value;
    else state.profile.assists[Number(idx)].enabled = value;
  } else {
    state.profile[key] = value;
    if (key === 'originRelative' && value === 'Custom' && isVisualizerOverlay && state.step === 4) {
      state.profile.customOriginX = state.jobCenter?.minX ?? 0;
      state.profile.customOriginY = state.jobCenter?.minY ?? 0;
    }
    if (key === 'probePointMode' && value === 'Custom') {
      state.profile.customProbeX = state.jobCenter?.x ?? 0;
      state.profile.customProbeY = state.jobCenter?.y ?? 0;
    }
    if (['originX', 'originY', 'customOriginX', 'customOriginY', 'originRelative'].includes(key)) updateOriginCommand();
    if (['jobToolNumber', 'jobToolChangeCommands'].includes(key)) { state.motion.jobToolSent = false; state.motion.jobToolResumed = false; state.motion.jobToolDone = false; state.confirmReady = false; }
    if (key === 'leveling') state.motion = { ...state.motion, levelSent: false, levelBusy: false, levelDone: false };
    if (key === 'zProbe') state.motion = { ...state.motion, probeSent: false, probeBusy: false, probeDone: false };
  }
  if (key === 'confirmReady') return;
  void persist();
    if (['leveling', 'zProbe', 'profileName', 'originRelative', 'probePointMode', 'playbackMode'].includes(key)) render();
}
function updateOriginCommand() {
  const command = String(state.profile.originCommands || '').trim();
  if (!/^G10\s+L20\s+P0\s+X[-+\d.]+\s+Y[-+\d.]+$/i.test(command)) return;
  const format = value => Number(value || 0).toFixed(3).replace(/\.?0+$/, '');
  const { x, y } = originCoordinates();
  state.profile.originCommands = `G10 L20 P0 X${format(x)} Y${format(y)}`;
  const editor = document.querySelector('[data-field="originCommands"]');
  if (editor) editor.value = state.profile.originCommands;
}
function originCoordinates(profile = state.profile) {
  return profile.originRelative === 'Custom'
    ? { x: profile.customOriginX, y: profile.customOriginY }
    : { x: profile.originX, y: profile.originY };
}
function probeCoordinates(profile = state.profile) {
  return profile.probePointMode === 'Custom'
    ? { x: profile.customProbeX, y: profile.customProbeY }
    : { x: state.jobCenter?.x ?? 0, y: state.jobCenter?.y ?? 0 };
}
function hasLegacyZ1Origin(profile) {
  return profile.profileName === 'Makera Z1' && profile.originRelative === 'Anchor1' &&
    Number(profile.originX) === 0 && Number(profile.originY) === 0 &&
    /^G10\s+L20\s+P0\s+X0\s+Y0$/i.test(String(profile.originCommands || '').trim());
}
function migrateProfile(profile) {
  const migrated = { ...structuredClone(defaults), ...profile, assists: Array.isArray(profile.assists) ? profile.assists : structuredClone(defaults.assists) };
  if (!['stream', 'upload-run'].includes(migrated.playbackMode)) migrated.playbackMode = defaults.playbackMode;
  if (typeof migrated.localStartCommands !== 'string' || !migrated.localStartCommands.trim()) migrated.localStartCommands = defaults.localStartCommands;
  const legacyUploadEndpoint = /:\s*8766\/?$/i.test(String(migrated.uploadBridgeUrl || ''));
  if (legacyUploadEndpoint) migrated.uploadBridgeUrl = defaults.uploadBridgeUrl;
  const legacyZ1Origin = hasLegacyZ1Origin(migrated);
  if (migrated.originRelative === 'Anchor1') migrated.originRelative = 'Front-Left';
  migrated.customOriginX = Number.isFinite(Number(migrated.customOriginX)) ? Number(migrated.customOriginX) : 0;
  migrated.customOriginY = Number.isFinite(Number(migrated.customOriginY)) ? Number(migrated.customOriginY) : 0;
  // Replace only the original bundled Z1 defaults; preserve every user-edited origin.
  if (legacyZ1Origin) {
    migrated.originX = defaults.originX;
    migrated.originY = defaults.originY;
    migrated.originCommands = defaults.originCommands;
  }
  return migrated;
}
async function persist() {
  try {
    const index = state.profiles.findIndex(p => p.id === state.profileId);
    if (index >= 0) state.profiles[index] = state.profile;
    await storage.set(KEY, { activeProfileId: state.profileId, profiles: state.profiles });
  } catch (e) { state.notice = `Profile save failed: ${e.message || e}`; state.noticeType = 'error'; }
}
function legacyBind() {
  app.querySelectorAll('[data-field]').forEach(el => el.addEventListener('change', e => readForm(e.target)));
  app.querySelectorAll('input[name="stockMode"]').forEach(el => el.addEventListener('change', e => { state.profile.stockMode = e.target.value; void persist(); }));
  app.querySelectorAll('[data-step]').forEach(el => el.addEventListener('click', () => { state.step = Number(el.dataset.step); state.notice=''; render(); }));
  app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.action)));
  document.querySelector('#profile').addEventListener('change', (event) => {
    const selected = state.profiles.find(p => p.id === event.target.value);
    if (!selected) return;
    state.profileId = selected.id; state.profile = selected; state.confirmReady = false;
    state.motion = { levelSent: false, levelBusy: false, levelDone: false, probeSent: false, probeBusy: false, probeDone: false };
    state.notice = ''; void persist(); render();
  });
  const ready = document.querySelector('#confirmReady');
  if (ready) ready.addEventListener('change', () => { state.confirmReady = ready.checked; document.querySelector('#startJob').disabled = !state.confirmReady || !state.connected || state.status !== 'Idle' || state.busy || (state.profile.jobToolChangeCommands?.trim() && !state.motion.jobToolDone); });
}
async function sendLines(text, overrides = {}) {
  const values = { ...state.profile, levelingClearance: state.profile.levelingClearance, ...overrides };
  const lines = String(text || '').split(/\r?\n/).map(v => v.trim()).filter(v => v && !v.startsWith(';'))
    .map(line => line.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match));
  if (lines.some(line => /\{[^}]+\}/.test(line))) throw new Error('A command contains a placeholder that is not defined in this profile.');
  if (!lines.length) throw new Error('No G-code commands are configured for this action.');
  for (const line of lines) await machine.command('gcode', line);
}
function validateLocalPlaybackSettings() {
  const p = state.profile;
  const bridgeUrl = String(p.uploadBridgeUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(bridgeUrl)) throw new Error('Enter the active Z1 bridge upload endpoint in Machine Profiles.');
  const commands = String(p.localStartCommands || '').trim();
  if (!commands) throw new Error('Configure the local start command in Machine Profiles.');
  if (!/\{filePath\}/i.test(commands)) throw new Error('The local start command must include the {filePath} placeholder.');
  return { bridgeUrl, commands };
}
function formatLocalStartCommands(template, uploaded) {
  const commands = String(template || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith(';'))
    .map(line => line.replace(/\{filePath\}/gi, uploaded.path).replace(/\{fileName\}/gi, uploaded.name));
  if (!commands.length || commands.some(line => /\{[^}]+\}/.test(line))) throw new Error('The local start command contains an unsupported placeholder.');
  return commands;
}
function sanitizeUploadFilename(rawName) {
  const baseName = String(rawName || '').split(/[\\/]/).pop() || '';
  const extensionMatch = baseName.match(/(\.(?:nc|ngc|gcode|tap))$/i);
  if (!extensionMatch) {
    throw new Error('This file type cannot be uploaded. Use an .nc, .ngc, .gcode, or .tap file.');
  }
  const extension = extensionMatch[1].toLowerCase();
  const rawStem = baseName.slice(0, -extensionMatch[1].length);
  const safeStem = rawStem.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 120 - extension.length)
    .replace(/[._-]+$/g, '');
  return (safeStem || 'gcode') + extension;
}
async function uploadLoadedJobToZ1() {
  const settings = validateLocalPlaybackSettings();
  const [reduxSnapshot, workspaceSnapshot] = await Promise.all([
    redux.getState(), workspace.getState().catch(() => null),
  ]);
  const file = loadedFileFromState(reduxSnapshot, workspaceSnapshot);
  if (!file || typeof file.content !== 'string' || !file.content.length) throw new Error('Load an NC file in gSender before running this workflow.');
  const name = sanitizeUploadFilename(file.name || file.path || state.job?.name || 'current-job.nc');
  const headers = { 'Content-Type': 'application/json' };
  let response;
  try {
    response = await fetch(settings.bridgeUrl + '/api/upload', {
      method: 'POST', mode: 'cors', headers,
      body: JSON.stringify({ name, content: file.content }),
    });
  } catch {
    throw new Error('Cannot reach the local Z1 bridge upload endpoint. Connect gSender through the updated Makera Z1 bridge.');
  }
  let result = {};
  try { result = await response.json(); } catch { /* Report the HTTP status below. */ }
  if (!response.ok || result.ok === false) throw new Error(result.error || ('Upload bridge returned HTTP ' + response.status + '.'));
  if (result.listed !== true) throw new Error('The Z1 reported an upload, but its SD file listing did not confirm the exact filename and byte count. The job was not started.');
  return { name, path: 'gcodes/' + name, bytes: result.bytes || new TextEncoder().encode(file.content).length };
}
async function pollLocalJobProgress() {
  if (!state.runStarted || !state.localRunStartedAt || state.localRunPollBusy || Date.now() - state.localRunPollAt < 5000) return;
  state.localRunPollBusy = true;
  state.localRunPollAt = Date.now();
  try {
    const result = await machine.query('M27', { timeout: 2500, allowDuringJob: true, maxLines: 4 });
    const text = Array.isArray(result?.lines) ? result.lines.join(' ') : '';
    const match = text.match(/SD printing byte\s+(\d+)\s*\/\s*(\d+)/i);
    if (match && Number(match[2]) > 0) {
      state.localRunSawProgress = true;
      state.localRunProgress = Math.min(100, Math.round(Number(match[1]) * 100 / Number(match[2])));
      render();
    } else if (/SD print is paused/i.test(text)) {
      state.localRunSawActive = true;
    } else if (/Not currently playing/i.test(text) && state.status === 'Idle' &&
        (state.localRunSawActive || state.localRunSawProgress || Date.now() - state.localRunStartedAt >= 5000)) {
      await finishLocalJob();
    }
  } catch { /* Status polling is best-effort; controller state remains visible in gSender. */ }
  finally { state.localRunPollBusy = false; }
}
async function finishLocalJob() {
  if (!state.runStarted || state.localRunFinishBusy) return;
  state.localRunFinishBusy = true;
  state.runStarted = false;
  if (state.localRunProgress !== null && state.localRunProgress >= 99) state.localRunProgress = 100;
  state.busy = true;
  render();
  try {
    for (const assist of state.profile.assists) if (assist.enabled && assist.off?.trim()) await sendLines(assist.off);
    state.notice = (state.runPlaybackMode === 'stream' ? 'gSender streaming ended.' : 'Z1 SD playback ended.') + ' Configured assist-off commands were sent.';
    state.noticeType = 'ok';
  } catch (e) {
    state.notice = (state.runPlaybackMode === 'stream' ? 'gSender streaming ended' : 'Z1 SD playback ended') + ', but an assist-off command failed: ' + (e.message || e);
    state.noticeType = 'error';
  } finally {
    state.busy = false;
    state.localRunFinishBusy = false;
    state.localRunStartedAt = 0;
    state.runPlaybackMode = null;
    render();
  }
}
async function legacyHandleAction(action) {
  if (action === 'confirm-run-zprobe') {
    if (!state.confirmProbe) return;
    state.confirmProbe = false;
    action = 'execute-zprobe';
  }
  if (action === 'cancel-probe-confirm') { state.confirmProbe = false; state.notice = ''; render(); return; }
  if (action === 'next') {
    if (state.step === 2 && ((state.profile.leveling && !state.motion.levelDone) || (state.profile.zProbe && !state.motion.probeDone))) {
      setNotice('Complete each selected probe operation and confirm it while the controller reports Idle before continuing.', 'error'); return;
    }
    if (state.step === 1 && state.profile.zProbe && !state.jobCenter) {
      setNotice('Load an NC file with readable XY motion coordinates before continuing to Z-height probing.', 'error'); return;
    }
    state.step = Math.min(4, state.step + 1); if (state.step === 4) state.confirmReady = false; state.notice=''; render(); return;
  }
  if (action === 'back') { state.step = Math.max(0, state.step - 1); state.notice=''; render(); return; }
  if (action === 'cancel') { state.step = 0; state.notice='Setup wizard reset. No commands were sent.'; state.noticeType='info'; render(); return; }
  if (action === 'save') { await persist(); setNotice('Profile saved in gSender.', 'ok'); return; }
  if (action === 'new-profile') {
    const profile = { ...structuredClone(state.profile), id: `profile-${Date.now().toString(36)}`, profileName: `${state.profile.profileName} Copy` };
    state.profiles.push(profile); state.profile = profile; state.profileId = profile.id; state.confirmReady = false;
    state.motion = { levelSent: false, levelBusy: false, levelDone: false, probeSent: false, probeBusy: false, probeDone: false };
    await persist(); state.notice = 'New machine profile created from the current settings.'; state.noticeType = 'ok'; render(); return;
  }
  if (!state.connected) { setNotice('Connect gSender to the machine first.', 'error'); return; }
  if (action === 'confirm-level') { state.motion.levelDone = true; setNotice('Leveling marked complete at controller Idle.', 'ok'); return; }
  if (action === 'confirm-zprobe') { state.motion.probeDone = true; setNotice('Z probing marked complete at controller Idle.', 'ok'); return; }
  if (action === 'change-job-tool' && state.motion.jobToolSent) { setNotice('This tool-change sequence has already been started. Do not resend M6; finish or safely cancel the controller sequence first.', 'error'); return; }
  if (action === 'confirm-job-tool') {
    if (!state.motion.jobToolResumed || state.status !== 'Idle') { setNotice('Wait for the cutting-tool height check to finish and the controller to report Idle.', 'error'); return; }
    state.motion.jobToolDone = true; setNotice('Cutting tool height check confirmed. Verify the installed tool before running the job.', 'ok'); return;
  }
  if (state.busy) return;
  if (action === 'run-zprobe') {
    state.confirmProbe = true;
    state.notice = '';
    render();
    return;
  }
  if (['apply-origin', 'run-level', 'run-zprobe', 'execute-zprobe', 'change-job-tool', 'continue-job-tool', 'start'].includes(action) && state.status !== 'Idle') { setNotice('Wait until gSender reports Idle before starting this setup action.', 'error'); return; }
  if (action === 'start' && state.profile.jobToolChangeCommands?.trim() && !state.motion.jobToolDone) { setNotice('Change to and confirm the cutting tool before starting the job.', 'error'); return; }
  state.busy = true; render();
  try {
    if (action === 'apply-origin') {
      updateOriginCommand();
      await persist();
      await sendLines(state.profile.originCommands);
      setNotice(`Sent to the machine: ${state.profile.originCommands.split(/\r?\n/).filter(line => line.trim()).join(' · ')}. Confirm the controller response.`, 'ok');
    }
    else if (action === 'run-level') {
      if (!window.confirm('This runs the machine’s workpiece leveling routine and can move through the stock area. Confirm the machine is homed, the probe is installed, and the displayed origin and stock bounds are correct.')) throw new Error('Leveling canceled by operator.');
      await sendLines(state.profile.levelingCommands);
      state.motion.levelSent = true; state.motion.levelBusy = false; state.motion.levelDone = false;
    }
    else if (action === 'execute-zprobe') {
      if (!state.jobCenter) throw new Error('Could not determine the loaded NC file’s XY center. Load a file with readable XY motion coordinates first.');
      if (state.profile.probePrepareCommands?.trim()) await sendLines(state.profile.probePrepareCommands);
      await sendLines(state.profile.zProbeCommands, { jobCenterX: state.jobCenter.x, jobCenterY: state.jobCenter.y, originX: state.jobCenter.x, originY: state.jobCenter.y });
      state.motion.probeSent = true; state.motion.probeBusy = false; state.motion.probeDone = false;
      state.motion.jobToolSent = false; state.motion.jobToolBusy = false; state.motion.jobToolResumed = false; state.motion.jobToolDone = false; state.confirmReady = false;
    }
    else if (action === 'change-job-tool') {
      const jobToolNumber = detectJobToolNumber(state.job?.content, state.profile.jobToolNumber);
      await sendLines(state.profile.jobToolChangeCommands, { jobToolNumber });
      state.motion.jobToolSent = true; state.motion.jobToolBusy = false; state.motion.jobToolResumed = false; state.motion.jobToolDone = false;
    }
    else if (action === 'continue-job-tool') {
      await sendLines('M490.2');
      state.motion.jobToolResumed = true; state.motion.jobToolDone = false;
      setNotice('Sent M490.2. Wait for the Z1 tool-height check to finish; its status may still show Idle.', 'info');
    }
    else if (action === 'stop') await emergencyStopChecklist();
    else if (action === 'start') {
      const missing = state.profile.assists.filter(a => a.enabled && (!a.on?.trim() || !a.off?.trim())).map(a => a.name);
      if (missing.length) throw new Error(`Add both on and off commands for selected assists: ${missing.join(', ')}.`);
      for (const a of state.profile.assists) if (a.enabled && a.on.trim()) await sendLines(a.on);
      await machine.command('gcode:start');
      setNotice('gSender accepted the start request. Confirm motion and accessory state at the machine.', 'ok');
    }
    if (action === 'run-level' || action === 'execute-zprobe') setNotice('Command accepted by gSender. Wait for the operation to finish and the controller to report Idle, then confirm completion.', 'info');
    else if (action === 'continue-job-tool') { /* Keep the resume instruction visible. */ }
    else if (action !== 'start' && action !== 'apply-origin') setNotice('Commands accepted by gSender. Confirm the machine response before continuing.', 'ok');
  } catch (e) { setNotice(`Action failed: ${e.message || e}`, 'error'); }
  finally { state.busy = false; render(); }
}
async function legacyRefresh() {
  try {
    const [snapshot, workspaceSnapshot] = await Promise.all([
      redux.getState(),
      workspace.getState().catch(() => null),
    ]);
    const oldStatus = state.status;
    state.connected = !!snapshot?.connection?.isConnected;
    state.status = snapshot?.controller?.state?.status?.activeState || 'Unknown';
    if (state.workflowPhase === 'await-probe-tool' && /tool\s*change/i.test(state.status)) onToolChangePrompt(state.status);
    else if (state.workflowPhase === 'await-job-tool' && /tool\s*change/i.test(state.status)) onToolChangePrompt(state.status);
    if (!state.connected) state.homed = false;
    if (isVisualizerOverlay) {
      const file = snapshot?.file || snapshot?.fileInfo;
      const content = file?.fileLoaded && typeof file.content === 'string' ? file.content : '';
      const name = content ? String(file.name || file.path || 'Loaded NC file').split(/[\\/]/).pop() : '';
      if (state.job?.name !== name || state.job?.content !== content) {
        state.job = content ? { name, content } : null;
        state.jobCenter = content ? computeJobCenter(content) : null;
        state.motion.jobToolSent = false; state.motion.jobToolBusy = false; state.motion.jobToolResumed = false; state.motion.jobToolDone = false; state.confirmReady = false;
        if (state.step === 0 || state.step === 2) render();
      }
    }
    for (const prefix of ['level', 'probe']) {
      if (!state.motion[`${prefix}Sent`] || state.motion[`${prefix}Done`]) continue;
      if (state.status !== 'Idle' && state.status !== 'Unknown') state.motion[`${prefix}Busy`] = true;
      if (state.motion[`${prefix}Busy`] && state.status === 'Idle') {
        state.motion[`${prefix}Done`] = true;
        state.notice = `${prefix === 'level' ? 'Leveling' : 'Z probing'} finished; controller returned to Idle.`;
        state.noticeType = 'ok';
      }
    }
    if (state.step === 4) {
      const ready = document.querySelector('#confirmReady');
      const button = document.querySelector('#startJob');
      if (ready && button) button.disabled = !state.confirmReady || !ready.checked || !state.connected || state.status !== 'Idle' || state.busy || (state.profile.jobToolChangeCommands?.trim() && !state.motion.jobToolDone);
    }
    const node = document.querySelector('.connection');
    if (node) { node.className = `connection ${state.connected ? 'ok' : ''}`; node.textContent = state.connected ? `Connected · ${state.status}` : 'Not connected'; }
    if (oldStatus !== state.status && isVisualizerOverlay && [2, 4].includes(state.step)) render();
  } catch { state.connected = false; }
}
async function init() {
  try {
    const saved = await storage.get(KEY, null);
    if (Array.isArray(saved?.profiles) && saved.profiles.length) {
      const migratedOrigin = saved.profiles.some(hasLegacyZ1Origin);
      const migratedUploadEndpoint = saved.profiles.some(p => /:\s*8766\/?$/i.test(String(p.uploadBridgeUrl || '')));
      state.profiles = saved.profiles.map(migrateProfile);
      state.profileId = saved.activeProfileId || state.profiles[0].id;
      state.profile = state.profiles.find(p => p.id === state.profileId) || state.profiles[0];
      state.profileId = state.profile.id;
      if (migratedOrigin || migratedUploadEndpoint) await persist();
    } else if (saved && typeof saved === 'object') {
      const migratedOrigin = hasLegacyZ1Origin(saved);
      const migratedUploadEndpoint = /:\s*8766\/?$/i.test(String(saved.uploadBridgeUrl || ''));
      state.profile = migrateProfile({ ...saved, id: 'makera-z1' });
      state.profiles = [state.profile]; state.profileId = state.profile.id;
      if (migratedOrigin || migratedUploadEndpoint) await persist();
    } else {
      state.profiles = [state.profile];
    }
  } catch (e) { state.notice = `Could not load the saved profile: ${e.message || e}`; state.noticeType = 'error'; }
  render(); await refresh(); setInterval(refresh, 1000);
  machine.addListener('job:stop', async () => {
    const offCommands = state.profile.assists.filter(a => a.enabled && a.off?.trim()).map(a => a.off);
    for (const command of offCommands) {
      try { await machine.command('gcode', command.trim()); }
      catch (e) { setNotice(`Job ended, but assist-off command ${command} failed: ${e.message || e}`, 'error'); return; }
    }
    if (offCommands.length) setNotice('Job stopped. Configured assist-off commands were sent; verify the machine state.', 'info');
  });
}
function workflowMessage() {
  const tool = detectJobToolNumber(state.job?.content, state.profile.jobToolNumber);
  return ({
    idle: 'Run the Z probe to begin.',
    'await-probe-tool': 'Waiting for the firmware to request the probe tool.',
    'probe-tool-wait': 'Install the probe tool, then press Next to continue.',
    probing: 'Probe tool measurement and stock probing are running.',
    'await-job-tool': 'Waiting for the cutting-tool change prompt.',
    'job-tool-wait': 'Install cutting tool T' + tool + ', then acknowledge the tool-change prompt.',
    'measuring-job-tool': state.status === 'Idle' ? 'Waiting for the tool-height check to settle.' : `Cutting tool height measurement is running · controller ${state.status}.`,
    'ready-to-run': 'Probe and cutting tool measurement are complete. Continue to Run Job.',
    error: 'The controller stopped the setup sequence. Resolve the controller alarm before restarting.'
  })[state.workflowPhase] || 'Waiting for the controller.';
}

function stepContent() {
  const p = state.profile;
  if (state.step === 0) return "<h2>Load NC File</h2><p class='intro'>Load the job file before setting up the machine.</p><div class='job-file'>" +
    (state.job ? "<strong>" + esc(state.job.name) + "</strong><span>" + (state.jobCenter ? "Loaded. Calculated path center: X" + esc(state.jobCenter.x) + " · Y" + esc(state.jobCenter.y) + " mm." : "Loaded, but no XY path center could be calculated. Check that the NC file contains XY motion before probing.") + "</span>" : "<strong>No NC file detected yet</strong><span>Use gSender’s Load File control to select an NC file. This panel checks gSender automatically once per second until it detects the loaded file.</span>") +
    "</div>";
  if (state.step === 1) return "<h2>Home Machine</h2><div class='job-file'><strong>Controller state: " + esc(state.status) + "</strong></div><div class='button-row'><button class='secondary' data-action='home-machine' " + (!state.connected || state.busy || state.homing || !['Idle', 'Alarm'].includes(state.status) ? 'disabled' : '') + ">" + (state.homing ? 'Homing…' : 'Home machine') + "</button><span class='operation-state'>" + (state.homed ? 'Homed' : state.homing ? 'Homing…' : '') + "</span></div>";
  if (state.step === 2) return "<h2>Assist Options</h2><div class='assist-list checklist-assists'>" +
    p.assists.map((a, i) => "<div class='assist'>" + toggle(a.name, "assist:" + i, a.enabled) + "</div>").join('') +
    "</div>";
  if (state.step === 3) return "<h2>Set Stock</h2><div class='stock-job-summary'><strong>" +
    esc(state.job?.name || 'No NC file loaded') + "</strong><span>" + (state.jobCenter ? "Path center X" + esc(state.jobCenter.x) + " · Y" + esc(state.jobCenter.y) + " mm" : "XY path center unavailable") +
    "</span></div><div class='form-grid stock-dimensions'>" +
    field('X size', 'stockX', p.stockX, 'number', 'mm') + field('Y size', 'stockY', p.stockY, 'number', 'mm') + field('Thickness', 'stockZ', p.stockZ, 'number', 'mm') +
    "</div>";
  if (state.step === 4) return "<h2>Set Origin</h2><div class='origin-selector'><label class='field'><span>Origin point</span><select data-field='originRelative'><option " +
    (p.originRelative === 'Front-Left' ? 'selected' : '') + ">Front-Left</option><option " + (p.originRelative === 'Custom' ? 'selected' : '') + ">Custom</option></select></label></div>" +
    (p.originRelative === 'Custom' ? "<div class='form-grid origin-custom-grid'>" + field('X coordinate', 'customOriginX', p.customOriginX, 'number', 'mm') + field('Y coordinate', 'customOriginY', p.customOriginY, 'number', 'mm') + "</div>" : '');
  if (state.step === 5) return "<h2>Z-Height Probe</h2><div class='probe-point-selector'><label class='field'><span>Probe point</span><select data-field='probePointMode'><option " +
    (p.probePointMode === 'Probe Stock Center' ? 'selected' : '') + ">Probe Stock Center</option><option " + (p.probePointMode === 'Custom' ? 'selected' : '') + ">Custom</option></select></label></div>" +
    (p.probePointMode === 'Custom' ? "<div class='form-grid compact'>" + field('X coordinate', 'customProbeX', p.customProbeX, 'number', 'mm') + field('Y coordinate', 'customProbeY', p.customProbeY, 'number', 'mm') + "</div>" : '') +
    "<div class='button-row'><button class='secondary' data-action='run-zprobe' " + (!state.connected || state.status !== 'Idle' || state.busy || state.workflowPhase !== 'idle' || !state.jobCenter ? 'disabled' : '') + ">Run Z probe</button>" +
    "<span class='operation-state'>" + esc(workflowMessage()) + "</span></div>";
  const tool = detectJobToolNumber(state.job?.content, p.jobToolNumber);
  const origin = originCoordinates(p);
  const localPlaybackStatus = state.runStarted
    ? `<p class='operation-state'>${state.runPlaybackMode === 'stream' ? 'gSender stream' : 'Z1 SD playback'} · ${esc(state.status)}${state.runPlaybackMode === 'upload-run' && state.localRunProgress !== null ? ' · ' + esc(state.localRunProgress) + '%' : ''}</p>`
    : '';
  return "<h2>Run Job</h2><p class='intro'>The probe and cutting-tool height measurement are complete.</p><div class='review-grid'><div><h3>Job setup</h3><p>" +
    esc(state.job?.name || 'No NC file loaded') + "</p><p>Stock: " + esc(p.stockX) + " × " + esc(p.stockY) + " × " + esc(p.stockZ) + " mm</p><p>Origin: " + esc(p.originRelative) + " · X" + esc(origin.x) + " Y" + esc(origin.y) + "</p><p>Tool: T" + esc(tool) + " · measured</p></div><div><h3>Job assists</h3>" +
    p.assists.map(a => "<p>" + esc(a.name) + " <strong>" + (a.enabled ? 'On' : 'Off') + "</strong></p>").join('') +
    "</div></div>" + localPlaybackStatus + "<p class='step-help'>Run Job uses the selected playback mode: " + (p.playbackMode === 'stream' ? 'gSender streams the loaded file.' : 'the Z1 plays the uploaded file from its SD card.') + "</p>";
}

function configurationContent() {
  const p = state.profile;
  return "<h2>Machine profile configuration</h2><p class='intro'>Configure the machine-specific values and commands used by this workflow.</p>" +
    "<div class='config-section'><h3>Profile and stock defaults</h3><div class='form-grid'>" + field('Profile name', 'profileName', p.profileName, 'text') + field('Stock X', 'stockX', p.stockX, 'number', 'mm') + field('Stock Y', 'stockY', p.stockY, 'number', 'mm') + field('Stock thickness', 'stockZ', p.stockZ, 'number', 'mm') + "</div></div>" +
    "<div class='config-section'><h3>Origin</h3><div class='form-grid'><label class='field'><span>Origin point</span><select data-field='originRelative'><option " + (p.originRelative === 'Front-Left' ? 'selected' : '') + ">Front-Left</option><option " + (p.originRelative === 'Custom' ? 'selected' : '') + ">Custom</option></select></label>" + field('Front-Left X at home', 'originX', p.originX, 'number', 'mm') + field('Front-Left Y at home', 'originY', p.originY, 'number', 'mm') + "</div>" + textarea('Origin G-code command', 'originCommands', p.originCommands) + "</div>" +
    "<div class='config-section'><h3>Required Z-height probe</h3><p>The probe runs for every job. The XY point is calculated from the loaded NC file.</p><div class='form-grid'>" + field('Probe X offset', 'probeOffsetX', p.probeOffsetX, 'number', 'mm') + field('Probe Y offset', 'probeOffsetY', p.probeOffsetY, 'number', 'mm') + field('Default cutting tool number', 'jobToolNumber', p.jobToolNumber) + "</div>" +
    textarea('Probe preparation (manual tool change only)', 'probePrepareCommands', p.probePrepareCommands) + textarea('Z-height probe G-code', 'zProbeCommands', p.zProbeCommands) + textarea('Cutting-tool change sequence (manual tool change only)', 'jobToolChangeCommands', p.jobToolChangeCommands) + "</div>" +
    "<div class='config-section'><h3>Job playback</h3><div class='form-grid'><label class='field'><span>Playback mode</span><select data-field='playbackMode'><option value='stream' " + (p.playbackMode === 'stream' ? 'selected' : '') + ">Stream through gSender</option><option value='upload-run' " + (p.playbackMode !== 'stream' ? 'selected' : '') + ">Upload and Run from Z1 SD</option></select></label></div>" +
    (p.playbackMode === 'stream' ? "<p>Run Job starts the currently loaded file through gSender.</p>" : "<p>Run Job uploads through the active Makera Z1 bridge connection, verifies the SD file listing, then sends the configured start command. Use {filePath} for the relative SD path and {fileName} for the uploaded filename.</p><div class='form-grid'>" + field('Bridge upload endpoint', 'uploadBridgeUrl', p.uploadBridgeUrl, 'url') + "</div>" + textarea('Local start command(s)', 'localStartCommands', p.localStartCommands, 'M32 {filePath}') + "") + "</div>" +
    "<div class='config-section'><h3>Job assists</h3>" + p.assists.map((a, i) => "<div class='assist'>" + toggle(a.name, 'assist:' + i, a.enabled) + "<div class='assist-cmd'><input aria-label='" + esc(a.name) + " on command' data-field='assist:" + i + ":on' placeholder='On command' value='" + esc(a.on) + "'><input aria-label='" + esc(a.name) + " off command' data-field='assist:" + i + ":off' placeholder='Off command' value='" + esc(a.off) + "'></div></div>").join('') + "</div>" +
    "<div class='button-row'><button class='primary' data-action='save'>Save Profile</button><span class='operation-state'>Settings are saved in gSender.</span></div>";
}

function render() {
  document.body.classList.toggle('overlay-mode', isVisualizerOverlay);
  const header = "<header><div><span class='eyebrow'>CNC JOB SETUP</span><h1>" + (isVisualizerOverlay ? 'Prepare this job' : 'Machine profiles') + "</h1></div><div class='head-actions'>" +
    (isVisualizerOverlay ? '' : "<button class='secondary' data-action='new-profile'>New Profile</button>") +
    "<label class='profile-select'>" + (isVisualizerOverlay ? 'Profile' : 'Machine profile') + "<select id='profile'>" + state.profiles.map(p => "<option value='" + esc(p.id) + "' " + (p.id === state.profileId ? 'selected' : '') + ">" + esc(p.profileName) + "</option>").join('') + "</select></label><span class='connection " + (state.connected ? 'ok' : '') + "'>" + (state.connected ? 'Connected · ' + esc(state.status) : 'Not connected') + "</span></div></header>";
  let content;
  if (isVisualizerOverlay) {
    const buttons = steps.map((s, i) => "<button data-step='" + i + "' class='" + (i === state.step ? 'selected' : i < state.step ? 'done' : '') + "' " + (i > state.step ? 'disabled' : '') + "><span>" + (i + 1) + "</span>" + s + "</button>").join('');
    const nextLabel = state.step === 5 && state.workflowPhase === 'ready-to-run' ? 'Continue to Run Job' : 'Next ›';
    const nextDisabled = state.step === 0 ? (!state.job || state.busy) :
      state.step === 1 ? (!state.homed || !state.connected || state.status !== 'Idle' || state.busy) :
      state.step === 4 ? (!state.connected || state.status !== 'Idle' || state.busy) :
      state.step === 5 ? (!state.connected || state.busy || state.toolChangePending || state.workflowPhase !== 'ready-to-run' || state.status !== 'Idle') : state.busy;
    const footerButton = state.step < 6 ? "<button class='primary' data-action='next' " + (nextDisabled ? 'disabled' : '') + ">" + nextLabel + "</button>" :
      "<button class='primary' data-action='start' id='startJob' " + (!state.connected || state.status !== 'Idle' || state.busy || state.runStarted || !state.motion.jobToolDone || !state.motion.probeDone || !state.job ? 'disabled' : '') + ">" + (state.runStarted ? 'Job Running' : 'Run Job') + "</button>";
    const toolChangePrompt = state.toolChangePending && !state.runStarted ? "<section class='tool-change-prompt' role='alert'><div><span class='tool-change-kicker'>CONTROLLER TOOL CHANGE</span><h2>Tool change is waiting</h2><p>Install the requested tool, then continue the controller sequence here. This prompt stays available throughout job setup.</p>" + (state.toolChangeMessage ? "<code>" + esc(state.toolChangeMessage) + "</code>" : '') + "</div><button class='primary' data-action='resume-tool-change' " + (!state.connected || state.busy ? 'disabled' : '') + ">Tool changed · resume (M490.2)</button></section>" : '';
    content = header + notice() + toolChangePrompt + "<nav class='steps'>" + buttons + "</nav><section class='panel'>" + stepContent() + "</section><footer><button class='danger' data-action='stop' " + (!state.connected || state.emergencyStopInProgress ? 'disabled' : '') + ">Stop</button><div class='footer-right'><button class='secondary' data-action='cancel'>Cancel</button>" + (state.step ? "<button class='secondary' data-action='back'>‹ Back</button>" : '') + footerButton + "</div></footer>";
  } else {
    content = header + notice() + "<section class='panel'>" + configurationContent() + "</section>";
  }
  app.innerHTML = content;
  bind();
}

function bind() {
  app.querySelectorAll('[data-field]').forEach(el => el.addEventListener('change', e => readForm(e.target)));
  const installedToolCheck = app.querySelector('[data-checklist="tool-installed"]');
  if (installedToolCheck) installedToolCheck.addEventListener('change', e => { state.toolInstalledConfirmed = e.target.checked; render(); });
  app.querySelectorAll('input[name="stockMode"]').forEach(el => el.addEventListener('change', e => { state.profile.stockMode = e.target.value; void persist(); }));
  app.querySelectorAll('[data-step]').forEach(el => el.addEventListener('click', () => { if (!el.disabled) { state.step = Number(el.dataset.step); state.notice = ''; render(); } }));
  app.querySelectorAll('[data-action]').forEach(el => el.addEventListener('click', () => handleAction(el.dataset.action)));
  const profileSelect = document.querySelector('#profile');
  if (profileSelect) profileSelect.addEventListener('change', event => {
    const selected = state.profiles.find(p => p.id === event.target.value);
    if (!selected) return;
    state.profileId = selected.id; state.profile = selected; state.workflowPhase = 'idle'; state.toolInstalledConfirmed = false;
    state.motion = { probeSent: false, probeDone: false, jobToolSent: false, jobToolDone: false };
    state.notice = ''; void persist(); render();
  });
}

function controllerLine(result) {
  if (typeof result === 'string' || typeof result === 'number') return String(result).trim();
  const candidate = result?.line ?? result?.text ?? result?.data?.line ?? result?.data?.text ?? result?.lines?.[0] ?? '';
  return String(candidate).trim();
}

function onToolChangePrompt(result) {
  const line = controllerLine(result);
  const toolRequest = line.match(/Please change the tool to:\s*T\s*(\d+)\b/i);
  const requestedTool = toolRequest ? Number(toolRequest[1]) : null;
  const isProbeRequest = requestedTool === 0 || /Change to probe tool first!/i.test(line);
  const isCuttingToolRequest = requestedTool !== null && requestedTool !== 0;
  if (state.runStarted || !isVisualizerOverlay || (!isProbeRequest && !isCuttingToolRequest)) return;
  if (state.workflowPhase === 'await-probe-tool' && isProbeRequest) state.workflowPhase = 'probe-tool-wait';
  else if (isCuttingToolRequest && ['await-job-tool', 'measuring-job-tool'].includes(state.workflowPhase)) state.workflowPhase = 'job-tool-wait';
  state.toolChangePending = true;
  state.toolChangeMessage = line;
  state.toolChangeStatusDismissed = false;
  state.toolInstalledConfirmed = false;
  state.notice = 'The controller requested a tool change. Use the prompt below whenever the tool is installed.';
  state.noticeType = 'info'; render();
}

async function startJobToolChange() {
  state.workflowPhase = 'await-job-tool';
  // The probe-tool hold was already acknowledged. A new cutting-tool request
  // must be allowed to raise its own prompt, including when gSender only
  // exposes the Tool controller state instead of a serial prompt line.
  state.toolChangeStatusDismissed = false;
  state.toolChangePending = false;
  state.toolChangeMessage = '';
  state.motion.jobToolSent = true;
  render();
  try {
    const tool = detectJobToolNumber(state.job?.content, state.profile.jobToolNumber);
    await sendLines(state.profile.jobToolChangeCommands, { jobToolNumber: tool });
  } catch (e) {
    state.workflowPhase = 'error';
    state.notice = 'Could not start the cutting-tool change: ' + (e.message || e);
    state.noticeType = 'error'; render();
  }
}

async function clearToolChange() {
  if (!state.connected) throw new Error('Connect gSender to the machine first.');
  if (!state.toolChangePending) throw new Error('No tool-change hold is currently pending.');
  const phase = state.workflowPhase;
  if (phase === 'await-probe-tool' || phase === 'probe-tool-wait') {
    state.workflowPhase = 'probing';
    state.motion.probeActivitySeen = false;
    state.motion.probeIdleSince = null;
  }
  else if (phase === 'await-job-tool' || phase === 'job-tool-wait') {
    state.workflowPhase = 'measuring-job-tool';
    state.motion.jobToolIdleSince = null;
    state.motion.jobToolResumeRequestedAt = null;
  }
  state.toolChangePending = false;
  state.toolChangeStatusDismissed = true;
  state.toolInstalledConfirmed = false;
  state.busy = true;
  render();
  try {
    const response = await machine.query('M490.2');
    const responseLines = Array.isArray(response?.lines) ? response.lines.map(String) : [];
    const failure = responseLines.find(line => /(?:ALARM|error:)/i.test(line));
    if (failure) throw new Error(failure);
    if (!responseLines.some(line => /^ok\s*$/i.test(line))) {
      throw new Error('The controller did not acknowledge M490.2. The tool-change hold may still be active.');
    }
    if (phase === 'await-job-tool' || phase === 'job-tool-wait') state.motion.jobToolResumeRequestedAt = Date.now();
    state.notice = 'Controller acknowledged M490.2. Waiting for the firmware sequence.';
    state.noticeType = 'info';
  } catch (e) {
    state.workflowPhase = phase;
    state.toolChangePending = true;
    state.toolChangeStatusDismissed = false;
    state.notice = 'Could not clear the tool-change hold: ' + (e.message || e);
    state.noticeType = 'error';
  } finally {
    state.busy = false;
    render();
  }
}

function onAtcDone(result) {
  const line = controllerLine(result);
  if (!/Done ATC/i.test(line)) return;
  if (state.workflowPhase === 'probing') finishProbeSequence();
  else if (state.workflowPhase === 'measuring-job-tool') finishJobToolMeasurement('Firmware reported Done ATC.');
}

function finishJobToolMeasurement(detail = 'The controller returned to Idle.') {
  if (state.workflowPhase !== 'measuring-job-tool' || state.motion.jobToolDone) return;
  state.motion.jobToolDone = true;
  state.motion.jobToolIdleSince = null;
  state.workflowPhase = 'ready-to-run';
  state.notice = `Cutting tool height check complete. ${detail} Continue when the controller is Idle.`;
  state.noticeType = 'ok';
  render();
}

function finishProbeSequence() {
  if (state.workflowPhase !== 'probing' || state.motion.probeDone) return;
  state.motion.probeDone = true;
  state.motion.probeIdleSince = null;
  if (state.profile.jobToolChangeCommands.trim()) void startJobToolChange();
  else {
    state.motion.jobToolDone = true;
    state.workflowPhase = 'ready-to-run';
    state.notice = 'Probe complete. Continue to Run Job when the controller is Idle.';
    state.noticeType = 'ok';
    render();
  }
}

function onProbeResult(result) {
  if (state.workflowPhase === 'probing' && /\[PRB:/i.test(controllerLine(result))) {
    state.motion.probeActivitySeen = true;
  }
}

async function handleAction(action) {
  if (action === 'stop') { await emergencyStopChecklist(); return; }
  if (state.busy) return;
  if (action === 'save') { await persist(); setNotice('Profile saved in gSender.', 'ok'); return; }
  if (action === 'new-profile') {
    const profile = { ...structuredClone(state.profile), id: 'profile-' + Date.now().toString(36), profileName: state.profile.profileName + ' Copy' };
    state.profiles.push(profile); state.profile = profile; state.profileId = profile.id; state.workflowPhase = 'idle'; state.toolInstalledConfirmed = false;
    state.motion = { probeSent: false, probeDone: false, jobToolSent: false, jobToolDone: false };
    await persist(); render(); return;
  }
  if (action === 'cancel') { state.step = 0; state.homed = false; state.runStarted = false; state.runPlaybackMode = null; state.localRunStartedAt = 0; state.toolChangePending = false; state.toolChangeStatusDismissed = false; state.toolInstalledConfirmed = false; state.notice = 'Workflow closed. Any active controller operation must finish or be stopped at the machine.'; state.noticeType = 'info'; render(); return; }
  if (action === 'back') { state.step = Math.max(0, state.step - 1); render(); return; }
  if (action === 'home-machine') {
    if (!state.connected) { setNotice('Connect gSender to the machine first.', 'error'); return; }
    if (!['Idle', 'Alarm'].includes(state.status)) { setNotice('Wait until the controller is Idle or Alarm before homing.', 'error'); return; }
    const operationGeneration = ++state.operationGeneration;
    const isCurrentOperation = () => operationGeneration === state.operationGeneration;
    state.busy = true; state.homed = false; state.homing = true; render();
    try {
      const response = await machine.query('$H');
      if (!isCurrentOperation()) return;
      const responseLines = Array.isArray(response?.lines) ? response.lines.map(String) : [];
      const failure = responseLines.find(line => /(?:ALARM|error:)/i.test(line));
      if (failure) throw new Error(failure);
      // $H can be acknowledged before gSender publishes the new controller
      // state. Do not treat that stale pre-home Idle report as completion.
      let sawHomingStart = false;
      let completed = false;
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!isCurrentOperation()) return;
        await refresh();
        if (!isCurrentOperation()) return;
        if (!state.connected) throw new Error('gSender disconnected while homing.');
        if (state.status === 'Alarm') throw new Error('The controller entered Alarm while homing.');
        if (state.status === 'Idle') {
          if (sawHomingStart) { completed = true; break; }
        } else if (state.status !== 'Unknown') {
          // gSender reports the active homing phase as "Home" on this Z1.
          sawHomingStart = true;
        }
      }
      if (!completed) throw new Error(sawHomingStart
        ? 'Homing did not return to Idle within 120 seconds.'
        : 'gSender did not report that homing started; the machine is not marked homed.');
      state.homed = true;
      state.notice = 'Homing completed. The machine position is known; continue to stock setup.';
      state.noticeType = 'ok';
    } catch (e) {
      if (isCurrentOperation()) { state.homing = false; state.notice = 'Homing did not start: ' + (e.message || e); state.noticeType = 'error'; }
    }
    finally {
      if (isCurrentOperation()) { state.busy = false; state.homing = false; render(); }
    }
    return;
  }
  if (action === 'run-zprobe') {
    if (!state.connected) { setNotice('Connect gSender to the machine first.', 'error'); return; }
    if (state.status !== 'Idle' || !state.jobCenter) { setNotice('Connect an idle controller and load an NC file with XY motion before probing.', 'error'); return; }
    // Each probe starts a new probe-tool request (T0). A previous Stop or
    // acknowledged hold must not suppress this cycle's prompt.
    state.toolChangePending = false; state.toolChangeMessage = ''; state.toolChangeStatusDismissed = false;
    state.busy = true; state.workflowPhase = 'await-probe-tool'; state.toolInstalledConfirmed = false; state.motion = { probeSent: true, probeDone: false, probeActivitySeen: false, probeIdleSince: null, jobToolSent: false, jobToolDone: false }; render();
    try {
      await sendLines(state.profile.probePrepareCommands);
      const probePoint = probeCoordinates();
      await sendLines(state.profile.zProbeCommands, { jobCenterX: probePoint.x, jobCenterY: probePoint.y, originX: probePoint.x, originY: probePoint.y });
      state.notice = 'Probe sequence sent. Waiting for the firmware tool-change prompt.';
      state.noticeType = 'info';
    } catch (e) { state.workflowPhase = 'error'; state.notice = 'Probe command failed: ' + (e.message || e); state.noticeType = 'error'; }
    finally { state.busy = false; render(); }
    return;
  }
  if (action === 'resume-tool-change') {
    try { await clearToolChange(); }
    catch (e) { setNotice('Could not resume the tool-change hold: ' + (e.message || e), 'error'); }
    return;
  }
  if (action === 'next') {
    if (state.step === 0) {
      if (!state.job) { setNotice('Load an NC file in gSender before continuing.', 'error'); return; }
      state.step = 1; state.notice = ''; render(); return;
    }
    if (state.step === 1) {
      if (!state.connected || !state.homed || state.status !== 'Idle') { setNotice('Complete the home cycle and wait for a connected Idle controller before continuing.', 'error'); return; }
      state.step = 2; state.notice = ''; render(); return;
    }
    if (state.step === 4) {
      if (!state.connected || state.status !== 'Idle') { setNotice('Connect the machine and wait for the controller to report Idle before applying the origin.', 'error'); return; }
      state.busy = true; render();
      try {
        updateOriginCommand(); await persist(); await sendLines(state.profile.originCommands);
        state.step = 5; state.workflowPhase = 'idle'; state.notice = 'Origin command sent. Run the required Z probe to continue.'; state.noticeType = 'ok';
      } catch (e) { state.notice = 'Could not apply the origin: ' + (e.message || e); state.noticeType = 'error'; }
      finally { state.busy = false; render(); }
      return;
    }
    if (state.step === 5) {
      if (!state.connected) { setNotice('Connect gSender to the machine before continuing the probe sequence.', 'error'); return; }
      if (state.workflowPhase === 'ready-to-run' && state.status === 'Idle') { state.step = 6; state.notice = ''; render(); return; }
      setNotice('Run the probe and follow the firmware tool-change prompts to continue.', 'info'); return;
    }
    state.step = Math.min(5, state.step + 1); state.notice = ''; render(); return;
  }
  if (!state.connected) { setNotice('Connect gSender to the machine first.', 'error'); return; }
  if (action === 'start') {
    if (state.runStarted) { setNotice('A job is already running.', 'info'); return; }
    if (state.status !== 'Idle' || !state.motion.probeDone || !state.motion.jobToolDone || !state.job) {
      setNotice('Run is available after the probe and cutting-tool measurement finish and the controller is Idle.', 'error'); return;
    }
    const missing = state.profile.assists.filter(a => a.enabled && (!a.on?.trim() || !a.off?.trim())).map(a => a.name);
    if (missing.length) { setNotice('Add both on and off commands for selected assists: ' + missing.join(', ') + '.', 'error'); return; }
    const playbackMode = state.profile.playbackMode === 'stream' ? 'stream' : 'upload-run';
    let startMayHaveBeenSent = false;
    const activatedAssists = [];
    state.busy = true; render();
    try {
      let uploaded = null;
      let startCommands = [];
      if (playbackMode === 'upload-run') {
        const settings = validateLocalPlaybackSettings();
        uploaded = await uploadLoadedJobToZ1();
        startCommands = formatLocalStartCommands(settings.commands, uploaded);
        state.notice = 'Uploaded and verified ' + uploaded.name + ' on the Z1 SD card.';
        state.noticeType = 'info'; render();
      }
      for (const assist of state.profile.assists) if (assist.enabled && assist.on.trim()) {
        await sendLines(assist.on);
        activatedAssists.push(assist);
      }
      state.runStarted = true;
      state.runPlaybackMode = playbackMode;
      state.localRunStartedAt = playbackMode === 'upload-run' ? Date.now() : 0;
      state.localRunSawActive = false;
      state.localRunSawProgress = false;
      state.localRunProgress = playbackMode === 'upload-run' ? 0 : null;
      state.localRunPollAt = 0;
      state.toolChangePending = false;
      state.toolChangeStatusDismissed = true;
      if (playbackMode === 'stream') {
        startMayHaveBeenSent = true;
        await machine.command('gcode:start');
        setNotice('gSender accepted the stream start request. gSender will stream the loaded file and report job progress.', 'ok');
      } else {
        for (let i = 0; i < startCommands.length; i++) {
          const command = startCommands[i];
          const isStartCommand = i === startCommands.length - 1;
          if (isStartCommand) startMayHaveBeenSent = true;
          let result;
          try { result = await machine.query(command, { timeout: 15000, maxLines: 12 }); }
          catch (e) {
            if (isStartCommand) {
              state.notice = 'The local start command may have reached the controller, but its reply was not confirmed. Check the machine before retrying.';
              state.noticeType = 'error';
              return;
            }
            throw e;
          }
          const lines = Array.isArray(result?.lines) ? result.lines.map(String) : [];
          const failure = lines.find(line => /(?:file\.open failed|ALARM:|error:)/i.test(line));
          if (failure) { startMayHaveBeenSent = false; throw new Error(failure); }
          if (!result?.ok || !lines.some(line => /^ok\s*$/i.test(line))) {
            if (isStartCommand) {
              state.notice = 'The local start command may have reached the controller, but its acknowledgement was not confirmed. Check the machine before retrying.';
              state.noticeType = 'error';
              return;
            }
            throw new Error('No acknowledgement for configured file-selection command: ' + command);
          }
        }
        setNotice('The Z1 acknowledged the configured local start command. gSender is monitoring controller state and M27 SD progress.', 'ok');
        state.localRunPollAt = Date.now() - 5000;
        void pollLocalJobProgress();
      }
    } catch (e) {
      if (!startMayHaveBeenSent) {
        state.runStarted = false;
        state.runPlaybackMode = null;
        state.localRunStartedAt = 0;
        for (const assist of activatedAssists) {
          if (!assist.off?.trim()) continue;
          try { await sendLines(assist.off); } catch { /* Keep the primary start failure visible. */ }
        }
        setNotice('Could not start the job: ' + (e.message || e), 'error');
      } else {
        setNotice('The start request may have reached the controller. Check the machine before retrying: ' + (e.message || e), 'error');
      }
    }
    finally { state.busy = false; render(); }
  }
}

async function refresh() {
  try {
    const [snapshot, workspaceSnapshot] = await Promise.all([
      redux.getState(),
      workspace.getState().catch(() => null),
    ]);
    const previousStatus = state.status;
    const previousWorkflowPhase = state.workflowPhase;
    const wasConnected = state.connected;
    const wasToolChangePending = state.toolChangePending;
    let jobChanged = false;
    state.connected = !!snapshot?.connection?.isConnected;
    state.controllerType = String(snapshot?.controller?.type || '');
    state.status = snapshot?.controller?.state?.status?.activeState || 'Unknown';
    if (state.runStarted) {
      if (/^(Run|Hold|Tool)$/i.test(state.status)) state.localRunSawActive = true;
      if (state.localRunSawActive && state.status === 'Idle' && previousStatus !== 'Idle') void finishLocalJob();
      else void pollLocalJobProgress();
    }
    const isToolChangeStatus = isToolChangeState(state.status);
    if (state.workflowPhase === 'probing') {
      if (!['Idle', 'Unknown'].includes(state.status) && !isToolChangeStatus) {
        state.motion.probeActivitySeen = true;
        state.motion.probeIdleSince = null;
      } else if (isToolChangeStatus) {
        state.motion.probeIdleSince = null;
      } else if (state.status === 'Idle' && state.motion.probeActivitySeen) {
        state.motion.probeIdleSince ??= Date.now();
        // Some Z1 firmware sequences omit the Done ATC text event. Only use
        // stable Idle as a fallback after probe motion or a PRB result was seen.
        if (Date.now() - state.motion.probeIdleSince >= 2500) finishProbeSequence();
      }
    }
    if (state.workflowPhase === 'measuring-job-tool' && state.motion.jobToolResumeRequestedAt) {
      if (state.status === 'Idle') {
        state.motion.jobToolIdleSince ??= Date.now();
        // Some Z1 firmware sequences finish without exposing their Done ATC
        // text through the plugin parser. Accept a stable post-resume Idle.
        if (Date.now() - state.motion.jobToolIdleSince >= 2500) finishJobToolMeasurement('Controller returned to Idle.');
      } else {
        state.motion.jobToolIdleSince = null;
      }
    }
    if (isToolChangeStatus && !state.runStarted && isVisualizerOverlay && !state.toolChangeStatusDismissed) {
      if (state.workflowPhase === 'await-probe-tool') state.workflowPhase = 'probe-tool-wait';
      else if (state.workflowPhase === 'await-job-tool') state.workflowPhase = 'job-tool-wait';
      state.toolChangePending = true;
      state.toolChangeMessage = 'Controller status: ' + state.status;
    }
    if (!state.connected && wasConnected) {
      state.homed = false;
      state.homing = false;
    }
    if (isVisualizerOverlay) {
      const file = loadedFileFromState(snapshot, workspaceSnapshot);
      const content = typeof file?.content === 'string' ? file.content : '';
      const name = content ? String(file.name || file.path || 'Loaded NC file').split(/[\\/]/).pop() : '';
      if (state.job?.name !== name || state.job?.content !== content) {
        jobChanged = true;
        const replacingLoadedJob = !!state.job;
        state.job = content ? { name, content } : null; state.jobCenter = content ? computeJobCenter(content) : null;
        if (content && state.runStarted) { state.runStarted = false; state.toolChangePending = false; state.toolChangeStatusDismissed = false; }
        if (replacingLoadedJob && (state.workflowPhase === 'idle' || state.workflowPhase === 'ready-to-run')) {
          // Loading or replacing a job does not invalidate a completed machine home cycle.
          state.workflowPhase = 'idle'; state.toolInstalledConfirmed = false; state.motion = { probeSent: false, probeDone: false, jobToolSent: false, jobToolDone: false };
          state.step = 0;
        }
      }
    }
    const node = document.querySelector('.connection');
    if (node) { node.className = 'connection ' + (state.connected ? 'ok' : ''); node.textContent = state.connected ? 'Connected · ' + state.status : 'Not connected'; }
    if (jobChanged || previousStatus !== state.status || previousWorkflowPhase !== state.workflowPhase || wasToolChangePending !== state.toolChangePending || (!state.connected && wasConnected)) render();
  } catch {
    if (state.connected) { state.connected = false; state.homed = false; state.homing = false; render(); }
  }
}

try {
  state.unsubscribeToolPrompt = machine.onLine(/Please change the tool to:\s*T\d+|Change to probe tool first!|tool\s*change/i, onToolChangePrompt);
  state.unsubscribeAtcDone = machine.onLine(/Done ATC/i, onAtcDone);
  state.unsubscribeProbeResult = machine.onLine(/\[PRB:/i, onProbeResult);
} catch (e) {
  state.notice = 'Firmware sequence monitoring is unavailable: ' + (e.message || e);
  state.noticeType = 'error';
}

void init();
