import { getReduxState, gcode, machine, storage } from '@sienci/gsender-plugin-sdk';
import { DEFAULTS, appendMachineOriginReturn, compensateGcode, computePostProbeRetract, computeProjectMapOrigin, computeProjectMapSettings, makeContourProbePoints, makeStlExportRecord, mapCoversProjectBounds, parseAbsoluteXYBounds, parseClosedContours, parseProbePosition, parseTravelLimits, parseWorkOffsetLine, pointInPolygon, probePositionMatches, rebaseGcodeCoordinates, validateMap } from './heightmap.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const fields = ['lengthX', 'lengthY', 'pointsX', 'pointsY', 'clearanceZ', 'probeTravel', 'fastFeed', 'slowFeed', 'slowTravel', 'retract', 'puckThickness'];
const state = { origin: null, homeMachineZ: null, controllerHomed: false, adoptingHomedPosition: false, probeReportSequence: 0, probeWaiter: null, offsetParserSequence: 0, map: null, stlExport: null, file: null, project: null, analyzingProject: false, busy: false, stopRequested: false, abortPuck: null, calibrationReadings: [], calibrationReadingCount: 0 };
const setNotice = (message, kind = '') => { $('notice').textContent = message; $('notice').className = kind; };
const setApplyStatus = (message, kind = '') => { $('applyStatus').textContent = message; $('applyStatus').className = kind; };
const n = (id) => Number($(id).value);
const negativeMachineZ = (value) => {
    const z = Number(value);
    return Number.isFinite(z) && z > 0 ? -z : z;
};
const round = (v) => Number(v.toFixed(4));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function renderProbeReadings() {
    const body = $('probeReadingsBody');
    body.replaceChildren();
    if (!state.calibrationReadings.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.className = 'empty-readings';
        cell.textContent = 'No readings collected in this calibration yet.';
        row.append(cell);
        body.append(row);
        $('probeReadingCount').textContent = 'No readings yet';
        return;
    }

    const shown = state.calibrationReadings.length;
    const noun = state.calibrationReadingCount === 1 ? 'reading' : 'readings';
    $('probeReadingCount').textContent = `Showing ${shown} of ${state.calibrationReadingCount} ${noun}`;
    for (const reading of state.calibrationReadings) {
        const row = document.createElement('tr');
        for (const value of [reading.x, reading.y, reading.zAbs, reading.zOffset]) {
            const cell = document.createElement('td');
            cell.textContent = value.toFixed(3);
            row.append(cell);
        }
        body.append(row);
    }
}

function drawSurfaceMap() {
    const panel = $('mapVisual');
    const map = state.map;
    panel.hidden = !map;
    if (!map) return;
    const values = Array.isArray(map.samples) ? map.samples.map((sample) => sample.z) : map.z.flat();
    if (!values.length || values.some((value) => !Number.isFinite(value))) return;
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
    const color = (level) => {
        const stops = [[36, 91, 219], [25, 185, 165], [184, 214, 60], [245, 140, 50], [216, 56, 56]];
        const at = level * (stops.length - 1);
        const idx = Math.min(stops.length - 2, Math.floor(at));
        const t = at - idx;
        const rgb = stops[idx].map((channel, c) => Math.round(channel + (stops[idx + 1][c] - channel) * t));
        return `rgb(${rgb.join(',')})`;
    };
    if (Array.isArray(map.samples)) {
        const margin = 24;
        const px = (x) => margin + ((x - map.originX) / (map.lengthX * (map.directionX ?? 1))) * (width - margin * 2);
        const py = (y) => height - margin - ((y - map.originY) / (map.lengthY * (map.directionY ?? 1))) * (height - margin * 2);
        ctx.beginPath();
        map.contourMachine.forEach((point, index) => index ? ctx.lineTo(px(point.x), py(point.y)) : ctx.moveTo(px(point.x), py(point.y)));
        ctx.closePath();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
        for (const sample of map.samples) {
            const level = range > 0 ? (sample.z - min) / range : 0.5;
            ctx.beginPath();
            ctx.arc(px(sample.x), py(sample.y), sample.kind === 'perimeter' ? 2.6 : 2, 0, Math.PI * 2);
            ctx.fillStyle = color(level);
            ctx.fill();
        }
        return;
    }
    const nx = map.pointsX;
    const ny = map.pointsY;
    const span = Math.min(width * 0.40, height * 0.34);
    const lift = Math.min(height * 0.28, span * factor * 0.08);
    const points = map.z.map((row, iy) => row.map((z, ix) => {
        const u = ix / (nx - 1);
        const v = iy / (ny - 1);
        const level = range > 0 ? (z - min) / range : 0.5;
        return { x: width / 2 + (u - v) * span, y: height * 0.32 + (u + v) * span * 0.43 - level * lift, level };
    }));
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
    ctx.textAlign = 'center';
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.fillText('X', width / 2 + span + 14, height * 0.32 + span * 0.43);
    ctx.fillText('Y', width / 2 - span - 14, height * 0.32 + span * 0.43);
}

function currentSettings() {
    return {
        ...Object.fromEntries(fields.map((id) => [id, id === 'clearanceZ' ? negativeMachineZ(n(id)) : n(id)])),
        machineZeroX: n('machineZeroX'),
        machineZeroY: n('machineZeroY'),
        surfaceType: document.querySelector('input[name="surfaceType"]:checked').value,
        mapAlignment: $('mapAlignment').value,
    };
}

