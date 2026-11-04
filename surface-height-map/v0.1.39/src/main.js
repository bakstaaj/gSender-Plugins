import { gcode, getReduxState, machine, storage, workspace } from '@sienci/gsender-plugin-sdk';
import { DEFAULTS, SHORT_RETRACT_MM, SLOW_PROBE_TRAVEL_MM, appendMachineOriginReturn, compensateGcode, computeG54ForMapOrigin, computePostProbeRetract, extendMapToMachineTravel, makeStlExportRecord, parseAbsoluteXYBounds, parseProbePosition, parseTravelLimits, parseWorkOffsetLine, validateMachineTarget, validateMap } from './heightmap.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const fields = ['lengthX', 'lengthY', 'pointsX', 'pointsY', 'fullRetract', 'fastFeed', 'slowFeed', 'puckThickness', 'parkX', 'parkY'];
const state = { origin: null, wposOrigin: null, probedOrigin: null, homeMachineZ: null, machinePosition: null, workPosition: null, positionMode: 'wpos', controllerHomed: false, adoptingHomedPosition: false, probeParserSequence: 0, offsetParserSequence: 0, probeStatusSequence: 0, probeMotionStatus: '', probePinActive: false, probePinKnown: false, probeSignalTested: false, probeSignalTestCancelled: false, probeMoveGuard: null, probeMovePause: null, map: null, mapInvalid: false, stlExport: null, file: null, busy: false, stopRequested: false, abortPuck: null, continuousJog: null };
const setNotice = (message, kind = '') => { $('notice').textContent = message; $('notice').className = kind; };
const setApplyStatus = (message, kind = '') => { $('applyStatus').textContent = message; $('applyStatus').className = kind; };
const n = (id) => Number($(id).value);
const round = (v) => Number(v.toFixed(4));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calibrationLogKey = 'calibrationLog';
const calibrationLogLimit = 400;
let calibrationLog = [];

async function logCalibration(message) {
    const entry = `${new Date().toISOString()} ${message}`;
    calibrationLog = [...calibrationLog, entry].slice(-calibrationLogLimit);
    const output = $('calibrationLog');
    if (output) { output.value = calibrationLog.join('\n'); output.scrollTop = output.scrollHeight; }
    try { await storage.set(calibrationLogKey, calibrationLog); } catch (error) { console.warn('Could not persist calibration log', error); }
}

function drawSurfaceMap() {
    const panel = $('mapVisual');
    const map = state.map;
    panel.hidden = !map;
    if (!map) return;
    let surface = map.measuredSurface;
    if (!surface && map.probeBounds && map.xPositions && map.yPositions) {
        const measuredIndices = (axis, min, max, start) => {
            const indices = axis.map((value, index) => ({ value, index }))
                .filter(({ value }) => value >= min - 1e-4 && value <= max + 1e-4);
            if (indices.length && Number.isFinite(start) && Math.abs(indices.at(-1).value - start) < Math.abs(indices[0].value - start)) indices.reverse();
            return indices;
        };
        const xs = measuredIndices(map.xPositions, map.probeBounds.minX, map.probeBounds.maxX, map.probeStart?.x);
        const ys = measuredIndices(map.yPositions, map.probeBounds.minY, map.probeBounds.maxY, map.probeStart?.y);
        if (xs.length > 1 && ys.length > 1) {
            surface = { z: ys.map(({ index: iy }) => xs.map(({ index: ix }) => map.z[iy][ix])) };
        }
    }
    const surfaceZ = surface?.z ?? map.z;
    const gridWidth = Array.isArray(surfaceZ) && Array.isArray(surfaceZ[0]) ? surfaceZ[0].length : 0;
    const validGrid = Array.isArray(surfaceZ) && surfaceZ.length >= 2 && gridWidth >= 2
        && Array.from(surfaceZ).every((row) => Array.isArray(row) && row.length === gridWidth
            && Array.from(row).every((value) => Number.isFinite(value)));
    if (!validGrid) {
        state.mapInvalid = true;
        $('compensate').disabled = true;
        $('mapStats').textContent = 'Saved map data is incomplete or inconsistent.';
        setNotice('The saved height map has an incomplete grid and cannot be displayed or applied. Delete the saved map and calibrate again.', 'error');
        return;
    }
    state.mapInvalid = false;
    $('compensate').disabled = !state.file || state.busy;
    const values = surfaceZ.flat();
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    $('mapStats').textContent = `Lowest ${min.toFixed(3)} mm · highest ${max.toFixed(3)} mm · range ${range.toFixed(3)} mm`;
    const factor = Number($('exaggeration').value);
    $('exaggerationValue').textContent = `${factor}×`;
    const canvas = $('surfaceCanvas');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const ny = surfaceZ.length;
    const nx = surfaceZ[0].length;
    const span = Math.min(width * 0.38, height * 0.34);
    const lift = Math.min(height * 0.24, span * factor * 0.08);
    const frontY = height * 0.78;
    const firstLevel = range > 0 ? (surfaceZ[0][0] - min) / range : 0.5;
    const points = surfaceZ.map((row, iy) => row.map((z, ix) => {
        const u = ix / (nx - 1);
        const v = iy / (ny - 1);
        const level = range > 0 ? (z - min) / range : 0.5;
        return { x: width / 2 + (u - v) * span, y: frontY - (u + v) * span * 0.43 - (level - firstLevel) * lift, level };
    }));
    const color = (level) => {
        const stops = [[36, 91, 219], [25, 185, 165], [184, 214, 60], [245, 140, 50], [216, 56, 56]];
        const at = level * (stops.length - 1);
        const idx = Math.min(stops.length - 2, Math.floor(at));
        const t = at - idx;
        const rgb = stops[idx].map((channel, c) => Math.round(channel + (stops[idx + 1][c] - channel) * t));
        return `rgb(${rgb.join(',')})`;
    };
    for (let iy = 0; iy < ny - 1; iy += 1) {
        for (let ix = 0; ix < nx - 1; ix += 1) {
            const quad = [points[iy][ix], points[iy][ix + 1], points[iy + 1][ix + 1], points[iy + 1][ix]];
            const level = quad.reduce((sum, point) => sum + point.level, 0) / quad.length;
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i].x, quad[i].y);
            ctx.closePath();
            ctx.fillStyle = color(level);
            ctx.globalAlpha = 0.84;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(235,245,255,0.72)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const row of points) for (const point of row) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = getComputedStyle(canvas).color;
    const interpolatePoint = (xPosition, yPosition) => {
        const x0 = Math.floor(xPosition);
        const y0 = Math.floor(yPosition);
        const x1 = Math.min(nx - 1, x0 + 1);
        const y1 = Math.min(ny - 1, y0 + 1);
        const tx = xPosition - x0;
        const ty = yPosition - y0;
        const blend = (a, b, t) => a + (b - a) * t;
        return {
            x: blend(blend(points[y0][x0].x, points[y0][x1].x, tx), blend(points[y1][x0].x, points[y1][x1].x, tx), ty),
            y: blend(blend(points[y0][x0].y, points[y0][x1].y, tx), blend(points[y1][x0].y, points[y1][x1].y, tx), ty),
        };
    };
    const corner = map.wposOriginCorner ?? 'front-left';
    const originIndices = {
        'front-left': [0, 0],
        'front-right': [nx - 1, 0],
        'rear-left': [0, ny - 1],
        'rear-right': [nx - 1, ny - 1],
        center: [(nx - 1) / 2, (ny - 1) / 2],
    };
    const [originXIndex, originYIndex] = originIndices[corner] ?? originIndices['front-left'];
    const originPoint = interpolatePoint(originXIndex, originYIndex);
    const xPoint = points[0][nx - 1];
    const yPoint = points[ny - 1][0];
    ctx.beginPath();
    ctx.arc(originPoint.x, originPoint.y, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText('0,0', originPoint.x + 9, originPoint.y - 10);
    ctx.textAlign = 'left';
    ctx.fillText('X', xPoint.x + 9, xPoint.y - 4);
    ctx.textAlign = 'right';
    ctx.fillText('Y', yPoint.x - 9, yPoint.y - 4);
}

function currentSettings() {
    return {
        ...Object.fromEntries(fields.map((id) => [id, n(id)])),
        retract: SHORT_RETRACT_MM,
        surfaceType: document.querySelector('input[name="surfaceType"]:checked').value,
        probeMode: document.querySelector('input[name="probeMode"]:checked')?.value ?? DEFAULTS.probeMode,
        parkMode: $('parkMode').value,
        wposOrigin: selectedWposOrigin(),
    };
}

function populateSettings(saved = {}) {
    for (const id of fields) {
        const value = saved[id];
        const missingOrInvalid = value == null || value === '' || !Number.isFinite(Number(value));
        const selectedValue = missingOrInvalid ? DEFAULTS[id] : value;
        $(id).value = String(selectedValue);
    }
    const surfaceType = ['conductive', 'puck', 'switch'].includes(saved.surfaceType) ? saved.surfaceType : DEFAULTS.surfaceType;
    document.querySelector(`input[name="surfaceType"][value="${surfaceType}"]`).checked = true;
    const probeMode = ['fast', 'precise'].includes(saved.probeMode) ? saved.probeMode : DEFAULTS.probeMode;
    document.querySelector(`input[name="probeMode"][value="${probeMode}"]`).checked = true;
    $('parkMode').value = ['wpos-origin', 'machine-zero', 'custom-machine'].includes(saved.parkMode) ? saved.parkMode : DEFAULTS.parkMode;
    updateParkFieldsVisibility();
    const wposOrigin = ['front-left', 'front-right', 'rear-left', 'rear-right', 'center'].includes(saved.wposOrigin) ? saved.wposOrigin : 'front-left';
    document.querySelector(`input[name="wposOrigin"][value="${wposOrigin}"]`).checked = true;
    updatePuckThicknessVisibility();
}

function updatePuckThicknessVisibility() {
    $('puckThicknessField').hidden = document.querySelector('input[name="surfaceType"]:checked').value !== 'puck';
}

function updateParkFieldsVisibility() {
    $('customParkFields').hidden = $('parkMode').value !== 'custom-machine';
}

function renderStlExport() {
    const panel = $('stlExportPanel');
    const output = state.stlExport;
    panel.hidden = !output || typeof output.text !== 'string' || typeof output.filename !== 'string';
    if (panel.hidden) return;
    panel.open = true;
    $('stlExportSummary').textContent = `${output.filename} · ${(new TextEncoder().encode(output.text).length / 1024).toFixed(1)} KiB in plugin storage`;
    $('stlText').value = output.text;
}

async function saveSettings() {
    try { await storage.set('settings', currentSettings()); }
    catch (err) { setNotice(`Could not save plugin settings: ${err.message}`, 'error'); }
}

function positionVector(position) {
    if (Array.isArray(position)) return position.slice(0, 3).map(Number);
    if (position && typeof position === 'object') return [Number(position.x), Number(position.y), Number(position.z)];
    return null;
}