function populateSettings(saved = {}) {
    for (const id of fields) {
        const value = saved[id];
        const missingOrInvalid = value == null || value === '' || !Number.isFinite(Number(value));
        const invalidSlowTravel = id === 'slowTravel'
            && Number(value) <= Number(saved.retract ?? DEFAULTS.retract);
        const selectedValue = missingOrInvalid || invalidSlowTravel ? DEFAULTS[id] : value;
        $(id).value = String(id === 'clearanceZ' ? negativeMachineZ(selectedValue) : selectedValue);
    }
    const surfaceType = ['conductive', 'puck', 'switch'].includes(saved.surfaceType) ? saved.surfaceType : DEFAULTS.surfaceType;
    document.querySelector(`input[name="surfaceType"][value="${surfaceType}"]`).checked = true;
    $('mapAlignment').value = saved.mapAlignment === 'center' ? 'center' : 'zero';
    for (const id of ['machineZeroX', 'machineZeroY']) {
        const value = saved[id];
        $(id).value = String(value == null || value === '' || !Number.isFinite(Number(value)) ? 0 : value);
    }
    updatePuckThicknessVisibility();
}

function updatePuckThicknessVisibility() {
    $('puckThicknessField').hidden = document.querySelector('input[name="surfaceType"]:checked').value !== 'puck';
}

function updateWorkZeroVisibility() {
    $('machineZeroFields').hidden = $('workZeroMode').value !== 'machine';
}