function renderMachineDro() {
    const mode = $('coordinateMode');
    if (mode) {
        mode.textContent = state.positionMode === 'wpos' ? 'WPOS' : 'MPOS';
        mode.setAttribute('aria-pressed', String(state.positionMode === 'wpos'));
        mode.title = state.positionMode === 'wpos' ? 'Showing G54 work position. Click to show machine position.' : 'Showing machine position. Click to show G54 work position.';
    }
    const position = state.positionMode === 'wpos' ? state.workPosition : state.machinePosition;
    ['X', 'Y', 'Z'].forEach((axis, index) => {
        const value = position?.[index];
        $(`dro${axis}`).textContent = Number.isFinite(value) ? value.toFixed(3) : '—';
    });
}

function updateDroPositions(status) {
    state.machinePosition = positionVector(status?.mpos);
    state.workPosition = positionVector(status?.wpos);
    renderMachineDro();
}

function selectedWposOrigin() {
    return document.querySelector('input[name="wposOrigin"]:checked')?.value ?? 'front-left';
}

function mapFrontLeftFromWposOrigin(origin, corner, lengthX, lengthY) {
    const xOffset = corner.endsWith('right') ? -lengthX : corner === 'center' ? -lengthX / 2 : 0;
    const yOffset = corner.startsWith('rear') ? -lengthY : corner === 'center' ? -lengthY / 2 : 0;
    return { x: round(origin.x + xOffset), y: round(origin.y + yOffset) };
}

function activeWcsFromLines(lines) {
    const gcLine = (Array.isArray(lines) ? lines : [lines]).map(String).find((line) => /^\s*\[GC:/i.test(line));
    const match = gcLine?.match(/\b(G5[4-9])\b/i);
    return match?.[1]?.toUpperCase() ?? null;
}

async function readActiveWcs() {
    const result = await machine.query('$G', { until: 'ok-or-error', timeout: 8000, maxLines: 30 });
    if (!result.complete || result.error || !result.ok) throw new Error(`Could not read the active work coordinate system: ${result.error ?? result.reason ?? result.lines.join(' ')}`);
    const activeWcs = activeWcsFromLines(result.lines);
    if (!activeWcs) throw new Error(`Could not find an active G54–G59 work coordinate system in the controller's $G response: ${result.lines.join(' ')}`);
    return activeWcs;
}

function invalidateWposOrigin(message = '') {
    state.probeSignalTested = false;
    renderProbeSignalStatus();
    if (!state.wposOrigin) return;
    state.wposOrigin = null;
    state.origin = null;
    if (message) setNotice(message, 'error');
}

async function controllerSnapshot() {
    const reduxState = await getReduxState();
    if (!reduxState?.connection?.isConnected) throw new Error('Connect to the controller in gSender before continuing.');
    const status = reduxState?.controller?.state?.status;
    const mpos = positionVector(status?.mpos);
    if (!mpos || !mpos.every(Number.isFinite)) throw new Error('gSender has not reported a valid machine position yet. Wait for a controller status update and try again.');
    updateDroPositions(status);
    return { state: status.activeState ?? 'unknown', mpos, wpos: positionVector(status.wpos) };
}

async function statusSnapshot() {
    // Allow gSender's regular status poll to refresh after any recent move.
    await pause(300);
    return controllerSnapshot();
}

function renderProbeSignalStatus(message = '') {
    const output = $('probeSignalStatus');
    if (!output) return;
    output.textContent = message || (state.probeSignalTested
        ? 'Probe signal verified: gSender detected activation and release.'
        : 'Safety check required: test the probe signal before probing the WPOS origin.');
    output.className = state.probeSignalTested ? 'probe-signal-status success' : 'probe-signal-status error';
}

function showProbeSignalDialog() {
    const dialog = $('probeSignalDialog');
    const status = $('probeSignalDialogStatus');
    const action = $('continueProbeSignalTest');
    const cancel = $('cancelProbeSignalTest');
    state.probeSignalTestCancelled = false;
    state.probeSignalTested = false;
    renderProbeSignalStatus();
    status.textContent = 'Waiting for the probe input to be clear. Status is checked every 0.7 seconds.';
    status.className = 'probe-signal-status error';
    action.disabled = true;
    action.textContent = 'Continue to WPOS probe';
    dialog.showModal();
    return new Promise((resolve) => {
        let finished = false;
        const finish = (accepted) => {
            if (finished) return;
            finished = true;
            state.probeSignalTestCancelled = !accepted;
            dialog.close();
            dialog.oncancel = null;
            action.onclick = null;
            cancel.onclick = null;
            resolve(accepted);
        };
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
        cancel.onclick = () => finish(false);
        action.onclick = () => { if (state.probeSignalTested) finish(true); };
        void (async () => {
            let clearBaselineSeen = false;
            let activationSeen = false;
            await logCalibration('WPOS origin probe: automatic probe-signal monitoring started (700 ms polling).');
            while (!finished && !state.probeSignalTestCancelled && !state.probeSignalTested) {
                const cycleStarted = Date.now();
                const previousSequence = state.probeStatusSequence;
                try {
                    await machine.command('?');
                    const reportDeadline = Date.now() + 450;
                    while (!finished && !state.probeSignalTestCancelled
                        && state.probeStatusSequence <= previousSequence && Date.now() < reportDeadline) await pause(20);
                    if (state.probeStatusSequence > previousSequence) {
                        if (!state.probePinKnown) {
                            status.textContent = 'Waiting for gSender to report the probe-pin state (Pn:...).';
                            status.className = 'probe-signal-status error';
                        } else if (!state.probePinActive) {
                            if (!clearBaselineSeen) {
                                clearBaselineSeen = true;
                                status.textContent = 'Probe input is clear. Activate the probe now; monitoring continues automatically.';
                                status.className = 'probe-signal-status';
                            } else if (activationSeen) {
                                state.probeSignalTested = true;
                                action.disabled = false;
                                status.textContent = 'Probe activation and release detected. Continue to the WPOS origin probe.';
                                status.className = 'probe-signal-status success';
                                await logCalibration('WPOS origin probe: probe-pin activation and release detected; signal test passed.');
                                renderProbeSignalStatus();
                            }
                        } else if (!clearBaselineSeen) {
                            status.textContent = 'Probe input is active. Release it first; monitoring will then wait for a new activation.';
                            status.className = 'probe-signal-status error';
                        } else if (!activationSeen) {
                            activationSeen = true;
                            status.textContent = 'Probe activation detected. Release the probe now.';
                            status.className = 'probe-signal-status';
                            await logCalibration('WPOS origin probe: probe-pin activation detected.');
                        }
                    }
                } catch (error) {
                    status.textContent = `Waiting for controller probe status: ${error.message}`;
                    status.className = 'probe-signal-status error';
                }
                const waitMs = Math.max(0, 700 - (Date.now() - cycleStarted));
                if (!finished && !state.probeSignalTestCancelled && !state.probeSignalTested && waitMs) await pause(waitMs);
            }
        })();
    });
}

function receiveProbeMotionStatus(report) {
    const match = String(report?.line ?? '').trim().match(/^<([^>]*)>$/);
    if (!match) return;
    const statusFields = match[1].split('|');
    state.probeMotionStatus = statusFields[0];
    const pinState = statusFields.find((field) => field.startsWith('Pn:'));
    // GRBL omits Pn entirely when no input pins are active. A valid status
    // report without Pn therefore means the probe input is clear, not unknown.
    state.probePinKnown = true;
    state.probePinActive = Boolean(pinState && pinState.slice(3).includes('P'));
    state.probeStatusSequence += 1;
    const guard = state.probeMoveGuard;
    if (guard?.active && guard.motionStarted && state.probePinActive && !guard.tripped) {
        guard.tripped = true;
        setNotice(`Probe input activated during ${guard.label}. Sending feed hold…`, 'error');
        guard.holdPromise = machine.command('feedhold')
            .then(() => logCalibration(`PROBE INPUT ACTIVATED during ${guard.label}; feed hold sent.`))
            .catch(async (error) => {
                guard.holdError = error;
                await logCalibration(`PROBE INPUT ACTIVATED during ${guard.label}; feed-hold command failed: ${error.message}`);
            });
        state.probeMovePause = guard;
        setNotice(`Probe input activated during ${guard.label}. Motion is pausing; clear the probe signal to resume.`, 'error');
    }
    void refreshUi();
}

async function waitForFreshProbeStatus(previousSequence, timeoutMs = 1500) {
    await machine.command('?');
    const deadline = Date.now() + timeoutMs;
    while (state.probeStatusSequence <= previousSequence && Date.now() < deadline) await pause(20);
    return state.probeStatusSequence > previousSequence;
}

async function moveXYWithProbeGuard(line, label) {
    const guard = { active: false, tripped: false, holdPromise: null, label };
    state.probeMoveGuard = guard;
    try {
        const previousSequence = state.probeStatusSequence;
        if (!await waitForFreshProbeStatus(previousSequence)) {
            throw new Error('Could not verify the probe input before XY travel. No move was sent; check controller status reporting and reconnect.');
        }
        if (state.probePinActive) throw new Error(`Probe input is already active before XY travel ${label}. No move was sent; clear the probe signal first.`);
        await logCalibration(`Probe monitor armed for XY travel ${label}.`);
        await sendAndWait(line, 30000, () => {
            if (state.probePinActive) throw new Error(`Probe input is already active before XY travel ${label}. No move was sent; clear the probe signal first.`);
            guard.active = true;
            guard.motionStarted = true;
        });
        let until = Date.now() + 120000;
        while (Date.now() < until) {
            if (guard.tripped) {
                await guard.holdPromise;
                if (guard.holdError) throw new Error(`Probe input activated during ${label}, but gSender could not send feed hold: ${guard.holdError.message}. Check the machine immediately.`);
                guard.active = false;
                await waitForProbeMoveToStop(guard);
                if (state.stopRequested) throw new Error('Calibration stopped after probe activation. The machine was left stopped; start a new calibration when ready.');
                setNotice(`Probe signal cleared and motion stopped during ${label}. Review the machine, then resume to finish this XY move and continue calibration.`);
                let resumeState = '';
                while (!resumeState) {
                    const resume = await new Promise((resolve) => { guard.resumeResolve = resolve; });
                    guard.resumeResolve = null;
                    if (!resume || state.stopRequested) throw new Error('Calibration stopped while paused after probe activation. The machine was left stopped; start a new calibration when ready.');
                    const statusSequence = state.probeStatusSequence;
                    if (!await waitForFreshProbeStatus(statusSequence) || state.probePinActive
                        || !['Idle', 'Hold:0'].includes(state.probeMotionStatus)) {
                        setNotice('Resume is available only after the machine has stopped and the probe input is clear.', 'error');
                        continue;
                    }
                    resumeState = state.probeMotionStatus;
                }
                until = Date.now() + 120000;
                state.probeMovePause = null;
                if (resumeState === 'Hold:0') {
                    guard.tripped = false;
                    guard.holdPromise = null;
                    guard.holdError = null;
                    guard.active = true;
                    await logCalibration(`Resume requested for ${label}; continuing the held XY move.`);
                    guard.motionStarted = true;
                    await machine.command('cyclestart');
                    continue;
                }
                // Some controllers report Idle after a hold/reset. Reissue
                // this same absolute target so we never probe at a partial
                // XY position; the move remains guarded by Pn:P monitoring.
                guard.tripped = false;
                guard.holdPromise = null;
                guard.holdError = null;
                guard.active = true;
                await logCalibration(`Resume requested for ${label}; controller is Idle, reissuing the XY target.`);
                await sendAndWait(line, 30000, () => {
                    if (state.probePinActive) throw new Error(`Probe input is active before resuming ${label}. No move was sent; clear the probe signal first.`);
                    guard.motionStarted = true;
                });
                continue;
            }
            const snapshot = await controllerSnapshot();
            if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state after probe activation. Resolve the alarm in gSender before continuing.');
            if (snapshot.state === 'Idle') break;
            await machine.command('?');
            await pause(100);
        }
        if (Date.now() >= until) throw new Error(`Timed out waiting for XY travel ${label} to finish or pause.`);
    } finally {
        guard.active = false;
        state.probeMovePause = null;
        if (state.probeMoveGuard === guard) state.probeMoveGuard = null;
    }
}

async function waitForProbeMoveToStop(guard, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (state.stopRequested) throw new Error('Calibration stopped after probe activation. The machine was left stopped; start a new calibration when ready.');
        if (state.probeMotionStatus === 'Idle' || state.probeMotionStatus === 'Hold:0') return;
        const snapshot = await controllerSnapshot();
        if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state after probe activation. Resolve the alarm in gSender before continuing.');
        await machine.command('?');
        await pause(100);
    }
    throw new Error(`Timed out waiting for XY travel ${guard.label} to stop after feed hold.`);
}