function renderContourPreview() {
    const svg = $('contourPreview');
    const polygon = state.project?.contour;
    svg.hidden = !polygon?.length;
    if (!polygon?.length) return;
    const xs = polygon.map((point) => point.x), ys = polygon.map((point) => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min(280 / Math.max(maxX - minX, 0.001), 160 / Math.max(maxY - minY, 0.001));
    const offsetX = (320 - (maxX - minX) * scale) / 2;
    const offsetY = (200 - (maxY - minY) * scale) / 2;
    $('contourPreviewShape').setAttribute('points', polygon.map((point) => `${offsetX + (point.x - minX) * scale},${200 - offsetY - (point.y - minY) * scale}`).join(' '));
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

async function controllerSnapshot() {
    const reduxState = await getReduxState();
    if (!reduxState?.connection?.isConnected) throw new Error('Connect to the controller in gSender before continuing.');
    const status = reduxState?.controller?.state?.status;
    const mpos = positionVector(status?.mpos);
    if (!mpos || !mpos.every(Number.isFinite)) throw new Error('gSender has not reported a valid machine position yet. Wait for a controller status update and try again.');
    return { state: status.activeState ?? 'unknown', mpos, wpos: positionVector(status.wpos) };
}

async function statusSnapshot() {
    await pause(300);
    return controllerSnapshot();
}

async function waitIdle(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    await pause(150);
    while (Date.now() < until) {
        const snapshot = await statusSnapshot();
        if (snapshot.state === 'Idle') return snapshot;
        if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state. Resolve the alarm in gSender before continuing.');
        await pause(200);
    }
    throw new Error('Timed out waiting for the machine to become idle.');
}

async function sendAndWait(line, timeout = 30000) {
    const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 });
    if (!result.complete || result.error || !result.ok) {
        throw new Error(`Controller did not accept “${line}”: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
    }
    return result;
}

async function readTravelLimits() {
    let lastError = 'The controller did not return a complete settings response.';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = await machine.query('$$', { until: 'ok-or-error', timeout: 10000, maxLines: 350 });
        if (!result.complete || result.error || !result.ok) {
            lastError = result.error ?? result.reason ?? lastError;
        } else {
            try {
                const settingsLines = result.lines.map((line) => String(line));
                const homingMask = readHomingMask(settingsLines);
                if (homingMask === null) throw new Error('the $23 line was missing');
                const limits = parseTravelLimits(settingsLines);
                return { ...limits, homingMask, zHomePositive: (homingMask & 4) === 0 };
            } catch (error) {
                lastError = error.message;
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
        state.homeMachineZ = null;
        state.controllerHomed = false;
        state.origin = null;
    }
    const homed = connected && state.controllerHomed && Number.isFinite(state.homeMachineZ);
    $('connection').textContent = connected ? 'Connected' : 'Not connected';
    $('connection').dataset.connected = String(connected);
    $('home').disabled = !connected || !state.project || state.busy || state.analyzingProject;
    $('checkProject').disabled = !connected || !state.file || state.busy || state.analyzingProject;
    $('mapAlignment').disabled = state.busy || state.analyzingProject;
    $('calibrate').disabled = !homed || state.busy || !state.origin || !state.project;
    $('stop').disabled = !state.busy;
    $('compensate').disabled = !state.map || !mapCoversProject() || !state.file || state.busy || state.analyzingProject;
    $('clearMap').disabled = !state.map || state.busy;
    $('exportStl').disabled = !state.map || state.busy;
    $('originLabel').textContent = state.origin ? `Probe grid origin: machine X${state.origin.x.toFixed(3)} Y${state.origin.y.toFixed(3)}` : 'Derived from the imported file and alignment setting';
    $('homeLabel').textContent = homed ? `Machine already homed · safe Z${state.homeMachineZ.toFixed(3)}` : state.controllerHomed ? 'Machine homed · waiting for Idle position' : 'Machine not homed';
    $('mapSummary').textContent = state.map
        ? `${state.map.lengthX} × ${state.map.lengthY} mm · ${Array.isArray(state.map.samples) ? `contour map with ${state.map.samples.length} points` : `${state.map.pointsX} × ${state.map.pointsY} grid`} · captured at machine X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)} · ${new Date(state.map.createdAt).toLocaleString()}`
        : 'No height map saved.';
    $('fileLabelApply').textContent = state.file ? `${state.file.name} · ${(state.file.size / 1024).toFixed(1)} KB` : 'Import a G-code project above.';
    drawSurfaceMap();
}

async function adoptControllerHoming(hasHomed) {
    state.controllerHomed = Boolean(hasHomed);
    if (!state.controllerHomed) {
        state.homeMachineZ = null;
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
        state.origin = state.project ? { ...state.project.mapOrigin } : null;
        setNotice('Machine is already homed. Its current machine Z is the retract baseline; confirm it is clear and safe before moving.', 'success');
    } catch (err) {
        setNotice(`Machine is homed, but its current Z position could not be read: ${err.message}`, 'error');
    } finally {
        state.adoptingHomedPosition = false;
        await refreshUi();
    }
}

function mapCoversProject() {
    if (!state.project || !mapCoversProjectBounds(state.map, state.project.settings, state.project.limits)) return false;
    if (state.map?.contourMachine) {
        const contour = state.project.contour;
        if (contour) return contour.length === state.map.contourMachine.length && contour.every((point, index) => {
            const mapped = state.map.contourMachine[index];
            return Math.abs((point.x - state.project.bounds.minX) * (state.map.directionX ?? 1) - (mapped.x - state.map.originX)) < 0.05
                && Math.abs((point.y - state.project.bounds.minY) * (state.map.directionY ?? 1) - (mapped.y - state.map.originY)) < 0.05;
        });
        const b = state.project.bounds;
        const corners = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
        return corners.every((p) => pointInPolygon({ x: (p.x - b.minX) * (state.map.directionX ?? 1) + state.map.originX, y: (p.y - b.minY) * (state.map.directionY ?? 1) + state.map.originY }, state.map.contourMachine));
    }
    return true;
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

function receiveProbeReport(report) {
    const line = report.line ?? report.lines?.find((entry) => /^\s*\[PRB:/i.test(String(entry)));
    if (!line) return;
    state.probeReportSequence += 1;
    const waiter = state.probeWaiter;
    if (!waiter || state.probeReportSequence <= waiter.afterSequence || !probePositionMatches(line, waiter.expected)) return;
    try { waiter.resolve({ position: parseProbePosition(line) }); }
    catch (error) { waiter.resolve({ error }); }
}

async function queryProbe(line, timeout, stage, expected) {
    let resolveReport;
    const reportPromise = new Promise((resolve) => { resolveReport = resolve; });
    const waiter = { expected, afterSequence: state.probeReportSequence, resolve: resolveReport };
    state.probeWaiter = waiter;
    try {
        const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 });
        if (!result.complete || !result.ok || result.error) {
            throw new Error(`${stage} probe was not accepted. Controller response: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        }
        const reportLine = result.lines.map((entry) => String(entry).trim()).find((entry) => /^\[PRB:/i.test(entry) && probePositionMatches(entry, expected));
        if (reportLine) return readProbePosition({ lines: [reportLine] });

        setNotice(`${stage} probe was acknowledged. Waiting for its matching X/Y position report…`);
        let reportTimeout;
        const timeoutPromise = new Promise((_, reject) => {
            reportTimeout = setTimeout(() => reject(new Error(`The controller acknowledged the probe with “ok” but no matching [PRB:...] report arrived for X${expected.x.toFixed(3)} Y${expected.y.toFixed(3)}. Check the probe reporting stream and controller connection.`)), 10000);
        });
        let outcome;
        try {
            outcome = await Promise.race([reportPromise, timeoutPromise]);
        } catch (error) {
            const reduxState = await getReduxState().catch(() => null);
            const controllerStatus = reduxState?.controller?.state?.status;
            if (controllerStatus?.activeState === 'Alarm') {
                const code = controllerStatus.alarmCode == null ? '' : ` ${controllerStatus.alarmCode}`;
                throw new Error(`${stage} returned no [PRB:...] report and gSender reports Alarm${code}. Check the controller alarm before retrying.`);
            }
            const machinePosition = positionVector(controllerStatus?.mpos);
            if (controllerStatus?.activeState === 'Idle' && machinePosition?.every(Number.isFinite)) {
                setNotice(`${stage} completed, but its [PRB:...] report was not delivered. Using gSender's stopped machine position.`);
                return { x: machinePosition[0], y: machinePosition[1], z: machinePosition[2] };
            }
            if (controllerStatus?.activeState && controllerStatus.activeState !== 'Idle') {
                throw new Error(`${stage} returned no [PRB:...] position; gSender still reports ${controllerStatus.activeState}. Wait for Idle and check the controller before retrying.`);
            }
            throw error;
        } finally {
            clearTimeout(reportTimeout);
        }
        if (outcome.error) throw outcome.error;
        if (!outcome.position) throw new Error(`${stage} probe report did not contain a valid position.`);
        return outcome.position;
    } finally {
        if (state.probeWaiter === waiter) state.probeWaiter = null;
    }
}