async function resumePausedCalibration() {
    const guard = state.probeMovePause;
    if (!guard?.resumeResolve) return;
    const previousSequence = state.probeStatusSequence;
    if (!await waitForFreshProbeStatus(previousSequence) || state.probePinActive
        || !['Idle', 'Hold:0'].includes(state.probeMotionStatus)) {
        await refreshUi();
        setNotice('Resume is available only after the machine has stopped and the probe input is clear.', 'error');
        return;
    }
    guard.resumeResolve(true);
}

async function waitIdle(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    const settleAfter = Date.now() + 500;
    while (Date.now() < until) {
        const snapshot = await controllerSnapshot();
        if (snapshot.state === 'Idle' && Date.now() >= settleAfter) return snapshot;
        if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state. Resolve the alarm in gSender before continuing.');
        await pause(200);
    }
    throw new Error('Timed out waiting for the machine to become idle.');
}

async function sendAndWait(line, timeout = 30000, beforeSend = null) {
    await logCalibration(`TX ${line}`);
    beforeSend?.();
    let result;
    try { result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 }); }
    catch (error) { await logCalibration(`RX/ERROR ${line}: ${error.message}`); throw error; }
    await logCalibration(`RX ${line}: ${JSON.stringify({ complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines })}`);
    if (!result.complete || result.error || !result.ok) {
        throw new Error(`Controller did not accept “${line}”: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
    }
    return result;
}

async function readTravelLimits() {
    let lastError = 'The controller did not return a complete settings response.';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await logCalibration(`TX $$ settings query attempt ${attempt}/3.`);
        let result;
        try {
            result = await machine.query('$$', { until: 'ok-or-error', timeout: 10000, maxLines: 350 });
            await logCalibration(`RX $$ settings query attempt ${attempt}/3: ${JSON.stringify({ complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, durationMs: result.durationMs, lineCount: result.lines?.length ?? 0, lines: result.lines ?? [] })}`);
        } catch (error) {
            lastError = error.message;
            await logCalibration(`RX/ERROR $$ settings query attempt ${attempt}/3: ${error.message}`);
        }
        if (!result) {
            // Query threw before returning a response; retry and preserve the error in the log.
        } else if (!result.complete || result.error || !result.ok) {
            lastError = result.error ?? result.reason ?? lastError;
            await logCalibration(`$$ attempt ${attempt}/3 was incomplete or rejected: ${lastError}`);
        } else {
            try {
                const settingsLines = result.lines.map((line) => String(line));
                const homingMask = readHomingMask(settingsLines);
                if (homingMask === null) throw new Error(`the $23 line was missing from ${settingsLines.length} returned lines`);
                const limits = parseTravelLimits(settingsLines);
                const hardLimitsEnabled = settingsLines.some((line) => /^\s*\$?21\s*=\s*1(?:\s|$)/i.test(line));
                const pullOffLine = settingsLines.find((line) => /^\s*\$?27\s*=/i.test(line));
                const pullOffMatch = pullOffLine?.match(/^\s*\$?27\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+))(?:\s|$)/i);
                const pullOff = pullOffMatch ? Number(pullOffMatch[1]) : 0;
                if (hardLimitsEnabled && Number.isFinite(pullOff) && pullOff > 0) {
                    // $132 is measured from the post-homing position. Keep
                    // that Z=0 home endpoint valid and reserve pull-off at
                    // the far end, where the remaining axis travel is shorter.
                    if (limits.zHomePositive) limits.minZ += pullOff;
                    else limits.maxZPosition -= pullOff;
                    if (limits.minZ >= limits.maxZPosition) throw new Error('$27 homing pull-off leaves no usable Z travel within $132=' + limits.maxZ + ' mm.');
                }
                await logCalibration('Controller Z travel: ' + limits.minZ + '..' + limits.maxZPosition + (hardLimitsEnabled && pullOff > 0 ? ' ($27=' + pullOff + ' mm pull-off clearance applied)' : '.') );
                await logCalibration(`$$ settings query attempt ${attempt}/3 parsed successfully; found $23=${homingMask}, $130=${limits.maxX}, $131=${limits.maxY}, $132=${limits.maxZ}.`);
                return { ...limits, homingMask, zHomePositive: (homingMask & 4) === 0 };
            } catch (error) {
                lastError = error.message;
                await logCalibration(`$$ settings query attempt ${attempt}/3 parse/validation failed: ${lastError}`);
            }
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Could not read a complete GRBL settings response (attempted $$ three times): ${lastError}. Check the controller connection and try again.`);
}

function readHomingMask(lines) {
    const match = (Array.isArray(lines) ? lines : [lines]).map((line) => String(line)).join('\n').match(/^\s*\$?23\s*=\s*(\d+)(?:\s|$)/im);
    return match ? Number(match[1]) : null;
}

async function readCoordinateOffsets(activeWcs) {
    const parserId = `surface-height-map-offset-${++state.offsetParserSequence}`;
    const registration = await machine.registerParser({
        id: parserId,
        mode: 'line',
        match: /^\[(?<name>G5[4-9]|G92):[-\d.,]+\]\s*$/i,
    });
    if (!registration.registered.includes(parserId) || registration.errors.length) {
        throw new Error(`Could not listen for coordinate offsets: ${registration.errors.map((entry) => entry.error ?? 'parser registration failed').join('; ')}`);
    }

    const offsets = {};
    let resolveOffset;
    const offsetReport = new Promise((resolve) => { resolveOffset = resolve; });
    const collect = (name, line) => {
        name = String(name ?? '').toUpperCase();
        const values = parseWorkOffsetLine(line, name);
        if (values) {
            offsets[name] = values;
            if (offsets[activeWcs] && offsets.G92) resolveOffset();
        }
    };
    const unsubscribe = machine.onParsed(parserId, (report) => collect(report.groups?.name, report.line));
    try {
        const result = await machine.query('$#', { until: 'ok-or-error', timeout: 8000, maxLines: 100 });
        if (!result.complete || result.error || !result.ok) throw new Error(`Could not read work offsets ($#): ${result.error ?? result.reason}`);
        for (const line of result.lines) {
            for (const name of ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G92']) collect(name, line);
        }
        if (!offsets[activeWcs] || !offsets.G92) {
            // Some controllers may send coordinate records after their `ok`; keep the
            // temporary line parser armed briefly to collect that late tail.
            await Promise.race([
                offsetReport,
                pause(2000),
            ]);
        }
        if (!offsets[activeWcs] || !offsets.G92) {
            const received = result.lines.map((line) => String(line).trim()).join(' | ') || '(no response lines)';
            throw new Error(`Could not read ${activeWcs} and G92 offsets from the controller's $# response. Expected [${activeWcs}:X,Y,Z,...] and [G92:X,Y,Z,...]. Received: ${received}`);
        }
        await pause(250);
        return offsets;
    } finally {
        unsubscribe();
        try { await machine.unregisterParser(parserId); } catch { /* connection may have closed */ }
    }
}

async function refreshUi() {
    let connected = false;
    try { connected = Boolean((await machine.getContext())?.connected); } catch { /* disconnected or SDK denied */ }
    if (!connected) {
        state.machinePosition = null;
        state.workPosition = null;
        state.homeMachineZ = null;
        state.controllerHomed = false;
        state.wposOrigin = null;
        state.probedOrigin = null;
        state.probeSignalTested = false;
        state.origin = null;
    }
    const homed = connected && state.controllerHomed && Number.isFinite(state.homeMachineZ);
    $('connection').textContent = connected ? 'Connected' : 'Not connected';
    renderMachineDro();
    $('connection').dataset.connected = String(connected);
    $('home').disabled = !connected || state.busy;
    $('originSelector').disabled = !homed || state.busy;
    const jogDisabled = !homed || (state.busy && !state.continuousJog) || Boolean(state.wposOrigin);
    $('jogStep').disabled = jogDisabled;
    for (const id of ['jogXMinus', 'jogXPlus', 'jogYMinus', 'jogYPlus', 'jogZMinus', 'jogZPlus']) $(id).disabled = jogDisabled;
    $('probeWpos').disabled = !homed || state.busy || Boolean(state.wposOrigin);
    renderProbeSignalStatus();
    $('gotoOrigin').disabled = !homed || state.busy || !state.probedOrigin;
    $('calibrate').disabled = !homed || state.busy || !state.wposOrigin;
    $('resumeProbe').hidden = !state.probeMovePause;
    $('resumeProbe').disabled = !state.probeMovePause?.resumeResolve || state.probePinActive || !['Idle', 'Hold:0'].includes(state.probeMotionStatus);
    $('stop').disabled = !state.busy;
    $('compensate').disabled = !state.map || state.mapInvalid || !state.file || state.busy;
    $('clearMap').disabled = !state.map || state.busy;
    $('exportStl').disabled = !state.map || state.busy;
    $('originLabel').textContent = state.origin ? `Map front-left X${state.origin.x.toFixed(3)}  Y${state.origin.y.toFixed(3)}`
        : state.wposOrigin ? `WPOS origin set at ${state.wposOrigin.corner.replace('-', ' ')} · machine X${state.wposOrigin.mpos[0].toFixed(3)} Y${state.wposOrigin.mpos[1].toFixed(3)}`
            : 'Probe the selected WPOS origin to enable calibration';
    $('homeLabel').textContent = homed
        ? 'Machine already homed'
        : state.controllerHomed ? 'Machine homed · waiting for Idle position' : 'Machine not homed';
    if (state.map?.machineBounds) {
        const { minX, maxX, minY, maxY } = state.map.machineBounds;
        const probed = state.map.probeBounds
            ? `${(state.map.probeBounds.maxX - state.map.probeBounds.minX).toFixed(1)} × ${(state.map.probeBounds.maxY - state.map.probeBounds.minY).toFixed(1)} mm probed`
            : `${state.map.lengthX} × ${state.map.lengthY} mm probed`;
        $('mapSummary').textContent = `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} mm machine coverage · ${probed} · ${state.map.pointsX} × ${state.map.pointsY} grid nodes · WPOS origin at machine X${(state.map.wposOriginMachineX ?? state.map.originX).toFixed(3)} Y${(state.map.wposOriginMachineY ?? state.map.originY).toFixed(3)} · ${new Date(state.map.createdAt).toLocaleString()}`;
    } else {
        $('mapSummary').textContent = state.map
            ? `${state.map.lengthX} × ${state.map.lengthY} mm · ${state.map.pointsX} × ${state.map.pointsY} points · captured at machine X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)} · ${new Date(state.map.createdAt).toLocaleString()}`
            : 'No height map saved.';
    }
    drawSurfaceMap();
}

async function adoptControllerHoming(hasHomed) {
    state.controllerHomed = Boolean(hasHomed);
    if (!state.controllerHomed) {
        state.homeMachineZ = null;
        state.wposOrigin = null;
        state.probedOrigin = null;
        state.origin = null;
        await refreshUi();
        return;
    }
    if (state.busy || Number.isFinite(state.homeMachineZ) || state.adoptingHomedPosition) {
        await refreshUi();
        return;
    }
    state.adoptingHomedPosition = true;
    try {
        const snapshot = await statusSnapshot();
        if (!state.controllerHomed || snapshot.state !== 'Idle') return;
        state.homeMachineZ = round(snapshot.mpos[2]);
        state.origin = null;
        setNotice('Machine is already homed. Jog to the selected work origin, then use Probe WPOS origin to touch off and set X0 Y0 Z0.', 'success');
    } catch (err) {
        setNotice(`Machine is homed, but its current Z position could not be read: ${err.message}`, 'error');
    } finally {
        state.adoptingHomedPosition = false;
        await refreshUi();
    }
}

function readProbePosition(result) {
    const line = result.lines.map((entry) => String(entry).trim()).find((entry) => /^\[PRB:/i.test(entry));
    const position = line && parseProbePosition(line);
    if (!position) throw new Error(`Probe did not trigger successfully. Response: ${result.lines.join(' ') || result.reason}`);
    return position;
}

async function exportSurfaceStl() {
    const button = $('exportStl');
    button.disabled = true;
    try {
        if (!state.map) throw new Error('Calibrate or load a saved height map before exporting an STL.');
        const record = makeStlExportRecord(state.map);
        await storage.set('stlExport', record);
        state.stlExport = record;
        renderStlExport();
        $('stlStatus').textContent = `STL text saved in gSender plugin storage as ${record.filename}. Use Copy STL text, then paste it into a plain-text editor and save the file with the .stl extension.`;
        $('stlStatus').className = 'success';
    } catch (error) {
        $('stlStatus').textContent = error.message;
        $('stlStatus').className = 'error';
    } finally {
        button.disabled = !state.map || state.busy;
    }
}

async function copyStlText() {
    const output = state.stlExport;
    if (!output?.text) return;
    const field = $('stlText');
    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable in this gSender build.');
        await navigator.clipboard.writeText(output.text);
        $('copyStlStatus').textContent = 'STL text copied. Paste it into a plain-text editor and save with the .stl extension.';
        $('copyStlStatus').className = 'success';
    } catch {
        field.focus();
        field.select();
        field.setSelectionRange(0, field.value.length);
        $('copyStlStatus').textContent = 'Clipboard access was blocked. The STL text is selected; press Ctrl+C, paste it into a plain-text editor, and save with the .stl extension.';
        $('copyStlStatus').className = '';
    }
}

function probeMissError(stage) {
    const error = new Error(`${stage} did not trigger within the configured probe travel.`);
    error.probeMiss = true;
    return error;
}

async function queryProbe(line, timeout, stage) {
    await logCalibration(`TX ${stage}: ${line}`);
    const parserId = `surface-height-map-probe-${++state.probeParserSequence}`;
    const registration = await machine.registerParser({
        id: parserId,
        mode: 'line',
        match: /^\[PRB:(?<x>[-\d.]+),(?<y>[-\d.]+),(?<z>[-\d.]+)(?:,[-\d.]+)*:(?<success>[01])\]\s*$/i,
    });
    if (!registration.registered.includes(parserId) || registration.errors.length) {
        throw new Error(`Could not listen for the ${stage.toLowerCase()} probe report: ${registration.errors.map((entry) => entry.error ?? 'parser registration failed').join('; ')}`);
    }

    let resolveReport;
    const reportPromise = new Promise((resolve) => { resolveReport = resolve; });
    const unsubscribe = machine.onParsed(parserId, (report) => {
        if (/:0\]\s*$/i.test(String(report.line).trim())) {
            resolveReport({ missed: true });
            return;
        }
        try { resolveReport({ position: parseProbePosition(report.line) }); }
        catch (error) { resolveReport({ error }); }
    });
    try {
        const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 });
        await logCalibration(`RX ${stage}: ${JSON.stringify({ complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines })}`);
        const alarmLine = result.lines.map((entry) => String(entry).trim()).find((entry) => /^ALARM\s*:/i.test(entry));
        if (alarmLine) throw new Error(`${stage} was stopped by the controller (${alarmLine}). Check machine travel and probe reach before retrying.`);
        if (!result.complete || !result.ok || result.error) {
            throw new Error(`${stage} probe was not accepted. Controller response: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        }
        const reportLine = result.lines.map((entry) => String(entry).trim()).find((entry) => /^\[PRB:/i.test(entry));
        if (reportLine) {
            await logCalibration(`${stage} report: ${reportLine}`);
            if (/:0\]$/i.test(reportLine)) throw probeMissError(stage);
            return readProbePosition({ lines: [reportLine] });
        }

        setNotice(`${stage} probe was acknowledged. Waiting for its position report…`);
        let reportTimeout;
        const timeoutPromise = new Promise((_, reject) => {
            reportTimeout = setTimeout(() => reject(new Error('The controller acknowledged the probe with “ok” but no [PRB:...] position report arrived. Check the probe reporting stream and controller connection.')), 5000);
        });
        let outcome;
        try {
            outcome = await Promise.race([reportPromise, timeoutPromise]);
        } catch (error) {
            const reduxState = await getReduxState().catch(() => null);
            const controllerStatus = reduxState?.controller?.state?.status;
            if (controllerStatus?.activeState === 'Alarm') {
                const code = controllerStatus.alarmCode == null ? '' : ` ${controllerStatus.alarmCode}`;
                throw new Error(`${stage} returned no [PRB:...] position and gSender reports Alarm${code}. Check the controller alarm before retrying.`);
            }
            const machinePosition = positionVector(controllerStatus?.mpos);
            if (controllerStatus?.activeState === 'Idle'
                && machinePosition
                && machinePosition.every(Number.isFinite)) {
                setNotice(`${stage} completed, but its [PRB:...] report was not delivered. Using gSender's stopped machine position.`);
                return { position: { x: machinePosition[0], y: machinePosition[1], z: machinePosition[2] } };
            }
            if (controllerStatus?.activeState && controllerStatus.activeState !== 'Idle') {
                throw new Error(`${stage} returned no [PRB:...] position; gSender still reports ${controllerStatus.activeState}. Wait for Idle and check the controller before retrying.`);
            }
            throw error;
        } finally {
            clearTimeout(reportTimeout);
        }
        if (outcome.missed) throw probeMissError(stage);
        if (outcome.error) throw outcome.error;
        if (!outcome.position) throw new Error(`${stage} probe report did not contain a valid position.`);
        return outcome.position;
    } finally {
        unsubscribe();
        try { await machine.unregisterParser(parserId); } catch { /* connection may have closed */ }
    }
}

function safeProbeTravel(distance, stage, pointLabel, currentZ, limits) {
    const zMinimum = limits.minZ;
    if (!Number.isFinite(currentZ)) throw new Error(`Could not read the current machine Z before ${stage.toLowerCase()} at ${pointLabel}.`);
    const available = currentZ - zMinimum - 0.1;
    if (!Number.isFinite(available) || available <= 0.1) throw new Error(`${stage} at ${pointLabel} has no safe downward Z travel remaining before the machine Z limit (${zMinimum.toFixed(3)} mm). Move to a higher safe Z before calibration.`);
    return Math.floor(Math.min(distance, available) * 1000) / 1000;
}

async function probeSequenceOnce(settings, point, pointLabel, limits, startingZ, attempt) {
    const retryLabel = attempt === 1 ? ' (retry)' : '';
    const fastTravel = safeProbeTravel(limits.maxZ, 'Fast probe', pointLabel, startingZ, limits);
    setNotice(`Fast probe on ${pointLabel}${retryLabel}: up to ${fastTravel.toFixed(3)} mm available before the machine Z limit. Keep hands clear.`);
    const fastProbe = await queryProbe(`G91 G38.3 Z-${fastTravel} F${settings.fastFeed}`, 45000, `Fast probe on ${pointLabel}${retryLabel}`);
    if (settings.probeMode === 'fast') {
        setNotice(`Single fast probe contact registered on ${pointLabel}; moving on.`);
        return fastProbe;
    }
    const interimRetract = computePostProbeRetract(fastProbe.z, limits.maxZPosition, SHORT_RETRACT_MM);
    setNotice(`Fast contact found on ${pointLabel}. Retracting ${interimRetract.toFixed(3)} mm before the slow touch…`);
    await sendAndWait(`G91 G0 Z${interimRetract}`);
    const slowStart = await waitIdle();
    const slowTravel = safeProbeTravel(SLOW_PROBE_TRAVEL_MM, 'Slow probe', pointLabel, slowStart.mpos[2], limits);
    setNotice(slowTravel < SLOW_PROBE_TRAVEL_MM
        ? `Slow probe at ${pointLabel}: limiting travel to ${slowTravel.toFixed(3)} mm to stay inside Z travel.`
        : `Slow probe on ${pointLabel}${retryLabel}…`);
    const slowProbe = await queryProbe(`G91 G38.3 Z-${slowTravel} F${settings.slowFeed}`, 30000, `Slow probe on ${pointLabel}${retryLabel}`);
    setNotice(`Slow probe contact registered on ${pointLabel}.`);
    return slowProbe;
}

async function probeWithOneRetry(settings, point, pointLabel, limits, startingZ, retryZ = startingZ) {
    try {
        return await probeSequenceOnce(settings, point, pointLabel, limits, startingZ, 0);
    } catch (error) {
        if (!error.probeMiss) throw error;
        await logCalibration(`PROBE MISS at ${pointLabel}: ${error.message} Returning to machine Z${retryZ.toFixed(3)} for one retry.`);
        setNotice(`${error.message} Returning to a safe height for one retry at ${pointLabel}…`);
        const status = await statusSnapshot();
        if (status.state !== 'Idle') throw new Error(`${error.message} One retry was not possible because the controller is ${status.state}; resolve the controller state and restart.`);
        if (retryZ < limits.minZ || retryZ > limits.maxZPosition) throw new Error(`${error.message} One retry was not possible because the saved safe retry Z is outside machine travel.`);
        await sendAndWait(`G90 G53 G0 Z${retryZ.toFixed(3)}`);
        const retryStart = await waitIdle();
        await logCalibration(`Retrying ${pointLabel} once from machine Z${retryStart.mpos[2].toFixed(3)}.`);
        setNotice(`Retrying probe at ${pointLabel} once…`);
        try {
            return await probeSequenceOnce(settings, point, pointLabel, limits, retryStart.mpos[2], 1);
        } catch (retryError) {
            if (retryError.probeMiss) {
                const stopped = await statusSnapshot();
                if (stopped.state === 'Idle') {
                    await sendAndWait(`G90 G53 G0 Z${retryZ.toFixed(3)}`);
                    await waitIdle();
                }
                throw new Error(`${retryError.message} The single retry also missed; calibration stopped at ${pointLabel}.`);
            }
            throw retryError;
        }
    }
}