function safeProbeTravel(distance, stage, pointLabel, currentZ, limits) {
    const zMinimum = limits.zHomePositive ? -limits.maxZ : 0;
    if (!Number.isFinite(currentZ)) throw new Error(`Could not read the current machine Z before ${stage.toLowerCase()} at ${pointLabel}.`);
    const available = currentZ - zMinimum - 0.1;
    if (!Number.isFinite(available) || available <= 0.1) throw new Error(`${stage} at ${pointLabel} has no safe downward Z travel remaining before the machine Z limit (${zMinimum.toFixed(3)} mm). Move to a higher safe Z before calibration.`);
    return Math.floor(Math.min(distance, available) * 1000) / 1000;
}

async function probeAt(settings, point, index, total, limits, startingZ) {
    const pointLabel = `point ${index + 1}/${total} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)})`;
    const fastTravel = safeProbeTravel(settings.probeTravel, 'Fast probe', pointLabel, startingZ, limits);
    setNotice(fastTravel < settings.probeTravel
        ? `Fast probe at ${pointLabel}: limiting travel to ${fastTravel.toFixed(3)} mm to stay inside Z travel. Keep hands clear.`
        : `Fast probe on ${pointLabel}… keep hands clear.`);
    const fastProbe = await queryProbe(`G91 G38.2 Z-${fastTravel} F${settings.fastFeed}`, 45000, `Fast probe on ${pointLabel}`, point);
    const interimRetract = computePostProbeRetract(fastProbe.z, state.homeMachineZ, settings.retract);
    setNotice(`Fast contact found on ${pointLabel}. Retracting ${interimRetract.toFixed(3)} mm before the slow touch…`);
    await sendAndWait(`G91 G0 Z${interimRetract}`);
    const slowStart = await waitIdle();
    const slowTravel = safeProbeTravel(settings.slowTravel, 'Slow probe', pointLabel, slowStart.mpos[2], limits);
    setNotice(slowTravel < settings.slowTravel
        ? `Slow probe at ${pointLabel}: limiting travel to ${slowTravel.toFixed(3)} mm to stay inside Z travel.`
        : `Slow probe on ${pointLabel}…`);
    await queryProbe(`G91 G38.2 Z-${slowTravel} F${settings.slowFeed}`, 30000, `Slow probe on ${pointLabel}`, point);
    setNotice(`Slow probe contact registered on ${pointLabel}. Reading the stopped Z position…`);
    const status = await statusSnapshot();
    return {
        z: status.mpos[2] - (settings.surfaceType === 'puck' ? settings.puckThickness : 0),
        machineZ: status.mpos[2],
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
    $('alignPrompt').textContent = `This will save G54 X/Y to ${targetG54.x.toFixed(3)}, ${targetG54.y.toFixed(3)} mm for the selected work-zero method. The saved offsets affect other G54 jobs until changed again. Current G54 is X${oldG54[0].toFixed(3)} Y${oldG54[1].toFixed(3)}.`;
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

function confirmRectangleFallback() {
    const dialog = $('rectangleFallbackDialog');
    dialog.showModal();
    return new Promise((resolve) => {
        const finish = (accepted) => {
            dialog.close();
            dialog.oncancel = null;
            resolve(accepted);
        };
        $('useRectangleFallback').onclick = () => finish(true);
        $('cancelRectangleFallback').onclick = () => finish(false);
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    });
}

function validateSettings(s, limits) {
    for (const id of fields) if (!Number.isFinite(s[id])) throw new Error(`Enter a valid number for ${id}.`);
    if (s.clearanceZ < limits.minZ || s.clearanceZ > limits.maxZPosition) throw new Error(`Safe Z clearance must be between machine Z${limits.minZ} and Z${limits.maxZPosition} mm.`);
    if (s.probeTravel <= 0 || s.probeTravel > limits.maxZ) throw new Error(`Probe travel must be greater than zero and no more than the Z travel limit ${limits.maxZ} mm.`);
    if (s.slowTravel <= s.retract) throw new Error('Slow probe travel must be greater than the retract distance.');
    if (s.fastFeed <= 0 || s.slowFeed <= 0 || s.retract <= 0) throw new Error('Feeds and retract must be greater than zero.');
    if (s.puckThickness < 0) throw new Error('Probe puck thickness cannot be negative.');
    if (!['conductive', 'puck', 'switch'].includes(s.surfaceType)) throw new Error('Choose Conductive, Puck, or Switch as the probe type.');
}

async function homeMachine() {
    if (state.busy) return;
    if (!state.project) {
        setNotice('Import and validate the G-code project before homing for its map.', 'error');
        return;
    }
    state.homeMachineZ = null;
    state.controllerHomed = false;
    state.origin = null;
    state.busy = true; await refreshUi(); setNotice('Homing… keep clear of the machine.');
    try {
        const result = await machine.query('$H', { until: 'ok-or-error', timeout: 120000, maxLines: 80 });
        if (!result.complete || !result.ok || result.error) throw new Error(`Homing failed: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        const homeStatus = await waitIdle(30000);
        state.homeMachineZ = round(homeStatus.mpos[2]);
        if (Math.abs(homeStatus.mpos[0]) > 0.1 || Math.abs(homeStatus.mpos[1]) > 0.1) {
            throw new Error(`Homing finished at machine X${homeStatus.mpos[0].toFixed(3)} Y${homeStatus.mpos[1].toFixed(3)}; this workflow requires machine X0 Y0 at home before using it as the map origin.`);
        }
        state.controllerHomed = true;
        state.origin = { ...state.project.mapOrigin };
        await refreshUi();
        setNotice(`Homing complete. The probe grid is ready at its ${state.project.mapAlignment === 'center' ? 'centered' : 'machine-zero'} origin X${state.origin.x.toFixed(3)} Y${state.origin.y.toFixed(3)}.`, 'success');
    } catch (err) { setNotice(err.message, 'error'); }
    finally { state.busy = false; await refreshUi(); }
}

async function analyzeProjectFile(file = state.file) {
    if (state.busy || state.analyzingProject) return;
    if (!file) {
        state.file = null;
        state.project = null;
        renderContourPreview();
        state.origin = null;
        $('fileLabel').textContent = 'No project selected.';
        $('projectSummary').textContent = '';
        $('projectStatus').textContent = 'Import a G-code project to calculate its map area.';
        $('projectStatus').className = '';
        setApplyStatus('');
        await refreshUi();
        return;
    }
    state.file = file;
    state.project = null;
    state.origin = null;
    state.analyzingProject = true;
    setApplyStatus('');
    $('projectStatus').className = '';
    $('projectStatus').textContent = 'Reading project bounds and CNC travel limits…';
    $('projectSummary').textContent = '';
    $('fileLabel').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    for (const id of ['lengthX', 'lengthY', 'pointsX', 'pointsY']) $(id).value = '';
    await refreshUi();
    try {
        const source = await file.text();
        const bounds = parseAbsoluteXYBounds(source);
        const contours = parseClosedContours(source);
        let contour = contours[0] ?? null;
        let mappingMode = 'contour';
        if (!contour) {
            const useRectangle = await confirmRectangleFallback();
            if (!useRectangle) {
                const message = 'Analysis canceled. Choose rectangle mapping to use this file’s minimum and maximum X/Y points.';
                state.project = null;
                $('projectStatus').textContent = message;
                $('projectStatus').className = '';
                setNotice(message);
                return;
            }
            mappingMode = 'rectangle';
        }
        const context = await machine.getContext();
        if (!context?.connected) throw new Error('Connect to the CNC in gSender, then click “Check project and machine limits” to read $130/$131/$132.');
        const limits = await readTravelLimits();
        const settings = computeProjectMapSettings(bounds, limits);
        const mapOrigin = computeProjectMapOrigin(settings, limits, $('mapAlignment').value);
        $('fileZeroX').value = bounds.minX.toFixed(3);
        $('fileZeroY').value = bounds.minY.toFixed(3);
        $('machineZeroX').value = mapOrigin.x.toFixed(3);
        $('machineZeroY').value = mapOrigin.y.toFixed(3);
        state.project = { bounds, limits, settings, mapOrigin, mapAlignment: $('mapAlignment').value, contour, mappingMode };
        state.origin = state.controllerHomed && Number.isFinite(state.homeMachineZ) ? { ...mapOrigin } : null;
        renderContourPreview();
        if (contour) {
            state.project.probePoints = makeContourProbePoints({ polygon: contour, bounds, originX: mapOrigin.x, originY: mapOrigin.y, pointsX: settings.pointsX, pointsY: settings.pointsY, directionX: limits.directionX, directionY: limits.directionY });
            state.project.contourMachine = contour.map((point) => ({ x: mapOrigin.x + limits.directionX * (point.x - bounds.minX), y: mapOrigin.y + limits.directionY * (point.y - bounds.minY) }));
        }
        for (const id of ['lengthX', 'lengthY', 'pointsX', 'pointsY']) $(id).value = String(settings[id]);
        await storage.set('settings', currentSettings());
        const pitchX = settings.lengthX / (settings.pointsX - 1);
        const pitchY = settings.lengthY / (settings.pointsY - 1);
        const alignmentSummary = state.project.mapAlignment === 'center'
            ? `center at machine X${((limits.directionX * limits.maxX) / 2).toFixed(3)} Y${((limits.directionY * limits.maxY) / 2).toFixed(3)} with ±${(settings.lengthX / 2).toFixed(3)} X / ±${(settings.lengthY / 2).toFixed(3)} Y extents`
            : 'project minimum aligned at machine X0 Y0';
        const probeCount = contour ? state.project.probePoints.length : settings.pointCount;
        $('projectSummary').textContent = `${settings.lengthX.toFixed(3)} × ${settings.lengthY.toFixed(3)} mm project · file bounds X${bounds.minX.toFixed(3)}…${bounds.maxX.toFixed(3)}, Y${bounds.minY.toFixed(3)}…${bounds.maxY.toFixed(3)} · ${alignmentSummary} · ${contour ? `closed perimeter detected (${contour.length} vertices), perimeter probes ≤10 mm apart plus ${settings.pointsX} × ${settings.pointsY} interior grid, ${probeCount} unique points total` : `rectangular grid ${settings.pointsX} × ${settings.pointsY} (${probeCount} points)`}`;
        $('projectStatus').textContent = mapCoversProject()
            ? `Project fits within the saved scan. Applying the map aligns its minimum X/Y to saved map origin X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)}; the scan is not changed.`
            : state.controllerHomed && Number.isFinite(state.homeMachineZ)
                ? 'Project fits machine travel. The machine is already homed; confirm Z is clear and safe, then start calibration.'
                : 'Project fits machine travel. Confirm the machine is homed, then start calibration.';
        $('projectStatus').className = 'success';
        const applyOrigin = mapCoversProject() ? { x: state.map.originX, y: state.map.originY } : mapOrigin;
        setNotice(`Project analysis passed. The project minimum X/Y will align to probe-grid origin X${applyOrigin.x.toFixed(3)} Y${applyOrigin.y.toFixed(3)} when applying the map.`, 'success');
    } catch (error) {
        state.project = null;
        renderContourPreview();
        $('projectStatus').textContent = error.message;
        $('projectStatus').className = 'error';
        setNotice(error.message, 'error');
    } finally {
        state.analyzingProject = false;
        await refreshUi();
    }
}

async function calibrate() {
    if (state.busy || !state.origin) return;
    if (!state.controllerHomed || !Number.isFinite(state.homeMachineZ)) {
        setNotice('Confirm homing in gSender or click Home machine before starting calibration.', 'error');
        return;
    }
    state.busy = true; state.stopRequested = false; state.calibrationReadings = []; state.calibrationReadingCount = 0;
    $('calibrationProgress').hidden = false; $('progress').value = 0; $('progressPercent').textContent = '0%';
    renderProbeReadings();
    await refreshUi(); setNotice('Reading controller travel limits and validating the complete grid…');
    try {
        const initialStatus = await statusSnapshot();
        if (initialStatus.state !== 'Idle') throw new Error(`Machine must be idle before calibration (current state: ${initialStatus.state}).`);
        const settings = currentSettings();
        const limits = await readTravelLimits();
        validateSettings(settings, limits);
        if (initialStatus.mpos[2] < limits.minZ - 0.1 || initialStatus.mpos[2] > limits.maxZPosition + 0.1) throw new Error(`Current machine Z${initialStatus.mpos[2].toFixed(3)} is outside the reported Z travel ${limits.minZ}..${limits.maxZPosition} mm.`);
        const grid = state.project.mappingMode === 'contour'
            ? state.project.probePoints.map((point, index) => ({ ...point, ix: index, iy: 0 }))
                : validateMap({ originX: state.origin.x, originY: state.origin.y, lengthX: settings.lengthX, lengthY: settings.lengthY, pointsX: settings.pointsX, pointsY: settings.pointsY }, limits).flat();
        if (grid.some((point) => point.x < limits.minX || point.y < limits.minY || point.x > limits.maxX || point.y > limits.maxY)) throw new Error('A generated perimeter or grid probe point falls outside machine travel. Change map alignment or reduce the project area.');
        const flat = grid;
        const measured = [];
        if (settings.surfaceType === 'conductive') {
            await confirmUser(`Attach the probe clip to the conductive work surface. The machine will move Z to machine Z0 before traveling to the first probe point. After each point, it will retract to safe clearance Z${settings.clearanceZ} before the next XY move; keep clear of the machine.`, 'Prepare conductive probe', 'Clip is attached');
        }
        await machine.setBusy(true, 'Surface height-map calibration');
        setNotice('Moving Z to machine Z0 before traveling to the first probe point…');
        await sendAndWait('G90 G53 G0 Z0');
        await waitIdle();
        state.homeMachineZ = 0;
        let firstZ = null;
        for (let index = 0; index < flat.length; index += 1) {
            if (state.stopRequested) break;
            const point = flat[index];
            const nextPoint = flat[index + 1];
            const directionNote = index === 0
                ? ` Using $23=${limits.homingMask}: map direction ${limits.directionX > 0 ? '+X' : '−X'}/${limits.directionY > 0 ? '+Y' : '−Y'}; next point ${nextPoint ? `X${nextPoint.x.toFixed(3)} Y${nextPoint.y.toFixed(3)}` : 'none'}.`
                : '';
            setNotice(`Moving to map point ${index + 1}/${flat.length}: X${point.x.toFixed(3)} Y${point.y.toFixed(3)}.${directionNote} Keep hands clear.`);
            if (state.stopRequested) break;
            await sendAndWait(`G90 G53 G0 X${point.x.toFixed(3)} Y${point.y.toFixed(3)}`);
            const pointStart = await waitIdle();
            if (state.stopRequested) break;
            if (settings.surfaceType === 'puck') await promptPuck(point, index, flat.length);
            if (state.stopRequested) break;
            const probe = await probeAt(settings, point, index, flat.length, limits, pointStart.mpos[2]);
            if (firstZ === null) firstZ = probe.z;
            state.calibrationReadings.unshift({ x: point.x, y: point.y, zAbs: probe.machineZ, zOffset: round(probe.z - firstZ) });
            state.calibrationReadingCount += 1;
            if (state.calibrationReadings.length > 10) state.calibrationReadings.pop();
            renderProbeReadings();
            if (settings.clearanceZ < probe.machineZ - 0.1) throw new Error(`Probe contact at point ${index + 1} reached machine Z${probe.machineZ.toFixed(3)}, above the configured clearance Z${settings.clearanceZ}. Increase the safe Z clearance before calibration.`);
            setNotice(`Probe complete at point ${index + 1}/${flat.length} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)}). Retracting to safe machine Z${settings.clearanceZ}…`);
            await sendAndWait(`G90 G53 G0 Z${settings.clearanceZ}`);
            await waitIdle();
            setNotice(`Point ${index + 1}/${flat.length} saved. Retract complete; moving to the next point…`);
            measured.push({ x: point.x, y: point.y, ix: point.ix, iy: point.iy, z: round(probe.z), kind: point.kind ?? 'grid' });
            $('progress').value = (index + 1) / flat.length;
            $('progressPercent').textContent = `${Math.round(((index + 1) / flat.length) * 100)}%`;
        }
        if (state.stopRequested) throw new Error('Calibration stopped at a point boundary. Partial measurements were discarded; the previous saved map remains available.');
        if (measured.length !== flat.length || measured.some((sample) => !Number.isFinite(sample.z))) throw new Error('Calibration ended with missing measurements; no new map was saved.');
        setNotice(`All probe points measured. Retracting to safe machine Z${settings.clearanceZ}, then moving to machine X0 Y0…`);
        await sendAndWait(`G90 G53 G0 Z${settings.clearanceZ}`);
        await waitIdle();
        await sendAndWait('G90 G53 G0 X0 Y0');
        await waitIdle();
        state.map = {
            originX: state.origin.x, originY: state.origin.y,
            directionX: limits.directionX, directionY: limits.directionY,
            lengthX: settings.lengthX, lengthY: settings.lengthY,
            pointsX: settings.pointsX, pointsY: settings.pointsY,
            maxX: limits.maxX, maxY: limits.maxY, minX: limits.minX, minY: limits.minY,
            mapAlignment: state.project.mapAlignment,
            surfaceType: settings.surfaceType, puckThickness: settings.puckThickness,
            referenceZ: round(firstZ), z: state.project.mappingMode === 'rectangle' ? Array.from({ length: settings.pointsY }, (_, iy) => Array.from({ length: settings.pointsX }, (_, ix) => measured.find((sample) => sample.ix === ix && sample.iy === iy)?.z)) : [],
            samples: state.project.mappingMode === 'contour' ? measured : null,
            contourMachine: state.project.mappingMode === 'contour' ? state.project.contourMachine : null,
            createdAt: new Date().toISOString(),
        };
        await storage.set('heightMap', state.map);
        await storage.delete('stlExport');
        state.stlExport = null;
        renderStlExport();
        $('stlStatus').textContent = '';
        $('copyStlStatus').textContent = '';
        setNotice(`Calibration saved (${flat.length} points${state.project.mappingMode === 'contour' ? ', including perimeter and interior grid samples' : ''}).`, 'success');
    } catch (err) {
        setNotice(err.message, 'error');
    } finally {
        $('calibrationProgress').hidden = true; state.busy = false;
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
        const sourceContour = parseClosedContours(source)[0] ?? null;
        if (activeWcs !== 'G54') throw new Error(`Select G54 in gSender before applying the map. The active coordinate system is ${activeWcs}.`);
        const offsets = await readCoordinateOffsets('G54');
        const oldG54 = offsets.G54;
        const g92 = offsets.G92;
        const mode = $('workZeroMode').value;
        let outputSource = source;
        let targetG54;
        if (mode === 'rebase') {
            const zeroX = Number($('fileZeroX').value), zeroY = Number($('fileZeroY').value);
            if (![zeroX, zeroY].every(Number.isFinite)) throw new Error('Enter a valid file X/Y work-zero point.');
            if (sourceContour && !pointInPolygon({ x: zeroX, y: zeroY }, sourceContour)) throw new Error('The selected file work-zero point is outside the uploaded file perimeter.');
            if (!sourceContour && (zeroX < bounds.minX || zeroX > bounds.maxX || zeroY < bounds.minY || zeroY > bounds.maxY)) throw new Error('The selected file work-zero point must be within the uploaded file bounds.');
            if (state.map.contourMachine) {
                const mappedZero = { x: state.map.originX + (state.map.directionX ?? 1) * (zeroX - bounds.minX), y: state.map.originY + (state.map.directionY ?? 1) * (zeroY - bounds.minY) };
                if (!pointInPolygon(mappedZero, state.map.contourMachine)) throw new Error('The selected file work zero is outside the scanned perimeter.');
            }
            outputSource = rebaseGcodeCoordinates(source, zeroX, zeroY);
            targetG54 = { x: Number((state.map.originX + (state.map.directionX ?? 1) * (zeroX - bounds.minX) - g92[0]).toFixed(4)), y: Number((state.map.originY + (state.map.directionY ?? 1) * (zeroY - bounds.minY) - g92[1]).toFixed(4)) };
        } else {
            const zeroX = Number($('fileZeroX').value), zeroY = Number($('fileZeroY').value);
            const machineX = Number($('machineZeroX').value), machineY = Number($('machineZeroY').value);
            if (![zeroX, zeroY, machineX, machineY].every(Number.isFinite)) throw new Error('Enter valid file-zero and machine-coordinate X/Y values.');
            if (sourceContour && !pointInPolygon({ x: zeroX, y: zeroY }, sourceContour)) throw new Error('The selected file work-zero point is outside the uploaded file perimeter.');
            if (!sourceContour && (zeroX < bounds.minX || zeroX > bounds.maxX || zeroY < bounds.minY || zeroY > bounds.maxY)) throw new Error('The selected file work-zero point must be within the uploaded file bounds.');
            if (machineX < (state.map.minX ?? 0) || machineY < (state.map.minY ?? 0) || machineX > state.map.maxX || machineY > state.map.maxY) throw new Error('Selected machine origin is outside the calibrated machine travel.');
            if (state.map.contourMachine) {
                const mappedZero = { x: machineX, y: machineY };
                if (!pointInPolygon(mappedZero, state.map.contourMachine)) throw new Error('The selected machine work-zero point is outside the scanned perimeter.');
            }
            targetG54 = { x: Number((machineX - zeroX - g92[0]).toFixed(4)), y: Number((machineY - zeroY - g92[1]).toFixed(4)) };
        }
        const targetWorkOffset = { x: targetG54.x + g92[0], y: targetG54.y + g92[1] };
        if (bounds.maxX - bounds.minX > state.map.lengthX + 1e-6 || bounds.maxY - bounds.minY > state.map.lengthY + 1e-6) {
            throw new Error(`Toolpath size ${ (bounds.maxX - bounds.minX).toFixed(3) } × ${ (bounds.maxY - bounds.minY).toFixed(3) } mm is larger than the mapped area ${state.map.lengthX} × ${state.map.lengthY} mm.`);
        }
        // Preflight before updating the persistent controller offset, so invalid or
        // unsupported files cannot leave G54 changed without a usable output file.
        const compensated = compensateGcode(outputSource, state.map, targetWorkOffset, 'G54', null);
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
        setApplyStatus(`Loaded “${outputName}” into the visualizer. Open Carve to review the copy.`, 'success');
    } catch (err) { setApplyStatus(err.message, 'error'); }
}

async function start() {
    try {
        machine.onParsed('probe-report', receiveProbeReport);
        populateSettings(await storage.get('settings', DEFAULTS));
        updateWorkZeroVisibility();
        state.map = await storage.get('heightMap', null);
        state.stlExport = await storage.get('stlExport', null);
        renderStlExport();
        $('exaggeration').addEventListener('input', drawSurfaceMap);
        if (window.ResizeObserver) new ResizeObserver(drawSurfaceMap).observe($('surfaceCanvas'));
        for (const id of fields) {
            $(id).addEventListener('change', id === 'clearanceZ' ? () => {
                $('clearanceZ').value = String(negativeMachineZ(n('clearanceZ')));
                saveSettings();
            } : saveSettings);
        }
        for (const id of ['machineZeroX', 'machineZeroY']) $(id).addEventListener('change', saveSettings);
        for (const input of document.querySelectorAll('input[name="surfaceType"]')) input.addEventListener('change', () => {
            updatePuckThicknessVisibility();
            saveSettings();
        });
        $('mapAlignment').addEventListener('change', async () => {
            await saveSettings();
            if (state.file) await analyzeProjectFile();
        });
        $('workZeroMode').addEventListener('change', updateWorkZeroVisibility);
        $('home').addEventListener('click', homeMachine);
        $('calibrate').addEventListener('click', calibrate);
        $('stop').addEventListener('click', () => { state.stopRequested = true; state.abortPuck?.(); setNotice('Stop requested. The current controller move/probe will finish before calibration stops.'); });
        $('clearMap').addEventListener('click', async () => { state.map = null; state.stlExport = null; await storage.delete('heightMap'); await storage.delete('stlExport'); renderStlExport(); $('stlStatus').textContent = ''; await refreshUi(); setNotice('Saved height map and STL export deleted.', 'success'); });
        $('exportStl').addEventListener('click', exportSurfaceStl);
        $('copyStlText').addEventListener('click', copyStlText);
        $('file').addEventListener('change', (event) => { analyzeProjectFile(event.target.files?.[0] ?? null); });
        $('checkProject').addEventListener('click', () => analyzeProjectFile());
        $('compensate').addEventListener('click', compensateFile);
        machine.addListener('controller:state', (_type, controllerState) => {
            refreshUi();
            if (state.controllerHomed && !Number.isFinite(state.homeMachineZ)
                && controllerState?.status?.activeState === 'Idle') adoptControllerHoming(true);
        });
        machine.addListener('homing:has-homed', (hasHomed) => adoptControllerHoming(hasHomed));
        $('puckDialog').addEventListener('cancel', (event) => { event.preventDefault(); state.abortPuck?.(); });
        await refreshUi();
        try {
            const reduxState = await getReduxState();
            await adoptControllerHoming(Boolean(reduxState?.controller?.hasHomed));
        } catch (err) {
            setNotice(`Could not read gSender's existing homing state. Use Home machine if needed. ${err.message}`, 'error');
        }
    } catch (err) { setNotice(`Plugin initialization failed: ${err.message}`, 'error'); }
}

start();