async function probeAt(settings, point, index, total, limits, startingZ) {
    const pointLabel = `point ${index + 1}/${total} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)})`;
    const slowProbe = await probeWithOneRetry(settings, point, pointLabel, limits, startingZ);
    return {
        z: slowProbe.z - (settings.surfaceType === 'puck' ? settings.puckThickness : 0),
        machineZ: slowProbe.z,
    };
}

function confirmUser(message, title, buttonLabel = 'Continue') {
    $('dialogTitle').textContent = title;
    $('puckPrompt').textContent = message;
    $('continuePuck').textContent = buttonLabel;
    $('puckDialog').showModal();
    return new Promise((resolve, reject) => {
        state.abortPuck = () => { $('puckDialog').close(); reject(new Error('Calibration cancelled by user.')); };
        $('continuePuck').onclick = () => { state.abortPuck = null; $('puckDialog').close(); resolve(); };
        $('cancelPuck').onclick = () => state.abortPuck?.();
    });
}

function promptPuck(point, index, total) {
    return confirmUser(`Place the probe puck at grid point ${index + 1} of ${total} (machine X${point.x.toFixed(3)}, Y${point.y.toFixed(3)}), then confirm. Keep hands clear before continuing.`, 'Move the probe puck', 'Puck is in place');
}

function confirmG54Alignment(bounds, oldG54, targetG54) {
    const dialog = $('alignDialog');
    $('alignPrompt').textContent = `This will save G54 X/Y to ${targetG54.x.toFixed(3)}, ${targetG54.y.toFixed(3)} mm so the file's minimum X${bounds.minX.toFixed(3)} Y${bounds.minY.toFixed(3)} lands at the map origin X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)}. Current G54 is X${oldG54[0].toFixed(3)} Y${oldG54[1].toFixed(3)}. The saved offsets affect other G54 jobs until changed again.`;
    dialog.showModal();
    return new Promise((resolve) => {
        const finish = (accepted) => {
            dialog.close();
            dialog.oncancel = null;
            resolve(accepted);
        };
        $('confirmAlign').onclick = () => finish(true);
        $('cancelAlign').onclick = () => finish(false);
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    });
}

function validateSettings(s, limits, wposZeroMachineZ = null) {
    for (const id of fields) if (!Number.isFinite(s[id])) throw new Error(`Enter a valid number for ${id}.`);
    if (s.fullRetract <= 0) throw new Error('Full Retract Height must be greater than zero above WPOS Z0.');
    if (Number.isFinite(wposZeroMachineZ)) {
        const retractMachineZ = wposZeroMachineZ + s.fullRetract;
        if (retractMachineZ < limits.minZ || retractMachineZ > limits.maxZPosition) {
            throw new Error(`Full Retract Height ${s.fullRetract.toFixed(3)} mm places machine Z at ${retractMachineZ.toFixed(3)} mm, outside the reported Z travel ${limits.minZ}..${limits.maxZPosition} mm. Reduce the height or choose an origin with more Z clearance.`);
        }
    }
    if (s.fastFeed <= 0 || s.slowFeed <= 0) throw new Error('Probe feeds must be greater than zero.');
    if (s.puckThickness < 0) throw new Error('Probe puck thickness cannot be negative.');
    if (!['conductive', 'puck', 'switch'].includes(s.surfaceType)) throw new Error('Choose Conductive, Puck, or Switch as the probe type.');
    if (!['fast', 'precise'].includes(s.probeMode)) throw new Error('Choose Fast or Precise as the probe method.');
    if (!['wpos-origin', 'machine-zero', 'custom-machine'].includes(s.parkMode)) throw new Error('Choose a valid post-calibration park location.');
    if (s.parkMode === 'machine-zero') {
        validateMachineTarget({ x: 0, y: 0 }, limits);
        if (limits.minZ > 0 || limits.maxZPosition < 0) throw new Error(`Machine Z0 is outside the reported Z travel ${limits.minZ}..${limits.maxZPosition} mm.`);
    } else if (s.parkMode === 'custom-machine') validateMachineTarget({ x: s.parkX, y: s.parkY }, limits);
}

async function homeMachine() {
    if (state.busy) return;
    state.homeMachineZ = null;
    state.wposOrigin = null;
    state.probedOrigin = null;
    state.origin = null;
    state.controllerHomed = false;
    state.busy = true; await refreshUi(); setNotice('Homing… keep clear of the machine.');
    try {
        const result = await machine.query('$H', { until: 'ok-or-error', timeout: 120000, maxLines: 80 });
        if (!result.complete || !result.ok || result.error) throw new Error(`Homing failed: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        const homeStatus = await waitIdle(30000);
        state.controllerHomed = true;
        state.homeMachineZ = round(homeStatus.mpos[2]);
        state.wposOrigin = null;
        state.origin = null;
        await refreshUi();
        setNotice('Homing complete. Select the work origin, jog the probe above it, and use Probe WPOS origin.', 'success');
    } catch (err) { setNotice(err.message, 'error'); }
    finally { state.busy = false; await refreshUi(); }
}

async function jogMachine(axis, sign) {
    if (state.busy || !state.controllerHomed || !['X', 'Y', 'Z'].includes(axis)) return;
    const step = Number($('jogStep').value);
    if (![0.1, 1, 10].includes(step) || ![-1, 1].includes(sign)) {
        setNotice('Choose a valid jog step before moving.', 'error');
        return;
    }
    invalidateWposOrigin('Machine jogged. Probe the selected WPOS origin again before calibration.');
    state.busy = true;
    await refreshUi();
    try {
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Jogging requires an idle machine (current state: ${snapshot.state}).`);
        const limits = await readTravelLimits();
        const target = [...snapshot.mpos];
        const axisIndex = { X: 0, Y: 1, Z: 2 }[axis];
        target[axisIndex] += sign * step;
        if (axis === 'Z') {
            if (target[2] < limits.minZ || target[2] > limits.maxZPosition) {
                throw new Error(`Z jog would exceed machine travel ${limits.minZ}..${limits.maxZPosition} mm.`);
            }
        } else {
            validateMachineTarget({ x: target[0], y: target[1] }, limits);
        }
        await machine.setBusy(true, `Jog ${axis} ${sign > 0 ? '+' : '-'}${step} mm`);
        const delta = (sign * step).toFixed(3);
        await sendAndWait(`G21 G91 G0 ${axis}${delta}`);
        await waitIdle();
        await sendAndWait('G90');
        setNotice(`Jogged ${axis} ${sign > 0 ? '+' : '-'}${step} mm. Use Probe WPOS origin when the probe is over the selected origin.`, 'success');
    } catch (error) {
        try { await sendAndWait('G90', 5000); } catch { /* preserve the motion error */ }
        setNotice(error.message, 'error');
    } finally {
        state.busy = false;
        try { await machine.setBusy(false); } catch { /* connection may have closed */ }
        await refreshUi();
    }
}

async function startContinuousJog(axis, sign, inputEvent) {
    if (state.busy || !state.controllerHomed || !['X', 'Y', 'Z'].includes(axis) || ![-1, 1].includes(sign)) return;
    const jog = { axis, sign, pointerId: inputEvent?.pointerId ?? null, key: inputEvent?.key ?? null, stopRequested: false, commandSent: false, cancelSent: false };
    state.continuousJog = jog;
    invalidateWposOrigin('Machine jogged. Probe the selected WPOS origin again before calibration.');
    state.busy = true;
    await refreshUi();
    let busySet = false;
    try {
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Jogging requires an idle machine (current state: ${snapshot.state}).`);
        const limits = await readTravelLimits();
        const index = { X: 0, Y: 1, Z: 2 }[axis];
        const travel = axis === 'X' ? { min: limits.minX, max: limits.maxX }
            : axis === 'Y' ? { min: limits.minY, max: limits.maxY }
                : { min: limits.minZ, max: limits.maxZPosition };
        const position = snapshot.mpos[index];
        const targetLimit = sign > 0 ? travel.max : travel.min;
        const distance = Math.abs(targetLimit - position) - 0.1;
        if (!Number.isFinite(distance) || distance <= 0.1) throw new Error(`${axis} is already at its machine travel limit.`);
        if (jog.stopRequested) return;
        await machine.setBusy(true, `Continuous jog ${axis} ${sign > 0 ? '+' : '−'}`);
        busySet = true;
        const signedDistance = (sign * distance).toFixed(3);
        const command = `$J=G21 G91 ${axis}${signedDistance} F500`;
        jog.commandSent = true;
        await sendAndWait(command, 10000);
        setNotice(`Continuously jogging ${axis} ${sign > 0 ? '+' : '−'}. Release the button to stop.`);
        while (!jog.stopRequested) await pause(40);
        await machine.command('gcode', '[\\x85]');
        jog.cancelSent = true;
        await logCalibration(`Continuous jog cancelled by release: ${axis} ${sign > 0 ? '+' : '−'}.`);
        await waitIdle();
        await sendAndWait('G90');
        setNotice('Continuous jog stopped. Probe the selected WPOS origin again before calibration.', 'success');
    } catch (error) {
        if (jog.commandSent && !jog.cancelSent) {
            try {
                await machine.command('gcode', '[\\x85]');
                jog.cancelSent = true;
                await waitIdle();
            } catch { /* preserve the motion error for the operator */ }
        }
        setNotice(error.message, 'error');
    } finally {
        state.continuousJog = null;
        state.busy = false;
        if (busySet) try { await machine.setBusy(false); } catch { /* machine disconnected during cleanup */ }
        await refreshUi();
    }
}

function requestContinuousJogStop(event = null) {
    const jog = state.continuousJog;
    if (!jog) return;
    if (jog.pointerId !== null && event?.pointerId !== undefined && event.pointerId !== jog.pointerId) return;
    if (jog.key && event?.key && event.key !== jog.key) return;
    jog.stopRequested = true;
}

async function probeWposOrigin() {
    if (state.busy || !state.controllerHomed) return;
    state.wposOrigin = null;
    state.probedOrigin = null;
    state.origin = null;
    const settings = currentSettings();
    state.busy = true;
    await refreshUi();
    setNotice('Checking the origin position and probe travel…');
    try {
        const initial = await statusSnapshot();
        if (initial.state !== 'Idle') throw new Error(`Probe WPOS origin requires an idle machine (current state: ${initial.state}).`);
        if (!await showProbeSignalDialog()) throw new Error('WPOS origin probe canceled before motion.');
        const limits = await readTravelLimits();
        validateSettings(settings, limits);
        await logCalibration('WPOS origin probe method=' + settings.probeMode + (settings.probeMode === 'fast' ? ' (single fast touch).' : ' (fast touch plus slow repeat).'));
        if (initial.mpos[2] < limits.minZ || initial.mpos[2] > limits.maxZPosition) {
            throw new Error(`Current machine Z${initial.mpos[2].toFixed(3)} is outside the reported Z travel ${limits.minZ}..${limits.maxZPosition} mm.`);
        }
        validateMachineTarget({ x: initial.mpos[0], y: initial.mpos[1] }, limits);
        const activeWcs = await readActiveWcs();
        if (activeWcs !== 'G54') throw new Error(`Select G54 in gSender before probing the WPOS origin. The active coordinate system is ${activeWcs}; map compensation uses G54.`);
        const corner = selectedWposOrigin();
        if (settings.surfaceType === 'conductive') {
            await confirmUser('Attach the conductive probe clip to the material and keep it connected during the calibration. The probe will touch the selected WPOS origin, set G54 X0 Y0 Z0, then retract to the configured Full Retract Height.', 'Prepare conductive probe', 'Clip is attached');
        } else if (settings.surfaceType === 'puck') {
            await confirmUser('Place the probe puck at the selected work-origin point. The probe will touch it, set G54 X0 Y0 Z0, then retract. The puck thickness is applied to map readings.', 'Place probe puck at origin', 'Puck is in place');
        }
        const ready = await statusSnapshot();
        if (ready.state !== 'Idle' || ready.mpos.some((value, index) => Math.abs(value - initial.mpos[index]) > 0.05)) {
            throw new Error('Machine position changed while preparing the origin probe. Return to the selected origin and try again.');
        }
        const retractDirection = limits.zHomePositive ? 1 : -1;
        const homeZLimit = limits.zHomePositive ? limits.maxZPosition : limits.minZ;
        const requestedProbeStartMachineZ = ready.mpos[2] + retractDirection * settings.fullRetract;
        const probeStartMachineZ = round(limits.zHomePositive
            ? Math.min(requestedProbeStartMachineZ, homeZLimit)
            : Math.max(requestedProbeStartMachineZ, homeZLimit));
        if (probeStartMachineZ < limits.minZ || probeStartMachineZ > limits.maxZPosition) {
            throw new Error(`Cannot back Z off by the configured Full Retract Height (${settings.fullRetract.toFixed(3)} mm) before probing: machine Z${probeStartMachineZ.toFixed(3)} would be outside travel ${limits.minZ}..${limits.maxZPosition} mm. Jog Z farther from its home end, then try again.`);
        }
        await machine.setBusy(true, 'Probe WPOS origin and set G54 zero');
        const actualBackoff = Math.abs(probeStartMachineZ - ready.mpos[2]);
        await logCalibration(`WPOS origin pre-probe back-off: machine Z${ready.mpos[2].toFixed(3)} to Z${probeStartMachineZ.toFixed(3)} (${actualBackoff.toFixed(3)} mm toward the Z home end${actualBackoff + 0.001 < settings.fullRetract ? '; limited by the homed Z travel boundary' : ''}).`);
        if (actualBackoff > 0.001) await sendAndWait(`G90 G53 G0 Z${probeStartMachineZ.toFixed(3)}`);
        const backedOff = actualBackoff > 0.001 ? await waitIdle() : ready;
        if (backedOff.mpos.slice(0, 2).some((value, index) => Math.abs(value - ready.mpos[index]) > 0.05)
            || Math.abs(backedOff.mpos[2] - probeStartMachineZ) > 0.1) {
            throw new Error('Machine did not reach the expected safe Z height before the WPOS origin probe.');
        }
        const pointLabel = `${corner.replace('-', ' ')} WPOS origin`;
        const slowProbe = await probeWithOneRetry(settings, { x: backedOff.mpos[0], y: backedOff.mpos[1] }, `WPOS origin (${pointLabel})`, limits, backedOff.mpos[2]);
        await sendAndWait('G90');
        // G10 L20 sets zero from the controller's stopped position. Use that
        // same reported MPos as the retract baseline; the PRB trigger report
        // can differ slightly from the final stopped position on some boards.
        const stoppedAtContact = await waitIdle();
        if (stoppedAtContact.state !== 'Idle'
            || stoppedAtContact.mpos.slice(0, 2).some((value, index) => Math.abs(value - slowProbe[['x', 'y'][index]]) > 0.1)) {
            throw new Error('Could not confirm the stopped machine position after the WPOS origin probe.');
        }
        const contact = { x: stoppedAtContact.mpos[0], y: stoppedAtContact.mpos[1], z: stoppedAtContact.mpos[2] };
        const probeReportDelta = contact.z - slowProbe.z;
        if (Math.abs(probeReportDelta) > 0.05) {
            await logCalibration(`WPOS origin probe report Z${slowProbe.z.toFixed(3)} differs from stopped MPos Z${contact.z.toFixed(3)} by ${probeReportDelta.toFixed(3)} mm; using stopped MPos for G54 touch-off and retract.`);
        }
        const fullRetractMachineZ = round(contact.z + settings.fullRetract);
        validateSettings(settings, limits, contact.z);
        await logCalibration(`WPOS origin touch: corner=${corner}; contact machine X${contact.x.toFixed(3)} Y${contact.y.toFixed(3)} Z${contact.z.toFixed(3)}; fixed short retract=${SHORT_RETRACT_MM} mm; full retract target machine Z${fullRetractMachineZ.toFixed(3)}.`);
        await sendAndWait('G21 G90 G10 L20 P1 X0 Y0 Z0');
        await waitIdle();
        await sendAndWait(`G90 G53 G0 Z${fullRetractMachineZ.toFixed(3)}`);
        await waitIdle();
        let originStatus = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            originStatus = await controllerSnapshot();
            if (originStatus.state === 'Alarm') throw new Error('Controller entered Alarm state while setting WPOS zero. Resolve the alarm in gSender before continuing.');
            if (originStatus.state === 'Idle' && originStatus.wpos?.length >= 3
                && originStatus.wpos.slice(0, 3).every(Number.isFinite)
                && originStatus.wpos.slice(0, 2).every((value) => Math.abs(value) <= 0.05)
                && Math.abs(originStatus.wpos[2] - settings.fullRetract) <= 0.1
                && originStatus.mpos.slice(0, 2).every((value, index) => Math.abs(value - [contact.x, contact.y][index]) <= 0.05)
                && Math.abs(originStatus.mpos[2] - fullRetractMachineZ) <= 0.1) break;
            await pause(250);
        }
        const expectedOriginMpos = [contact.x, contact.y, fullRetractMachineZ];
        const expectedOriginWpos = [0, 0, settings.fullRetract];
        const formatPosition = (position) => position?.map((value) => Number.isFinite(value) ? Number(value).toFixed(3) : 'invalid').join(', ') ?? 'unavailable';
        await logCalibration(`WPOS origin retract verification: state=${originStatus?.state ?? 'unavailable'}; probe mode=${settings.probeMode}; expected WPOS=${formatPosition(expectedOriginWpos)}; reported WPOS=${formatPosition(originStatus?.wpos)}; expected MPos=${formatPosition(expectedOriginMpos)}; reported MPos=${formatPosition(originStatus?.mpos)}; tolerance WPOS XY/Z=0.050/0.100 mm, MPos XY/Z=0.050/0.100 mm.`);
        if (!originStatus || originStatus.state !== 'Idle' || !originStatus.wpos || originStatus.wpos.length < 3
            || !originStatus.wpos.slice(0, 3).every(Number.isFinite)
            || originStatus.wpos.slice(0, 2).some((value) => Math.abs(value) > 0.05)
            || Math.abs(originStatus.wpos[2] - settings.fullRetract) > 0.1
            || originStatus.mpos.slice(0, 2).some((value, index) => Math.abs(value - [contact.x, contact.y][index]) > 0.05)
            || Math.abs(originStatus.mpos[2] - fullRetractMachineZ) > 0.1) {
            throw new Error(`Controller did not confirm G54 origin and retract. State ${originStatus?.state ?? 'unavailable'}; expected WPOS ${formatPosition(expectedOriginWpos)}, reported ${formatPosition(originStatus?.wpos)}; expected MPos ${formatPosition(expectedOriginMpos)}, reported ${formatPosition(originStatus?.mpos)}.`);
        }
        state.wposOrigin = {
            corner,
            mpos: originStatus.mpos.slice(0, 3).map(round),
            surfaceMachineZ: round(contact.z),
            wposZ: round(originStatus.wpos[2]),
        };
        state.probedOrigin = structuredClone(state.wposOrigin);
        state.origin = null;
        setNotice(`Origin probed and G54 set to WPOS X0 Y0 Z0. Z retracted to WPOS +${settings.fullRetract.toFixed(2)} mm. Calibration is ready.`, 'success');
        await logCalibration(`WPOS origin set and verified at machine X${contact.x.toFixed(3)} Y${contact.y.toFixed(3)} Z${contact.z.toFixed(3)}; now safely retracted to WPOS Z${originStatus.wpos[2].toFixed(3)}.`);
    } catch (error) {
        renderProbeSignalStatus(error.message);
        await logCalibration(`WPOS ORIGIN ERROR: ${error.message}`);
        setNotice(error.message, 'error');
    } finally {
        state.busy = false;
        try { await machine.setBusy(false); } catch { /* connection may have closed */ }
        await refreshUi();
    }
}

async function goToWposOrigin() {
    if (state.busy || !state.controllerHomed || !state.probedOrigin) return;
    state.busy = true;
    await refreshUi();
    setNotice('Returning to the probed WPOS origin…');
    try {
        const initial = await statusSnapshot();
        if (initial.state !== 'Idle') throw new Error(`Returning to the origin requires an idle machine (current state: ${initial.state}).`);
        const limits = await readTravelLimits();
        const target = state.probedOrigin;
        const targetXY = validateMachineTarget({ x: target.mpos[0], y: target.mpos[1] }, limits);
        const zDirection = limits.zHomePositive ? 1 : -1;
        const retractZ = round(target.surfaceMachineZ + zDirection * n('fullRetract'));
        if (retractZ < limits.minZ || retractZ > limits.maxZPosition) {
            throw new Error(`Full Retract Height puts the probed origin at machine Z${retractZ.toFixed(3)}, outside Z travel ${limits.minZ}..${limits.maxZPosition} mm.`);
        }
        const currentClearance = (initial.mpos[2] - target.surfaceMachineZ) * zDirection;
        await machine.setBusy(true, 'Return to probed WPOS origin');
        if (currentClearance < n('fullRetract') - 0.05) {
            await sendAndWait(`G90 G53 G0 Z${retractZ.toFixed(3)}`);
            await waitIdle();
        }
        await moveXYWithProbeGuard(`G90 G53 G0 X${targetXY.x.toFixed(3)} Y${targetXY.y.toFixed(3)}`, 'back to the probed WPOS origin');
        const arrived = await statusSnapshot();
        if (arrived.mpos.slice(0, 2).some((value, index) => Math.abs(value - [targetXY.x, targetXY.y][index]) > 0.1)) {
            throw new Error('Controller did not confirm arrival at the probed WPOS origin.');
        }
        setNotice(`Returned to the probed WPOS origin at machine X${targetXY.x.toFixed(3)} Y${targetXY.y.toFixed(3)}.`, 'success');
    } catch (error) {
        await logCalibration(`GO TO ORIGIN ERROR: ${error.message}`);
        setNotice(error.message, 'error');
    } finally {
        state.busy = false;
        try { await machine.setBusy(false); } catch { /* connection may have closed */ }
        await refreshUi();
    }
}

async function calibrate() {
    if (state.busy) return;
    if (!Number.isFinite(state.homeMachineZ)) {
        setNotice('Home machine using the plugin before starting calibration.', 'error');
        return;
    }
    if (!state.wposOrigin) {
        setNotice('Jog to the selected work origin and use Probe WPOS origin before starting calibration.', 'error');
        return;
    }
    state.busy = true; state.stopRequested = false; $('progress').hidden = false; $('progress').value = 0;
    state.origin = null;
    await refreshUi(); setNotice('Checking the start position, controller travel, and calibration settings…');
    try {
        await logCalibration('--- Calibration started ---');
        const initialStatus = await statusSnapshot();
        if (initialStatus.state !== 'Idle') throw new Error(`Machine must be idle before calibration (current state: ${initialStatus.state}).`);
        const wpos = initialStatus.wpos;
        if (!wpos || wpos.length < 3 || !wpos.slice(0, 3).every(Number.isFinite)) {
            throw new Error('Could not read the current WPOS. Wait for a gSender position update and try again.');
        }
        if (Math.abs(wpos[0]) > 0.05 || Math.abs(wpos[1]) > 0.05 || Math.abs(wpos[2] - state.wposOrigin.wposZ) > 0.1) {
            throw new Error('The machine moved after WPOS origin probing. Return to the selected origin, jog Z to a safe height if needed, and probe the origin again.');
        }
        if (initialStatus.mpos.slice(0, 3).some((value, index) => Math.abs(value - state.wposOrigin.mpos[index]) > 0.05)) {
            invalidateWposOrigin('Machine position changed after the WPOS touch-off. Probe the selected origin again.');
            throw new Error('Machine position changed after the WPOS touch-off. Probe the selected origin again.');
        }
        const settings = currentSettings();
        const limits = await readTravelLimits();
        const wposMachine = { x: round(state.wposOrigin.mpos[0]), y: round(state.wposOrigin.mpos[1]) };
        const gridOrigin = mapFrontLeftFromWposOrigin(wposMachine, state.wposOrigin.corner, settings.lengthX, settings.lengthY);
        const retractMachineZ = round(state.wposOrigin.surfaceMachineZ + settings.fullRetract);
        await logCalibration(`Settings: $23=${limits.homingMask}; $132 max Z travel=${limits.maxZ} mm; probe method=${settings.probeMode}; selected WPOS origin=${state.wposOrigin.corner} at machine X${wposMachine.x.toFixed(3)} Y${wposMachine.y.toFixed(3)}; map front-left X${gridOrigin.x.toFixed(3)} Y${gridOrigin.y.toFixed(3)}; scan front-left to back-right (+WPOS X/+WPOS Y); machine travel X=${limits.minX}..${limits.maxX}, Y=${limits.minY}..${limits.maxY}; Full Retract WPOS Z+${settings.fullRetract.toFixed(3)} / machine Z${retractMachineZ.toFixed(3)}; short retract=${SHORT_RETRACT_MM} mm; fast probe travel is calculated from available Z travel per point.`);
        validateSettings(settings, limits, state.wposOrigin.surfaceMachineZ);
        if (initialStatus.mpos[2] < limits.minZ - 0.1 || initialStatus.mpos[2] > limits.maxZPosition + 0.1) throw new Error(`Current machine Z${initialStatus.mpos[2].toFixed(3)} is outside the reported Z travel ${limits.minZ}..${limits.maxZPosition} mm.`);
        const grid = validateMap({ originX: gridOrigin.x, originY: gridOrigin.y, lengthX: settings.lengthX, lengthY: settings.lengthY, pointsX: settings.pointsX, pointsY: settings.pointsY, directionX: 1, directionY: 1 }, limits);
        if (settings.surfaceType === 'conductive') {
            await confirmUser(`The machine will scan the complete grid from the material front-left to back-right. It will retract to WPOS Z+${settings.fullRetract.toFixed(2)} mm (machine Z${retractMachineZ.toFixed(3)}) before XY travel. Attach the probe clip and keep clear of the machine.`, 'Prepare conductive probe', 'Clip is attached');
        }
        const readyStatus = await statusSnapshot();
        if (readyStatus.state !== 'Idle') throw new Error(`Machine must be idle before calibration (current state: ${readyStatus.state}).`);
        if (!readyStatus.wpos || !readyStatus.wpos.slice(0, 3).every(Number.isFinite)
            || Math.abs(readyStatus.wpos[0]) > 0.05 || Math.abs(readyStatus.wpos[1]) > 0.05
            || readyStatus.mpos.slice(0, 3).some((value, index) => Math.abs(value - initialStatus.mpos[index]) > 0.05)) {
            throw new Error('Machine position changed after origin preflight. Probe the selected WPOS origin again before restarting calibration.');
        }
        await machine.setBusy(true, 'Retract to safe height and calibrate surface');
        setNotice(`Retracting to WPOS Z+${settings.fullRetract.toFixed(2)} mm, then moving to the map front-left…`);
        await sendAndWait(`G90 G53 G0 Z${retractMachineZ.toFixed(3)}`);
        await waitIdle();
        await moveXYWithProbeGuard(`G90 G53 G0 X${gridOrigin.x.toFixed(3)} Y${gridOrigin.y.toFixed(3)}`, 'to the map front-left');
        state.origin = gridOrigin;
        await refreshUi();
        const flat = grid.flat();
        const measured = Array.from({ length: settings.pointsY }, () => Array(settings.pointsX));
        for (let index = 0; index < flat.length; index += 1) {
            if (state.stopRequested) break;
            const point = flat[index];
            const nextPoint = flat[index + 1];
            const directionNote = index === 0
                ? ` Scanning front-left to back-right; $23=${limits.homingMask} is used for machine travel limits. Next machine point ${nextPoint ? `X${nextPoint.x.toFixed(3)} Y${nextPoint.y.toFixed(3)}` : 'none'}.`
                : '';
            if (index === 0) await logCalibration(`Grid first points: ${flat.slice(0, 4).map((p, i) => `${i + 1}=X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`).join('; ')}`);
            setNotice(`Moving to map point ${index + 1}/${flat.length}: X${point.x.toFixed(3)} Y${point.y.toFixed(3)}.${directionNote} Keep hands clear.`);
            if (state.stopRequested) break;
            await moveXYWithProbeGuard(`G90 G53 G0 X${point.x.toFixed(3)} Y${point.y.toFixed(3)}`, `to point ${index + 1}/${flat.length}`);
            const pointStart = await statusSnapshot();
            if (state.stopRequested) break;
            if (settings.surfaceType === 'puck') await promptPuck(point, index, flat.length);
            if (state.stopRequested) break;
            const probe = await probeAt(settings, point, index, flat.length, limits, pointStart.mpos[2]);
            if (retractMachineZ < probe.machineZ - 0.1) throw new Error(`Probe contact at point ${index + 1} reached machine Z${probe.machineZ.toFixed(3)}, above the configured Full Retract target Z${retractMachineZ.toFixed(3)}. Increase Full Retract Height before calibration.`);
            setNotice(`Probe complete at point ${index + 1}/${flat.length} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)}). Retracting to WPOS Z+${settings.fullRetract.toFixed(2)} mm…`);
            await sendAndWait(`G90 G53 G0 Z${retractMachineZ.toFixed(3)}`);
            await waitIdle();
            setNotice(`Point ${index + 1}/${flat.length} saved. Retract complete; moving to the next point…`);
            measured[point.iy][point.ix] = round(probe.z);
            $('progress').value = (index + 1) / flat.length;
        }
        if (state.stopRequested) throw new Error('Calibration stopped at a point boundary. Partial measurements were discarded; the previous saved map remains available.');
        if (measured.flat().some((value) => !Number.isFinite(value))) throw new Error('Calibration ended with missing measurements; no new map was saved.');
        if (settings.parkMode === 'machine-zero') {
            setNotice('All probe points measured. Raising to machine Z0, then parking at machine X0 Y0…');
            await sendAndWait('G90 G53 G0 Z0');
            await waitIdle();
            await moveXYWithProbeGuard('G90 G53 G0 X0 Y0', 'to machine X0 Y0');
        } else {
            const destination = settings.parkMode === 'wpos-origin' ? 'WPOS X0 Y0' : `machine X${settings.parkX.toFixed(3)} Y${settings.parkY.toFixed(3)}`;
            setNotice(`All probe points measured. Retracting to WPOS Z+${settings.fullRetract.toFixed(2)} mm, then parking at ${destination}…`);
            await sendAndWait(`G90 G53 G0 Z${retractMachineZ.toFixed(3)}`);
            await waitIdle();
            const parkMove = settings.parkMode === 'wpos-origin'
                ? 'G54 G90 G0 X0 Y0'
                : `G90 G53 G0 X${settings.parkX.toFixed(3)} Y${settings.parkY.toFixed(3)}`;
            await moveXYWithProbeGuard(parkMove, `to ${destination}`);
        }
        const baselineZ = round(state.wposOrigin.surfaceMachineZ - (settings.surfaceType === 'puck' ? settings.puckThickness : 0));
        const fullTravelMap = extendMapToMachineTravel(grid, measured, limits, baselineZ);
        state.map = {
            ...fullTravelMap,
            probeStart: { x: round(grid[0][0].x), y: round(grid[0][0].y) },
            measuredSurface: {
                x: grid[0].map((point) => round(point.x)),
                y: grid.map((row) => round(row[0].y)),
                z: measured.map((row) => row.slice()),
            },
            wposOriginCorner: state.wposOrigin.corner,
            wposOriginMachineX: wposMachine.x, wposOriginMachineY: wposMachine.y,
            surfaceType: settings.surfaceType, puckThickness: settings.puckThickness,
            referenceZ: baselineZ, createdAt: new Date().toISOString(),
        };
        await logCalibration(`Extended map to machine XY travel X${limits.minX.toFixed(3)}..${limits.maxX.toFixed(3)}, Y${limits.minY.toFixed(3)}..${limits.maxY.toFixed(3)}. Unprobed strips extend the nearest measured edge row or column; corner regions extrapolate along 45-degree diagonals.`);
        await storage.set('heightMap', state.map);
        await storage.delete('stlExport');
        state.stlExport = null;
        renderStlExport();
        $('stlStatus').textContent = '';
        $('copyStlStatus').textContent = '';
        setNotice(`Calibration saved (${settings.pointsX * settings.pointsY} points).`, 'success');
    } catch (err) {
        await logCalibration(`CALIBRATION ERROR: ${err.message}`);
        setNotice(err.message, 'error');
    } finally {
        $('progress').hidden = true; state.busy = false; state.wposOrigin = null; state.origin = null;
        try { await machine.setBusy(false); } catch { /* machine disconnected during cleanup */ }
        await refreshUi();
    }
}

async function compensateFile() {
    if (!state.file || !state.map || state.busy) return;
    setApplyStatus('Preparing compensated copy…');
    try {
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error('Stop the machine and wait for Idle before aligning G54 for a file.');
        const modal = await machine.query('$G', { until: 'ok-or-error', timeout: 5000, maxLines: 20 });
        const modalLine = modal.lines.find((line) => /^\[GC:/i.test(line));
        const activeWcs = modalLine?.match(/(?:^|\s)(G5[4-9])(?:\s|\])/i)?.[1]?.toUpperCase();
        if (!activeWcs) throw new Error('Could not determine the active work coordinate system from $G.');
        const source = await state.file.text();
        const bounds = parseAbsoluteXYBounds(source);
        if (activeWcs !== 'G54') throw new Error(`Select G54 in gSender before applying the map. This workflow aligns G54 to the toolpath's minimum X/Y coordinates; the active coordinate system is ${activeWcs}.`);
        const offsets = await readCoordinateOffsets('G54');
        const oldG54 = offsets.G54;
        const g92 = offsets.G92;
        const targetG54 = computeG54ForMapOrigin({ x: state.map.originX, y: state.map.originY }, bounds, g92);
        const targetWorkOffset = { x: targetG54.x + g92[0], y: targetG54.y + g92[1] };
        const machineBounds = state.map.machineBounds ?? {
            minX: state.map.originX, maxX: state.map.originX + state.map.lengthX,
            minY: state.map.originY, maxY: state.map.originY + state.map.lengthY,
        };
        const toolpathMachineBounds = {
            minX: bounds.minX + targetWorkOffset.x, maxX: bounds.maxX + targetWorkOffset.x,
            minY: bounds.minY + targetWorkOffset.y, maxY: bounds.maxY + targetWorkOffset.y,
        };
        if (toolpathMachineBounds.minX < machineBounds.minX - 1e-6 || toolpathMachineBounds.maxX > machineBounds.maxX + 1e-6
            || toolpathMachineBounds.minY < machineBounds.minY - 1e-6 || toolpathMachineBounds.maxY > machineBounds.maxY + 1e-6) {
            throw new Error(`Toolpath extends beyond machine XY travel after alignment: X${toolpathMachineBounds.minX.toFixed(3)}..${toolpathMachineBounds.maxX.toFixed(3)} mm, Y${toolpathMachineBounds.minY.toFixed(3)}..${toolpathMachineBounds.maxY.toFixed(3)} mm. Machine coverage is X${machineBounds.minX.toFixed(3)}..${machineBounds.maxX.toFixed(3)} mm, Y${machineBounds.minY.toFixed(3)}..${machineBounds.maxY.toFixed(3)} mm.`);
        }
        // Preflight before updating the persistent controller offset, so invalid or
        // unsupported files cannot leave G54 changed without a usable output file.
        const compensated = compensateGcode(source, state.map, targetWorkOffset, 'G54', null);
        const output = [
            '(Retract to machine Z0 before positioning to the file start)',
            'G21 G90 G53 G0 Z0',
            appendMachineOriginReturn(compensated),
        ].join('\n');
        const offsetChanged = Math.abs(oldG54[0] - targetG54.x) > 0.0001 || Math.abs(oldG54[1] - targetG54.y) > 0.0001;
        if (offsetChanged) {
            const accepted = await confirmG54Alignment(bounds, oldG54, targetG54);
            if (!accepted) {
                setApplyStatus('Canceled. No compensated file was loaded.');
                return;
            }
            const command = `G21 G10 L2 P1 X${targetG54.x.toFixed(4)} Y${targetG54.y.toFixed(4)}`;
            await sendAndWait(command, 10000);
            const updated = await readCoordinateOffsets('G54');
            if (Math.abs(updated.G54[0] - targetG54.x) > 0.001 || Math.abs(updated.G54[1] - targetG54.y) > 0.001) {
                throw new Error(`Controller accepted the G54 update but readback did not match. Expected X${targetG54.x.toFixed(3)} Y${targetG54.y.toFixed(3)}; received X${updated.G54[0].toFixed(3)} Y${updated.G54[1].toFixed(3)}. No compensated file was loaded.`);
            }
        }
        const outputName = state.file.name.replace(/(\.[^.]+)?$/, '-heightmapped$1');
        await gcode.loadToVisualizer(output, outputName);
        if (typeof workspace.navigateToCarve !== 'function') {
            setApplyStatus(`Loaded “${outputName}”. This gSender build does not support automatic navigation; open Carve to review the copy.`, 'success');
            return;
        }
        setApplyStatus(`Loaded “${outputName}”. Returning to Carve…`, 'success');
        await pause(1200);
        try {
            await workspace.navigateToCarve();
        } catch (err) {
            setApplyStatus(`Loaded “${outputName}”, but automatic navigation to Carve failed: ${err.message}`, 'error');
        }
    } catch (err) { setApplyStatus(err.message, 'error'); }
}

async function start() {
    try {
        machine.onParsed('probe-motion-status', receiveProbeMotionStatus);
        calibrationLog = await storage.get(calibrationLogKey, []);
        $('calibrationLog').value = calibrationLog.join('\n');
        $('calibrationLog').scrollTop = $('calibrationLog').scrollHeight;
        populateSettings(await storage.get('settings', DEFAULTS));
        state.map = await storage.get('heightMap', null);
        state.stlExport = await storage.get('stlExport', null);
        renderStlExport();
        $('exaggeration').addEventListener('input', drawSurfaceMap);
        if (window.ResizeObserver) new ResizeObserver(drawSurfaceMap).observe($('surfaceCanvas'));
        for (const id of fields) $(id).addEventListener('change', saveSettings);
        $('parkMode').addEventListener('change', () => { updateParkFieldsVisibility(); saveSettings(); });
        for (const input of document.querySelectorAll('input[name="surfaceType"]')) input.addEventListener('change', () => {
            updatePuckThicknessVisibility();
            saveSettings();
        });
        for (const input of document.querySelectorAll('input[name="probeMode"]')) input.addEventListener('change', saveSettings);
        $('home').addEventListener('click', homeMachine);
        for (const [id, axis, sign] of [
            ['jogXMinus', 'X', -1], ['jogXPlus', 'X', 1], ['jogYMinus', 'Y', -1],
            ['jogYPlus', 'Y', 1], ['jogZMinus', 'Z', -1], ['jogZPlus', 'Z', 1],
        ]) {
            const button = $(id);
            button.addEventListener('click', (event) => {
                if ($('jogStep').value === 'continuous') { event.preventDefault(); return; }
                void jogMachine(axis, sign);
            });
            button.addEventListener('pointerdown', (event) => {
                if ($('jogStep').value !== 'continuous' || event.button !== 0) return;
                event.preventDefault();
                try { button.setPointerCapture(event.pointerId); } catch { /* window release listener remains as fallback */ }
                void startContinuousJog(axis, sign, event);
            });
            button.addEventListener('keydown', (event) => {
                if ($('jogStep').value !== 'continuous' || !['Enter', ' '].includes(event.key) || event.repeat) return;
                event.preventDefault();
                void startContinuousJog(axis, sign, event);
            });
            button.addEventListener('keyup', (event) => requestContinuousJogStop(event));
        }
        window.addEventListener('pointerup', requestContinuousJogStop, true);
        window.addEventListener('pointercancel', requestContinuousJogStop, true);
        window.addEventListener('blur', () => requestContinuousJogStop());
        document.addEventListener('visibilitychange', () => { if (document.hidden) requestContinuousJogStop(); });
        $('probeWpos').addEventListener('click', probeWposOrigin);
        $('gotoOrigin').addEventListener('click', goToWposOrigin);
        for (const input of document.querySelectorAll('input[name="wposOrigin"]')) input.addEventListener('change', async () => {
            invalidateWposOrigin('Work origin changed. Jog to the selected origin, then probe WPOS origin again.');
            await saveSettings();
            await refreshUi();
        });
        $('copyCalibrationLog').addEventListener('click', async () => {
            $('calibrationLog').focus(); $('calibrationLog').select();
            try { await navigator.clipboard.writeText($('calibrationLog').value); $('copyCalibrationLog').textContent = 'Copied'; setTimeout(() => $('copyCalibrationLog').textContent = 'Copy log', 1500); }
            catch { setNotice('Select the log text and copy it manually.', 'error'); }
        });
        $('calibrate').addEventListener('click', calibrate);
        $('resumeProbe').addEventListener('click', resumePausedCalibration);
        $('stop').addEventListener('click', () => { state.stopRequested = true; state.probeMovePause?.resumeResolve?.(false); state.abortPuck?.(); setNotice('Stop requested. The current controller move/probe will finish before calibration stops.'); });
        $('clearMap').addEventListener('click', async () => { state.map = null; state.stlExport = null; await storage.delete('heightMap'); await storage.delete('stlExport'); renderStlExport(); $('stlStatus').textContent = ''; await refreshUi(); setNotice('Saved height map and STL export deleted.', 'success'); });
        $('exportStl').addEventListener('click', exportSurfaceStl);
        $('copyStlText').addEventListener('click', copyStlText);
        $('file').addEventListener('change', (event) => {
            state.file = event.target.files?.[0] ?? null;
            $('fileLabel').textContent = state.file ? `${state.file.name} · ${(state.file.size / 1024).toFixed(1)} KB` : 'No file selected.';
            refreshUi();
        });
        $('compensate').addEventListener('click', compensateFile);
        $('coordinateMode').addEventListener('click', () => {
            state.positionMode = state.positionMode === 'wpos' ? 'mpos' : 'wpos';
            renderMachineDro();
        });
        machine.addListener('controller:state', (_type, controllerState) => {
            updateDroPositions(controllerState?.status);
            if (controllerState?.status?.activeState === 'Idle') state.probeMotionStatus = 'Idle';
            if (!state.busy && state.wposOrigin && controllerState?.status?.activeState === 'Idle') {
                const mpos = positionVector(controllerState.status.mpos);
                const wpos = positionVector(controllerState.status.wpos);
                if (!mpos || !wpos || mpos.some((value, index) => Math.abs(value - state.wposOrigin.mpos[index]) > 0.05)
                    || Math.abs(wpos[0]) > 0.05 || Math.abs(wpos[1]) > 0.05
                    || Math.abs(wpos[2] - state.wposOrigin.wposZ) > 0.1) {
                    invalidateWposOrigin('Machine position changed after WPOS touch-off. Jog to the selected origin and probe it again.');
                }
            }
            refreshUi();
            if (state.controllerHomed && !Number.isFinite(state.homeMachineZ)
                && controllerState?.status?.activeState === 'Idle') adoptControllerHoming(true);
        });
        machine.addListener('homing:has-homed', (hasHomed) => adoptControllerHoming(hasHomed));
        $('puckDialog').addEventListener('cancel', (event) => { event.preventDefault(); state.abortPuck?.(); });
        await refreshUi();
        try {
            const reduxState = await getReduxState();
            updateDroPositions(reduxState?.controller?.state?.status);
            await refreshUi();
            await adoptControllerHoming(Boolean(reduxState?.controller?.hasHomed));
        } catch (err) {
            setNotice(`Could not read gSender's existing homing state. Use Home machine in this plugin if needed. ${err.message}`, 'error');
        }
    } catch (err) { setNotice(`Plugin initialization failed: ${err.message}`, 'error'); }
}

start();
