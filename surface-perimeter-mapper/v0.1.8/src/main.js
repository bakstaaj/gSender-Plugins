import { getReduxState, machine, storage } from '@sienci/gsender-plugin-sdk';
import { cornerApproachFromContact } from './rectangle-probe-path.js';
import { insetPolygonBoundary, polygonAreaCentroid } from './surface-edge.js';
import { createPolygonContour } from './polygon-contour.js';
import { polygonSearchBox, simulatedOriginOffset } from './polygon-search-box.js';
import { planPolygonSurface } from './polygon-surface.js';
import { polygonMesh, polygonMeshStl, polygonPerimeterMesh, polygonSurfaceOnlyMesh, previewPolygonMesh } from './polygon-mesh.js';
import { planUltraCorner, sampleUltraCorner } from './ultra-corner.js';
import { recessCandidates } from './recess-detection.js';
import { compensateContour } from './perimeter-compensation.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const FIXED_VERTICAL_CLEARANCE_MM = 1;
const inputIds = ['tipDiameter', 'usableLength', 'approachClearance', 'minThickness', 'maxThickness', 'partRadius', 'partWidth', 'partHeight', 'polygonSides', 'rectangleWidth', 'rectangleHeight', 'sampleSpacing', 'fastFeed', 'slowFeed', 'polygonDirection', 'polygonClearance', 'polygonReleaseLimit'];
const STORAGE_KEY = 'surface-perimeter-mapper.setup.v2';
const LEGACY_STORAGE_KEY = 'surface-perimeter-mapper.setup.v1';
const HOMING_LOG_KEY = 'surface-perimeter-mapper.homing-diagnostics.v1';
const HOMING_LOG_ENABLED_KEY = 'surface-perimeter-mapper.homing-diagnostics-enabled.v1';
const INCOMPLETE_SCAN_KEY = 'surface-perimeter-mapper.incomplete-scan.v1';
const MAX_HOMING_DIAGNOSTICS = 500;
const FEATURE_WIDTH_MULTIPLIER = 4;
const PERIMETER_RELEASE_DIAMETER_FACTOR = 0.75;
const Z_LIMIT_MARGIN = 0.5;
const MAX_SURFACE_SAMPLES = 12000;
const MAX_PERIMETER_SAMPLES = 1200;
const state = { connected: false, controllerHomed: false, homingStateInitialized: false, homingEventReceived: false, homedPositionCaptured: false, homingError: null, motionState: 'Unknown', machinePosition: null, workPosition: null, lastProbeStatusAt: 0, lastControllerStatusAt: 0, lastStatusQueryAt: 0, statusQueryAttempts: 0, statusOutageStartedAt: 0, lastStatusQueryError: null, statusRecoveryPromise: null, recoveryDialogOpen: false, recoveryCanceled: false, recoveryHoldInFlight: false, positionMode: 'wpos', gotoXYContext: null, xyMoveGuard: null, busy: false, continuousJog: null, rectangleOriginMachine: null, wposZeroMachine: null, bedWposZ: null, bedOriginWpos: null, bedStartMpos: null, originSafeRetract: false, originMessage: null, probePinKnown: false, probePinActive: false, probePinReportingSeen: false, lastProbeStatusLine: null, lastProbeStatusHadPinField: false, probeStatusSequence: 0, probeContactSequence: 0, lastProbeContact: null, activeProbeCapture: null, probeSignalTested: false, probeTestRunning: false, cancelProbeTest: false, finishProbeTest: null, scanRunning: false, stopScan: false, scanCheckpoint: null, incompleteScan: null, perimeterPoints: [], surfaceRings: [], surfaceCenter: null, surfaceComplete: false, fullSurfaceAvailable: false, latest: null };
let persistenceTimer = 0;
let scanPersistTimer = 0;
let diagnosticPersistTimer = 0;
let homingDiagnostics = [];
let diagnosticLogReady = false;
let diagnosticLoggingEnabled = true;
let lastDiagnosticThrottle = new Map();
let controllerMaxProbeLengthMm = null;
let probeLengthLimitsLoaded = false;
let probeLengthLimitReadPending = false;
let probeLengthLimitRetryAt = 0;
let bedMaxProbeLengthMm = null;
let probeLengthLimitMessage = '';
let lastHomeDecisionKey = '';
let lastControllerStateKey = '';
let lastProbeContinueSnapshot = '';
let lastScanReadinessKey = '';
const number = (id) => Number($(id).value);
const positive = (value) => Number.isFinite(value) && value > 0;
const fmt = (value) => Number.isFinite(value) ? `${value.toFixed(1)} mm` : '—';
const fullClearanceHeight = (cfg) => cfg.usableLength + cfg.verticalClearance;
const positionVector = (value) => Array.isArray(value) ? value.slice(0, 3).map(Number)
    : value && typeof value === 'object' ? [Number(value.x), Number(value.y), Number(value.z)] : null;

function makeRectanglePerimeterPlan(width, height, spacing, cornerProbeOffset) {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const sides = [
        { name: 'front', start: [-halfWidth, -halfHeight], end: [halfWidth, -halfHeight], inward: [0, 1], length: width },
        { name: 'right', start: [halfWidth, -halfHeight], end: [halfWidth, halfHeight], inward: [-1, 0], length: height },
        { name: 'rear', start: [halfWidth, halfHeight], end: [-halfWidth, halfHeight], inward: [0, -1], length: width },
        { name: 'left', start: [-halfWidth, halfHeight], end: [-halfWidth, -halfHeight], inward: [1, 0], length: height }
    ];
    return sides.flatMap((side) => {
        // After each corner, put the first face probe 0.75D along the outgoing
        // edge from its predicted corner. Keep the same offset at both ends;
        // later samples advance by the configured resolution.
        const firstDistance = cornerProbeOffset;
        const endDistance = side.length - cornerProbeOffset;
        const distances = [];
        for (let distance = firstDistance; distance < endDistance - 0.001; distance += spacing) distances.push(distance);
        return distances.map((distance, index) => {
            const t = distance / side.length;
            return {
                side: side.name,
                x: side.start[0] + (side.end[0] - side.start[0]) * t,
                y: side.start[1] + (side.end[1] - side.start[1]) * t,
                inward: side.inward,
                corner: index === 0,
                distanceFromCorner: distance
            };
        });
    });
}

function startRectanglePlanAtFrontCenter(plan) {
    const workingPlan = plan.slice();
    const frontSamples = workingPlan.map((sample, index) => ({ sample, index }))
        .filter(({ sample }) => sample.side === 'front');
    if (!frontSamples.length) return plan;
    let centerIndex = frontSamples.find(({ sample }) => Math.abs(sample.x) <= 0.001)?.index;
    if (centerIndex === undefined) {
        const firstPositive = frontSamples.find(({ sample }) => sample.x > 0.001);
        const lastFrontIndex = frontSamples[frontSamples.length - 1].index;
        centerIndex = firstPositive?.index ?? lastFrontIndex + 1;
        workingPlan.splice(centerIndex, 0, {
            side: 'front', x: 0, y: frontSamples[0].sample.y,
            inward: [0, 1], corner: false
        });
    }
    return workingPlan.slice(centerIndex).concat(workingPlan.slice(0, centerIndex));
}

function readSettings() {
    return {
        ...Object.fromEntries(inputIds.map((id) => [id, $(id).value])),
        jogStep: $('jogStep').value,
        partShape: $('partShape').value,
        probeMode: document.querySelector('input[name="probeMode"]:checked')?.value ?? 'precise',
        scanMode: document.querySelector('input[name="scanMode"]:checked')?.value ?? 'both',
        resultRepresentation: $('resultRepresentation')?.value ?? 'both',
        skipProbeSignalTest: $('skipProbeSignalTest').checked,
        rectangleCorner: document.querySelector('input[name="rectangleCorner"]:checked')?.value ?? 'center',
        positionMode: state.positionMode
    };
}

function writeSettings(settings = {}) {
    if (settings.partRadius === undefined && settings.partShape === 'circle' && positive(Number(settings.partWidth))) {
        settings = { ...settings, partRadius: Number(settings.partWidth) / 2 };
    }
    if(settings.partShape && settings.partShape!=='polygon'){
        const diameter=2*Number(settings.partRadius);
        settings={...settings,partShape:'polygon',...(settings.partShape==='circle'&&positive(diameter)?{partWidth:diameter,partHeight:diameter}:{})};
    }
    for (const id of inputIds) {
        if (settings[id] !== undefined) $(id).value = settings[id];
    }
    if (settings.jogStep !== undefined) $('jogStep').value = settings.jogStep;
    if (settings.partShape) $('partShape').value = settings.partShape;
    if (settings.skipProbeSignalTest !== undefined) $('skipProbeSignalTest').checked = Boolean(settings.skipProbeSignalTest);
    if (['fast', 'precise', 'ultra'].includes(settings.probeMode)) {
        const mode = document.querySelector(`input[name="probeMode"][value="${settings.probeMode}"]`);
        if (mode) mode.checked = true;
    }
    if (['perimeter', 'surface', 'both'].includes(settings.scanMode)) {
        const mode = document.querySelector(`input[name="scanMode"][value="${settings.scanMode}"]`);
        if (mode) mode.checked = true;
    }
    if (['perimeter', 'surface', 'both'].includes(settings.resultRepresentation) && $('resultRepresentation')) $('resultRepresentation').value = settings.resultRepresentation;
    if (settings.rectangleCorner) {
        const corner = document.querySelector(`input[name="rectangleCorner"][value="${settings.rectangleCorner}"]`);
        if (corner) corner.checked = true;
    }
    if (settings.positionMode === 'mpos' || settings.positionMode === 'wpos') state.positionMode = settings.positionMode;
}

function incompleteScanSnapshot(error = null) {
    return {
        version: 1,
        savedAt: new Date().toISOString(),
        error,
        settings: readSettings(),
        bedStartMpos: state.bedStartMpos?.slice() ?? null,
        wposZeroMachine: state.wposZeroMachine?.slice() ?? null,
        bedWposZ: state.bedWposZ,
        checkpoint: state.scanCheckpoint,
        perimeterPoints: state.perimeterPoints,
        rawPerimeterPoints: state.rawPerimeterPoints ?? [],
        polygonSurfacePoints: state.polygonSurfacePoints ?? [],
        surfaceRings: state.surfaceRings,
        surfaceCenter: state.surfaceCenter,
        surfacePreviewBoundary: state.surfacePreviewBoundary,
        recesses: state.recesses ?? [],
        compensationApplied: Boolean(state.compensationApplied),
        surfaceComplete: Boolean(state.surfaceComplete)
    };
}

async function saveIncompleteScan(error = null) {
    if (state.surfaceComplete) return;
    const points = (state.perimeterPoints?.length ?? 0) + (state.polygonSurfacePoints?.length ?? 0)
        + (state.surfaceRings?.reduce((sum, ring) => sum + (ring.points?.length ?? 0), 0) ?? 0)
        + (state.surfaceCenter ? 1 : 0);
    if (!points) return;
    const record = incompleteScanSnapshot(error);
    await storage.set(INCOMPLETE_SCAN_KEY, record);
    state.incompleteScan = record;
}

function persistScanProgressSoon() {
    window.clearTimeout(scanPersistTimer);
    scanPersistTimer = window.setTimeout(() => {
        void saveIncompleteScan().catch(error => {
            logHomingDiagnostic('Could not persist incomplete scan progress', { message: error.message });
        });
    }, 500);
}

async function clearIncompleteScan() {
    window.clearTimeout(scanPersistTimer);
    scanPersistTimer = 0;
    await storage.delete(INCOMPLETE_SCAN_KEY);
    state.incompleteScan = null;
    state.scanCheckpoint = null;
}

function restoreIncompleteScan(record) {
    if (!record || record.version !== 1 || !record.checkpoint || !Array.isArray(record.perimeterPoints)) return false;
    state.incompleteScan = record;
    state.scanCheckpoint = record.checkpoint;
    state.bedStartMpos = record.bedStartMpos?.slice() ?? null;
    state.perimeterPoints = record.perimeterPoints;
    state.rawPerimeterPoints = record.rawPerimeterPoints ?? [];
    state.polygonSurfacePoints = record.polygonSurfacePoints ?? [];
    state.surfaceRings = record.surfaceRings ?? [];
    state.surfaceCenter = record.surfaceCenter ?? null;
    state.surfacePreviewBoundary = record.surfacePreviewBoundary ?? null;
    state.recesses = record.recesses ?? [];
    state.compensationApplied = Boolean(record.compensationApplied);
    state.surfaceComplete = false;
    return true;
}

async function chooseIncompleteScanAction() {
    if (!state.incompleteScan) return 'new';
    const dialog = $('scanConfirmDialog');
    $('scanConfirmTitle').textContent = 'An incomplete scan was saved';
    const saved = state.incompleteScan;
    const pointCount = saved.perimeterPoints.length + (saved.polygonSurfacePoints?.length ?? 0);
    dialog.querySelector('p').textContent = `${pointCount} successful probe results are saved from ${saved.checkpoint?.phase === 'surface' ? 'surface mapping' : 'perimeter mapping'}. To continue, the machine automatically raises to full clearance, returns to the saved bed-probe position, probes the bed again, then returns to the saved scan checkpoint and continues with the next planned move. Starting new clears these saved results.`;
    $('confirmScan').hidden = true;
    $('startNewScan').hidden = false;
    $('resumeSavedScan').hidden = false;
    dialog.showModal();
    return new Promise(resolve => {
        const finish = value => {
            dialog.close();
            $('cancelScan').onclick = null;
            $('startNewScan').onclick = null;
            $('resumeSavedScan').onclick = null;
            dialog.oncancel = null;
            $('confirmScan').hidden = false;
            $('startNewScan').hidden = true;
            $('resumeSavedScan').hidden = true;
            $('scanConfirmTitle').textContent = 'Find the bed, perimeter, and top surface?';
            resolve(value);
        };
        $('cancelScan').onclick = () => finish('cancel');
        $('startNewScan').onclick = () => finish('new');
        $('resumeSavedScan').onclick = () => finish('resume');
        dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
    });
}

function shiftPointFrame(point, delta) {
    if (!point || typeof point !== 'object') return;
    if (Number.isFinite(point.x)) point.x += delta[0];
    if (Number.isFinite(point.y)) point.y += delta[1];
    if (Number.isFinite(point.z)) point.z += delta[2];
    if (Number.isFinite(point.probeX)) point.probeX += delta[0];
    if (Number.isFinite(point.probeY)) point.probeY += delta[1];
    if (Number.isFinite(point.contactZ)) point.contactZ += delta[2];
}

function savedBedMachineOrigin(record) {
    if (record.wposZeroMachine?.every(Number.isFinite)) return record.wposZeroMachine.slice();
    const references=[...(record.rawPerimeterPoints??[]),...(record.perimeterPoints??[])];
    const point=references.find(item=>item?.rawMpos?.length>=3
        &&[item.x,item.y,item.contactZ,...item.rawMpos.slice(0,3)].every(Number.isFinite));
    if(!point)return null;
    return [point.rawMpos[0]-point.x,point.rawMpos[1]-point.y,point.rawMpos[2]-point.contactZ];
}

function rebaseIncompleteScan(record, newZero, oldZeroOverride = null) {
    const oldZero = savedBedMachineOrigin(record) ?? oldZeroOverride;
    if (!oldZero?.every(Number.isFinite) || !newZero?.every(Number.isFinite)) throw new Error('Saved scan has no valid bed reference; it cannot be resumed safely.');
    const delta = oldZero.map((value, axis) => value - newZero[axis]);
    for (const point of record.perimeterPoints ?? []) shiftPointFrame(point, delta);
    for (const point of record.rawPerimeterPoints ?? []) shiftPointFrame(point, delta);
    for (const point of record.polygonSurfacePoints ?? []) shiftPointFrame(point, delta);
    for (const ring of record.surfaceRings ?? []) for (const point of ring.points ?? []) shiftPointFrame(point, delta);
    if (record.surfaceCenter) shiftPointFrame(record.surfaceCenter, delta);
    for (const point of record.surfacePreviewBoundary ?? []) shiftPointFrame(point, delta);
    for (const recess of record.recesses ?? []) {
        for (const point of recess.contour ?? []) shiftPointFrame(point, delta);
        for (const point of recess.rawContour ?? []) shiftPointFrame(point, delta);
        for (const point of recess.floor ?? []) shiftPointFrame(point, delta);
        if (Number.isFinite(recess.floorZ)) recess.floorZ += delta[2];
        if (Number.isFinite(recess.sideZ)) recess.sideZ += delta[2];
    }
    const cursor = record.checkpoint?.cursor;
    if (cursor) {
        for (const key of ['contacts', 'first', 'closureContact']) {
            if (Array.isArray(cursor[key])) {
                if (Array.isArray(cursor[key][0])) cursor[key].forEach(p => { p[0] += delta[0]; p[1] += delta[1]; });
                else { cursor[key][0] += delta[0]; cursor[key][1] += delta[1]; }
            }
        }
        for (const key of ['origin', 'target']) if (cursor.pending?.[key]) {
            cursor.pending[key][0] += delta[0]; cursor.pending[key][1] += delta[1];
        }
        // The hash keys encode rounded positions. Clear that loop-detection cache
        // after a frame translation; the follower's contact history remains intact.
        cursor.seen = [];
    }
    const checkpoint = record.checkpoint;
    for (const point of checkpoint?.traceContacts ?? []) shiftPointFrame(point, delta);
    if (checkpoint?.task?.seed) shiftPointFrame(checkpoint.task.seed, delta);
    if (checkpoint?.task?.initialTarget) checkpoint.task.initialTarget = checkpoint.task.initialTarget.map((value, axis) => value + delta[axis]);
    if (checkpoint?.task?.entryContact) shiftPointFrame(checkpoint.task.entryContact, delta);
    if (checkpoint?.lastLocationWpos) checkpoint.lastLocationWpos = checkpoint.lastLocationWpos.map((value, axis) => value + delta[axis]);
    if (checkpoint?.lastProbe) shiftPointFrame(checkpoint.lastProbe, delta);
    if (checkpoint?.pendingObservation?.contact) checkpoint.pendingObservation.contact = checkpoint.pendingObservation.contact.map((value, axis) => value + delta[axis]);
    if (checkpoint?.pendingObservation?.stoppedWpos) checkpoint.pendingObservation.stoppedWpos = checkpoint.pendingObservation.stoppedWpos.map((value, axis) => value + delta[axis]);
    record.wposZeroMachine = newZero.slice();
    return delta;
}

function persistSettingsSoon() {
    window.clearTimeout(persistenceTimer);
    persistenceTimer = window.setTimeout(async () => {
        try {
            await storage.set(STORAGE_KEY, { ...readSettings(), calculated: state.latest, savedAt: new Date().toISOString() });
            $('saveStatus').textContent = 'Settings saved automatically.';
            $('saveStatus').dataset.state = 'ready';
        } catch (error) {
            $('saveStatus').textContent = `Could not save settings: ${error.message}`;
            $('saveStatus').dataset.state = 'error';
        }
    }, 300);
}

function setStepStatus(id, text, stateName) {
    const element = $(id);
    element.textContent = text;
    element.dataset.state = stateName;
}

function renderHomingDiagnostics() {
    const output = $('homingDiagnosticLog');
    if (!output || !diagnosticLoggingEnabled) return;
    output.value = homingDiagnostics.join('\n');
    output.scrollTop = output.scrollHeight;
}

function maximumProbeLengthMm() {
    const available = [controllerMaxProbeLengthMm, bedMaxProbeLengthMm].filter(Number.isFinite);
    return available.length ? Math.min(...available) : null;
}

function updateProbeLengthLimitNote() {
    const note = $('probeLengthLimitNote');
    if (!note) return;
    note.textContent = probeLengthLimitMessage;
    note.hidden = !probeLengthLimitMessage;
}

function enforceProbeLengthLimit(limitMm, reason) {
    if (!Number.isFinite(limitMm) || limitMm <= 0) return false;
    // The input uses 0.1 mm steps. Round down so its value stays within travel.
    const maxInput = Math.floor((limitMm - 1e-8) * 10) / 10;
    const field = $('usableLength');
    const current = Number(field.value);
    const activeLimit = maximumProbeLengthMm();
    const nextLimit = Number.isFinite(activeLimit) ? Math.floor((activeLimit - 1e-8) * 10) / 10 : maxInput;
    field.max = nextLimit.toFixed(1);
    if (Number.isFinite(current) && current > nextLimit + 1e-8) {
        field.value = nextLimit.toFixed(1);
        probeLengthLimitMessage = `Maximum probe length must be < ${(nextLimit + 0.1).toFixed(1)} mm (${reason}); L was reduced from ${current.toFixed(1)} to ${nextLimit.toFixed(1)} mm.`;
        updateProbeLengthLimitNote();
        return true;
    }
    return false;
}

function keepMotionOrControllerDiagnostic(event) {
    const name = String(event ?? '').trim();
    if (/^(?:Homing UI decision|Probe Continue button state changed|Probe dialog message changed|GOTO XY dialog ready|GOTO XY dialog validation failed|Manual probe test skipped by operator for live testing|Probe Continue DOM attribute mutation|Probe signal test dialog opened|Probe signal test dialog finished|Probe Continue clicked|Start scan button clicked|Perimeter scan confirmation canceled|Scan readiness updated|gSender Redux homing snapshot|gSender connection context|Could not read gSender connection context|Could not read gSender Redux state|Plugin connection state changed|Plugin diagnostics initialized|Diagnostic log cleared by user)$/.test(name)) return false;
    return /(?:\bcontroller\b|\bprobe\b|\bperimeter\b|\binterior\b|\bsurface\b|\bbed(?: search| probe| height)\b|\bpolygon\b|\brectangle\b|\bcorner\b|\bcontact\b|\brelease\b|\bretract\b|\bbackoff\b|\boutcropping\b|\btravel\b|\bmove\b|\bjog\b|\bfeed.?hold\b|\brecovery\b|\bhoming\b|\bhomed position\b|\bworkflow stopped\b|\bscan (?:stopped|completed|started)\b)/i.test(name)
        || /^GOTO XY (?:move|clearance|execution plan|target reached|completed|failed)\b/i.test(name)
        || /^Home button pressed$/i.test(name)
        || /^Dispatching gSender homing action$/i.test(name)
        || /^gSender homing action response$/i.test(name)
        || /^Homing completed and confirmed by gSender$/i.test(name);
}

function keepMotionOrControllerDiagnosticLine(line) {
    const text = String(line ?? '');
    const match = text.match(/^\S+\s+(.+?)(?=\s+\{|\s+\[|$)/);
    return Boolean(match && keepMotionOrControllerDiagnostic(match[1]));
}

function logHomingDiagnostic(event, details = {}) {
    if (!diagnosticLoggingEnabled || !keepMotionOrControllerDiagnostic(event)) return;
    let serialized;
    try { serialized = JSON.stringify(details); } catch { serialized = String(details); }
    const line = `${new Date().toISOString()} ${event}${serialized && serialized !== '{}' ? ` ${serialized}` : ''}`;
    homingDiagnostics.push(line);
    if (homingDiagnostics.length > MAX_HOMING_DIAGNOSTICS) homingDiagnostics = homingDiagnostics.slice(-MAX_HOMING_DIAGNOSTICS);
    renderHomingDiagnostics();
    if (!diagnosticLogReady) return;
    window.clearTimeout(diagnosticPersistTimer);
    diagnosticPersistTimer = window.setTimeout(async () => {
        try { await storage.set(HOMING_LOG_KEY, homingDiagnostics); }
        catch (error) { console.warn('Could not persist homing diagnostics', error); }
    }, 250);
}

function logHomingDiagnosticThrottled(key, event, details, signature, intervalMs = 15000) {
    if (!diagnosticLoggingEnabled) return;
    const now = Date.now();
    const previous = lastDiagnosticThrottle.get(key);
    if (!previous || previous.signature !== signature || now - previous.at >= intervalMs) {
        lastDiagnosticThrottle.set(key, { signature, at: now });
        logHomingDiagnostic(event, details);
    }
}

function updateLiveStatus(status = null) {
    if (status) {
        state.motionState = status.activeState ?? state.motionState;
        state.machinePosition = positionVector(status.mpos) ?? state.machinePosition;
        state.workPosition = positionVector(status.wpos) ?? state.workPosition;
    }
    $('coordinateMode').textContent = state.positionMode.toUpperCase();
    $('coordinateMode').setAttribute('aria-pressed', String(state.positionMode === 'wpos'));
    const connection = $('jogConnection');
    connection.classList.toggle('good', state.connected);
    connection.innerHTML = `<i></i> ${state.connected ? 'Connected' : 'Not connected'}`;
    const displayedPosition = state.positionMode === 'wpos' ? state.workPosition : state.machinePosition;
    ['X', 'Y', 'Z'].forEach((axis, index) => {
        const value = displayedPosition?.[index];
        $(`dro${axis}`).textContent = Number.isFinite(value) ? value.toFixed(3) : '—';
    });
    $('probeOriginButton').disabled = state.probeTestRunning || !state.connected || !state.controllerHomed || state.motionState !== 'Idle' || state.busy || state.workflowRunning || !state.latest?.inputsValid;
    refreshScanButton();
    $('stopPerimeterScan').disabled = !state.workflowRunning && !state.scanRunning;
    const probeDialog = $('probeTestDialog');
    const probeContinueReady = probeDialog.open && probeDialog.dataset.probePassed === 'true' && !state.probePinActive;
    setProbeContinueEnabled(probeContinueReady);
    $('homeButton').disabled = !state.connected || state.busy || state.probeTestRunning;
    const homeStatusText = state.homingError ?? (!state.connected ? 'Not connected' : state.controllerHomed ? 'Machine homed' : 'Machine not homed');
    $('homeStatus').textContent = state.controllerHomed ? 'Machine already homed' : homeStatusText;
    const jogDisabled = !state.connected || !state.controllerHomed
        || (state.busy && !state.continuousJog) || state.probeTestRunning;
    $('jogStep').disabled = jogDisabled;
    document.querySelectorAll('[data-axis][data-sign]').forEach((button) => {
        button.disabled = jogDisabled || (!state.continuousJog && state.motionState !== 'Idle');
    });
    const homeDecision = {
        text: homeStatusText,
        connected: state.connected,
        controllerHomed: state.controllerHomed,
        homingStateInitialized: state.homingStateInitialized,
        homingEventReceived: state.homingEventReceived,
        homedPositionCaptured: state.homedPositionCaptured,
        homingError: state.homingError,
        motionState: state.motionState,
        busy: state.busy,
        jogDisabled
    };
    const homeDecisionKey = JSON.stringify(homeDecision);
    if (homeDecisionKey !== lastHomeDecisionKey) {
        lastHomeDecisionKey = homeDecisionKey;
        logHomingDiagnostic('Homing UI decision', homeDecision);
    }
    const safeWposZ = fullClearanceHeight(state.latest ?? { usableLength: Number($('usableLength').value), verticalClearance: FIXED_VERTICAL_CLEARANCE_MM });
    $('gotoXY').disabled = !state.connected || !state.controllerHomed || state.motionState !== 'Idle'
        || state.busy || state.probeTestRunning;
    $('gotoOrigin').disabled = !state.rectangleOriginMachine || !state.controllerHomed || state.motionState !== 'Idle'
        || state.busy || state.probeTestRunning || !Number.isFinite(state.workPosition?.[2]) || state.workPosition[2] < safeWposZ;
    $('originCaptureStatus').textContent = state.originMessage ?? (state.rectangleOriginMachine
        ? `Part-center top origin set. Machine position X${state.rectangleOriginMachine[0].toFixed(3)} Y${state.rectangleOriginMachine[1].toFixed(3)} Z${state.rectangleOriginMachine[2].toFixed(3)}.`
        : 'Ready when homed and positioned above exposed bed just in front of the part.');
}

function setProbeContinueEnabled(enabled) {
    const action = $('continueProbeTest');
    action.disabled = !enabled;
    action.setAttribute('aria-disabled', String(!enabled));
    if (enabled) action.removeAttribute('disabled');
    else action.setAttribute('disabled', '');
    const snapshot = getProbeContinueSnapshot();
    const signature = JSON.stringify(snapshot);
    if (signature !== lastProbeContinueSnapshot) {
        lastProbeContinueSnapshot = signature;
        logHomingDiagnostic('Probe Continue button state changed', { requestedEnabled: enabled, ...snapshot });
    }
}

function getProbeContinueSnapshot() {
    const action = $('continueProbeTest');
    const dialog = $('probeTestDialog');
    return {
        disabledProperty: action.disabled,
        disabledAttribute: action.hasAttribute('disabled'),
        ariaDisabled: action.getAttribute('aria-disabled'),
        connectedToDom: action.isConnected,
        duplicateIdCount: document.querySelectorAll('#continueProbeTest').length,
        dialogOpen: dialog.open,
        probeActivated: dialog.dataset.probeActivated,
        probePassed: dialog.dataset.probePassed,
        probeSignalTested: state.probeSignalTested,
        probePinKnown: state.probePinKnown,
        probePinActive: state.probePinActive
    };
}

function setProbeTestStatus(message, stateName = '') {
    const element = $('probeTestStatus');
    const previous = element.textContent;
    element.textContent = message;
    element.dataset.state = stateName;
    if (previous !== message) {
        logHomingDiagnostic('Probe dialog message changed', {
            previous,
            current: message,
            signalKnown: state.probePinKnown,
            signalActive: state.probePinActive,
            continueButton: getProbeContinueSnapshot()
        });
    }
}

function receiveProbeStatus(report) {
    const line = String(report?.line ?? report?.lines?.find((value) => /^<[^>]+>$/.test(String(value).trim())) ?? '').trim();
    const match = line.match(/^<([^>]*)>$/);
    if (!match) return;
    const fields = match[1].split('|');
    state.lastProbeStatusAt = Date.now();
    state.statusQueryAttempts = 0;
    state.statusOutageStartedAt = 0;
    state.lastStatusQueryError = null;
    state.motionState = fields[0] ?? state.motionState;
    for (const field of fields) {
        if (field.startsWith('MPos:')) state.machinePosition = parsePosition(field.slice(5));
        if (field.startsWith('WPos:')) state.workPosition = parsePosition(field.slice(5));
    }
    const previousProbeState = { known: state.probePinKnown, active: state.probePinActive };
    const pins = fields.find((field) => field.startsWith('Pn:'));
    if (pins) state.probePinReportingSeen = true;
    // GRBL omits Pn when no pins are active. Treat a valid report without Pn
    // as a clear baseline; the signal test must still observe Pn:P and release
    // before it enables any automatic probing.
    state.probePinKnown = true;
    state.probePinActive = Boolean(pins && pins.slice(3).includes('P'));
    state.lastProbeStatusLine = line;
    state.lastProbeStatusHadPinField = Boolean(pins);
    state.probeStatusSequence += 1;
    const moveGuard = state.xyMoveGuard;
    if (moveGuard?.active && state.probePinActive && !moveGuard.triggered) {
        moveGuard.triggered = true;
        setOriginMessage(`Probe triggered during GOTO XY ${moveGuard.label}; requesting a feed hold.`);
        logHomingDiagnostic('GOTO XY probe guard triggered', {
            label: moveGuard.label,
            sequence: state.probeStatusSequence,
            report: state.lastProbeStatusLine,
            machinePosition: state.machinePosition,
            workPosition: state.workPosition
        });
        moveGuard.holdPromise = machine.command('feedhold').catch((error) => {
            moveGuard.holdError = error;
            return null;
        });
    }
    if ($('probeTestDialog').open && (previousProbeState.known !== state.probePinKnown || previousProbeState.active !== state.probePinActive)) {
        logHomingDiagnostic('Probe status signal transition received', {
            sequence: state.probeStatusSequence,
            report: line,
            pinFieldPresent: Boolean(pins),
            probePinReportingSeen: state.probePinReportingSeen,
            omittedPnMeansClear: !pins && state.probePinReportingSeen,
            previousKnown: previousProbeState.known,
            previousActive: previousProbeState.active,
            currentKnown: state.probePinKnown,
            currentActive: state.probePinActive,
            continueButton: getProbeContinueSnapshot()
        });
    }
    updateLiveStatus();
    update();
}

function dispatchFeedHold(label) {
    logHomingDiagnostic('Feed-hold request dispatched without waiting for acknowledgement', {
        label,
        motionState: state.motionState,
        lastStatusLine: state.lastProbeStatusLine
    });
    try {
        Promise.resolve(machine.command('feedhold'))
            .then((result) => logHomingDiagnostic('Feed-hold request completed', { label, result, motionState: state.motionState }))
            .catch((error) => logHomingDiagnostic('Feed-hold request failed', { label, message: error.message, motionState: state.motionState }));
        return true;
    } catch (error) {
        logHomingDiagnostic('Feed-hold request failed before dispatch', { label, message: error.message, motionState: state.motionState });
        return false;
    }
}

async function dispatchFeedHoldIfMoving(label) {
    try {
        const fresh = await requestFreshControllerStatus(500);
        const controllerState = fresh.state.split(':')[0];
        if (['Idle', 'Hold', 'Alarm', 'Door', 'Sleep', 'Check'].includes(controllerState)) {
            logHomingDiagnostic('Feed-hold request skipped; fresh controller state is already stopped', {
                label,
                state: fresh.state,
                status: fresh.line
            });
            return false;
        }
        return dispatchFeedHold(label);
    } catch (error) {
        logHomingDiagnostic('Could not confirm a stopped controller state before recovery feed hold; requesting hold as a precaution', {
            label,
            message: error.message,
            motionState: state.motionState,
            lastStatusLine: state.lastProbeStatusLine
        });
        return dispatchFeedHold(label);
    }
}

function receiveProbeContact(report) {
    const line = String(report?.line ?? report?.lines?.find((value) => /^\[PRB:[^\]]+\]$/.test(String(value).trim())) ?? '').trim();
    if (!line.startsWith('[PRB:')) return;
    const parsed = parseOptionalProbe({ lines: [line] });
    state.probeContactSequence += 1;
    state.lastProbeContact = { line, triggered: parsed?.triggered ?? false, mpos: parsed?.mpos ?? null, sequence: state.probeContactSequence, receivedAt: Date.now() };
    const capture = state.activeProbeCapture;
    if (capture && state.probeContactSequence > capture.baseline) {
        capture.report = { line, triggered: parsed?.triggered ?? false, mpos: parsed?.mpos ?? null };
        logHomingDiagnostic('Probe report captured independently of the command reply', {
            line,
            parserSequence: report?.seq ?? null
        });
    }
}

function parsePosition(value) {
    const parsed = String(value).split(',').slice(0, 3).map(Number);
    return parsed.length === 3 && parsed.every(Number.isFinite) ? parsed : null;
}

function currentSnapshot() {
    return getReduxState().then((redux) => {
        const controller = redux?.controller;
        const status = controller?.state?.status;
        if (!redux?.connection?.isConnected) throw new Error('Connect to the controller in gSender first.');
        const mpos = positionVector(status?.mpos) ?? state.machinePosition;
        const wpos = positionVector(status?.wpos) ?? state.workPosition;
        if (!mpos?.every(Number.isFinite)) throw new Error('Waiting for a valid machine position report.');
        return { state: status?.activeState ?? state.motionState, mpos, wpos, homed: state.controllerHomed };
    });
}

async function adoptControllerHoming(hasHomed) {
    const previousHomed = state.controllerHomed;
    state.controllerHomed = Boolean(hasHomed);
    state.homingStateInitialized = true;
    logHomingDiagnostic('Applied controller homing state', {
        rawHasHomed: hasHomed,
        rawType: typeof hasHomed,
        previousHomed,
        controllerHomed: state.controllerHomed,
        busy: state.busy,
        homedPositionCaptured: state.homedPositionCaptured
    });
    if (!state.controllerHomed) {
        state.homedPositionCaptured = false;
        state.rectangleOriginMachine = null;
        state.wposZeroMachine = null;
        state.bedWposZ = null;
        state.originSafeRetract = false;
        state.originMessage = null;
        updateLiveStatus();
        update();
        return;
    }
    if (state.busy || state.homedPositionCaptured) {
        updateLiveStatus();
        update();
        return;
    }
    try {
        const snapshot = await currentSnapshot();
        logHomingDiagnostic('Homed position snapshot', {
            activeState: snapshot.state,
            mpos: snapshot.mpos,
            wpos: snapshot.wpos,
            reduxHomed: snapshot.homed
        });
        if (!state.controllerHomed || snapshot.state !== 'Idle') return;
        state.machinePosition = snapshot.mpos;
        state.workPosition = snapshot.wpos;
        state.homedPositionCaptured = true;
    } catch (error) {
        logHomingDiagnostic('Could not capture homed position', { message: error.message });
        $('homeStatus').textContent = `Homed; waiting for position: ${error.message}`;
    } finally {
        updateLiveStatus();
        update();
    }
}

async function waitForIdle(timeoutMs = 30000, stableMs = 500) {
    const deadline = Date.now() + timeoutMs;
    const settleAfter = Date.now() + stableMs;
    while (Date.now() < deadline) {
        const snapshot = await currentSnapshot();
        if (snapshot.state === 'Idle' && Date.now() >= settleAfter) return snapshot;
        if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm. Resolve it in gSender before continuing.');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the machine to become idle.');
}

async function waitForHomingCycle(timeoutMs = 120000, stableMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let sawHoming = false;
    let idleSince = 0;
    while (Date.now() < deadline) {
        const snapshot = await currentSnapshot();
        const activeState = String(snapshot.state ?? '').toLowerCase();
        if (activeState === 'home' || activeState === 'homing') {
            sawHoming = true;
            idleSince = 0;
        } else if (activeState === 'alarm') {
            throw new Error('Controller entered Alarm during homing. Resolve the alarm in gSender before continuing.');
        } else if (sawHoming && activeState === 'idle') {
            if (!idleSince) idleSince = Date.now();
            if (Date.now() - idleSince >= stableMs) return snapshot;
        } else {
            idleSince = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(sawHoming
        ? 'Homing did not return to Idle before the timeout.'
        : 'gSender accepted the homing action, but the controller never reported a Home state.');
}

async function waitForReduxHomed(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = null;
    while (Date.now() < deadline) {
        const redux = await getReduxState();
        const controller = redux?.controller;
        const status = controller?.state?.status;
        lastSnapshot = {
            connectionIsConnected: redux?.connection?.isConnected,
            hasHomed: controller?.hasHomed,
            homingFlag: controller?.homingFlag,
            activeState: status?.activeState,
            mpos: positionVector(status?.mpos),
            wpos: positionVector(status?.wpos)
        };
        if (lastSnapshot.hasHomed === true) return lastSnapshot;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logHomingDiagnostic('Timed out waiting for gSender Redux homing confirmation', lastSnapshot ?? {});
    throw new Error('The homing cycle finished, but gSender did not confirm the machine as homed. See the Homing diagnostic log.');
}

async function runMotion(label, command, timeoutMs = 30000, requireProbeClear = true) {
    if (!state.connected || !state.controllerHomed || state.busy) throw new Error('Connect and home the machine before moving.');
    if (requireProbeClear && (!state.probeSignalTested || !state.probePinKnown || state.probePinActive)) throw new Error('Verify that the probe input is working and clear before moving.');
    const snapshot = await currentSnapshot();
    if (snapshot.state !== 'Idle') throw new Error(`Motion requires an idle machine (current state: ${snapshot.state}).`);
    state.busy = true;
    updateLiveStatus();
    let busyAnnounced = false;
    try {
        await machine.setBusy(true, label);
        busyAnnounced = true;
        const result = await queryController(command, { until: 'ok-or-error', timeout: timeoutMs, maxLines: 80 });
        if (!result.complete || !result.ok || result.error) throw new Error(`Controller did not accept ${command}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
        await waitForIdle(timeoutMs);
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* the controller may have disconnected */ }
        await checkConnection();
    }
}

// gSender can interleave modal-state reports from its own $G requests with a
// plugin command. Keep unsolicited [GC:...] lines out of command results; only
// requireG54Active() below is allowed to consume a modal report because it
// explicitly sends $G itself.
async function queryController(command, options = {}) {
    const result = await machine.query(command, options);
    if (String(command).trim() === '$G') return result;
    const lines = (result.lines ?? []).map((line) => String(line));
    const ignored = lines.filter((line) => /^\s*\[GC:/i.test(line));
    if (ignored.length) {
        logHomingDiagnostic('Ignored unsolicited controller modal report', { command: String(command), lines: ignored });
    }
    return ignored.length ? { ...result, lines: lines.filter((line) => !/^\s*\[GC:/i.test(line)) } : result;
}

async function queryProbeController(command, options = {}) {
    const result = await queryController(command, {
        ...options,
        // An `ok` may belong to gSender's unrelated $G request. A probe block
        // completes only when its own PRB report or a controller fault arrives.
        until: /^(?:\[PRB:[^\]]+\]|ALARM:.*|error:.*)$/i,
        allowDuringJob: true
    });
    const hasProbeReport = (result.lines ?? []).some((line) => /^\s*\[PRB:[^\]]+\]/i.test(String(line)));
    return { ...result, ok: hasProbeReport && !result.error };
}

async function prepareProbeSignalTest() {
    if (!$('skipProbeSignalTest').checked) return runProbeSignalCheck();
    if (!state.probePinKnown || state.probePinActive) {
        throw new Error('Skipping the manual probe test still requires a known, clear probe input from the controller.');
    }
    state.probeSignalTested = true;
    logHomingDiagnostic('Manual probe test skipped by operator for live testing', {
        probePinKnown: state.probePinKnown,
        probePinActive: state.probePinActive
    });
    update();
    return true;
}

async function homeMachine() {
    if (!state.connected || state.busy) return;
    logHomingDiagnostic('Home button pressed', { connected: state.connected, previousHomed: state.controllerHomed, motionState: state.motionState });
    state.busy = true;
    state.homingError = null;
    state.controllerHomed = false;
    state.homingStateInitialized = true;
    state.homedPositionCaptured = false;
    state.rectangleOriginMachine = null;
    state.wposZeroMachine = null;
    state.bedWposZ = null;
    state.originSafeRetract = false;
    state.originMessage = null;
    updateLiveStatus();
    try {
        await machine.setBusy(true, 'Home machine');
        logHomingDiagnostic('Dispatching gSender homing action', { command: "machine.command('homing')" });
        const dispatchResult = await machine.command('homing');
        logHomingDiagnostic('gSender homing action response', { response: dispatchResult ?? null });
        const snapshot = await waitForHomingCycle(120000);
        const reduxConfirmation = await waitForReduxHomed(5000);
        logHomingDiagnostic('Homing completed and confirmed by gSender', {
            activeState: snapshot.state,
            mpos: snapshot.mpos,
            wpos: snapshot.wpos,
            redux: reduxConfirmation
        });
        state.controllerHomed = true;
        state.homingError = null;
        state.machinePosition = snapshot.mpos;
        state.workPosition = snapshot.wpos;
        state.homedPositionCaptured = true;
        $('saveStatus').textContent = '';
    } catch (error) {
        logHomingDiagnostic('Homing command failed', { message: error.message });
        state.homingError = error.message;
        $('probeTestStatus').textContent = error.message;
    } finally {
        state.busy = false;
        try { await machine.setBusy(false); } catch { /* disconnected */ }
        await checkConnection();
    }
}

async function jog(axis, sign) {
    if (state.busy || !state.controllerHomed || !['X', 'Y', 'Z'].includes(axis) || ![-1, 1].includes(sign)) return;
    if ($('jogStep').value === 'continuous') return;
    const step = Number($('jogStep').value);
    if (![0.1, 1, 10].includes(step)) return;
    state.rectangleOriginMachine = null;
    state.wposZeroMachine = null;
    state.bedWposZ = null;
    state.originSafeRetract = false;
    state.originMessage = 'Machine jogged. Probe the WPOS origin again before scanning.';
    state.busy = true;
    updateLiveStatus();
    let busyAnnounced = false;
    try {
        const snapshot = await currentSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Jogging requires an idle machine (current state: ${snapshot.state}).`);
        const limits = await readProbeLimits();
        const target = [...snapshot.mpos];
        const axisIndex = { X: 0, Y: 1, Z: 2 }[axis];
        target[axisIndex] += sign * step;
        const travel = axis === 'X' ? limits.x : axis === 'Y' ? limits.y : limits.z;
        if (target[axisIndex] < travel.min || target[axisIndex] > travel.max) {
            throw new Error(`${axis} jog would exceed reported machine travel ${travel.min}..${travel.max} mm.`);
        }
        await machine.setBusy(true, `Jog ${axis} ${sign > 0 ? '+' : '−'}${step} mm`);
        busyAnnounced = true;
        await sendJogCommand(`G21 G91 G0 ${axis}${(sign * step).toFixed(3)}`);
        await waitForIdle();
        await sendJogCommand('G90', 5000);
        $('originCaptureStatus').textContent = `Jogged ${axis} ${sign > 0 ? '+' : '−'}${step} mm. Probe WPOS origin again before scanning.`;
    } catch (error) {
        try { await sendJogCommand('G90', 5000); } catch { /* preserve the jog error */ }
        $('originCaptureStatus').textContent = error.message;
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        await checkConnection();
    }
}

async function startContinuousJog(axis, sign, inputEvent) {
    if (state.busy || !state.controllerHomed || !['X', 'Y', 'Z'].includes(axis) || ![-1, 1].includes(sign)) return;
    const jog = { axis, sign, pointerId: inputEvent?.pointerId ?? null, key: inputEvent?.key ?? null, stopRequested: false, commandSent: false, cancelSent: false };
    state.continuousJog = jog;
    state.rectangleOriginMachine = null;
    state.wposZeroMachine = null;
    state.bedWposZ = null;
    state.originSafeRetract = false;
    state.originMessage = 'Machine jogged. Probe the WPOS origin again before scanning.';
    state.busy = true;
    updateLiveStatus();
    let busyAnnounced = false;
    try {
        const snapshot = await currentSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Jogging requires an idle machine (current state: ${snapshot.state}).`);
        const limits = await readProbeLimits();
        const travel = axis === 'X' ? limits.x : axis === 'Y' ? limits.y : limits.z;
        const position = snapshot.mpos[{ X: 0, Y: 1, Z: 2 }[axis]];
        const distance = Math.abs((sign > 0 ? travel.max : travel.min) - position) - 0.1;
        if (!Number.isFinite(distance) || distance <= 0.1) throw new Error(`${axis} is already at its machine travel limit.`);
        if (jog.stopRequested) return;
        await machine.setBusy(true, `Continuous jog ${axis} ${sign > 0 ? '+' : '−'}`);
        busyAnnounced = true;
        jog.commandSent = true;
        const command = `$J=G21 G91 ${axis}${(sign * distance).toFixed(3)} F500`;
        await sendJogCommand(command, 10000);
        $('originCaptureStatus').textContent = `Continuously jogging ${axis} ${sign > 0 ? '+' : '−'}. Release the button to stop.`;
        while (!jog.stopRequested) await new Promise((resolve) => setTimeout(resolve, 40));
        await machine.command('gcode', '[\\x85]');
        jog.cancelSent = true;
        await waitForIdle();
        await sendJogCommand('G90', 5000);
        $('originCaptureStatus').textContent = 'Continuous jog stopped. Probe WPOS origin again before scanning.';
    } catch (error) {
        if (jog.commandSent && !jog.cancelSent) {
            try { await machine.command('gcode', '[\\x85]'); jog.cancelSent = true; await waitForIdle(); } catch { /* preserve the jog error */ }
        }
        $('originCaptureStatus').textContent = error.message;
    } finally {
        state.continuousJog = null;
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        await checkConnection();
    }
}

function requestContinuousJogStop(event = null) {
    const jog = state.continuousJog;
    if (!jog) return;
    if (jog.pointerId !== null && event?.pointerId !== undefined && event.pointerId !== jog.pointerId) return;
    if (jog.key && event?.key && event.key !== jog.key) return;
    jog.stopRequested = true;
}

function setOriginMessage(message) {
    state.originMessage = message;
    $('originCaptureStatus').textContent = message;
}

async function readProbeLimits() {
    let lastError = 'Controller returned no settings.';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        let result;
        logHomingDiagnostic(`Controller $$ settings query attempt ${attempt}/3`);
        try {
            result = await queryController('$$', { until: 'ok-or-error', timeout: 10000, maxLines: 350 });
        } catch (error) {
            lastError = error.message;
            logHomingDiagnostic(`Controller $$ settings query failed on attempt ${attempt}/3`, { message: error.message });
        }
        if (result) {
            const lines = (result.lines ?? []).map((line) => String(line));
            logHomingDiagnostic(`Controller $$ settings response attempt ${attempt}/3`, {
                complete: result.complete, ok: result.ok, error: result.error, reason: result.reason,
                lineCount: lines.length, lines
            });
            if (!result.complete || !result.ok || result.error) {
                lastError = result.error ?? result.reason ?? 'Incomplete or rejected $$ response.';
            } else {
                const settings = new Map();
                const pattern = /^\s*\$?(\d+)\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:\s|$)/i;
                for (const line of lines) {
                    const match = line.match(pattern);
                    if (match) settings.set(Number(match[1]), Number(match[2]));
                }
                const homingMask = settings.get(23);
                const hardLimitsSetting = settings.get(21);
                const homingPullOffSetting = settings.get(27);
                const configuredTravelSettings = [130, 131, 132].map((setting) => [setting, settings.get(setting)]);
                const missing = configuredTravelSettings.filter(([, value]) => !Number.isFinite(value) || value <= 0).map(([setting]) => '$' + setting);
                if (!Number.isInteger(homingMask) || homingMask < 0) missing.unshift('$23');
                if (hardLimitsSetting !== 0 && hardLimitsSetting !== 1) missing.unshift('$21');
                if (!Number.isFinite(homingPullOffSetting) || homingPullOffSetting < 0) missing.unshift('$27');
                const pullOffClearance = hardLimitsSetting === 1 && Number.isFinite(homingPullOffSetting) && homingPullOffSetting >= 0
                    ? homingPullOffSetting
                    : 0;
                const effectiveTravelSettings = configuredTravelSettings.map(([setting, value]) => [setting, value - pullOffClearance]);
                const tooSmallAfterPullOff = effectiveTravelSettings.filter(([, value]) => !Number.isFinite(value) || value <= Z_LIMIT_MARGIN);
                missing.push(...tooSmallAfterPullOff.map(([setting]) => '$' + setting + ' after homing pull-off'));
                if (missing.length === 0) {
                    const configuredTravels = configuredTravelSettings.map(([, value]) => value);
                    const travels = effectiveTravelSettings.map(([, value]) => value);
                    logHomingDiagnostic(`Controller travel settings parsed on attempt ${attempt}/3`, {
                        homingMask,
                        hardLimitsEnabled: hardLimitsSetting === 1,
                        configuredTravels,
                        homingPullOffMm: pullOffClearance,
                        effectiveTravels: travels
                    });
                    controllerMaxProbeLengthMm = travels[2] - FIXED_VERTICAL_CLEARANCE_MM;
                    probeLengthLimitsLoaded = true;
                    probeLengthLimitRetryAt = 0;
                    const limitDescription = 'effective machine Z travel (' + travels[2].toFixed(1) + ' mm after ' + pullOffClearance.toFixed(1) + ' mm hard-limit homing pull-off) minus ' + FIXED_VERTICAL_CLEARANCE_MM.toFixed(1) + ' mm clearance';
                    if (enforceProbeLengthLimit(controllerMaxProbeLengthMm, limitDescription)) {
                        update();
                        persistSettingsSoon();
                    }
                    // Match the tested Surface Height Map interpretation of GRBL $23: set
                    // bits indicate positive machine-coordinate travel toward the home end.
                    const axis = (bit, travel) => {
                        const direction = (homingMask & bit) ? 1 : -1;
                        return { homePositive: direction > 0, min: direction < 0 ? -travel : 0, max: direction < 0 ? 0 : travel };
                    };
                    const x = axis(1, travels[0]);
                    const y = axis(2, travels[1]);
                    const zHomePositive = (homingMask & 4) === 0;
                    const z = { homePositive: zHomePositive, min: zHomePositive ? -travels[2] : 0, max: zHomePositive ? 0 : travels[2] };
                    return { x, y, z, zHomePositive: z.homePositive, minZ: z.min, maxZ: z.max, hardLimitsEnabled: hardLimitsSetting === 1, homingPullOffMm: pullOffClearance };
                }
                lastError = `Missing or invalid ${missing.join(', ')} in the controller's $$ response.`;
                logHomingDiagnostic(`Controller $$ settings parse failed on attempt ${attempt}/3`, { missing, parsed: Object.fromEntries(settings) });
            }
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Could not read controller travel settings after three $$ queries: ${lastError}`);
}

async function refreshProbeLengthLimitFromController() {
    if (!state.connected || state.motionState !== 'Idle' || probeLengthLimitsLoaded
        || probeLengthLimitReadPending || Date.now() < probeLengthLimitRetryAt) return;
    probeLengthLimitReadPending = true;
    probeLengthLimitMessage = 'Reading this machine’s Z travel to calculate the maximum L…';
    updateProbeLengthLimitNote();
    try {
        await readProbeLimits();
        $('usableLength').max = (Math.floor((maximumProbeLengthMm() - 1e-8) * 10) / 10).toFixed(1);
        if (probeLengthLimitMessage.startsWith('Reading this machine')
            || probeLengthLimitMessage.startsWith('Waiting for an Idle controller')) {
            probeLengthLimitMessage = '';
            updateProbeLengthLimitNote();
        }
        update();
    } catch (error) {
        probeLengthLimitRetryAt = Date.now() + 15000;
        probeLengthLimitMessage = `Could not read this machine’s Z travel. Maximum L is not verified: ${error.message}`;
        updateProbeLengthLimitNote();
    } finally {
        probeLengthLimitReadPending = false;
    }
}

async function sendJogCommand(line, timeout = 30000) {
    logHomingDiagnostic('Jog command TX', { line });
    const result = await queryController(line, { until: 'ok-or-error', timeout, maxLines: 60 });
    logHomingDiagnostic('Jog command RX', { line, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
    if (!result.complete || !result.ok || result.error) {
        throw new Error(`Jog command was not accepted: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    }
    return result;
}

async function requireG54Active() {
    const result = await machine.query('$G', { until: 'ok-or-error', timeout: 10000, maxLines: 40 });
    if (!result.complete || !result.ok || result.error) throw new Error(`Could not read the active work coordinate system: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const gcLine = (result.lines ?? []).map(String).find((line) => line.includes('[GC:')) ?? '';
    if (!/\bG54\b/.test(gcLine)) {
        const active = gcLine.match(/\bG5[4-9]\b/)?.[0] ?? 'unknown';
        throw new Error(`Select G54 in gSender before probing the origin. The origin touch-off writes G54; active coordinate system is ${active}.`);
    }
}

async function requirePolygonRecoveryFrame(snapshot) {
    if (!state.wposZeroMachine?.every(Number.isFinite) || !snapshot.mpos?.every(Number.isFinite) || !snapshot.wpos?.every(Number.isFinite)) {
        throw new Error('Cannot resume because the scan work-coordinate reference is unavailable.');
    }
    await requireG54Active();
    const measuredZero = snapshot.mpos.map((value, index) => value - snapshot.wpos[index]);
    const drift = Math.max(...measuredZero.map((value, index) => Math.abs(value - state.wposZeroMachine[index])));
    if (drift > 0.15) {
        throw new Error(`Cannot resume because the active work-coordinate zero moved ${drift.toFixed(3)} mm from the scan reference.`);
    }
}

function probeContact(result, label) {
    const report = parseOptionalProbe(result);
    if (!report?.triggered) {
        const lines = (result.lines ?? []).map((line) => String(line).trim()).filter((line) => !line.startsWith('[GC:'));
        const response = lines.join(' ') || result.reason || 'no PRB report';
        throw new Error(`${label} did not produce a confirmed probe contact; expected a [PRB:…:1] report. Controller response: ${response}`);
    }
    return { report:report.line, mpos:report.mpos };
}

async function probeWposOrigin() {
    if (state.busy || !state.connected || !state.controllerHomed) return;
    if (!(await machine.getContext())?.polygonSimulator) {
        setOriginMessage('This bed-based origin test build is restricted to the dedicated simulator.');
        return;
    }
    const configuredFastFeed = number('fastFeed');
    const configuredSlowFeed = number('slowFeed');
    if (!positive(configuredFastFeed) || !positive(configuredSlowFeed) || configuredSlowFeed > configuredFastFeed) {
        setOriginMessage('Enter positive probe feeds, with Slow feed no greater than Fast feed.');
        return;
    }
    state.rectangleOriginMachine = null;
    state.wposZeroMachine = null;
    state.bedWposZ = null;
    state.bedOriginWpos = null;
    state.originSafeRetract = false;
    state.originMessage = null;
    state.probeSignalTested = false;
    let busyAnnounced = false;
    update();
    try {
        setOriginMessage($('skipProbeSignalTest').checked
            ? 'Manual probe test skipped. Checking that the controller reports the probe input clear…'
            : 'Complete the probe signal test. The Z touch-off will start when you press Continue.');
        const accepted = await prepareProbeSignalTest();
        if (!accepted) {
            setOriginMessage('Origin probe canceled. No motion was sent.');
            return;
        }
        while (state.probeTestRunning) await new Promise((resolve) => setTimeout(resolve, 25));
        const initial = await currentSnapshot();
        if (!initial.homed) throw new Error('Home the machine before probing the WPOS origin.');
        if (initial.state !== 'Idle') throw new Error(`Origin probing requires an idle machine (current state: ${initial.state}).`);
        if (!initial.wpos?.every(Number.isFinite)) throw new Error('Waiting for a valid WPOS position report.');
        if (!state.probePinKnown || state.probePinActive) throw new Error('Probe input must be reported clear before the origin probe starts.');
        await requireG54Active();
        const limits = await readProbeLimits();
        const zHomeDirection = limits.zHomePositive ? 1 : -1;
        if (zHomeDirection !== 1) throw new Error('This simulator test currently requires positive-up Z coordinates.');
        const probeDirection = -zHomeDirection;
        if (initial.mpos[2] < limits.minZ || initial.mpos[2] > limits.maxZ) {
            throw new Error(`Current machine Z${initial.mpos[2].toFixed(3)} is outside reported Z travel ${limits.minZ.toFixed(3)}..${limits.maxZ.toFixed(3)} mm.`);
        }
        const maxProbeTravel = probeDirection < 0
            ? initial.mpos[2] - limits.minZ - Z_LIMIT_MARGIN
            : limits.maxZ - initial.mpos[2] - Z_LIMIT_MARGIN;
        const maxThickness = number('maxThickness');
        const tipDiameter = number('tipDiameter');
        const verticalClearance = number('verticalClearance');
        if (!positive(maxThickness) || !positive(tipDiameter) || !Number.isFinite(verticalClearance) || verticalClearance < 0) {
            throw new Error('Enter valid part thickness, tip diameter, and vertical allowance before probing the origin.');
        }
        const probeMode = document.querySelector('input[name="probeMode"]:checked')?.value ?? 'precise';
        const releaseDistance = tipDiameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
        const requiredProbeTravel = probeMode !== 'fast' ? releaseDistance + 0.5 : 0.5;
        if (maxProbeTravel <= requiredProbeTravel) {
            throw new Error(`Not enough Z travel remains in the probing direction from machine Z${initial.mpos[2].toFixed(3)}. Available probe travel after safety margin: ${Math.max(0, maxProbeTravel).toFixed(3)} mm; the ${probeMode} origin probe needs at least ${requiredProbeTravel.toFixed(2)} mm.`);
        }
        const safeWposZ = maxThickness * 0.1;
        const shape = $('partShape').value;
        const halfHeight = shape === 'circle' ? number('partRadius') : number('partHeight') / 2;
        if (!positive(halfHeight)) throw new Error('Enter a valid part height or circle radius before probing the bed.');
        const bedToCenter = halfHeight + releaseDistance;
        state.busy = true;
        await machine.setBusy(true, 'Probe WPOS origin');
        busyAnnounced = true;
        setOriginMessage(`Fast Z probe in progress (maximum ${maxProbeTravel.toFixed(1)} mm from current position)…`);
        updateLiveStatus();
        const fastFeed = configuredFastFeed;
        const slowFeed = configuredSlowFeed;
        const fastTimeout = Math.max(120000, Math.ceil((maxProbeTravel / fastFeed) * 60000 + 30000));
        const fastResult = await queryProbeController(`G21 G91 G38.2 Z${(probeDirection * maxProbeTravel).toFixed(3)} F${fastFeed}`, { timeout: fastTimeout, maxLines: 80 });
        if (!fastResult.complete || !fastResult.ok || fastResult.error) throw new Error(`Origin fast probe was not accepted: ${fastResult.error ?? fastResult.lines?.join(' ') ?? fastResult.reason}`);
        const fastContact = probeContact(fastResult, 'Origin fast probe');
        let originContact = fastContact;
        if (probeMode !== 'fast') {
            setOriginMessage(`First touch detected at machine Z${fastContact.mpos[2].toFixed(3)}. Releasing ${releaseDistance.toFixed(2)} mm for the precise touch…`);
            const releaseZ = fastContact.mpos[2] + zHomeDirection * releaseDistance;
            if (releaseZ < limits.minZ || releaseZ > limits.maxZ) throw new Error(`The ${releaseDistance.toFixed(2)} mm probe release move would exceed machine Z travel.`);
            const releaseResult = await queryController(`G90 G53 G0 Z${releaseZ.toFixed(3)}`, { until: 'ok-or-error', timeout: 30000, maxLines: 60 });
            if (!releaseResult.complete || !releaseResult.ok || releaseResult.error) throw new Error(`Could not release the probe after its first touch: ${releaseResult.error ?? releaseResult.lines?.join(' ') ?? releaseResult.reason}`);
            const releaseSnapshot = await waitForIdle();
            if (Math.abs(releaseSnapshot.mpos[2] - releaseZ) > 0.1) throw new Error('Controller did not reach the expected probe-release height.');
            const slowResult = await queryProbeController(`G21 G91 G38.2 Z${(probeDirection * (releaseDistance + 0.5)).toFixed(3)} F${slowFeed}`, { timeout: 30000, maxLines: 80 });
            if (!slowResult.complete || !slowResult.ok || slowResult.error) throw new Error(`Origin precise probe was not accepted: ${slowResult.error ?? slowResult.lines?.join(' ') ?? slowResult.reason}`);
            originContact = probeContact(slowResult, 'Origin precise probe');
        } else {
            setOriginMessage(`Fast mode: origin touch confirmed at machine Z${fastContact.mpos[2].toFixed(3)}; continuing without a second touch.`);
        }
        await queryController('G90', { until: 'ok-or-error', timeout: 5000, maxLines: 20 });
        const stopped = await waitForIdle();
        if (stopped.mpos.slice(0, 2).some((value, index) => Math.abs(value - originContact.mpos[index]) > 0.1)) {
            throw new Error('Could not confirm the stopped machine position after the origin touch-off.');
        }
        const availableRetract = (zHomeDirection > 0 ? limits.maxZ - stopped.mpos[2] : stopped.mpos[2] - limits.minZ) - Z_LIMIT_MARGIN;
        if (availableRetract < 1) throw new Error('Less than 1 mm of machine Z travel remains toward the Z home end after probing; cannot safely retract. Resolve the position manually.');
        const actualRetract = maxThickness + safeWposZ;
        if (availableRetract + 1e-6 < actualRetract) throw new Error(`The required bed-to-clearance retract is ${actualRetract.toFixed(2)} mm, beyond available Z travel. No work offset was changed.`);
        const retractTargetZ = stopped.mpos[2] + zHomeDirection * actualRetract;
        const centerMachineY = originContact.mpos[1] + bedToCenter;
        if(centerMachineY < limits.y.min + Z_LIMIT_MARGIN || centerMachineY > limits.y.max - Z_LIMIT_MARGIN) throw new Error('The estimated part center is outside machine Y travel. No work offset was changed.');
        setOriginMessage('Setting G54 Z0 at the estimated part top and XY at the estimated part center…');
        const stoppedX=stopped.mpos[0]-originContact.mpos[0];
        const stoppedY=stopped.mpos[1]-centerMachineY;
        const stoppedZ=stopped.mpos[2]-(originContact.mpos[2]+maxThickness);
        const zeroResult = await queryController(`G21 G90 G10 L20 P1 X${stoppedX.toFixed(3)} Y${stoppedY.toFixed(3)} Z${stoppedZ.toFixed(3)}`, { until: 'ok-or-error', timeout: 10000, maxLines: 40 });
        if (!zeroResult.complete || !zeroResult.ok || zeroResult.error) throw new Error(`Probe contact succeeded, but G54 zero was not accepted: ${zeroResult.error ?? zeroResult.lines?.join(' ') ?? zeroResult.reason}`);
        const retractResult = await queryController(`G90 G53 G0 Z${retractTargetZ.toFixed(3)}`, { until: 'ok-or-error', timeout: 30000, maxLines: 60 });
        if (!retractResult.complete || !retractResult.ok || retractResult.error) throw new Error(`G54 was set, but the safe Z retract failed: ${retractResult.error ?? retractResult.lines?.join(' ') ?? retractResult.reason}`);
        const final = await waitForIdle();
        if (Math.abs(final.mpos[2] - retractTargetZ) > 0.1 || !final.wpos?.every(Number.isFinite)
            || Math.abs(final.wpos[0]) > 0.1 || Math.abs(final.wpos[1] + bedToCenter) > 0.1 || Math.abs(final.wpos[2] - safeWposZ) > 0.15) {
            throw new Error(`Controller did not confirm G54 origin and retract. Expected WPOS X0 Y${(-bedToCenter).toFixed(3)} Z${safeWposZ.toFixed(3)}, reported ${final.wpos?.map((value) => value.toFixed(3)).join(', ') ?? 'unavailable'}.`);
        }
        state.machinePosition = final.mpos;
        state.workPosition = final.wpos;
        state.rectangleOriginMachine = [originContact.mpos[0],centerMachineY,final.mpos[2]];
        state.wposZeroMachine = [originContact.mpos[0],centerMachineY,originContact.mpos[2]+maxThickness];
        state.bedOriginWpos = [0,-bedToCenter,-maxThickness];
        state.bedWposZ = -maxThickness;
        state.bedSetup = {maxThickness,halfHeight,tipDiameter,shape};
        state.polygonOriginOffset = null;
        try {
            const simulatorContext = await machine.getContext();
            if (simulatorContext?.polygonSimulator) state.polygonOriginOffset = simulatedOriginOffset(state.wposZeroMachine, limits);
        } catch (error) { logHomingDiagnostic('Polygon origin offset unavailable', {message:error.message}); }
        logHomingDiagnostic('Polygon origin offset calculated', {offset:state.polygonOriginOffset});
        state.originSafeRetract = true;
        setOriginMessage(state.originSafeRetract
            ? `Bed probed; estimated top is WPOS Z0 and center is X0 Y0. Bed is Z${(-maxThickness).toFixed(2)}; retracted to Z${safeWposZ.toFixed(2)}.`
            : `G54 X0 Y0 Z0 was set, but Z travel only allowed a ${actualRetract.toFixed(2)} mm retract; ${safeWposZ.toFixed(2)} mm is needed to clear the part. The tool was raised as far as the travel margin allows. Reduce part thickness/clearance or increase available Z travel, then probe origin again.`);
    } catch (error) {
        setOriginMessage(error.message);
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        await checkConnection();
    }
}

async function requestFreshControllerStatus(timeoutMs = 5000) {
    const result = await machine.query('?', {
        until: /^<[^>]+>$/,
        timeout: timeoutMs,
        maxLines: 20,
        includeStatusReports: true,
        allowDuringJob: true
    });
    const lines = (result.lines ?? []).map((line) => String(line).trim());
    const line = lines.find((value) => /^<[^>]+>$/.test(value));
    if (!result.complete || !line) {
        throw new Error(`The controller did not return a fresh status report to '?': ${lines.join(' ') || result.reason || 'no response'}`);
    }
    receiveProbeStatus({ line });
    return { result, line, state: line.slice(1).split('|')[0] ?? 'Unknown' };
}

async function recoverMissingProbeReport(result, label, timeoutMs, capture) {
    const lines = (result.lines ?? []).map(String);
    let latestStatus = 'no fresh status report';
    let latestState = '';
    let sawRun = false;
    let idleSince = 0;
    const recoveryWindowMs = Math.min(6000, Math.max(2000, timeoutMs));
    const deadline = Date.now() + recoveryWindowMs;
    logHomingDiagnostic(`${label} response did not contain a PRB report; requesting fresh controller status`, {
        responseComplete: result.complete,
        responseOk: result.ok,
        responseLines: lines,
        recoveryWindowMs
    });

    let statusAttempts = 0;
    while (Date.now() < deadline) {
        if (capture?.report && !lines.includes(capture.report.line)) lines.push(capture.report.line);
        let report = parseOptionalProbe({ ...result, lines });
        let fresh;
        try {
            statusAttempts += 1;
            fresh = await requestFreshControllerStatus(Math.min(750, Math.max(200, deadline - Date.now())));
        } catch (error) {
            latestStatus = error.message;
            logHomingDiagnostic(`${label} status retry after missing PRB failed`, { statusAttempts, message: error.message, remainingMs: Math.max(0, deadline - Date.now()) });
            if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
            continue;
        }
        latestStatus = fresh.line;
        latestState = fresh.state;
        lines.push(...(fresh.result.lines ?? []).map(String));
        if (capture?.report && !lines.includes(capture.report.line)) lines.push(capture.report.line);
        report = parseOptionalProbe({ ...result, lines });
        logHomingDiagnostic(`${label} fresh status after missing PRB response`, {
            status: fresh.line,
            state: fresh.state,
            lateProbeReport: report?.line ?? null
        });
        if (fresh.state === 'Alarm') return { ...result, lines };
        if (fresh.state === 'Idle') {
            if (report) return { ...result, lines };
            if (!idleSince) idleSince = Date.now();
            if ((sawRun && Date.now() - idleSince >= 500) || Date.now() - idleSince >= 1500) return { ...result, lines };
        } else {
            sawRun = true;
            idleSince = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!parseOptionalProbe({ ...result, lines })) {
        lines.push(`Fresh '?' status: ${latestStatus}${latestState ? ` (${latestState})` : ''}`);
    }
    return { ...result, lines };
}

async function retractToKnownBedProbeStart(start, limits) {
    const fresh = await requestFreshControllerStatus(1200);
    if (fresh.state === 'Alarm') throw new Error('The bed probe entered Alarm. Clear the controller alarm before attempting a retry.');
    const current = await currentSnapshot();
    if (current.state !== 'Idle' || !current.homed || !current.mpos?.every(Number.isFinite)
        || !current.wpos?.every(Number.isFinite)) throw new Error('Cannot retry the bed probe until the controller reports a fresh, homed Idle position.');
    if (Math.hypot(current.mpos[0] - start.mpos[0], current.mpos[1] - start.mpos[1]) > 0.15) {
        throw new Error('The bed probe stopped at an unexpected XY position; automatic retry is disabled.');
    }
    if (current.mpos[2] > start.mpos[2] + 0.15) throw new Error('The probe is already above its bed-probe start height; automatic retry is disabled.');
    const startZ = start.mpos[2];
    if (startZ < limits.z.min + Z_LIMIT_MARGIN || startZ > limits.z.max - Z_LIMIT_MARGIN) {
        throw new Error('The saved bed-probe start height is outside the current Z travel limits.');
    }
    const command = `G21 G90 G53 G0 Z${startZ.toFixed(3)}`;
    const retract = await queryController(command, { until: 'ok-or-error', timeout: 30000, maxLines: 40 });
    if (!retract.complete || !retract.ok || retract.error) throw new Error(`Could not return to the known bed-probe start height: ${retract.error ?? retract.lines?.join(' ') ?? retract.reason}`);
    const returned = await waitForIdle(30000, 150);
    const confirmed = await requestFreshControllerStatus(1200);
    if (confirmed.state !== 'Idle' || !state.probePinKnown || state.probePinActive
        || !returned.mpos?.every(Number.isFinite)
        || Math.hypot(returned.mpos[0] - start.mpos[0], returned.mpos[1] - start.mpos[1]) > 0.15
        || Math.abs(returned.mpos[2] - startZ) > 0.15) {
        throw new Error('The known bed-probe start height or clear probe input was not confirmed after retracting.');
    }
    logHomingDiagnostic('Bed probe safely returned to known start for one slow retry', {
        startMpos: start.mpos,
        returnedMpos: returned.mpos,
        status: confirmed.line,
        probePinKnown: state.probePinKnown,
        probePinActive: state.probePinActive
    });
    return returned;
}

async function startSimplifiedWorkflow() {
    if(state.workflowRunning||state.busy||!state.connected||!state.controllerHomed||!state.latest?.inputsValid)return;
    const resumeChoice=await chooseIncompleteScanAction();
    if(resumeChoice==='cancel')return;
    const resumeRecord=resumeChoice==='resume'?state.incompleteScan:null;
    if(resumeRecord){writeSettings(resumeRecord.settings??{});update();}
    else{
        await clearIncompleteScan();
        state.perimeterPoints=[];state.rawPerimeterPoints=[];state.polygonSurfacePoints=[];state.surfaceRings=[];state.surfaceCenter=null;state.surfacePreviewBoundary=null;state.surfaceComplete=false;state.fullSurfaceAvailable=false;state.polygonMesh=null;state.recesses=[];state.compensationApplied=false;state.scanCheckpoint=null;state.bedStartMpos=null;
        renderPerimeterResult();
    }
    state.probeSignalTested=false;state.stopScan=false;state.recoveryCanceled=false;state.statusRecoveryPromise=null;state.wposZeroMachine=null;state.bedWposZ=null;state.originSafeRetract=false;
    bedMaxProbeLengthMm=null;
    let announced=false;
    try {
        const accepted=await prepareProbeSignalTest();if(!accepted){setOriginMessage('Probe test canceled. No motion was sent.');return;}
        while(state.probeTestRunning)await new Promise(resolve=>setTimeout(resolve,25));
        state.workflowRunning=true;state.busy=true;updateLiveStatus();update();
        await machine.setBusy(true,'Bed and perimeter scan');announced=true;
        let initial=await currentSnapshot();const limits=await readProbeLimits();let cfg=state.latest;
        if(!initial.homed||initial.state!=='Idle'||!initial.mpos?.every(Number.isFinite)||!state.probePinKnown||state.probePinActive)throw Error('Home the machine and confirm a clear probe at idle before starting.');
        if(!limits.zHomePositive)throw Error('This workflow requires positive-up Z.');
        if(resumeRecord){
            const bedStart=resumeRecord.bedStartMpos;
            if(!bedStart?.every(Number.isFinite))throw Error('Saved scan has no valid bed-probe position; start a new scan instead.');
            if(initial.mpos[2]<limits.z.min||initial.mpos[2]>limits.z.max)throw Error(`Current machine Z${initial.mpos[2].toFixed(3)} is outside reported Z travel ${limits.z.min.toFixed(3)}..${limits.z.max.toFixed(3)} mm.`);
            // Re-probe the bed first. Until the new contact establishes Z0, use
            // the machine's safe upper travel limit for the XY return; do not
            // derive a machine coordinate from the saved starting Z.
            const resumeSafeMachineZ=limits.z.max-Z_LIMIT_MARGIN;
            if(initial.mpos[2]<resumeSafeMachineZ-.1){
                validateMachineZ(resumeSafeMachineZ,limits,'Resume bed-probe clearance');
                const lift=await queryController(`G21 G90 G53 G0 Z${resumeSafeMachineZ.toFixed(3)}`,{until:'ok-or-error',timeout:30000,maxLines:60});
                if(!lift.complete||!lift.ok||lift.error)throw Error(`Could not raise to resume clearance before returning to the saved bed point: ${lift.error??lift.lines?.join(' ')??lift.reason}`);
                initial=await waitForIdle();
                if(Math.abs(initial.mpos[2]-resumeSafeMachineZ)>.12)throw Error('Controller did not confirm the full-clearance height for the saved bed point.');
            }
            logHomingDiagnostic('Resume raised to safe machine Z before re-probing bed',{resumeSafeMachineZ,currentMachineZ:initial.mpos[2],zLimits:limits.z});
            await moveXYWithProbeGuard({mode:'mpos',targetMpos:bedStart.slice(0,2),targetWpos:null,label:'to the saved bed-probe point'});
            initial=await currentSnapshot();
            if(initial.state!=='Idle'||!initial.mpos?.every(Number.isFinite)||initial.mpos.slice(0,2).some((v,i)=>Math.abs(v-bedStart[i])>.12))throw Error('Could not return to the saved bed-probe position.');
            logHomingDiagnostic('Resume returned to saved bed-probe position',{bedStartMpos:bedStart,reportedMpos:initial.mpos});
        }else state.bedStartMpos=initial.mpos.slice();
        // Keep the first bed probe inside the controller's soft-limit boundary.
        // Using the exact travel limit triggers Alarm 2 on some controllers.
        const available=initial.mpos[2]-limits.z.min-Z_LIMIT_MARGIN;
        if(available<=.001)throw Error('Not enough Z travel remains to probe the bed.');
        const feed=cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed;
        if(state.stopScan)throw Error('Stopped before the bed probe.');
        setOriginMessage('Probing the bed…');
        const bedTimeout=Math.max(120000,Math.ceil(available/feed*60000+30000));
        const capture={baseline:state.probeContactSequence,report:null};state.activeProbeCapture=capture;
        let bed,stopped,contact;
        try{
            bed=await queryProbeController(`G54 G21 G91 G38.2 Z${(-available).toFixed(3)} F${feed}`,{timeout:bedTimeout,maxLines:80});
            if(bed.error)throw Error(`Bed probe failed: ${bed.error}`);
            if(!parseOptionalProbe(bed))bed=await recoverMissingProbeReport(bed,'Bed probe',bedTimeout,capture);
            if(!parseOptionalProbe(bed)){
                await retractToKnownBedProbeStart(initial,limits);
                capture.baseline=state.probeContactSequence;capture.report=null;
                bed=await queryProbeController(`G54 G21 G91 G38.2 Z${(-available).toFixed(3)} F${Math.min(cfg.slowFeed,feed)}`,{timeout:bedTimeout,maxLines:80});
                if(bed.error)throw Error(`Bed probe retry failed: ${bed.error}`);
                if(!parseOptionalProbe(bed))bed=await recoverMissingProbeReport(bed,'Bed probe retry',bedTimeout,capture);
            }
            stopped=await waitForIdle(bedTimeout);if(state.stopScan)throw Error('Stopped after the bed probe.');
            const absolute=await queryController('G90',{until:'ok-or-error',timeout:5000,maxLines:20});
            if(!absolute.complete||!absolute.ok||absolute.error)throw Error(`Bed probe ended, but the controller did not confirm G90: ${absolute.error??absolute.lines?.join(' ')??absolute.reason}`);
            if(capture.report&&!bed.lines?.includes(capture.report.line))bed={...bed,lines:[...(bed.lines??[]),capture.report.line]};
            contact=probeContact(bed,'Bed probe');
        }finally{if(state.activeProbeCapture===capture)state.activeProbeCapture=null;}
        const sideZ=0.75*cfg.diameter,retract=contact.mpos[2]+sideZ;
        if(retract>limits.z.max-Z_LIMIT_MARGIN||retract<limits.z.min+Z_LIMIT_MARGIN)throw Error('The 0.75D perimeter height exceeds Z travel. No work offset was changed.');
        const offset=stopped.mpos.map((v,i)=>v-contact.mpos[i]);
        const set=await queryController(`G21 G90 G10 L20 P1 X${offset[0].toFixed(3)} Y${offset[1].toFixed(3)} Z${offset[2].toFixed(3)}`,{until:'ok-or-error',timeout:10000,maxLines:40});
        if(!set.complete||!set.ok||set.error)throw Error('Controller did not accept the bed work offset.');
        state.wposZeroMachine=contact.mpos.slice();state.bedWposZ=0;state.bedOriginWpos=[0,0,0];state.rectangleOriginMachine=contact.mpos.slice();
        if(resumeRecord){
            const previousBedOrigin=savedBedMachineOrigin(resumeRecord);
            const delta=rebaseIncompleteScan(resumeRecord,state.wposZeroMachine,previousBedOrigin);
            restoreIncompleteScan(resumeRecord);
            logHomingDiagnostic('Saved scan rebased to the newly probed bed',{delta,previousBedOrigin,derivedPreviousBedOrigin:!resumeRecord.wposZeroMachine?.every(Number.isFinite),newWposZeroMachine:state.wposZeroMachine});
            const checkpoint=state.scanCheckpoint,surfacePoints=state.polygonSurfacePoints.filter(point=>point.scanStage==='top-surface');
            if(checkpoint?.phase==='perimeter'&&surfacePoints.length){
                const last=surfacePoints.at(-1),x=last.probeX??last.x,y=last.probeY??last.y;
                checkpoint.phase='surface';checkpoint.stage='top-surface';checkpoint.nextIndex=Number.isInteger(last.scanIndex)?last.scanIndex+1:surfacePoints.length;
                checkpoint.lastLocationWpos=[x,y,last.z];checkpoint.lastProbe={x,y,z:last.z};checkpoint.cursor=null;checkpoint.pendingObservation=null;checkpoint.traceContacts=null;delete checkpoint.task;
                logHomingDiagnostic('Legacy surface checkpoint corrected before resume',{stage:'top-surface',nextIndex:checkpoint.nextIndex,lastProbe:checkpoint.lastProbe,discardedPerimeterCursor:true});
            }
        }
        const release=await queryController(`G90 G53 G0 Z${retract.toFixed(3)}`,{until:'ok-or-error',timeout:30000,maxLines:60});
        if(!release.complete||!release.ok||release.error)throw Error('Could not retract to the 0.75D perimeter height.');
        const ready=await waitForIdle();await refreshScanStatus();
        if(!ready.wpos?.every(Number.isFinite)||Math.abs(ready.wpos[2]-sideZ)>.15||!state.probePinKnown||state.probePinActive)throw Error('Controller did not confirm a clear probe at the 0.75D perimeter height.');
        bedMaxProbeLengthMm=limits.z.max-Z_LIMIT_MARGIN-contact.mpos[2]-FIXED_VERTICAL_CLEARANCE_MM;
        if(enforceProbeLengthLimit(bedMaxProbeLengthMm,'measured bed-to-Z-limit clearance')){
            update();
            persistSettingsSoon();
            cfg=state.latest;
        }else{
            const activeLimit=maximumProbeLengthMm();
            if(Number.isFinite(activeLimit))$('usableLength').max=(Math.floor((activeLimit-1e-8)*10)/10).toFixed(1);
        }
        const safeZ=fullClearanceHeight(cfg),safeMachineZ=contact.mpos[2]+safeZ;
        if(safeMachineZ>limits.z.max-Z_LIMIT_MARGIN||safeMachineZ<limits.z.min+Z_LIMIT_MARGIN){
            const minSafeMachineZ=limits.z.min+Z_LIMIT_MARGIN;
            const maxSafeHeight=limits.z.max-Z_LIMIT_MARGIN-contact.mpos[2];
            const error=new Error(`Bed probe succeeded and the probe was released, but L + clearance (${safeZ.toFixed(2)} mm above bed) exceeds available safe Z travel (${(minSafeMachineZ-contact.mpos[2]).toFixed(2)} to ${maxSafeHeight.toFixed(2)} mm above bed). Required machine Z is ${safeMachineZ.toFixed(3)} mm; allowed range is ${minSafeMachineZ.toFixed(3)} to ${(limits.z.max-Z_LIMIT_MARGIN).toFixed(3)} mm. Reduce L or reposition the part to provide more Z clearance before scanning.`);
            error.operatorRecoveryNotRequired=true;
            throw error;
        }
        state.machinePosition=ready.mpos;state.workPosition=ready.wpos;state.originSafeRetract=true;
        setOriginMessage(`Bed found at WPOS Z0; starting the perimeter scan.`);
        if(state.stopScan)throw Error('Stopped after the bed probe.');
        await runSimplifiedScan(cfg,limits,{resumeRecord});
    }catch(error){
        try{await saveIncompleteScan(error.message);}catch(saveError){logHomingDiagnostic('Could not save incomplete scan after failure',{message:saveError.message,scanError:error.message});}
        if(state.workflowRunning&&!state.stopScan&&!state.recoveryCanceled&&!state.recoveryDialogOpen){
            try{
                const restartAdvice=state.incompleteScan
                    ?'Once resolved, select Start Probe to continue the saved scan or start a new scan. The machine will automatically raise to full clearance, return to the saved bed-probe position, and probe the bed again.'
                    :'Once resolved, select Start Probe to begin a new scan from the current probe position. The bed probe will run first.';
                await waitForPolygonRecovery('Workflow error',state.probePinActive,{
                    message:`A non-recoverable error occurred: ${error.message} Check the probe for a stuck state or other machine issue. ${restartAdvice}`,
                    resumeSupported:false
                });
            }catch(recoveryError){logHomingDiagnostic('Workflow recovery dialog failed',{message:recoveryError.message,originalError:error.message});}
        }
        setOriginMessage(error.message);$('scanStatus').textContent=error.message;logHomingDiagnostic('Simplified workflow stopped',{message:error.message,points:state.perimeterPoints.length});
    }
    finally{state.workflowRunning=false;state.scanRunning=false;state.busy=false;if(announced)try{await machine.setBusy(false);}catch{}await checkConnection();update();}
}

async function runSimplifiedScan(cfg,limits,{resumeRecord=null}={}){
    const resuming=Boolean(resumeRecord);
    const scanMode=document.querySelector('input[name="scanMode"]:checked')?.value??'both';
    state.scanRunning=true;
    if(!resuming){state.perimeterPoints=[];state.rawPerimeterPoints=[];state.compensationApplied=false;state.polygonSurfacePoints=[];state.surfacePreviewBoundary=null;state.surfaceRings=[];state.surfaceCenter=null;state.surfaceComplete=false;state.fullSurfaceAvailable=false;state.polygonMesh=null;state.recesses=[];state.tracingRecess=false;state.scanCheckpoint={phase:'perimeter',stage:'outer-perimeter',cursor:null,lastLocationWpos:null,lastProbe:null};}
    $('surfaceStl').value='';$('surfaceStlStatus').textContent='';renderPerimeterResult();updateLiveStatus();
    const safeZ=fullClearanceHeight(cfg),bedZ=0,sideZ=bedZ+0.75*cfg.diameter;
    const yMax=limits.y.max-state.wposZeroMachine[1]-Z_LIMIT_MARGIN;
    if(yMax<=0.5)throw Error('The front-bed position leaves no +Y travel for the first edge search.');
    if(resuming){
        const checkpoint=state.scanCheckpoint;
        if(!checkpoint||!['perimeter','surface'].includes(checkpoint.phase))throw Error('The saved scan checkpoint is not supported. Start a new scan.');
        const current=await currentSnapshot();
        if(current.wpos[2]<safeZ-.1)await scanMove([current.wpos[0],current.wpos[1],safeZ],limits,'Resume: raise to full clearance above the bed');
        if(checkpoint.phase==='perimeter'){
            if(!checkpoint.lastLocationWpos?.every(Number.isFinite))throw Error('The saved perimeter checkpoint has no valid last location. Start a new scan.');
            await moveXYWithProbeGuard({mode:'wpos',targetWpos:checkpoint.lastLocationWpos.slice(0,2),targetMpos:null,label:'to the last perimeter position'});
            await scanMove([checkpoint.lastLocationWpos[0],checkpoint.lastLocationWpos[1],sideZ],limits,'Resume: lower to the perimeter probe height');
        }else if(checkpoint.stage==='recess-boundary'&&checkpoint.task?.seed?.x!==undefined){
            const seed=checkpoint.task.seed;
            if(![seed.x,seed.y,seed.z].every(Number.isFinite))throw Error('The saved recess checkpoint has no valid safe floor anchor. Start a new scan.');
            await moveXYWithProbeGuard({mode:'wpos',targetWpos:[seed.x,seed.y],targetMpos:null,label:'to the saved recess interior anchor'});
            const resumeZ=seed.z+0.75*cfg.diameter;
            checkScanTravel([seed.x,seed.y,resumeZ],limits);
            await scanMove([seed.x,seed.y,resumeZ],limits,'Resume: lower above the saved recess interior anchor');
            logHomingDiagnostic('Resume rejoined recess trace from its safe interior anchor',{seed,resumeZ,stage:checkpoint.stage});
        }else{
            if(checkpoint.lastProbe&&Number.isFinite(checkpoint.lastProbe.x)){
                const last=checkpoint.lastProbe;
                await moveXYWithProbeGuard({mode:'wpos',targetWpos:[last.x,last.y],targetMpos:null,label:'to the last surface probe location'});
                const resumeZ=last.z+0.75*cfg.diameter;
                checkScanTravel([last.x,last.y,resumeZ],limits);
                await scanMove([last.x,last.y,resumeZ],limits,'Resume: lower to 0.75D above the last surface probe');
            }else if(checkpoint.stage!=='top-surface'||(checkpoint.nextIndex??0)!==0){
                throw Error('The saved surface checkpoint has no valid probe location. Start a new scan.');
            }
        }
    }else{
        await ultraGuardedDescent([0,0,sideZ],limits,'Lowering at the confirmed bed position',cfg);
        if(state.stopScan)throw Error('Stopped before the perimeter scan.');
    }
    if(state.scanCheckpoint?.phase==='perimeter'){
        await scanPolygonPrototype(cfg,limits,bedZ,{direction:4,initialTarget:[0,yMax],cursor:resuming?state.scanCheckpoint.cursor:null,pendingObservation:resuming?state.scanCheckpoint.pendingObservation:null,checkpointStage:'outer-perimeter'});
        const current=await currentSnapshot();await scanMove([current.wpos[0],current.wpos[1],safeZ],limits,'Perimeter complete: raise to clearance');
        if(scanMode==='perimeter'){
            const surfacePlan=planPolygonSurface(state.perimeterPoints,{diameter:cfg.diameter,spacing:cfg.spacing,maxSamples:MAX_SURFACE_SAMPLES});
            const first=surfacePlan.samples[0];
            if(!first)throw Error('The measured perimeter does not leave a safe location for the first surface-height touch.');
            const heightPoint=await probeSurfacePoint(first.x,first.y,cfg,limits,safeZ,bedZ,'Perimeter-only first surface-height touch');
            state.polygonSurfacePoints=[{...heightPoint,scanStage:'top-surface',scanIndex:0}];
            state.rawPerimeterPoints=state.perimeterPoints.slice();
            state.perimeterPoints=compensateContour(state.perimeterPoints.slice(),cfg.radius);
            state.compensationApplied=true;
            state.polygonMesh=polygonPerimeterMesh(state.perimeterPoints,heightPoint.z,bedZ);
            state.surfaceComplete=true;
            state.scanCheckpoint={phase:'complete',stage:'perimeter-only',nextIndex:1,lastLocationWpos:[heightPoint.x,heightPoint.y,heightPoint.z],lastProbe:{x:heightPoint.x,y:heightPoint.y,z:heightPoint.z}};
            $('resultRepresentation').value='perimeter';
            $('scanStatus').textContent=`Perimeter-only scan complete: ${state.perimeterPoints.length} perimeter contacts and first surface height ${heightPoint.z.toFixed(3)} mm.`;
            renderPerimeterResult();
            await clearIncompleteScan();
            void showScanCompleteDialog();
            return;
        }
        state.scanCheckpoint={phase:'surface',stage:'top-surface',nextIndex:0,lastLocationWpos:null,lastProbe:null};
        persistScanProgressSoon();
    }
    const resumeCheckpoint=resuming&&state.incompleteScan?.checkpoint?.phase==='surface'?state.scanCheckpoint:null;
    await scanPolygonSurfacePrototype(cfg,limits,safeZ,bedZ,{resumeCheckpoint});
    $('scanStatus').textContent=`Scan complete: ${state.perimeterPoints.length} perimeter contacts and ${state.polygonSurfacePoints.length} surface samples.`;
    $('resultRepresentation').value=scanMode==='surface'?'surface':'both';
    renderPerimeterResult();
    await clearIncompleteScan();
    void showScanCompleteDialog();
}

async function showScanCompleteDialog(){
    const dialog=$('scanCompleteDialog');
    if(!dialog||dialog.open)return;
    const representation=$('resultRepresentation')?.selectedOptions[0]?.textContent??'selected model';
    $('scanCompleteMessage').textContent=`The scan completed successfully. ${state.perimeterPoints.length} perimeter contacts and ${state.polygonSurfacePoints?.length??0} surface readings were collected. The Results view and STL export are set to ${representation}.`;
    dialog.showModal();
    await new Promise(resolve=>{
        const finish=()=>{dialog.close();dialog.removeEventListener('cancel',preventCancel);$('exitScanComplete').removeEventListener('click',finish);resolve();};
        const preventCancel=event=>event.preventDefault();
        dialog.addEventListener('cancel',preventCancel);
        $('exitScanComplete').addEventListener('click',finish,{once:true});
    });
}

async function goToRectangleOrigin() {
    const target = state.rectangleOriginMachine;
    if (!target) return;
        const safeWposZ = fullClearanceHeight(state.latest);
    try {
        const snapshot = await currentSnapshot();
        if (snapshot.state !== 'Idle') throw new Error('Wait until the machine is idle before returning to the origin.');
        if (!snapshot.wpos || snapshot.wpos[2] < safeWposZ) throw new Error(`Raise WPOS Z to at least ${safeWposZ.toFixed(2)} mm to clear the part before moving XY.`);
        await runMotion('Return to part-center origin (XY only)', `G90 G53 G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)}`);
    } catch (error) {
        $('originCaptureStatus').textContent = error.message;
    }
}

// Reuses the shared Surface Height Map GOTO XY flow: seed from the active
// DRO mode, validate the entered coordinates against controller travel in
// machine coordinates, raise to safe clearance when needed, guard the XY
// move with the confirmed Pn probe state, and verify the final position.
async function openGotoXYDialog() {
    if (!state.connected || state.busy || !state.controllerHomed || state.motionState !== 'Idle' || state.probeTestRunning) return;
    const position = state.positionMode === 'wpos' ? state.workPosition : state.machinePosition;
    if (!position?.slice(0, 2).every(Number.isFinite)) {
        setOriginMessage(`Cannot open GOTO XY: the ${state.positionMode.toUpperCase()} position is not available yet.`);
        return;
    }
    const dialog = $('gotoXYDialog');
    $('gotoXYMode').textContent = state.positionMode === 'wpos'
        ? 'Enter coordinates in the active work coordinate system (WPOS).'
        : 'Enter machine coordinates (MPOS).';
    $('gotoX').value = position[0].toFixed(3);
    $('gotoY').value = position[1].toFixed(3);
    $('gotoX').disabled = true;
    $('gotoY').disabled = true;
    $('confirmGotoXY').disabled = true;
    $('gotoXYError').className = 'goto-xy-error';
    $('gotoXYError').textContent = 'Reading controller position and travel limits…';
    $('gotoXYError').hidden = false;
    state.gotoXYContext = null;
    dialog.showModal();
    const mode = state.positionMode;
    try {
        const snapshot = await currentSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`GOTO XY requires an idle machine (current state: ${snapshot.state}).`);
        await requireG54Active();
        const limits = await readProbeLimits();
        const zero = state.wposZeroMachine?.every(Number.isFinite)
            ? [...state.wposZeroMachine]
            : snapshot.mpos.map((value, index) => value - snapshot.wpos[index]);
        if (!zero.every(Number.isFinite)) throw new Error('Could not determine the current G54 WPOS-to-machine offset.');
        const offsetX = mode === 'wpos' ? zero[0] : 0;
        const offsetY = mode === 'wpos' ? zero[1] : 0;
        const minX = limits.x.min + Z_LIMIT_MARGIN - offsetX;
        const maxX = limits.x.max - Z_LIMIT_MARGIN - offsetX;
        const minY = limits.y.min + Z_LIMIT_MARGIN - offsetY;
        const maxY = limits.y.max - Z_LIMIT_MARGIN - offsetY;
        const hasSafeOrigin = Boolean(state.rectangleOriginMachine && state.wposZeroMachine && state.originSafeRetract);
        const safeWposZ = hasSafeOrigin ? fullClearanceHeight(state.latest) : snapshot.wpos[2];
        const safeMachineZ = hasSafeOrigin ? zero[2] + safeWposZ : snapshot.mpos[2];
        if (hasSafeOrigin && (!Number.isFinite(safeMachineZ) || safeMachineZ < limits.z.min + Z_LIMIT_MARGIN || safeMachineZ > limits.z.max - Z_LIMIT_MARGIN)) {
            throw new Error(`Full-clearance WPOS Z${safeWposZ.toFixed(3)} maps outside reported machine Z travel.`);
        }
        state.gotoXYContext = { mode, limits, zero, offsetX, offsetY, minX, maxX, minY, maxY, safeWposZ, safeMachineZ, hasSafeOrigin };
        logHomingDiagnostic('GOTO XY dialog ready', {
            mode, seedPosition: position, mpos: snapshot.mpos, wpos: snapshot.wpos,
            zero, offsetX, offsetY, machineLimits: { x: limits.x, y: limits.y, z: limits.z },
            allowedRange: { x: [minX, maxX], y: [minY, maxY] }, hasSafeOrigin, safeMachineZ
        });
        $('gotoX').min = minX.toFixed(3); $('gotoX').max = maxX.toFixed(3); $('gotoX').disabled = false;
        $('gotoY').min = minY.toFixed(3); $('gotoY').max = maxY.toFixed(3); $('gotoY').disabled = false;
        document.querySelector('.goto-xy-safety').textContent = hasSafeOrigin
            ? 'Z raises to full clearance before XY travel when needed. The XY move stops if the probe signal activates.'
            : 'Z stays at its current height because no safe retract height has been confirmed yet. Make sure the tool is clear before moving. The XY move stops if the probe signal activates.';
        $('gotoXYError').textContent = `Allowed ${mode.toUpperCase()} range: X ${minX.toFixed(3)} to ${maxX.toFixed(3)} mm; Y ${minY.toFixed(3)} to ${maxY.toFixed(3)} mm. XY travel is guarded by the probe input.`;
        updateGotoXYValidation();
        $('gotoX').focus();
    } catch (error) {
        $('gotoXYError').className = 'goto-xy-error';
        $('gotoXYError').textContent = `Cannot validate this move: ${error.message}. Move is disabled.`;
        $('gotoXYError').hidden = false;
        logHomingDiagnostic('GOTO XY dialog validation failed', { message: error.message, mode });
    }
}

function updateGotoXYValidation() {
    const context = state.gotoXYContext;
    const button = $('confirmGotoXY');
    const error = $('gotoXYError');
    if (!context) { button.disabled = true; return; }
    const xText = $('gotoX').value.trim(), yText = $('gotoY').value.trim();
    const x = Number(xText), y = Number(yText);
    if (!state.connected || !state.controllerHomed || state.motionState !== 'Idle' || state.busy) {
        button.disabled = true;
        error.className = 'goto-xy-error';
        error.textContent = 'GOTO XY is available when the connected machine is homed and idle.';
        error.hidden = false;
        return;
    }
    if (!state.probePinKnown || state.probePinActive) {
        button.disabled = true;
        error.className = 'goto-xy-error';
        error.textContent = state.probePinActive ? 'Clear the probe input before moving.' : 'Waiting for the controller to report a clear probe input.';
        error.hidden = false;
        return;
    }
    if (!xText || !yText || ![x, y].every(Number.isFinite)) {
        button.disabled = true;
        error.className = 'goto-xy-error';
        error.textContent = 'Enter valid X and Y coordinates in millimetres.';
        error.hidden = false;
        return;
    }
    try {
        const machineTarget = validateMachineTarget({ x: x + context.offsetX, y: y + context.offsetY }, context.limits);
        button.disabled = false;
        error.className = 'goto-xy-error success';
        error.textContent = `Target is within machine travel (MPOS X${machineTarget.x.toFixed(3)} Y${machineTarget.y.toFixed(3)}).`;
        context.validatedTarget = { input: { x, y }, machine: machineTarget };
    } catch {
        button.disabled = true;
        error.className = 'goto-xy-error';
        error.textContent = `Target is outside machine XY travel. Allowed ${context.mode.toUpperCase()} range: X ${context.minX.toFixed(3)} to ${context.maxX.toFixed(3)} mm; Y ${context.minY.toFixed(3)} to ${context.maxY.toFixed(3)} mm.`;
    }
    error.hidden = false;
}

// Shared library helper: convert the requested coordinates to machine space
// and reject non-finite or out-of-travel targets before any motion is sent.
function validateMachineTarget({ x, y }, limits) {
    const maxX = limits.x.max;
    const maxY = limits.y.max;
    if (![limits.x.min, maxX, limits.y.min, maxY].every(Number.isFinite)) {
        throw new Error('Could not read valid machine XY travel limits from $23/$130/$131.');
    }
    if (![x, y].every(Number.isFinite)) throw new Error('Enter valid X and Y positions.');
    if (x < limits.x.min + Z_LIMIT_MARGIN || x > maxX - Z_LIMIT_MARGIN
        || y < limits.y.min + Z_LIMIT_MARGIN || y > maxY - Z_LIMIT_MARGIN) {
        throw new Error(`Position must be within machine travel: X ${limits.x.min + Z_LIMIT_MARGIN}–${maxX - Z_LIMIT_MARGIN} mm, Y ${limits.y.min + Z_LIMIT_MARGIN}–${maxY - Z_LIMIT_MARGIN} mm.`);
    }
    return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
}

function validateMachineZ(z, limits, label = 'Position') {
    const minZ = limits.z.min + Z_LIMIT_MARGIN;
    const maxZ = limits.z.max - Z_LIMIT_MARGIN;
    if (!Number.isFinite(z) || z < minZ || z > maxZ) {
        throw new Error(`${label} machine Z${Number.isFinite(z) ? z.toFixed(3) : z} mm is outside allowed travel ${minZ.toFixed(3)} to ${maxZ.toFixed(3)} mm.`);
    }
    return Number(z.toFixed(4));
}

// Shared library behavior adapted to this plugin's parser: monitor the gSender
// status stream while an ordinary XY move is in flight and feed-hold on Pn:P.
async function moveXYWithProbeGuard({ mode, targetWpos, targetMpos, label }) {
    // MPOS targets use G53 directly, avoiding a work-offset round trip. Both
    // paths intentionally omit Z so an XY-only command cannot retrigger a Z
    // soft-limit check at an unchanged endpoint such as machine Z0.
    const command = mode === 'mpos'
        ? `G21 G90 G53 G0 X${targetMpos[0].toFixed(3)} Y${targetMpos[1].toFixed(3)}`
        : `G21 G90 G54 G0 X${targetWpos[0].toFixed(3)} Y${targetWpos[1].toFixed(3)}`;
    const guard = { active: false, triggered: false, holdPromise: null, holdError: null, label };
    state.xyMoveGuard = guard;
    try {
        const sequence = state.probeStatusSequence;
        if (!await waitForProbeStatus(sequence, 1500)) throw new Error('Could not get a fresh probe status before GOTO XY; no move was sent.');
        if (!state.probePinKnown || state.probePinActive) throw new Error('GOTO XY requires a confirmed clear probe input.');
        guard.active = true;
        logHomingDiagnostic('GOTO XY move TX', {
            mode, label, targetWpos, targetMpos, startMpos: state.machinePosition,
            startWpos: state.workPosition, command, statusSequence: state.probeStatusSequence
        });
        const result = await queryController(command, { until: 'ok-or-error', timeout: 30000, maxLines: 80 });
        logHomingDiagnostic('GOTO XY move RX', { mode, label, command, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
        if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
        const deadline = Date.now() + 120000;
        let stableReports = 0;
        while (Date.now() < deadline) {
            if (guard.triggered) {
                await guard.holdPromise;
                const holdDeadline = Date.now() + 15000;
                while (Date.now() < holdDeadline && !['Idle', 'Hold:0', 'Hold:1'].includes(state.motionState)) {
                    await refreshScanStatus();
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
                if (guard.holdError) throw new Error(`Probe triggered during ${label}; gSender could not send feed hold: ${guard.holdError.message}. Check the machine immediately.`);
                throw new Error(`Probe triggered during ${label}. Motion was feed-held; clear the probe and inspect the machine before moving again.`);
            }
            const snapshot = await refreshScanStatus();
            const expected = mode === 'mpos' ? targetMpos : targetWpos;
            const actual = mode === 'mpos' ? snapshot.mpos : snapshot.wpos;
            const atTarget = actual?.slice(0, 2).every((value, index) => Math.abs(value - expected[index]) <= 0.12);
            stableReports = atTarget && snapshot.state === 'Idle' ? stableReports + 1 : 0;
            if (stableReports >= 2) {
                logHomingDiagnostic('GOTO XY target reached', { mode, label, expectedXY: expected.slice(0, 2), reportedMpos: snapshot.mpos, reportedWpos: snapshot.wpos });
                return snapshot;
            }
            if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state during GOTO XY. Resolve the alarm before continuing.');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for GOTO XY to finish: ${label}.`);
    } finally {
        guard.active = false;
        if (state.xyMoveGuard === guard) state.xyMoveGuard = null;
    }
}

async function executeGotoXY() {
    const context = state.gotoXYContext;
    const x = Number($('gotoX').value), y = Number($('gotoY').value);
    if (!context || $('confirmGotoXY').disabled || state.busy || !state.controllerHomed) return;
    const mode = context.mode;
    const snapshot = await currentSnapshot();
    if (snapshot.state !== 'Idle') throw new Error(`GOTO XY requires an idle machine (current state: ${snapshot.state}).`);
    if (!state.probePinKnown || state.probePinActive) throw new Error('GOTO XY requires a confirmed clear probe input.');
    if (mode === 'wpos') await requireG54Active();
    const limits = await readProbeLimits();
    const zero = context.zero;
    const liveOffset = snapshot.mpos.map((value, index) => value - snapshot.wpos[index]);
    if (!zero?.every(Number.isFinite) || liveOffset.some((value, index) => Math.abs(value - zero[index]) > 0.15)) {
        throw new Error('The active G54 offsets changed after opening GOTO XY. Close the dialog and open it again.');
    }
    // This command preserves the reported current Z unless a confirmed safe
    // origin requires a lift. Do not reject an unchanged endpoint such as
    // machine Z0 just because the margin reserves it from new Z moves.
    const targetMachine = validateMachineTarget({ x: x + context.offsetX, y: y + context.offsetY }, limits);
    const targetWpos = [targetMachine.x - zero[0], targetMachine.y - zero[1], snapshot.wpos[2]];
    logHomingDiagnostic('GOTO XY execution plan', {
        mode, input: { x, y }, targetMachine, targetWpos,
        startMpos: snapshot.mpos, startWpos: snapshot.wpos,
        liveOffset, validatedTarget: context.validatedTarget ?? null,
        machineLimits: { x: limits.x, y: limits.y, z: limits.z }, hasSafeOrigin: context.hasSafeOrigin
    });
    const safeMachineZ = context.safeMachineZ;
    state.busy = true;
    $('gotoXYDialog').close();
    updateLiveStatus();
    let busyAnnounced = false;
    try {
        await machine.setBusy(true, `GOTO ${mode.toUpperCase()} X${x.toFixed(3)} Y${y.toFixed(3)}`);
        busyAnnounced = true;
        const fresh = await currentSnapshot();
        if (fresh.state !== 'Idle') throw new Error(`Machine is no longer idle (current state: ${fresh.state}).`);
        if (context.hasSafeOrigin && fresh.mpos[2] < safeMachineZ - 0.1) {
            validateMachineTarget({ x: targetMachine.x, y: targetMachine.y }, limits);
            validateMachineZ(safeMachineZ, limits, 'GOTO XY clearance');
            const liftCommand = `G21 G90 G53 G0 Z${safeMachineZ.toFixed(3)}`;
            logHomingDiagnostic('GOTO XY clearance TX', { mode, command: liftCommand, startMpos: fresh.mpos, startWpos: fresh.wpos, targetMachineZ: safeMachineZ });
            const lift = await queryController(liftCommand, { until: 'ok-or-error', timeout: 30000, maxLines: 60 });
            logHomingDiagnostic('GOTO XY clearance RX', { mode, command: liftCommand, complete: lift.complete, ok: lift.ok, error: lift.error, reason: lift.reason, lines: lift.lines });
            if (!lift.complete || !lift.ok || lift.error) throw new Error(`Could not raise Z to full clearance: ${lift.error ?? lift.lines?.join(' ') ?? lift.reason}`);
            const lifted = await waitForIdle();
            if (Math.abs(lifted.mpos[2] - safeMachineZ) > 0.12) throw new Error('Controller did not confirm the full-clearance Z position.');
        }
        const finalWpos = [targetWpos[0], targetWpos[1], context.hasSafeOrigin ? Math.max(snapshot.wpos?.[2] ?? 0, context.safeWposZ) : snapshot.wpos[2]];
        validateMachineTarget({ x: zero[0] + finalWpos[0], y: zero[1] + finalWpos[1] }, limits);
        if (context.hasSafeOrigin && finalWpos[2] > (snapshot.wpos?.[2] ?? finalWpos[2]) + 0.1) {
            validateMachineZ(zero[2] + finalWpos[2], limits, 'GOTO XY final clearance');
        }
        const arrived = await moveXYWithProbeGuard({
            mode,
            targetWpos: finalWpos,
            targetMpos: [targetMachine.x, targetMachine.y],
            label: `to ${mode.toUpperCase()} X${x.toFixed(3)} Y${y.toFixed(3)}`
        });
        const expectedMpos = [targetMachine.x, targetMachine.y];
        if (Math.abs(arrived.mpos[0] - expectedMpos[0]) > 0.12 || Math.abs(arrived.mpos[1] - expectedMpos[1]) > 0.12) {
            throw new Error(`GOTO XY did not reach the requested target. Reported machine XY ${arrived.mpos[0].toFixed(3)}, ${arrived.mpos[1].toFixed(3)}.`);
        }
        state.machinePosition = arrived.mpos;
        state.workPosition = arrived.wpos;
        setOriginMessage(context.hasSafeOrigin
            ? `Arrived at ${mode.toUpperCase()} X${x.toFixed(3)} Y${y.toFixed(3)} at full-clearance height.`
            : `Arrived at ${mode.toUpperCase()} X${x.toFixed(3)} Y${y.toFixed(3)} with Z preserved.`);
        logHomingDiagnostic('GOTO XY completed', { mode, target: [x, y], machineTarget: expectedMpos, reportedMpos: arrived.mpos, reportedWpos: arrived.wpos });
    } catch (error) {
        setOriginMessage(`GOTO XY failed: ${error.message}`);
        logHomingDiagnostic('GOTO XY failed', {
            mode, target: [x, y], machineTarget: [targetMachine.x, targetMachine.y],
            targetWpos, startMpos: snapshot.mpos, startWpos: snapshot.wpos,
            message: error.message, motionState: state.motionState,
            currentMpos: state.machinePosition, currentWpos: state.workPosition,
            probePinKnown: state.probePinKnown, probePinActive: state.probePinActive
        });
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        await checkConnection();
    }
}

function scanMachinePosition(wpos, limits) {
    const zero = state.wposZeroMachine;
    if (!zero || !wpos.every(Number.isFinite)) throw new Error('Probe the WPOS origin again before scanning.');
    // G54 is a translation: WPOS = MPOS - work offset on every axis. $23
    // selects the signed machine-travel range, but does not reverse WPOS math.
    return [zero[0] + wpos[0], zero[1] + wpos[1], zero[2] + wpos[2]];
}

function checkScanTravel(wpos, limits) {
    const mpos = scanMachinePosition(wpos, limits);
    const axes = [limits.x, limits.y, limits.z];
    for (let index = 0; index < 3; index += 1) {
        if (mpos[index] < axes[index].min + Z_LIMIT_MARGIN || mpos[index] > axes[index].max - Z_LIMIT_MARGIN) {
            throw new Error(`Planned ${['X', 'Y', 'Z'][index]} move would exceed reported machine travel. WPOS target ${wpos.map((value) => value.toFixed(2)).join(', ')}; machine target ${mpos.map((value) => value.toFixed(2)).join(', ')}.`);
        }
    }
    return mpos;
}

async function refreshScanStatus(timeoutMs = 3000) {
    if(state.recoveryCanceled)throw new Error('Scan canceled from the operator recovery dialog.');
    const freshForMs = 500;
    const queryCooldownMs = 750;
    const latestStatusAt = () => Math.max(state.lastProbeStatusAt || 0, state.lastControllerStatusAt || 0);
    let requestCount = state.statusQueryAttempts;
    let lastRequestError = null;
    const ageBeforeRequest = Date.now() - latestStatusAt();
    if (ageBeforeRequest >= freshForMs && Date.now() - state.lastStatusQueryAt >= queryCooldownMs) {
        if (!state.statusOutageStartedAt) state.statusOutageStartedAt = latestStatusAt() || Date.now();
        state.statusQueryAttempts += 1;
        requestCount = state.statusQueryAttempts;
        state.lastStatusQueryAt = Date.now();
        try {
            const requestTimeout = Math.max(150, Math.min(350, timeoutMs));
            const fresh = await requestFreshControllerStatus(requestTimeout);
            logHomingDiagnostic('Perimeter status query returned a fresh controller report', {
                requestCount,
                status: fresh.line,
                state: fresh.state,
                workPosition: state.workPosition
            });
        } catch (error) {
            lastRequestError = error.message;
            state.lastStatusQueryError = lastRequestError;
            logHomingDiagnostic('Perimeter status query did not return a fresh controller report', {
                requestCount,
                message: lastRequestError,
                elapsedMs: Date.now() - state.lastStatusQueryAt
            });
        }
    }
    const statusAge = Date.now() - latestStatusAt();
    if (statusAge >= timeoutMs && !state.recoveryDialogOpen) {
        if(state.statusRecoveryPromise)return state.statusRecoveryPromise;
        const details = {
            timeoutMs,
            requestCount: state.statusQueryAttempts,
            outageDurationMs: state.statusOutageStartedAt ? Date.now() - state.statusOutageStartedAt : statusAge,
            lastRequestError: lastRequestError ?? state.lastStatusQueryError,
            statusAge,
            probeStatusAt: state.lastProbeStatusAt,
            controllerStatusAt: state.lastControllerStatusAt,
            motionState: state.motionState,
            workPosition: state.workPosition,
            lastStatusLine: state.lastProbeStatusLine
        };
        const recovery= (async()=>{
            logHomingDiagnostic('Controller status watchdog requested feed hold and opened operator recovery', details);
            dispatchFeedHold('Controller status timeout');
            const recovered = await waitForPolygonRecovery('Controller status timeout', state.probePinActive, {
                message: `No fresh controller status arrived after ${details.requestCount} request${details.requestCount === 1 ? '' : 's'} over ${details.timeoutMs} ms. A feed-hold request was sent, but motion is not considered stopped until a fresh Idle status arrives.`,
                resumeSupported: true
            });
            if (!recovered) throw new Error('Scan canceled from the controller status recovery dialog.');
            return recovered;
        })();
        state.statusRecoveryPromise=recovery;
        try{return await recovery;}finally{if(state.statusRecoveryPromise===recovery)state.statusRecoveryPromise=null;}
    }
    if (state.motionState === 'Alarm' && !state.recoveryDialogOpen) {
        const recovered = await waitForPolygonRecovery('Controller alarm', state.probePinActive, {
            message: 'The controller entered Alarm. Clear the alarm in gSender, inspect the probe and motion path, then continue only when the machine is idle and the probe is clear.',
            resumeSupported: true
        });
        if (!recovered) throw new Error('Scan canceled from the controller alarm recovery dialog.');
        return recovered;
    }
    return currentSnapshot();
}

async function waitForScanPosition(target, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await refreshScanStatus();
        if (snapshot.state === 'Idle' && snapshot.wpos?.every((value, index) => Math.abs(value - target[index]) <= 0.12)) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for WPOS ${target.map((value) => value.toFixed(2)).join(', ')}.`);
}

async function waitForXYScanPosition(target, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const snapshot = await refreshScanStatus();
        if (snapshot.state === 'Idle' && snapshot.wpos?.slice(0, 2).every((value, axis) => Math.abs(value - target[axis]) <= 0.12)) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for WPOS X${target[0].toFixed(2)} Y${target[1].toFixed(2)}.`);
}

async function scanMove(target, limits, label, allowProbeActive = false) {
    if (state.stopScan) throw new Error('Scan stopped by user.');
    if (!state.probePinKnown || (state.probePinActive && !allowProbeActive)) throw new Error('Probe input is not confirmed clear before a non-probing move.');
    checkScanTravel(target, limits);
    $('scanStatus').textContent = label;
    const command = `G21 G90 G54 G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)}`;
        const result = await queryController(command, { until: 'ok-or-error', timeout: 60000, maxLines: 80 });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const snapshot = await waitForScanPosition(target);
    if (state.probePinActive && !allowProbeActive) throw new Error(`Probe triggered during ${label}. Machine stopped during the current move; inspect the probe and part before continuing.`);
    return snapshot;
}

function parseOptionalProbe(result) {
    const line = (result.lines ?? []).map(value=>String(value).trim()).find((value) => value.startsWith('[PRB:'));
    if (!line) return null;
    const match = line.match(/^\[PRB:([^:]+):([01])\]$/);
    const fields=match?.[1].split(',');
    const numeric=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
    if(!fields||fields.length<3||fields.some(field=>!numeric.test(field.trim())))throw new Error(`Invalid probe report: ${line}`);
    const axes=fields.map(Number),mpos=axes.slice(0,3);
    if (!axes.every(Number.isFinite)) throw new Error(`Invalid probe report: ${line}`);
    return { mpos, triggered: match[2]==='1', line };
}

async function probeRay({ center, angle, startRadius, endRadius, feed, height, limits, label }) {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    if (state.stopScan) throw new Error('Scan stopped by user before the next perimeter probe.');
    if (state.probePinActive || !state.probePinKnown) throw new Error('Probe must be reported clear before starting a perimeter probe.');
    const target = [center[0] + ux * endRadius, center[1] + uy * endRadius, height];
    checkScanTravel(target, limits);
    const distance = Math.max(0, startRadius - endRadius);
    const command = `G21 G90 G54 G38.3 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} F${feed}`;
    const timeout = Math.max(30000, Math.ceil((distance / feed) * 60000 + 15000));
    $('scanStatus').textContent = `${label} · one continuous inward probe over ${distance.toFixed(1)} mm`;
    logHomingDiagnostic('Perimeter radial probe TX', { label, startRadius, endRadius, inwardDistance: distance, targetWpos: target, command, timeout });
    const result = await queryProbeController(command, { timeout, maxLines: 80 });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    logHomingDiagnostic('Perimeter radial probe RX', { label, complete: result.complete, ok: result.ok, error: result.error, lines: result.lines });
    const report = parseOptionalProbe(result);
    let triggered = Boolean(report?.triggered);
    let contactMpos = report?.triggered ? report.mpos : null;
    let snapshot = await refreshScanStatus();
    const deadline = Date.now() + timeout;
    let idleWithoutContactReports = 0;
    while (Date.now() < deadline) {
        if (state.probePinActive) {
            triggered = true;
            contactMpos = snapshot.mpos;
        }
        if (snapshot.state === 'Idle') {
            if (triggered) break;
            if (snapshot.wpos?.every((value, index) => Math.abs(value - target[index]) <= 0.12)) {
                await waitForScanPosition(target);
                logHomingDiagnostic('Perimeter radial probe completed without contact', { label, targetWpos: target, stoppedWpos: snapshot.wpos });
                return null;
            }
            idleWithoutContactReports += 1;
            if (idleWithoutContactReports >= 3) {
                throw new Error(`${label}: controller stopped the probe move short of its endpoint, but no Pn:P or [PRB:…:1] contact report arrived. Position ${snapshot.wpos?.map((value) => value.toFixed(3)).join(', ') ?? 'unavailable'}.`);
            }
        } else {
            idleWithoutContactReports = 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = await refreshScanStatus();
    }
    if (snapshot.state !== 'Idle') throw new Error(`${label}: timed out waiting for the controller to finish the perimeter probe move.`);
    if (triggered) {
        const mpos = report?.triggered ? report.mpos : (contactMpos ?? snapshot.mpos);
        if (!mpos?.every(Number.isFinite)) throw new Error(`${label}: probe triggered but its stopped position was unavailable.`);
        const radius = (mpos[0] - state.wposZeroMachine[0]) * ux + (mpos[1] - state.wposZeroMachine[1]) * uy;
        logHomingDiagnostic('Perimeter probe contact detected; preparing immediate release', {
            label, contactMpos: mpos, contactRadius: radius, stoppedWpos: snapshot.wpos,
            probePinKnown: state.probePinKnown, probePinActive: state.probePinActive
        });
        return { mpos, radius };
    }
    throw new Error(`${label}: controller stopped before the target without reporting a probe contact.`);
}

function predictNextContactRadius(history, nominalRadius, sampleSpacing) {
    if (history.length < 2) return nominalRadius;
    // Samples are evenly spaced in angle. Fit a local line to the last five
    // measured radii from the configured center, then extrapolate one sample.
    const recent = history.slice(-5);
    const xs = recent.map((_radius, index) => index);
    const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const yMean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
    const numerator = recent.reduce((sum, value, index) => sum + (xs[index] - xMean) * (value - yMean), 0);
    const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    const slope = denominator > 0 ? numerator / denominator : 0;
    const prediction = yMean + slope * (xs.length - xMean);
    // A bad contact or abrupt feature must not make one approach jump
    // arbitrarily far from the last measured contour.
    const maxChange = Math.max(0.5, sampleSpacing * 2);
    const last = history[history.length - 1];
    return Math.max(0.5, Math.min(last + maxChange, Math.max(last - maxChange, prediction)));
}

async function waitForProbeClearAfterRetract(limits, target, label, { preserveZ = false } = {}) {
    const beforeMove = preserveZ ? await currentSnapshot() : null;
    if (preserveZ && !Number.isFinite(beforeMove?.wpos?.[2])) throw new Error(`${label}: cannot preserve Z because the current WPOS Z is unavailable.`);
    const motionTarget = preserveZ ? [target[0], target[1], beforeMove.wpos[2]] : target;
    let machineTarget;
    try {
        machineTarget = checkScanTravel(motionTarget, limits);
    } catch (error) {
        logHomingDiagnostic('Perimeter probe release target rejected by travel check', { label, targetWpos: motionTarget, probePinActive: state.probePinActive, preserveZ, message: error.message });
        throw error;
    }
    const command = `G21 G90 G54 G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)}${preserveZ ? '' : ` Z${target[2].toFixed(3)}`}`;
    $('scanStatus').textContent = `${label}: moving outward until the probe input clears…`;
    logHomingDiagnostic('Perimeter probe release TX', { label, targetWpos: motionTarget, requestedWpos: target, targetMpos: machineTarget, preserveZ, probePinActive: state.probePinActive, command });
        const result = await queryController(command, { until: 'ok-or-error', timeout: 60000, maxLines: 80 });
    logHomingDiagnostic('Perimeter probe release RX', { label, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const snapshot = preserveZ ? await waitForXYScanPosition(target) : await waitForScanPosition(target);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        // After the controller has reported Pn once, Grbl omits Pn when no
        // pins are active. The status parser therefore treats no Pn:P as the
        // cleared state needed before continuing around the perimeter.
        if (state.probePinReportingSeen && state.probePinKnown && !state.probePinActive) {
            logHomingDiagnostic('Perimeter probe release confirmed', {
                label,
                targetWpos: motionTarget,
                statusSequence: state.probeStatusSequence,
                statusLine: state.lastProbeStatusLine,
                pinFieldPresent: state.lastProbeStatusHadPinField,
                probePinReportingSeen: state.probePinReportingSeen,
                probePinActive: state.probePinActive
            });
            return snapshot;
        }
        await refreshScanStatus();
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    logHomingDiagnostic('Perimeter probe release timed out', {
        label,
        targetWpos: target,
        statusSequence: state.probeStatusSequence,
        statusLine: state.lastProbeStatusLine,
        pinFieldPresent: state.lastProbeStatusHadPinField,
        probePinReportingSeen: state.probePinReportingSeen,
        probePinKnown: state.probePinKnown,
        probePinActive: state.probePinActive
    });
    throw new Error(`${label}: probe did not report released after retracting. Stop and inspect it.`);
}

async function probeTravelLine(startWpos, targetXY, limits, label, feed = 100) {
    if (!state.probePinKnown || state.probePinActive) throw new Error(`${label}: probe input must be confirmed clear before moving.`);
    const target = [targetXY[0], targetXY[1], startWpos[2]];
    checkScanTravel(target, limits);
    const dx = target[0] - startWpos[0], dy = target[1] - startWpos[1];
    const distance = Math.hypot(dx, dy);
    if (distance < 0.05) return { contact: null, snapshot: await currentSnapshot(), direction: [0, 0] };
    const direction = [dx / distance, dy / distance];
    const command = `G21 G90 G54 G38.3 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} F${feed}`;
    const timeout = Math.max(30000, Math.ceil((distance / feed) * 60000 + 15000));
    $('scanStatus').textContent = `${label}: probing the XY travel path…`;
    logHomingDiagnostic('Perimeter XY travel-probe TX', { label, startWpos, targetWpos: target, distance, command, timeout });
    const result = await queryProbeController(command, { timeout, maxLines: 80 });
    logHomingDiagnostic('Perimeter XY travel-probe RX', { label, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: XY travel probe was not accepted: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const report = parseOptionalProbe(result);
    let contactMpos = report?.triggered ? report.mpos : null;
    let triggered = Boolean(report?.triggered);
    let snapshot = await refreshScanStatus();
    let idleShortOfEndpoint = 0;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (state.probePinActive) { triggered = true; contactMpos = snapshot.mpos; }
        if (snapshot.state === 'Idle') {
            if (triggered) break;
            if (snapshot.wpos?.slice(0, 2).every((value, index) => Math.abs(value - target[index]) <= 0.12)) {
                // G38.3 travels in XY only. Probe reports can contain a slightly
                // different Z than the controller's actual held Z, so require
                // endpoint agreement on the axes this command moved.
                return { contact: null, snapshot: await waitForXYScanPosition(target), direction };
            }
            idleShortOfEndpoint += 1;
            if (idleShortOfEndpoint >= 3) throw new Error(`${label}: controller stopped the XY probe move short of its endpoint without a probe contact.`);
        } else idleShortOfEndpoint = 0;
        await new Promise((resolve) => setTimeout(resolve, 100));
        snapshot = await refreshScanStatus();
    }
    if (snapshot.state !== 'Idle') throw new Error(`${label}: timed out waiting for the XY probe move to stop.`);
    if (!triggered) throw new Error(`${label}: XY probe stopped before the target without a contact report.`);
    const mpos = report?.triggered ? report.mpos : contactMpos ?? snapshot.mpos;
    if (!mpos?.every(Number.isFinite)) throw new Error(`${label}: probe triggered during XY travel but its stopped position was unavailable.`);
    return { contact: mpos, snapshot, direction };
}

async function moveToPerimeterApproachWithProbe(target, nominalSurface, cfg, limits, label) {
    let snapshot = await currentSnapshot();
    if (!snapshot.wpos?.every(Number.isFinite)) throw new Error(`${label}: waiting for a valid WPOS before the next perimeter move.`);
    let currentXY = snapshot.wpos.slice(0, 2);
    const targetXY = target.slice(0, 2);
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const maxOutcropContacts = 6;
    let contacts = 0;
    let maxContactRadius = 0;
    let nextXY = targetXY;
    let routingAroundContact = false;
    let pendingLine = null;

    while (contacts <= maxOutcropContacts) {
        if (state.stopScan && !routingAroundContact) throw new Error('Scan stopped by user before the next perimeter sample.');
        const line = pendingLine ?? await probeTravelLine([currentXY[0], currentXY[1], snapshot.wpos[2]], nextXY, limits,
            routingAroundContact ? `${label}: probing the outcropping bypass` : label, cfg.fastFeed);
        pendingLine = null;
        snapshot = line.snapshot;
        if (!line.contact) {
            currentXY = nextXY;
            if (routingAroundContact) {
                nextXY = targetXY;
                routingAroundContact = false;
                continue;
            }
            return { maxContactRadius };
        }

        contacts += 1;
        const zero = state.wposZeroMachine;
        if (!zero?.every(Number.isFinite)) throw new Error(`${label}: WPOS origin was lost during XY contact detection.`);
        const contactWpos = [line.contact[0] - zero[0], line.contact[1] - zero[1], line.contact[2] - zero[2]];
        maxContactRadius = Math.max(maxContactRadius, Math.hypot(contactWpos[0], contactWpos[1]));
        let normalX = contactWpos[0] - nominalSurface[0];
        let normalY = contactWpos[1] - nominalSurface[1];
        let normalLength = Math.hypot(normalX, normalY);
        if (normalLength < 0.05) { normalX = contactWpos[0]; normalY = contactWpos[1]; normalLength = Math.hypot(normalX, normalY); }
        if (normalLength < 0.05) throw new Error(`${label}: could not determine an outward direction to clear the detected contact.`);
        normalX /= normalLength; normalY /= normalLength;
        const surfacePoint = [contactWpos[0] - normalX * cfg.radius, contactWpos[1] - normalY * cfg.radius];
        const point = {
            index: state.perimeterPoints.length + 1,
            angle: Math.atan2(surfacePoint[1], surfacePoint[0]) * 180 / Math.PI,
            x: surfacePoint[0], y: surfacePoint[1], z: state.bedWposZ ?? contactWpos[2],
            kind: 'travel outcropping'
        };
        state.perimeterPoints.push(point);
        renderPerimeterResult();
        logHomingDiagnostic('Perimeter outcropping detected during XY travel', {
            label, contactNumber: contacts, contactMpos: line.contact, contactWpos,
            contactRadius: Math.hypot(contactWpos[0], contactWpos[1]),
            nominalSurface, correctedSurfacePoint: surfacePoint, travelDirection: line.direction,
            bypassLimit: maxOutcropContacts
        });

        const reverse = [
            contactWpos[0] - line.direction[0] * releaseDistance,
            contactWpos[1] - line.direction[1] * releaseDistance,
            contactWpos[2]
        ];
        const released = await waitForProbeClearAfterRetract(limits, reverse, `${label}: release after outcropping contact ${contacts}`, { preserveZ: true });
        if (state.stopScan) throw new Error('Scan stopped by user after releasing the probe from an outcropping contact.');

        // Step away from the detected surface, then probe the remaining route
        // again. Repeated contacts push the route farther outward; all lateral
        // re-approach travel remains a probe move so another bump is detected.
        const bypass = [contactWpos[0] + normalX * releaseDistance, contactWpos[1] + normalY * releaseDistance];
        const bypassStart = released?.wpos?.every(Number.isFinite)
            ? released.wpos.slice(0, 3)
            : [reverse[0], reverse[1], snapshot.wpos[2]];
        const bypassResult = await probeTravelLine(bypassStart, bypass, limits, `${label}: moving outside the detected outcropping`, cfg.fastFeed);
        snapshot = bypassResult.snapshot;
        if (bypassResult.contact) {
            // Start the next loop at this newly detected obstacle. It is
            // released and recorded on the following iteration.
            currentXY = [bypassResult.contact[0] - zero[0], bypassResult.contact[1] - zero[1]];
            nextXY = bypass;
            routingAroundContact = true;
            pendingLine = bypassResult;
            continue;
        }
        currentXY = bypass;
        nextXY = targetXY;
        routingAroundContact = true;
    }
    throw new Error(`${label}: encountered more than ${maxOutcropContacts} outcroppings while routing to the next probe point. The scan stopped for operator review.`);
}

function recordRectangleCornerContact(contactMpos, cfg, outward, label, details = {}) {
    const zero = state.wposZeroMachine;
    if (!zero?.every(Number.isFinite)) throw new Error(`${label}: WPOS origin was lost during corner following.`);
    const contactWpos = [contactMpos[0] - zero[0], contactMpos[1] - zero[1], contactMpos[2] - zero[2]];
    const surfacePoint = [contactWpos[0] - outward[0] * cfg.radius, contactWpos[1] - outward[1] * cfg.radius];
    state.perimeterPoints.push({
        index: state.perimeterPoints.length + 1,
        angle: Math.atan2(surfacePoint[1], surfacePoint[0]) * 180 / Math.PI,
        x: surfacePoint[0], y: surfacePoint[1], z: state.bedWposZ ?? contactWpos[2],
        kind: 'corner-follow contact'
    });
    renderPerimeterResult();
    logHomingDiagnostic('Rectangle corner-follow contact recorded', { label, contactMpos, contactWpos, outward, correctedSurfacePoint: surfacePoint, ...details });
    return { contactWpos, contactRadius: Math.hypot(contactWpos[0], contactWpos[1]) };
}

async function searchRectangleCorner(currentWpos, tangent, outward, side, cfg, limits, label) {
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const axes = [
        { name: tangent[0] ? (tangent[0] > 0 ? 'X+' : 'X-') : (tangent[1] > 0 ? 'Y+' : 'Y-'), direction: tangent }
    ];
    const maxRounds = 12;
    let current = currentWpos.slice(0, 3);
    let totalContacts = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
        let touchedThisRound = false;
        for (const axis of axes) {
            if (state.stopScan) throw new Error('Scan stopped by user during rectangle corner search.');
            const target = [
                current[0] + axis.direction[0] * cfg.spacing,
                current[1] + axis.direction[1] * cfg.spacing
            ];
            const result = await probeTravelLine(current, target, limits,
                `${label}: corner search ${round}/${maxRounds} ${axis.name} probe (${cfg.spacing.toFixed(2)} mm)`, cfg.fastFeed);
            current = result.snapshot.wpos.slice(0, 3);
            if (!result.contact) {
                logHomingDiagnostic('Rectangle corner search direction clear', { label, side, round, direction: axis.name, spacing: cfg.spacing, reached: current });
                continue;
            }

            touchedThisRound = true;
            totalContacts += 1;
            const outward = [-axis.direction[0], -axis.direction[1]];
            const detected = recordRectangleCornerContact(result.contact, cfg, outward, label,
                { phase: 'resolution corner search', side, round, contactNumber: totalContacts, probeDirection: axis.name, spacing: cfg.spacing });
            const releaseTarget = [
                detected.contactWpos[0] + outward[0] * releaseDistance,
                detected.contactWpos[1] + outward[1] * releaseDistance,
                current[2]
            ];
            await waitForProbeClearAfterRetract(limits, releaseTarget,
                `${label}: corner contact release ${totalContacts} (${releaseDistance.toFixed(2)} mm opposite ${axis.name})`, { preserveZ: true });
            current = (await currentSnapshot()).wpos.slice(0, 3);
        }

        if (!touchedThisRound) {
            logHomingDiagnostic('Rectangle corner search complete', {
                label, side, rounds: round, totalContacts, spacing: cfg.spacing,
                releaseDistance, lastPosition: current,
                reason: 'The outgoing tangent was clear at resolution spacing; the guarded next-face transfer uses the last measured face contact.'
            });
            return current;
        }
    }
    throw new Error(`${label}: corner-search probes still contacted the part after ${maxRounds} rounds. The scan paused for operator review.`);
}

async function followRectangleCornerToApproach(target, incomingSide, nextSide, cfg, limits, label) {
    // Trace the incoming edge axis first instead of cutting diagonally over a
    // rounded corner. Once the side falls away, transfer perpendicularly to
    // the next face-normal probe start. Every XY leg remains probe guarded.
    const snapshot = await currentSnapshot();
    if (!snapshot.wpos?.every(Number.isFinite)) throw new Error(`${label}: waiting for valid WPOS before following the corner.`);
    let current = snapshot.wpos.slice(0, 3);
    const targetWpos = target.slice(0, 3);
    const tangentBySide = { front: [1, 0], right: [0, 1], rear: [-1, 0], left: [0, -1] };
    const outwardByIncomingSide = { front: [0, -1], right: [1, 0], rear: [0, 1], left: [-1, 0] };
    const tangent = tangentBySide[incomingSide];
    const outward = outwardByIncomingSide[incomingSide];
    if (!tangent || !outward) throw new Error(`${label}: could not determine the axis directions for this rectangle corner.`);
    const outwardBySide = { front: [0, -1], right: [1, 0], rear: [0, 1], left: [-1, 0] };
    const nextOutward = outwardBySide[nextSide];
    if (!nextOutward) throw new Error(`${label}: could not determine the next edge's outward direction.`);
    const nextTangent = tangentBySide[nextSide];
    const directionName = ([x, y]) => Math.abs(x) > 0.5 ? (x > 0 ? 'X+' : 'X-') : (y > 0 ? 'Y+' : 'Y-');
    const tangentAxis = Math.abs(tangent[0]) > 0.5 ? 0 : 1;
    const crossAxis = 1 - tangentAxis;
    const crossDirection = Math.sign(targetWpos[crossAxis] - current[crossAxis]);
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const nextApproachOffset = cfg.radius + releaseDistance;
    const expectedCorner = [
        targetWpos[0] - nextOutward[0] * nextApproachOffset,
        targetWpos[1] - nextOutward[1] * nextApproachOffset
    ];
    const maxCornerContacts = 8;
    let contacts = 0;
    let maxContactRadius = 0;

    while ((expectedCorner[tangentAxis] - current[tangentAxis]) * tangent[tangentAxis] > 0.05) {
        const tangentTarget = current.slice();
        tangentTarget[tangentAxis] = expectedCorner[tangentAxis];
        const line = await probeTravelLine(current, tangentTarget, limits, `${label}: following ${incomingSide} edge`, cfg.fastFeed);
        current = line.snapshot.wpos.slice(0, 3);
        if (!line.contact) {
            logHomingDiagnostic('Rectangle corner edge fell away', {
                label, incomingSide, nextSide, tangent, reached: current, tangentTarget,
                contactAttempts: contacts,
                perpendicularMove: crossAxis === 0 ? (crossDirection < 0 ? 'X-' : 'X+') : (crossDirection < 0 ? 'Y-' : 'Y+')
            });
            break;
        }

        contacts += 1;
        if (contacts > maxCornerContacts) throw new Error(`${label}: the ${incomingSide} edge still contacts after ${maxCornerContacts} releases; scan paused for operator review.`);
        const detected = recordRectangleCornerContact(line.contact, cfg, outward, label, { contactNumber: contacts, incomingSide, nextSide, tangent });
        maxContactRadius = Math.max(maxContactRadius, detected.contactRadius);
        const releaseTarget = [
            detected.contactWpos[0] + outward[0] * releaseDistance,
            detected.contactWpos[1] + outward[1] * releaseDistance,
            detected.contactWpos[2]
        ];
        await waitForProbeClearAfterRetract(limits, releaseTarget, `${label}: release perpendicular to ${incomingSide} edge`, { preserveZ: true });
        if (state.stopScan) throw new Error('Scan stopped by user after releasing the probe at a rectangle corner.');
        current = (await currentSnapshot()).wpos.slice(0, 3);
    }

    // The caller has already confirmed a full face-probe miss and returned
    // to the start of that clear probe path. Keep the transfer guarded, but
    // do not make another predicted or full-spacing corner search.

    const nextNormalAxis = Math.abs(nextOutward[0]) > 0.5 ? 0 : 1;
    const nextTangentAxis = 1 - nextNormalAxis;
    logHomingDiagnostic('Rectangle corner axis transition', {
        label, incomingSide, nextSide,
        advanceAlongNextEdge: directionName(nextTangent),
        probeInwardOnNextEdge: directionName([-nextOutward[0], -nextOutward[1]])
    });

    // First move along the upcoming face (toward the part center) while still
    // beyond its end, then approach the face along its outward normal. For a
    // right-to-rear turn this must move X- at the rear-clear Y, then move Y-;
    // doing Y- first cuts across the rounded corner and repeatedly retriggers
    // the probe before the scan ever starts the rear edge.
    const transferTargets = [];
    const alongNextFace = current.slice();
    alongNextFace[nextTangentAxis] = targetWpos[nextTangentAxis];
    transferTargets.push(alongNextFace);
    transferTargets.push(targetWpos);
    for (const [legIndex, transferTarget] of transferTargets.entries()) {
        const leg = await probeTravelLine(current, transferTarget, limits,
            `${label}: guarded perpendicular transfer ${legIndex + 1}/2 to ${nextSide} probe start`, cfg.fastFeed);
        current = leg.snapshot.wpos.slice(0, 3);
        if (leg.contact) {
            // On the second leg we are moving along the new edge's inward
            // normal (for a right-to-rear turn, Y-). A contact here is the
            // first valid face probe on that edge, not a travel obstruction
            // to route around. Hand it to the scan loop so it can record the
            // normal perimeter point, release the probe, then continue with
            // the regular swapped-axis sequence (X- advance, Y- face probe).
            const transferIsNewFaceProbe = legIndex === 1
                && leg.direction[0] * -nextOutward[0] + leg.direction[1] * -nextOutward[1] > 0.99;
            if (transferIsNewFaceProbe) {
                logHomingDiagnostic('Rectangle corner acquired next face on transfer', {
                    label, incomingSide, nextSide, contactMpos: leg.contact,
                    travelDirection: leg.direction,
                    nextEdgeAdvance: directionName(nextTangent),
                    nextFaceProbe: directionName([-nextOutward[0], -nextOutward[1]])
                });
                return { ...(await currentSnapshot()), maxContactRadius, firstFaceContact: leg.contact };
            }
            // A guarded transfer can itself find the outgoing face before it
            // reaches the nominal approach point. Treat the touch as useful
            // perimeter data, retract opposite the actual travel vector, then
            // route to the next approach with the existing outcropping logic.
            const transferOutward = [-leg.direction[0], -leg.direction[1]];
            const detected = recordRectangleCornerContact(leg.contact, cfg, transferOutward, label, { phase: 'perpendicular transfer', incomingSide, nextSide, leg: legIndex + 1, travelDirection: leg.direction });
            const releaseTarget = [
                detected.contactWpos[0] + transferOutward[0] * releaseDistance,
                detected.contactWpos[1] + transferOutward[1] * releaseDistance,
                detected.contactWpos[2]
            ];
            await waitForProbeClearAfterRetract(limits, releaseTarget, `${label}: release after perpendicular-transfer contact`, { preserveZ: true });
            const nominalSurface = [
                targetWpos[0] - nextOutward[0] * nextApproachOffset,
                targetWpos[1] - nextOutward[1] * nextApproachOffset
            ];
            const reroute = await moveToPerimeterApproachWithProbe(targetWpos, nominalSurface, cfg, limits,
                `${label}: safely routing to the ${nextSide} probe start after detecting the corner`);
            maxContactRadius = Math.max(maxContactRadius, detected.contactRadius, reroute.maxContactRadius);
            current = (await waitForXYScanPosition(targetWpos)).wpos.slice(0, 3);
            logHomingDiagnostic('Rectangle corner transfer recovered', {
                label, incomingSide, nextSide, transferLeg: legIndex + 1,
                detectedContactWpos: detected.contactWpos,
                releasedAt: releaseTarget,
                nextApproach: targetWpos,
                maxContactRadius
            });
            return { ...(await currentSnapshot()), maxContactRadius };
        }
    }
    return { ...(await waitForScanPosition(targetWpos)), maxContactRadius };
}

async function moveRectangleAlongEdge(start, tangentTarget, side, cfg, limits, label) {
    const tangentBySide = { front: [1, 0], right: [0, 1], rear: [-1, 0], left: [0, -1] };
    const outwardBySide = { front: [0, -1], right: [1, 0], rear: [0, 1], left: [-1, 0] };
    const tangent = tangentBySide[side];
    const outward = outwardBySide[side];
    if (!tangent || !outward) throw new Error(`${label}: invalid rectangle edge direction.`);
    const tangentAxis = Math.abs(tangent[0]) > 0.5 ? 0 : 1;
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const maxContacts = 8;
    let contacts = 0;
    let current = start.slice(0, 3);

    while ((tangentTarget[tangentAxis] - current[tangentAxis]) * tangent[tangentAxis] > 0.05) {
        const target = current.slice();
        target[tangentAxis] = tangentTarget[tangentAxis];
        const line = await probeTravelLine(current, target, limits, `${label}: advance ${tangent[0] ? (tangent[0] > 0 ? 'X+' : 'X-') : (tangent[1] > 0 ? 'Y+' : 'Y-')} by map spacing`, cfg.fastFeed);
        if (!line.contact) return line.snapshot;

        contacts += 1;
        if (contacts > maxContacts) throw new Error(`${label}: probe kept contacting while advancing along the edge after ${maxContacts} outward releases; scan paused for review.`);
        const detected = recordRectangleCornerContact(line.contact, cfg, outward, label, { phase: 'edge advance', contactNumber: contacts, side, tangent });
        const releaseTarget = [
            detected.contactWpos[0] + outward[0] * releaseDistance,
            detected.contactWpos[1] + outward[1] * releaseDistance,
            detected.contactWpos[2]
        ];
        await waitForProbeClearAfterRetract(limits, releaseTarget, `${label}: fixed ${releaseDistance.toFixed(2)} mm outward retract`, { preserveZ: true });
        if (state.stopScan) throw new Error('Scan stopped by user after retracting from an edge contact.');
        current = (await currentSnapshot()).wpos.slice(0, 3);
    }
    return waitForScanPosition(current);
}

function renderPerimeterResult() {
    const result = $('perimeterResult');
    if (!state.perimeterPoints.length && !state.surfaceRings.length) {
        result.hidden = true;
        $('downloadPerimeterCsv').disabled = true;
        $('copySurfaceStl').disabled = true;
        $('downloadSurfaceStl').disabled = true;
        $('downloadPolygonSurfaceCsv').hidden = true;
        return;
    }
    const xs = state.perimeterPoints.map((point) => point.x);
    const ys = state.perimeterPoints.map((point) => point.y);
    const rawPolygon=state.perimeterPoints.some(point=>point.kind==='raw probe center');
    result.hidden = false;
    result.querySelector('strong').textContent=rawPolygon?(state.compensationApplied?'Radius-corrected perimeter and surface':'Raw polygon probe-center contacts'):'Measured perimeter and surface';
    result.querySelector('.surface-visual').hidden=false;
    result.querySelector('.stl-export').hidden=rawPolygon&&!state.polygonMesh;
    const selectedView=$('resultRepresentation')?.value??'both';
    const capturedSurface=Boolean(state.fullSurfaceAvailable&&state.polygonMesh?.surfaceTriangles?.length);
    const capturedPerimeter=Boolean(state.perimeterPoints.length>=3&&state.polygonSurfacePoints?.some(point=>Number.isFinite(point.z)));
    for(const [value,available] of [['both',capturedSurface],['surface',capturedSurface],['perimeter',capturedPerimeter]]){
        const option=$('resultRepresentation')?.querySelector(`option[value="${value}"]`);
        if(option)option.disabled=!available;
    }
    if($('resultRepresentation')?.selectedOptions[0]?.disabled)$('resultRepresentation').value=capturedSurface?'both':capturedPerimeter?'perimeter':'both';
    $('surfaceStlDescription').textContent=!state.surfaceComplete?'Surface scan is in progress.':selectedView==='perimeter'?'Perimeter-only solid: flat top at the first measured surface height, perimeter wall, and bed-level bottom.':selectedView==='surface'?'Open surface mesh with measured boundary heights; vertical perimeter and bed walls are omitted.': 'Closed perimeter and surface model with a bed-level bottom. Edge heights are estimated from nearby surface readings; Z is relative to bed.';
    $('perimeterStats').textContent = state.perimeterPoints.length
        ? `${state.perimeterPoints.length} ${rawPolygon?`${state.compensationApplied?'radius-corrected points':'raw probe-center contacts'} · ${state.polygonSurfacePoints?.length ?? 0} surface samples`:`perimeter points · ${state.surfaceRings.reduce((sum, ring) => sum + ring.points.filter(Boolean).length, 0) + (state.surfaceCenter ? 1 : 0)} interior height points`} · X ${Math.min(...xs).toFixed(3)}…${Math.max(...xs).toFixed(3)} mm · Y ${Math.min(...ys).toFixed(3)}…${Math.max(...ys).toFixed(3)} mm.`
        : 'Preparing surface scan…';
    $('downloadPerimeterCsv').disabled = !state.perimeterPoints.length;
    $('downloadPolygonSurfaceCsv').hidden=!rawPolygon;
    $('downloadPolygonSurfaceCsv').disabled=!state.polygonSurfacePoints?.length;
    $('copySurfaceStl').disabled = !state.surfaceComplete;
    $('downloadSurfaceStl').disabled = !state.surfaceComplete;
    if (state.surfaceComplete) {
        try { $('surfaceStl').value = surfaceMeshToStl(); }
        catch (error) { $('surfaceStlStatus').textContent = error.message; }
    }
    drawSurfaceMesh();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drawSurfaceMesh);
}

function drawSurfaceMesh() {
    const canvas = $('surfaceCanvas');
    const visibleRings = state.surfaceRings.filter((ring) => ring.points.length);
    const boundaryPoints = (state.surfacePreviewBoundary??state.perimeterPoints).length ? (state.surfacePreviewBoundary??state.perimeterPoints) : [];
    const livePoints=state.polygonSurfacePoints??[];
    const polygonResult = (state.surfaceComplete?selectedResultMesh():null) ?? state.polygonMesh ?? (livePoints.length?previewPolygonMesh(state.perimeterPoints,livePoints,state.latest?.spacing??1):null);
    const allPoints = polygonResult
        ? [...boundaryPoints, ...polygonResult.points]
        : boundaryPoints.concat(visibleRings.flatMap((ring) => ring.points), state.surfaceCenter ? [state.surfaceCenter] : []);
    if (!canvas || !allPoints.length) return;
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
    const minZ = Math.min(...allPoints.map((point) => point.z));
    const maxZ = Math.max(...allPoints.map((point) => point.z));
    const range = maxZ - minZ;
    $('surfaceStats').textContent = `${polygonResult?.preview?'Live preview · ':''}Lowest ${minZ.toFixed(3)} mm · highest ${maxZ.toFixed(3)} mm · range ${range.toFixed(3)} mm · ${polygonResult ? polygonResult.measuredPoints.length : allPoints.length} measured points`;
    const factor = Number($('surfaceExaggeration').value);
    $('surfaceExaggerationValue').textContent = `${factor}×`;
    const maxRadius = Math.max(...allPoints.map((point) => Math.hypot(point.x, point.y)), 1);
    const span = Math.min(width * 0.36, height * 0.36);
    const lift = Math.min(height * 0.28, span * factor * 0.08);
    const frontY = height * 0.79;
    const project = (point) => {
        const u = (point.x / maxRadius + 1) / 2;
        const v = (point.y / maxRadius + 1) / 2;
        const level = range ? (point.z - minZ) / range : 0.5;
        return { x: width / 2 + (u - v) * span, y: frontY - (u + v) * span * 0.43 - (level - 0.5) * lift, level };
    };
    const projected = [boundaryPoints.map(project), ...visibleRings.map((ring) => ring.points.map(project))].filter((ring) => ring.length);
    const center = state.surfaceCenter ? project(state.surfaceCenter) : null;
    const stops = [[36, 91, 219], [25, 185, 165], [184, 214, 60], [245, 140, 50], [216, 56, 56]];
    const color = (level) => {
        const at = Math.max(0, Math.min(1, level)) * (stops.length - 1);
        const idx = Math.min(stops.length - 2, Math.floor(at));
        const t = at - idx;
        return `rgb(${stops[idx].map((channel, c) => Math.round(channel + (stops[idx + 1][c] - channel) * t)).join(',')})`;
    };
    const drawTriangle = (a, b, c) => {
        const avg = (a.level + b.level + c.level) / 3;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
        ctx.fillStyle = color(avg); ctx.globalAlpha = 0.86; ctx.fill(); ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(235,245,255,0.72)'; ctx.lineWidth = 1; ctx.stroke();
    };
    if(polygonResult) {
        const sorted=[...polygonResult.triangles].sort((a,b)=>(a[0].x+a[0].y+a[1].x+a[1].y+a[2].x+a[2].y)-(b[0].x+b[0].y+b[1].x+b[1].y+b[2].x+b[2].y));
        for(const triangle of sorted)drawTriangle(...triangle.map(project));
    } else for (let r = 0; r < projected.length - 1; r += 1) {
        for (let i = 0; i < projected[r].length; i += 1) {
            const next = (i + 1) % projected[r].length;
            drawTriangle(projected[r][i], projected[r][next], projected[r + 1][next]);
            drawTriangle(projected[r][i], projected[r + 1][next], projected[r + 1][i]);
        }
    }
    if (boundaryPoints.length > 1) {
        ctx.beginPath();
        const first = project(boundaryPoints[0]);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < boundaryPoints.length; i += 1) {
            const point = project(boundaryPoints[i]);
            ctx.lineTo(point.x, point.y);
        }
        ctx.closePath();
        ctx.strokeStyle = 'rgba(125,190,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    if (center && projected.length) {
        const inner = projected[projected.length - 1];
        for (let i = 0; i < inner.length; i += 1) drawTriangle(inner[i], inner[(i + 1) % inner.length], center);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    if(polygonResult){for(const p of polygonResult.points){const point=project(p);ctx.beginPath();ctx.arc(point.x,point.y,2,0,Math.PI*2);ctx.fill();}}
    else for (const ring of projected) for (const point of ring) { ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, Math.PI * 2); ctx.fill(); }
    if (center) { ctx.beginPath(); ctx.arc(center.x, center.y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.textAlign = 'left'; ctx.fillText('X', width * 0.75, height * 0.76);
    ctx.textAlign = 'right'; ctx.fillText('Y', width * 0.25, height * 0.76);
    ctx.textAlign = 'left'; ctx.fillText('WPOS 0,0', width / 2 + 8, frontY + 14);
}

function surfaceMeshToStl() {
    if(state.surfaceComplete&&state.polygonMesh)return polygonMeshStl(selectedResultMesh()??state.polygonMesh);
    const measuredRings = state.surfaceRings.filter((ring) => ring.points.length && ring.points.every(Boolean));
    if (!state.surfaceComplete || measuredRings.length < 1 || !state.surfaceCenter || state.perimeterPoints.length < 3) throw new Error('The interior surface and perimeter scans are not complete yet.');
    // The perimeter is the outer mesh boundary and is deliberately assigned
    // the measured bed height. This closes the surface cleanly at the part edge.
    const rings = [{ points: state.perimeterPoints }, ...measuredRings];
    const referenceZ = rings[0].points[0].z;
    const local = (point) => [point.x, point.y, point.z - referenceZ];
    const fmtStl = (value) => Number(value.toFixed(6)).toString();
    const lines = ['solid surface_perimeter_mapper_mm_z_relative_to_first_probe'];
    const facet = (a, b, c) => {
        const ab = b.map((value, i) => value - a[i]);
        const ac = c.map((value, i) => value - a[i]);
        const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const magnitude = Math.hypot(...n);
        const normal = magnitude ? n.map((value) => value / magnitude) : [0, 0, 1];
        lines.push(`  facet normal ${normal.map(fmtStl).join(' ')}`, '    outer loop');
        for (const vertex of [a, b, c]) lines.push(`      vertex ${vertex.map(fmtStl).join(' ')}`);
        lines.push('    endloop', '  endfacet');
    };
    for (let r = 0; r < rings.length - 1; r += 1) {
        for (let i = 0; i < rings[r].points.length; i += 1) {
            const next = (i + 1) % rings[r].points.length;
            facet(local(rings[r].points[i]), local(rings[r].points[next]), local(rings[r + 1].points[next]));
            facet(local(rings[r].points[i]), local(rings[r + 1].points[next]), local(rings[r + 1].points[i]));
        }
    }
    const inner = rings[rings.length - 1].points;
    for (let i = 0; i < inner.length; i += 1) facet(local(inner[i]), local(inner[(i + 1) % inner.length]), local(state.surfaceCenter));
    lines.push('endsolid surface_perimeter_mapper_mm_z_relative_to_first_probe');
    return `${lines.join('\n')}\n`;
}

function selectedResultMesh(){
    if(!state.polygonMesh)return null;
    const view=$('resultRepresentation')?.value??'both';
    if(view==='surface')return polygonSurfaceOnlyMesh(state.polygonMesh);
    if(view==='perimeter'){
        const firstHeight=state.polygonSurfacePoints?.find(point=>Number.isFinite(point.z))?.z;
        return polygonPerimeterMesh(state.perimeterPoints,firstHeight,state.bedWposZ??state.polygonMesh.bedZ??0);
    }
    return state.polygonMesh;
}

async function probeSurfacePoint(x, y, cfg, limits, clearanceZ, bedWposZ, sampleLabel, onRaisedContact=null) {
    let travelStart=await currentSnapshot();
    if(!travelStart.wpos?.every(Number.isFinite))throw Error(`${sampleLabel}: current position is unavailable.`);
    const feed=cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed;
    let travel=await probeTravelLine(travelStart.wpos,[x,y],limits,`${sampleLabel}: guarded XY travel`,feed);
    if(travel.contact){
        if(onRaisedContact&&await onRaisedContact(travel,travelStart.wpos))return {raisedBoundary:true};
        const stopped=travel.snapshot.wpos;
        if(!stopped?.every(Number.isFinite)||clearanceZ<=stopped[2]+.01)throw Error(`${sampleLabel}: probe touched during XY travel at full clearance; inspect the probe and part.`);
        logHomingDiagnostic('Surface XY contact; raising to full clearance',{sampleLabel,stoppedWpos:stopped,target:[x,y],clearanceZ});
        await waitForProbeClearAfterRetract(limits,[stopped[0],stopped[1],clearanceZ],`${sampleLabel}: raise after XY contact`);
        travelStart=await currentSnapshot();
        travel=await probeTravelLine(travelStart.wpos,[x,y],limits,`${sampleLabel}: retry XY at full clearance`,feed);
        if(travel.contact)throw Error(`${sampleLabel}: probe touched again during XY travel at full clearance; inspect the probe and part.`);
    }
    const endZ = bedWposZ;
    const target = [x, y, endZ];
    checkScanTravel(target, limits);
    const start = await currentSnapshot();
    if (!Number.isFinite(start.wpos?.[2]) || endZ >= start.wpos[2] - 0.05) throw new Error(`${sampleLabel}: calculated Z probe endpoint ${endZ.toFixed(3)} is not below the current clearance position.`);
    if (state.stopScan) throw new Error('Scan stopped by user before the next surface probe.');

    // gSender can acknowledge G38.3 before the controller's next status report
    // changes from Idle to Run. Do not interpret that brief stale Idle/clear
    // state as a missed touch and send a retract that interrupts the probe.
    const probeOnce = async (attempt, probeEndZ = endZ, feed = cfg.fastFeed, phase = 'surface') => {
        const attemptStart = await currentSnapshot();
        const probeTarget = [x, y, probeEndZ];
        const command = `G21 G90 G54 G38.3 Z${probeEndZ.toFixed(3)} F${feed}`;
        const distance = Math.max(0, attemptStart.wpos[2] - probeEndZ);
        const timeout = Math.max(30000, Math.ceil((distance / feed) * 60000 + 15000));
        $('scanStatus').textContent = `${sampleLabel}: probing the ${phase}${attempt > 1 ? ` (retry ${attempt - 1}/1)` : ''}…`;
        logHomingDiagnostic('Interior Z probe TX', { sampleLabel, phase, attempt, targetWpos: probeTarget, startWpos: attemptStart.wpos, bedWposZ, probeMode: cfg.probeMode, command, timeout });
        const result = await queryProbeController(command, { timeout, maxLines: 80 });
        logHomingDiagnostic('Interior Z probe RX', { sampleLabel, phase, attempt, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
        if (!result.complete || !result.ok || result.error) throw new Error(`${sampleLabel}: Z probe command failed: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);

        const report = parseOptionalProbe(result);
        let triggered = Boolean(report?.triggered);
        let contactMpos = report?.triggered ? report.mpos : null;
        let sawMotion = false;
        let idleShortOfEndpoint = 0;
        const deadline = Date.now() + timeout;
        let snapshot = await refreshScanStatus();
        while (Date.now() < deadline) {
            if (snapshot.state === 'Run' || snapshot.state === 'Home') sawMotion = true;
            if (snapshot.wpos?.some((value, index) => Math.abs(value - attemptStart.wpos[index]) > 0.05)) sawMotion = true;
            if (state.probePinActive) {
                triggered = true;
                contactMpos = snapshot.mpos;
            }

            if (snapshot.state === 'Idle') {
                if (triggered) return { report, snapshot, contactMpos, triggered: true };
                const reachedEndpoint = snapshot.wpos?.every((value, index) => Math.abs(value - probeTarget[index]) <= 0.12);
                if (reachedEndpoint) return { report, snapshot, contactMpos: null, triggered: false };
                if (sawMotion) {
                    idleShortOfEndpoint += 1;
                    if (idleShortOfEndpoint >= 3) {
                        throw new Error(`${sampleLabel}: probe stopped short of the measured bed at WPOS Z${snapshot.wpos?.[2]?.toFixed(3) ?? 'unknown'} without a contact report.`);
                    }
                }
            } else {
                idleShortOfEndpoint = 0;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
            snapshot = await refreshScanStatus();
        }
        throw new Error(`${sampleLabel}: timed out waiting for the Z probe to reach the surface or measured bed.`);
    };

    const probeBounded=async(attempt)=>{
        const feed=cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed;
        while(true){
            const start=await currentSnapshot();if(!Number.isFinite(start.wpos?.[2]))throw Error(`${sampleLabel}: no current Z position.`);
            const end=Math.max(endZ,start.wpos[2]-cfg.usableLength);
            const result=await probeOnce(attempt,end,feed,'surface');
            if(result.triggered||end<=endZ+.005)return result;
            if(state.stopScan)throw Error('Scan stopped between bounded Z probes.');
        }
    };
    let probeResult;
    while (!state.stopScan) {
        let retryAtThisPoint = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                probeResult = await probeBounded(attempt);
            } catch (error) {
                if (state.motionState === 'Alarm' || state.probePinActive || !state.probePinKnown) throw error;
                if (attempt === 1) {
                    logHomingDiagnostic('Interior Z probe retrying after incomplete move', { sampleLabel, attempt, message: error.message, workPosition: state.workPosition, motionState: state.motionState });
                    await waitForIdle(30000, 300);
                    await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: retract before retry`);
                    continue;
                }
                logHomingDiagnostic('Interior Z probe incomplete twice; pausing for operator check', { sampleLabel, message: error.message, workPosition: state.workPosition, motionState: state.motionState });
                await waitForIdle(30000, 300);
                await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: retract before operator check`);
                const resume = await waitForSurfaceProbeRecovery(sampleLabel, 'The probe move stopped before reaching the bed twice. Check the probe, wiring, and Z path before continuing.', { x, y, clearanceZ, limits });
                if (!resume) throw new Error(`${sampleLabel}: scan canceled by the operator after an incomplete probe move.`);
                retryAtThisPoint = true;
                break;
            }
            if (probeResult.triggered) break;
            logHomingDiagnostic('Interior Z probe reached bed without contact', { sampleLabel, attempt, bedWposZ, stoppedWpos: probeResult.snapshot.wpos });
            if (attempt === 1) {
                await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: retract before retry`);
                continue;
            }
            await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: retract before operator check`);
            const resume = await waitForSurfaceProbeRecovery(sampleLabel, `No probe contact was detected at the measured bed height WPOS Z${bedWposZ.toFixed(3)} mm after two attempts. Check the probe and the path to the bed.`, { x, y, clearanceZ, limits });
            if (!resume) throw new Error(`${sampleLabel}: scan canceled by the operator after two no-contact attempts.`);
            retryAtThisPoint = true;
            break;
        }
        if (probeResult?.triggered) break;
        if (retryAtThisPoint) continue;
        throw new Error(`${sampleLabel}: probe did not contact the surface or bed.`);
    }
    if (state.stopScan) throw new Error('Scan stopped by user after the current Z probe.');

    const report = probeResult.report;
    let hit = report?.triggered ? report.mpos : probeResult.contactMpos ?? probeResult.snapshot.mpos;
    if (!hit?.every(Number.isFinite)) throw new Error(`${sampleLabel}: probe triggered but the contact position was unavailable.`);
    let hitWposZ = hit[2] - state.wposZeroMachine[2];
    const retractZ=hitWposZ+0.75*cfg.diameter;
    checkScanTravel([x,y,retractZ],limits);
    if(retractZ<=hitWposZ+.01)throw Error(`${sampleLabel}: insufficient Z clearance to release the probe.`);
    try {
        await waitForProbeClearAfterRetract(limits, [x, y, retractZ], `${sampleLabel}: retract 0.75D`);
    } catch (error) {
        const stopped = await refreshScanStatus();
        const atShortRetract = stopped.state === 'Idle' && stopped.wpos?.every(Number.isFinite)
            && stopped.wpos.every((value, index) => Math.abs(value - [x, y, retractZ][index]) <= 0.12);
        if (!atShortRetract || !state.probePinKnown || !state.probePinActive) throw error;
        logHomingDiagnostic('Surface short retract left probe active; raising to full clearance', {
            sampleLabel, shortRetractWpos: stopped.wpos, fullClearanceZ: clearanceZ,
            probePinActive: state.probePinActive, statusLine: state.lastProbeStatusLine
        });
        try {
            await waitForProbeClearAfterRetract(limits, [x, y, clearanceZ], `${sampleLabel}: raise to full clearance after active input`);
        } catch (fullRetractError) {
            throw new Error(`${sampleLabel}: probe stayed active after the 0.75D retract and full-clearance recovery. Stop and inspect the probe and part. ${fullRetractError.message}`);
        }
    }
    const point = { x, y, z: hitWposZ };
    logHomingDiagnostic('Interior surface point captured', { sampleLabel, point, machinePosition: hit, mode: cfg.probeMode });
    return point;
}

function insideOrNearRecess(point, contour, margin) {
    let inside=false;
    for(let i=0,j=contour.length-1;i<contour.length;j=i++){
        const a=contour[j],b=contour[i],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;
        const t=l?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/l)):0;
        if(Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy)<=margin)return true;
        if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
    }
    return inside;
}

async function releaseSurfaceWallContact(travel,cfg,limits,label) {
    const stopped=travel.snapshot.wpos,dir=travel.direction;
    if(!stopped?.every(Number.isFinite)||!dir?.every(Number.isFinite)||Math.hypot(...dir)<.9)throw Error(`${label}: missing confirmed wall contact and approach direction.`);
    const contactMpos=travel.contact;
    if(!contactMpos?.every(Number.isFinite)||!state.wposZeroMachine?.every(Number.isFinite))throw Error(`${label}: probe contact position is unavailable for a safe retract.`);
    const contact=contactMpos.map((value,axis)=>value-state.wposZeroMachine[axis]);
    const reverse=[-dir[0],-dir[1]],releaseDistance=cfg.diameter;
    const end=[contact[0]+reverse[0]*releaseDistance,contact[1]+reverse[1]*releaseDistance,contact[2]];
    checkScanTravel(end,limits);
    logHomingDiagnostic(`${label}: wall contact backoff`,{contactWpos:contact,stoppedWpos:stopped,direction:dir,backoffWpos:end,releaseDistance,reason:'settled rapid retract with checked extension'});
    await scanMove(end,limits,`${label}: rapid retract from wall`,true);
    const released=await extendPolygonRelease(contact,reverse,releaseDistance,cfg,limits,`${label} release`);
    if(!state.probePinKnown||state.probePinActive||!released.wpos?.every(Number.isFinite))throw Error(`${label}: probe did not clear after rapid backoff from the wall.`);
    return {stopped,dir,contact,reverse,released};
}

async function traceRaisedSurface(travel,start,lowerPoint,cfg,limits,clearanceZ) {
    const stopped=travel.snapshot.wpos,dir=travel.direction;
    if(!lowerPoint||!stopped?.every(Number.isFinite)||!dir?.every(Number.isFinite)||Math.hypot(...dir)<.9)throw Error('Raised feature: missing confirmed approach and lower surface reading.');
    if(Math.abs(start[2]-(lowerPoint.z+.75*cfg.diameter))>.15)throw Error('Raised feature: XY contact was not made at the last measured surface clearance.');
    const {contact,reverse,released}=await releaseSurfaceWallContact(travel,cfg,limits,'Raised feature');
    const feed=cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed;
    const clearTarget=[released.wpos[0]+reverse[0]*cfg.radius*.5,released.wpos[1]+reverse[1]*cfg.radius*.5];
    const cleared=await probeTravelLine(released.wpos,clearTarget,limits,'Raised feature: guarded release clearance',feed);
    if(cleared.contact)throw Error('Raised feature: probe retriggered while backing away from the wall.');
    const contour=[],initial=[stopped[0]+dir[0]*cfg.diameter,stopped[1]+dir[1]*cfg.diameter];
    const raised={contour,floor:[],floorZ:lowerPoint.z,sideZ:stopped[2],parentIndex:null,raised:true};
    logHomingDiagnostic('Raised feature perimeter started',{lowerZ:lowerPoint.z,sideZ:stopped[2],initial,stopped});
    await scanPolygonPrototype(cfg,limits,lowerPoint.z,{direction:2,step:Math.min(cfg.spacing,cfg.diameter),clearance:Math.min(Number($('polygonClearance').value),cfg.radius*.5),initialTarget:initial,contacts:contour});
    // A point inside the traced loop means we approached its wall from a
    // lower pocket, not from outside a raised island.
    if(insideOrNearRecess(lowerPoint,contour,0)){
        raised.raised=false;raised.floor=[lowerPoint];raised.needsFloor=true;
        logHomingDiagnostic('XY boundary classified as recess',{lowerZ:lowerPoint.z,contacts:contour.length});
    }
    state.recesses.push(raised);
    logHomingDiagnostic(raised.raised?'Raised feature perimeter closed':'Recess perimeter closed from XY contact',{contacts:contour.length,lowerZ:lowerPoint.z,sideZ:stopped[2]});
    const after=await currentSnapshot();
    await scanMove([after.wpos[0],after.wpos[1],clearanceZ],limits,'Raised feature: raise to full clearance after perimeter');
    return raised;
}

async function traceRecessFromSurface(point,cfg,limits,clearanceZ,bedWposZ,parentIndex=null,{wallContact=null,entryContact=null}={}) {
    state.recesses ??= [];
    const saved=state.scanCheckpoint;
    const sameSeed=seed=>seed&&Math.hypot(seed.x-point.x,seed.y-point.y)<Math.max(.05,cfg.spacing*.1)&&Math.abs(seed.z-point.z)<.1;
    const resumeBoundary=saved?.stage==='recess-boundary'&&saved.task?.parentIndex===parentIndex&&sameSeed(saved.task.seed);
    const resumeFloor=saved?.stage==='recess-floor'&&saved.task?.parentIndex===parentIndex&&sameSeed(saved.task.seed);
    const existing=state.recesses.find(recess=>(recess.parentIndex??null)===parentIndex&&insideOrNearRecess(point,recess.contour,cfg.diameter));
    if(existing&&!resumeBoundary&&!resumeFloor)return;
    if(state.recesses.length>=32&&!resumeBoundary&&!resumeFloor)throw new Error('Recess count limit reached; partial scan retained.');
    const sideZ=point.z+0.75*cfg.diameter, surroundingZ=bedWposZ+cfg.minThickness;
    if(!(sideZ<surroundingZ-0.05))throw new Error(`Recess detected at Z${point.z.toFixed(3)}, but 0.75D above that floor does not clear the surrounding surface for wall tracing. Partial scan retained.`);
    if(sideZ-cfg.radius+cfg.usableLength<bedWposZ+cfg.maxThickness)throw new Error('Probe shaft may contact the part while tracing this recess. Partial scan retained.');
    const initialX=limits.x.max-state.wposZeroMachine[0]-Z_LIMIT_MARGIN;
    if(initialX<=point.x+0.1)throw new Error('Recess detected too close to the search-box limit to trace safely. Partial scan retained.');
    let initialTarget=[initialX,point.y];
    if(entryContact&&[entryContact.x,entryContact.y].every(Number.isFinite)){
        const dx=entryContact.x-point.x,dy=entryContact.y-point.y,length=Math.hypot(dx,dy);
        if(length>.1){const extension=cfg.diameter;initialTarget=[entryContact.x+dx/length*extension,entryContact.y+dy/length*extension];}
    }
    checkScanTravel([initialTarget[0],initialTarget[1],sideZ],limits);
    const contour=resumeBoundary?(saved.traceContacts??[]):(existing?.contour??[]),spacing=Math.min(cfg.spacing,cfg.diameter),clearance=Math.min(Number($('polygonClearance').value),cfg.radius*0.5);
    if(resumeBoundary&&saved.task?.initialTarget?.every(Number.isFinite))initialTarget=saved.task.initialTarget.slice();
    const task={seed:{x:point.x,y:point.y,z:point.z},parentIndex,minThickness:cfg.minThickness,initialTarget,entryContact:entryContact?{x:entryContact.x,y:entryContact.y}:(saved.task?.entryContact??null)};
    state.tracingRecess=true;
    try {
        if(!resumeBoundary&&!resumeFloor){
            state.scanCheckpoint={phase:'surface',stage:'recess-boundary',task,traceContacts:contour,cursor:null,nextIndex:0,lastLocationWpos:[point.x,point.y,sideZ],lastProbe:{x:point.x,y:point.y,z:point.z}};
            if(wallContact){
                const release=await releaseSurfaceWallContact(wallContact,cfg,limits,'Recess entry');
                logHomingDiagnostic('Recess entry cleared the contacted wall before tracing',{entryContact,seed:{x:point.x,y:point.y,z:point.z},releasePosition:release.released.wpos,backoffDirection:release.reverse,seedDistance:Math.hypot(point.x-release.released.wpos[0],point.y-release.released.wpos[1]),minimumWallMargin:Math.max(cfg.radius+.5,.75*cfg.diameter)});
            }
            checkScanTravel([point.x,point.y,sideZ],limits);
            const before=await currentSnapshot();
            if(!before.wpos?.every(Number.isFinite))throw Error('Recess: current position is unavailable.');
            if(before.wpos[2]<clearanceZ-.01)await scanMove([before.wpos[0],before.wpos[1],clearanceZ],limits,'Recess: raise before returning to the confirmed floor position');
            await scanMove([point.x,point.y,clearanceZ],limits,'Recess: return above the confirmed floor-probe position');
            await ultraGuardedDescent([point.x,point.y,sideZ],limits,'Recess: descend at the confirmed floor-probe position',cfg,cfg.slowFeed);
        }
        if(!resumeFloor)await scanPolygonPrototype(cfg,limits,point.z,{direction:2,step:spacing,clearance,initialTarget,contacts:contour,checkpointStage:'recess-boundary',cursor:resumeBoundary?saved.cursor:null,pendingObservation:resumeBoundary?saved.pendingObservation:null,feedOverride:cfg.slowFeed});
        const floorPlan=planPolygonSurface(contour,{diameter:cfg.diameter,spacing,maxSamples:MAX_SURFACE_SAMPLES});
        if(state.recesses.reduce((sum,r)=>sum+r.floor.length,0)+floorPlan.samples.length>MAX_SURFACE_SAMPLES)throw new Error('Recess floor sample limit reached; partial scan retained.');
        const recess=existing??{contour,floor:[point],floorZ:point.z,sideZ,parentIndex,seed:task.seed};
        if(!existing)state.recesses.push(recess);
        state.scanCheckpoint={phase:'surface',stage:'recess-floor',task,traceContacts:contour,nextIndex:resumeFloor?(saved.nextIndex??0):0,lastLocationWpos:state.scanCheckpoint?.lastLocationWpos??null,lastProbe:state.scanCheckpoint?.lastProbe??null};
        persistScanProgressSoon();
        if(!resumeFloor){
            logHomingDiagnostic('Recess perimeter closed',{contacts:contour.length,floorSamples:floorPlan.samples.length,threshold:bedWposZ+cfg.minThickness*0.9,sideZ});
            const current=await currentSnapshot();await scanMove([current.wpos[0],current.wpos[1],clearanceZ],limits,'Recess: raise to surface clearance');
        }
        const firstFloorIndex=resumeFloor?Math.max(0,saved.nextIndex??0):0;
        for(let i=firstFloorIndex;i<floorPlan.samples.length;i++){
            const p=floorPlan.samples[i];const sample=await probeSurfacePoint(p.x,p.y,cfg,limits,clearanceZ,bedWposZ,`Recess floor ${i+1}/${floorPlan.samples.length}`);
            if(sample.z>=bedWposZ+cfg.minThickness*0.9)throw new Error('Recess floor probe reached the surrounding top; partial scan retained.');
            recess.floor.push(sample);
            state.polygonSurfacePoints??=[];state.polygonSurfacePoints.push(sample);state.scanCheckpoint={phase:'surface',stage:'recess-floor',task,traceContacts:contour,nextIndex:i+1,lastLocationWpos:[sample.x,sample.y,sample.z],lastProbe:{x:sample.x,y:sample.y,z:sample.z}};persistScanProgressSoon();renderPerimeterResult();
        }
        state.scanCheckpoint={phase:'surface',stage:'surface-finalization',nextIndex:floorPlan.samples.length,lastLocationWpos:state.scanCheckpoint?.lastLocationWpos??null,lastProbe:state.scanCheckpoint?.lastProbe??null};
    } finally { state.tracingRecess=false; }
}

async function scanInteriorSurface(cfg, limits, clearanceZ, bedWposZ) {
    // The first touch is 0.5D inside the boundary; its Z is reported at the
    // boundary. The separate 0.75D release distance is unchanged.
    const edgeOffset = cfg.diameter * 0.5;
    const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
    const normalizeAngle = (angle) => (angle + 2 * Math.PI) % (2 * Math.PI);
    const angularDistance = (a, b) => {
        const delta = Math.abs(a - b) % (2 * Math.PI);
        return Math.min(delta, 2 * Math.PI - delta);
    };
    const originalBoundaryPoints = state.perimeterPoints.map((point) => ({ ...point }));
    const center = polygonAreaCentroid(originalBoundaryPoints);
    const boundarySamples = originalBoundaryPoints.map((point) => ({
        angle: normalizeAngle(Math.atan2(point.y - center.y, point.x - center.x)),
        boundaryRadius: Math.hypot(point.x - center.x, point.y - center.y),
        radialCorner: false,
        point
    }));
    const rayPolygonRadius = (direction) => {
        const intersections = [];
        for (let index = 0; index < state.perimeterPoints.length; index += 1) {
            const a = state.perimeterPoints[index];
            const b = state.perimeterPoints[(index + 1) % state.perimeterPoints.length];
            const start = [a.x - center.x, a.y - center.y];
            const edge = [b.x - a.x, b.y - a.y];
            const denominator = cross2(direction, edge);
            if (Math.abs(denominator) < 1e-9) {
                // A radial can lie exactly along a measured edge. In that
                // case use its farthest positive endpoint as the boundary.
                for (const point of [a, b]) {
                    const xy = [point.x - center.x, point.y - center.y];
                    if (Math.abs(cross2(xy, direction)) < 1e-7) {
                        const distance = xy[0] * direction[0] + xy[1] * direction[1];
                        if (distance > 0) intersections.push({ distance, segmentIndex: index });
                    }
                }
                continue;
            }
            const distance = cross2(start, edge) / denominator;
            const edgeFraction = cross2(start, direction) / denominator;
            if (distance >= 0 && edgeFraction >= -1e-8 && edgeFraction <= 1 + 1e-8) intersections.push({ distance, segmentIndex: index });
        }
        return intersections.length ? intersections.reduce((farthest, candidate) => candidate.distance > farthest.distance ? candidate : farthest) : null;
    };
    const diagonalRays = [
        [cfg.boundsX / 2, cfg.boundsY / 2],
        [-cfg.boundsX / 2, cfg.boundsY / 2],
        [-cfg.boundsX / 2, -cfg.boundsY / 2],
        [cfg.boundsX / 2, -cfg.boundsY / 2]
    ].map(([x, y], index) => {
        const magnitude = Math.hypot(x, y);
        const direction = [x / magnitude, y / magnitude];
        const intersection = rayPolygonRadius(direction);
        const boundaryRadius = intersection?.distance;
        if (!Number.isFinite(boundaryRadius) || boundaryRadius <= edgeOffset) {
            throw new Error(`Could not find enough measured perimeter along corner diagonal ${index + 1} for the first interior pass.`);
        }
        return {
            index: index + 1,
            angle: normalizeAngle(Math.atan2(direction[1], direction[0])),
            boundaryRadius,
            boundarySegmentIndex: intersection.segmentIndex,
            direction
        };
    });
    const polygonArea = originalBoundaryPoints.reduce((sum, point, index) => {
        const next = originalBoundaryPoints[(index + 1) % originalBoundaryPoints.length];
        return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
    const orientation = polygonArea >= 0 ? 1 : -1;
    const cornerSamplesByEdge = new Map();
    for (const ray of diagonalRays) {
        const existing = boundarySamples.find((sample) => angularDistance(sample.angle, ray.angle) < 1e-5);
        if (existing) {
            existing.boundaryRadius = ray.boundaryRadius;
            existing.radialCorner = true;
            existing.point = {
                ...existing.point,
                x: center.x + Math.cos(ray.angle) * ray.boundaryRadius,
                y: center.y + Math.sin(ray.angle) * ray.boundaryRadius,
                z: bedWposZ,
                kind: 'corner-radial boundary point'
            };
        } else {
            const insertionEdge = ray.boundarySegmentIndex;
            if (insertionEdge < 0) throw new Error(`Could not place corner diagonal ${ray.index} in perimeter order.`);
            const insertionOffset = normalizeAngle((ray.angle - boundarySamples[insertionEdge].angle) * orientation);
            const sample = {
                angle: ray.angle,
                boundaryRadius: ray.boundaryRadius,
                radialCorner: true,
                point: {
                    x: center.x + Math.cos(ray.angle) * ray.boundaryRadius,
                    y: center.y + Math.sin(ray.angle) * ray.boundaryRadius,
                    z: bedWposZ,
                    kind: 'corner-radial boundary point'
                }
            };
            if (!cornerSamplesByEdge.has(insertionEdge)) cornerSamplesByEdge.set(insertionEdge, []);
            cornerSamplesByEdge.get(insertionEdge).push({ offset: insertionOffset, sample });
        }
    }
    const orderedBoundarySamples = [];
    for (let index = 0; index < boundarySamples.length; index += 1) {
        orderedBoundarySamples.push(boundarySamples[index]);
        const insertions = cornerSamplesByEdge.get(index) ?? [];
        insertions.sort((a, b) => a.offset - b.offset);
        orderedBoundarySamples.push(...insertions.map(({ sample }) => sample));
    }
    state.perimeterPoints = orderedBoundarySamples.map((sample) => sample.point);
    const boundarySamplesInScanOrder = orderedBoundarySamples;
    const minRadius = Math.min(...boundarySamplesInScanOrder.map((sample) => sample.boundaryRadius));
    const firstTargets = boundarySamplesInScanOrder.map((sample) => {
        const boundary = { x: center.x + Math.cos(sample.angle) * sample.boundaryRadius, y: center.y + Math.sin(sample.angle) * sample.boundaryRadius };
        if (cfg.partShape !== 'circle') return insetPolygonBoundary(boundary, state.perimeterPoints, edgeOffset, center);
        const scale = (sample.boundaryRadius - edgeOffset) / sample.boundaryRadius;
        return { x: center.x + (boundary.x - center.x) * scale, y: center.y + (boundary.y - center.y) * scale };
    });
    const minFirstRadius = Math.min(...firstTargets.map((point) => Math.hypot(point.x - center.x, point.y - center.y)));
    const ringCount = Math.max(0, Math.ceil(minFirstRadius / cfg.spacing));
    const sampleCount = boundarySamplesInScanOrder.length;
    const estimated = ringCount * sampleCount + 1;
    if (estimated > MAX_SURFACE_SAMPLES) throw new Error(`Interior scan would require about ${estimated.toLocaleString()} Z probes, above the ${MAX_SURFACE_SAMPLES.toLocaleString()}-point safety limit. Increase Perimeter sample spacing.`);
    if (ringCount < 1) throw new Error(`The measured radius does not leave room for an interior scan starting ${edgeOffset.toFixed(2)} mm inside the perimeter. Use a smaller tip or larger part.`);
    const ringPlans = Array.from({ length: ringCount }, (_unused, ringIndex) => {
        const offset = edgeOffset + ringIndex * cfg.spacing;
        const points = boundarySamplesInScanOrder.map((sample, index) => {
            const radius = Math.hypot(firstTargets[index].x - center.x, firstTargets[index].y - center.y) - ringIndex * cfg.spacing;
            return {
                x: center.x + Math.cos(sample.angle) * radius,
                y: center.y + Math.sin(sample.angle) * radius,
                radialCorner: sample.radialCorner,
                reportX: ringIndex === 0 ? sample.point.x : undefined,
                reportY: ringIndex === 0 ? sample.point.y : undefined
            };
        });
        return { offset, points };
    });
    // Validate every planned XY and the full vertical probing span before
    // starting any interior motion, so a late out-of-travel point cannot
    // leave a partially executed unsafe scan.
    for (const [ringIndex, ring] of ringPlans.entries()) {
        for (const [index, point] of ring.points.entries()) {
            if (Math.hypot(point.x - center.x, point.y - center.y) <= 0) throw new Error(`Interior ring ${ringIndex + 1} crosses the part center at sample ${index + 1}.`);
            checkScanTravel([point.x, point.y, clearanceZ], limits);
            checkScanTravel([point.x, point.y, bedWposZ], limits);
        }
    }
    checkScanTravel([center.x, center.y, clearanceZ], limits);
    checkScanTravel([center.x, center.y, bedWposZ], limits);
    logHomingDiagnostic('Interior scan plan', {
        edgeOffset, center, minMeasuredRadius: minRadius, ringCount, sampleCount,
        estimatedSurfacePoints: estimated, spacing: cfg.spacing, clearanceZ, bedWposZ,
        geometry: 'first pass inset 0.5D from the measured boundary; later passes advance inward along rays',
        cornerRadialSamples: diagonalRays.map((ray) => ({
            corner: ray.index,
            direction: ray.direction,
            measuredBoundaryRadius: ray.boundaryRadius
        })),
        perimeterVerticesIncludingInterpolatedCornerRadials: state.perimeterPoints.length
    });
    state.surfaceRings = [];
    state.surfaceCenter = null;
    state.surfaceComplete = false;
    for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
        if (state.stopScan) throw new Error('Scan stopped by user before the next interior ring.');
        const plan = ringPlans[ringIndex];
        const ring = { offset: plan.offset, points: [] };
        state.surfaceRings.push(ring);
        for (let index = 0; index < plan.points.length; index += 1) {
            if (state.stopScan) throw new Error('Scan stopped by user before the next interior sample.');
            const target = plan.points[index];
            const point = await probeSurfacePoint(target.x, target.y, cfg, limits, clearanceZ, bedWposZ, `Interior ring ${ringIndex + 1}/${ringCount}, point ${index + 1}/${sampleCount}`);
            if (ringIndex === 0) {
                point.probeX = point.x;
                point.probeY = point.y;
                point.x = target.reportX;
                point.y = target.reportY;
                logHomingDiagnostic('First surface point reported at perimeter', {
                    probeWpos: [point.probeX, point.probeY], reportedWpos: [point.x, point.y],
                    heightWpos: point.z, clearance: edgeOffset
                });
            }
            point.radialCorner = target.radialCorner;
            ring.points.push(point);
            renderPerimeterResult();
            $('scanStatus').textContent = `Interior ring ${ringIndex + 1}/${ringCount}: ${index + 1}/${sampleCount} Z samples captured.`;
        }
        renderPerimeterResult();
    }
    state.surfaceCenter = await probeSurfacePoint(center.x, center.y, cfg, limits, clearanceZ, bedWposZ, 'Interior center point');
    state.surfaceComplete = true;
    if(state.recesses?.length){
        const measured=state.surfaceRings.flatMap(r=>r.points.map(p=>({...p,x:p.probeX??p.x,y:p.probeY??p.y}))).concat(state.surfaceCenter,...state.recesses.flatMap(r=>r.floor));
        state.polygonMesh=polygonMesh(state.perimeterPoints,measured,cfg.spacing,bedWposZ,state.recesses,bedWposZ+cfg.minThickness*.9);
    }
    renderPerimeterResult();
}

async function scanPolygonSurfacePrototype(cfg,limits,clearanceZ,bedWposZ,{resumeCheckpoint=null}={}) {
    const plan=planPolygonSurface(state.perimeterPoints,{diameter:cfg.diameter,spacing:cfg.spacing,maxSamples:MAX_SURFACE_SAMPLES});
    const reportedOuterBoundary=compensateContour(state.perimeterPoints.slice(),cfg.radius);
    state.surfacePreviewBoundary=reportedOuterBoundary;
    const projectToBoundary=point=>{
        let nearest=null,best=Infinity;
        for(let i=0;i<reportedOuterBoundary.length;i++){
            const a=reportedOuterBoundary[i],b=reportedOuterBoundary[(i+1)%reportedOuterBoundary.length],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;
            const t=l?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/l)):0,x=a.x+t*dx,y=a.y+t*dy,d=(point.x-x)**2+(point.y-y)**2;
            if(d<best){best=d;nearest={x,y};}
        }
        if(!nearest)throw Error('Could not project the first surface pass onto the measured perimeter.');
        return nearest;
    };
    const cutoutExclusionCache=new WeakMap(),cutoutSurfaceMargin=.25*cfg.diameter;
    const cutoutExclusion=recess=>{
        if(cutoutExclusionCache.has(recess))return cutoutExclusionCache.get(recess);
        const raw=recess.rawContour??recess.contour;
        let exclusion;
        try{exclusion={contour:compensateContour(raw.slice(),cfg.radius,{recess:true}),margin:cutoutSurfaceMargin,physicalEdge:true};}
        catch(error){
            exclusion={contour:raw,margin:cfg.radius+cutoutSurfaceMargin,physicalEdge:false};
            logHomingDiagnostic('Cutout surface clearance uses raw probe-center contour fallback',{contacts:raw.length,margin:exclusion.margin,message:error.message});
        }
        cutoutExclusionCache.set(recess,exclusion);
        return exclusion;
    };
    for(const point of plan.samples){checkScanTravel([point.x,point.y,clearanceZ],limits);checkScanTravel([point.x,point.y,bedWposZ],limits);}
    logHomingDiagnostic('Polygon inward surface passes planned',{sampleCount:plan.samples.length,loopCount:plan.rings.length,clearanceFromRawCenters:plan.clearance,estimatedInsetFromPartEdge:Math.max(0,plan.clearance-cfg.radius),first:plan.samples[0]});
    const resumeStage=resumeCheckpoint?.phase==='surface'&&['top-surface','surface-finalization','recess-boundary','recess-floor'].includes(resumeCheckpoint.stage);
    if(!resumeStage)state.polygonSurfacePoints=[];
    state.polygonMesh=null;
    renderPerimeterResult();
    const lowerPoints=resumeStage?state.polygonSurfacePoints.filter(point=>point.scanStage==='top-surface'):[];
    let lastLower=lowerPoints.at(-1)??null;
    const onRaisedContact=async(travel,start)=>{
        if(!lastLower)return false;
        const p={x:travel.snapshot.wpos[0],y:travel.snapshot.wpos[1]};
        const near=(contour)=>contour.some((a,i)=>{const b=contour[(i+1)%contour.length],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<=cfg.diameter;});
        if(state.recesses.some(r=>Math.abs(r.floorZ-lastLower.z)<.15&&near(r.contour)))return false;
        const candidates=recessCandidates(lowerPoints,{bedZ:bedWposZ,spacing:cfg.spacing,diameter:cfg.diameter})
            .filter(candidate=>candidate.reference-candidate.point.z>.75*cfg.diameter+.05);
        const lowerXY=point=>[point.probeX??point.x,point.probeY??point.y];
        const [lowerX,lowerY]=lowerXY(lastLower);
        const nearbyCandidates=candidates.filter(candidate=>{
            const [x,y]=lowerXY(candidate.point);
            return Math.hypot(x-lowerX,y-lowerY)<=4*cfg.diameter
                &&Math.abs(candidate.point.z-lastLower.z)<=Math.max(.25,.2*cfg.diameter);
        });
        const confirmedFloor=nearbyCandidates.find(candidate=>candidate.point===lastLower)
            ??nearbyCandidates.find(candidate=>Math.hypot(lowerXY(candidate.point)[0]-lowerX,lowerXY(candidate.point)[1]-lowerY)<=.5*cfg.diameter);
        if(confirmedFloor){
            const direction=travel.direction;
            if(!travel.contact?.every(Number.isFinite)||!state.wposZeroMachine?.every(Number.isFinite))throw Error('Recess entry: the controller did not provide a confirmed wall contact position. The scan paused before moving farther into the cutout.');
            const wallCenter=travel.contact.map((value,axis)=>value-state.wposZeroMachine[axis]);
            const reverse=[-direction[0],-direction[1]],minimumWallMargin=Math.max(cfg.radius+.5,.75*cfg.diameter);
            const safeSeeds=nearbyCandidates.filter(candidate=>{
                const [x,y]=lowerXY(candidate.point);
                const wallMargin=(x-wallCenter[0])*reverse[0]+(y-wallCenter[1])*reverse[1];
                return Math.hypot(x-lowerX,y-lowerY)<=3*cfg.diameter&&wallMargin>=minimumWallMargin;
            }).sort((a,b)=>{
                const [ax,ay]=lowerXY(a.point),[bx,by]=lowerXY(b.point);
                const projectionA=(ax-lowerX)*direction[0]+(ay-lowerY)*direction[1];
                const projectionB=(bx-lowerX)*direction[0]+(by-lowerY)*direction[1];
                return projectionA-projectionB;
            });
            if(!safeSeeds.length)throw Error(`Recess entry paused: no confirmed floor sample is at least ${minimumWallMargin.toFixed(2)} mm inside the contacted wall. The scan did not descend or retry at the edge.`);
            const seed=safeSeeds[0];
            const [seedX,seedY]=lowerXY(seed.point);
            const localCfg={...cfg,minThickness:seed.reference-bedWposZ};
            const wallMargin=(seedX-wallCenter[0])*reverse[0]+(seedY-wallCenter[1])*reverse[1];
            logHomingDiagnostic('Surface wall contact classified as recess entry',{contact:wallCenter,stopped:p,lastLower:{x:lowerX,y:lowerY,z:lastLower.z},seed:{x:seedX,y:seedY,z:seed.point.z},candidateCount:nearbyCandidates.length,approachDirection:direction,seedOffsetFromLastLower:Math.hypot(seedX-lowerX,seedY-lowerY),wallMargin,minimumWallMargin,referenceZ:seed.reference});
            await traceRecessFromSurface({...seed.point,x:seedX,y:seedY},localCfg,limits,clearanceZ,bedWposZ,null,{wallContact:travel,entryContact:wallCenter});
            return true;
        }
        await traceRaisedSurface(travel,start,lastLower,cfg,limits,clearanceZ);
        return true;
    };
    const traceRecessAfterLowTouch=async currentPoint=>{
        const candidates=recessCandidates(lowerPoints,{bedZ:bedWposZ,spacing:cfg.spacing,diameter:cfg.diameter})
            .filter(candidate=>candidate.reference-candidate.point.z>.75*cfg.diameter+.05)
            .filter(candidate=>!state.recesses.some(r=>(r.parentIndex??null)===null&&r.contour?.length>=3&&insideOrNearRecess(candidate.point,r.contour,cfg.diameter)));
        const [currentX,currentY]=[currentPoint.probeX??currentPoint.x,currentPoint.probeY??currentPoint.y];
        const nearby=candidates.filter(candidate=>{
            const x=candidate.point.probeX??candidate.point.x,y=candidate.point.probeY??candidate.point.y;
            return Math.hypot(x-currentX,y-currentY)<=Math.max(cfg.spacing*.75,.25*cfg.diameter)
                &&Math.abs(candidate.point.z-currentPoint.z)<=Math.max(.25,.2*cfg.diameter);
        });
        if(!nearby.length)return false;
        const minimumWallMargin=Math.max(cfg.radius+.5,.75*cfg.diameter),feature=candidates.find(candidate=>nearby.includes(candidate))??nearby[0];
        const floorCandidates=candidates.filter(candidate=>{
            const x=candidate.point.probeX??candidate.point.x,y=candidate.point.probeY??candidate.point.y;
            return Math.hypot(x-currentX,y-currentY)<=3*cfg.diameter
                &&Math.abs(candidate.point.z-feature.point.z)<=Math.max(.25,.2*cfg.diameter);
        });
        const highSamples=lowerPoints.filter(sample=>sample!==feature.point&&sample.z>feature.point.z+Math.max(.75*cfg.diameter,.5));
        const marginFor=candidate=>{
            const x=candidate.point.probeX??candidate.point.x,y=candidate.point.probeY??candidate.point.y;
            return highSamples.reduce((best,sample)=>Math.min(best,Math.hypot(x-(sample.probeX??sample.x),y-(sample.probeY??sample.y))),Infinity);
        };
        const safe=floorCandidates.filter(candidate=>marginFor(candidate)>=minimumWallMargin).sort((a,b)=>marginFor(b)-marginFor(a));
        if(!safe.length)throw Error(`Recess entry paused: no confirmed floor sample has ${minimumWallMargin.toFixed(2)} mm clearance from the measured surrounding surface. The scan did not descend again near the cutout edge.`);
        const seed=safe[0],seedX=seed.point.probeX??seed.point.x,seedY=seed.point.probeY??seed.point.y;
        const nearestHigh=highSamples.map(sample=>({sample,distance:Math.hypot(seedX-(sample.probeX??sample.x),seedY-(sample.probeY??sample.y))})).sort((a,b)=>a.distance-b.distance)[0]?.sample;
        const entryContact=nearestHigh?{x:nearestHigh.probeX??nearestHigh.x,y:nearestHigh.probeY??nearestHigh.y}:null;
        const localCfg={...cfg,minThickness:seed.reference-bedWposZ};
        logHomingDiagnostic('Low surface touch identified a cutout before the next planned sample',{latest:{x:currentX,y:currentY,z:currentPoint.z},seed:{x:seedX,y:seedY,z:seed.point.z},safeMargin:marginFor(seed),minimumWallMargin,entryTarget:entryContact,nearbyCandidateCount:nearby.length});
        await traceRecessFromSurface({...seed.point,x:seedX,y:seedY},localCfg,limits,clearanceZ,bedWposZ,null,{entryContact});
        return true;
    };
    const startIndex=resumeStage?Math.min(plan.samples.length,resumeCheckpoint.stage==='top-surface'?Math.max(0,resumeCheckpoint.nextIndex??0):plan.samples.length):0;
    for(let i=startIndex;i<plan.samples.length;i++){
        if(state.stopScan)throw new Error('Polygon surface scan stopped by user.');
        const target=plan.samples[i];
        const mappedRaised=state.recesses.find(r=>r.raised&&r.contour?.length>=3&&insideOrNearRecess(target,r.contour,.02));
        const mappedCutout=state.recesses.find(r=>!r.raised&&r.contour?.length>=3&&(()=>{const exclusion=cutoutExclusion(r);return insideOrNearRecess(target,exclusion.contour,exclusion.margin);})());
        if(mappedRaised){
            logHomingDiagnostic('Upper surface point skipped inside a mapped raised area',{target,physicalBoundaryInset:0.25*cfg.diameter});
            continue;
        }
        if(mappedCutout){
            const exclusion=cutoutExclusion(mappedCutout);
            logHomingDiagnostic('Upper surface point held outside a mapped cutout perimeter',{target,physicalEdgeMargin:exclusion.margin,marginUsesPhysicalEdge:exclusion.physicalEdge});
            continue;
        }
        const point=await probeSurfacePoint(target.x,target.y,cfg,limits,clearanceZ,bedWposZ,`Polygon surface ${i+1}/${plan.samples.length}`,onRaisedContact);
        if(point.raisedBoundary){i--;lastLower=null;continue;}
        if(target.pass===0){
            point.probeX=point.x;point.probeY=point.y;
            const reported=projectToBoundary(point);point.x=reported.x;point.y=reported.y;point.reportedAtPerimeter=true;
            logHomingDiagnostic('First surface pass projected onto perimeter',{probeXY:[point.probeX,point.probeY],reportedXY:[point.x,point.y],edgeInset:plan.clearance-cfg.radius});
        }
        lowerPoints.push(point);lastLower=point;
        point.scanStage='top-surface';point.scanIndex=i;
        state.polygonSurfacePoints.push(point);
        state.scanCheckpoint={phase:'surface',stage:'top-surface',nextIndex:i+1,lastLocationWpos:[point.probeX??point.x,point.probeY??point.y,point.z],lastProbe:{x:point.probeX??point.x,y:point.probeY??point.y,z:point.z}};
        persistScanProgressSoon();
        await traceRecessAfterLowTouch(point);
        $('scanStatus').textContent=`Polygon surface: ${i+1}/${plan.samples.length} samples captured.`;
        renderPerimeterResult();
    }
    state.scanCheckpoint={phase:'surface',stage:'surface-finalization',nextIndex:plan.samples.length,lastLocationWpos:state.scanCheckpoint?.lastLocationWpos??null,lastProbe:state.scanCheckpoint?.lastProbe??null};
    persistScanProgressSoon();
    for(const raised of state.recesses.filter(r=>r.raised)){
        const current=await currentSnapshot();
        if(current.wpos[2]<clearanceZ-.01)await scanMove([current.wpos[0],current.wpos[1],clearanceZ],limits,'Raised surface: raise to full clearance');
        const raisedPlan=planPolygonSurface(raised.contour,{diameter:cfg.diameter,spacing:cfg.spacing,maxSamples:MAX_SURFACE_SAMPLES});
        logHomingDiagnostic('Raised upper-surface path inset from its boundary',{samples:raisedPlan.samples.length,physicalBoundaryInset:Math.max(0,raisedPlan.clearance-cfg.radius),rawProbeCenterInset:raisedPlan.clearance});
        for(let i=0;i<raisedPlan.samples.length;i++){
            const target=raisedPlan.samples[i],point=await probeSurfacePoint(target.x,target.y,cfg,limits,clearanceZ,bedWposZ,`Raised surface ${i+1}/${raisedPlan.samples.length}`);
            raised.floor.push(point);state.polygonSurfacePoints.push(point);renderPerimeterResult();
        }
    }
    for(const recess of state.recesses.filter(r=>r.needsFloor)){
        const current=await currentSnapshot();
        if(current.wpos[2]<clearanceZ-.01)await scanMove([current.wpos[0],current.wpos[1],clearanceZ],limits,'Recess surface: raise to full clearance');
        const floorPlan=planPolygonSurface(recess.contour,{diameter:cfg.diameter,spacing:Math.min(cfg.spacing,cfg.diameter),maxSamples:MAX_SURFACE_SAMPLES});
        for(let i=0;i<floorPlan.samples.length;i++){
            const target=floorPlan.samples[i],point=await probeSurfacePoint(target.x,target.y,cfg,limits,clearanceZ,bedWposZ,`Recess floor ${i+1}/${floorPlan.samples.length}`);
            recess.floor.push(point);state.polygonSurfacePoints.push(point);renderPerimeterResult();
        }
    }
    const scanRecesses=async(points,parentIndex=null)=>{
        const candidates=recessCandidates(points,{bedZ:bedWposZ,spacing:cfg.spacing,diameter:cfg.diameter})
            .filter(c=>c.reference-c.point.z>0.75*cfg.diameter+0.05)
            .sort((a,b)=>b.point.z-a.point.z);
        for(const candidate of candidates){
            if(state.stopScan)throw Error('Scan stopped before the next recess.');
            const savedTask=state.scanCheckpoint?.task,savedSeed=savedTask?.seed;
            const resumesThisCandidate=['recess-boundary','recess-floor'].includes(state.scanCheckpoint?.stage)
                &&savedTask.parentIndex===parentIndex&&savedSeed
                &&Math.hypot(savedSeed.x-candidate.point.x,savedSeed.y-candidate.point.y)<Math.max(.05,cfg.spacing*.1)
                &&Math.abs(savedSeed.z-candidate.point.z)<.1;
            if(!resumesThisCandidate&&state.recesses.some(r=>(r.parentIndex??null)===parentIndex&&insideOrNearRecess(candidate.point,r.contour,cfg.diameter)))continue;
            const localCfg={...cfg,minThickness:candidate.reference-bedWposZ}, index=state.recesses.length;
            await traceRecessFromSurface(candidate.point,localCfg,limits,clearanceZ,bedWposZ,parentIndex);
            if(state.recesses.length>index)await scanRecesses(state.recesses[index].floor,index);
        }
    };
    await scanRecesses(lowerPoints);
    for(let i=0;i<state.recesses.length;i++)if(state.recesses[i].raised||state.recesses[i].needsFloor)await scanRecesses(state.recesses[i].floor,i);
    const allSurface=state.polygonSurfacePoints.slice();
    $('scanStatus').textContent='Applying probe-radius compensation and building the closed surface…';
    await new Promise(resolve=>setTimeout(resolve,0));
    state.rawPerimeterPoints=state.perimeterPoints.slice();
    state.perimeterPoints=reportedOuterBoundary;
    state.recesses=state.recesses.map(r=>({...r,rawContour:r.contour,contour:compensateContour(r.contour,cfg.radius,{recess:!r.raised})}));
    state.compensationApplied=true;
    logHomingDiagnostic('Probe-radius compensation applied',{rawContacts:state.rawPerimeterPoints.length,correctedPoints:state.perimeterPoints.length,radius:cfg.radius,approachAngles:state.perimeterPoints.filter(p=>Number.isFinite(p.approachAngle)).map(p=>p.approachAngle)});
    state.polygonMesh=polygonMesh(state.perimeterPoints,allSurface,cfg.spacing,bedWposZ,state.recesses);
    state.polygonSurfacePoints=allSurface;
    state.surfaceComplete=true;
    state.fullSurfaceAvailable=true;
    try { await storage.set('surface-perimeter-mapper.polygon-result.v1',{perimeter:state.perimeterPoints,surface:allSurface,spacing:cfg.spacing,bedZ:bedWposZ,recesses:state.recesses}); }
    catch(error) { console.warn('Could not save polygon result',error); }
    renderPerimeterResult();
}

async function findBedFromFrontEdge({ cfg, limits, safeZ, frontExtent }) {
    const stepOut = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const frontEdgeY = -frontExtent;
    const outerLimitY = -cfg.rectangleHeight / 2;
    let candidateY = Math.max(outerLimitY, frontEdgeY - stepOut);
    const maxAttempts = Math.ceil(Math.max(0, candidateY - outerLimitY) / stepOut - 1e-9) + 1;
    const zDirection = limits.zHomePositive ? -1 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (state.stopScan) throw new Error('Scan stopped by user before the bed was found.');
        const targetXY = [0, candidateY, safeZ];
        checkScanTravel(targetXY, limits);
        if (attempt === 1) {
            await scanMove(targetXY, limits, 'Moving to predicted front edge to find the bed');
        } else {
            await scanMove([0, candidateY, safeZ], limits, `Bed search ${attempt}/${maxAttempts}: moving outward by ${stepOut.toFixed(2)} mm`);
        }
        const start = await currentSnapshot();
        const available = zDirection < 0
            ? start.mpos[2] - limits.z.min - Z_LIMIT_MARGIN
            : limits.z.max - start.mpos[2] - Z_LIMIT_MARGIN;
        if (!Number.isFinite(available) || available <= 0.5) throw new Error('There is not enough Z travel left to probe for the bed from the current clearance height.');
        const sequence = state.probeStatusSequence;
        const command = `G21 G91 G38.3 Z${(zDirection * available).toFixed(3)} F${cfg.fastFeed}`;
        $('scanStatus').textContent = `Bed search ${attempt}/${maxAttempts}: probing down at WPOS Y${candidateY.toFixed(2)}…`;
        logHomingDiagnostic('Bed search Z probe TX', { attempt, maxAttempts, wposY: candidateY, startMpos: start.mpos, availableZTravel: available, command });
        const result = await queryProbeController(command, { timeout: Math.max(120000, Math.ceil((available / cfg.fastFeed) * 60000 + 30000)), maxLines: 80 });
        logHomingDiagnostic('Bed search Z probe RX', { attempt, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
        if (!result.complete || !result.ok || result.error) throw new Error(`Bed search probe was not accepted: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
        const report = parseOptionalProbe(result);
        const status = await refreshScanStatus();
        if (status.state !== 'Idle') await waitForIdle(30000, 0);
        const touched = report?.triggered || (!report && state.probePinKnown && state.probePinActive);
        if (!touched) {
            throw new Error(`No bed contact at WPOS Y${candidateY.toFixed(2)} before reaching the safe Z-travel limit. Check the probe, entered thickness range, and search-box placement.`);
        }
        const contactMpos = report?.mpos ?? status.mpos;
        const bedWposZ = contactMpos[2] - state.wposZeroMachine[2];
        const bedThresholdZ = -(cfg.minThickness * 0.5);
        const classifiedAsBed = bedWposZ <= bedThresholdZ;
        const releaseZ = classifiedAsBed ? bedWposZ + cfg.selectedHeight : safeZ;
        logHomingDiagnostic('Bed search contact', { attempt, wposY: candidateY, contactMpos, bedWposZ, bedThresholdZ, minimumThickness: cfg.minThickness, classifiedAsBed, releaseZ, releaseHeight: classifiedAsBed ? 'calculated perimeter height' : 'full clearance' });
        if (classifiedAsBed) {
            try {
                checkScanTravel([0, candidateY, releaseZ], limits);
            } catch (error) {
                await waitForProbeClearAfterRetract(limits, [0, candidateY, safeZ], `Bed-search recovery to full clearance at Y${candidateY.toFixed(2)}`);
                throw error;
            }
        }
        await waitForProbeClearAfterRetract(limits, [0, candidateY, releaseZ], classifiedAsBed
            ? `Bed-search retract to perimeter height at Y${candidateY.toFixed(2)}`
            : `Part-contact retract to full clearance at Y${candidateY.toFixed(2)}`);
        if (classifiedAsBed) {
            state.bedWposZ = bedWposZ;
            $('scanStatus').textContent = `Bed found at WPOS Z${bedWposZ.toFixed(3)} mm, Y${candidateY.toFixed(2)} mm.`;
            logHomingDiagnostic('Bed height accepted', { bedWposZ, wposY: candidateY, attempt });
            return { bedWposZ, wposY: candidateY };
        }
        if (attempt === maxAttempts) {
            throw new Error(`No bed found by the search-box boundary at WPOS Y${outerLimitY.toFixed(2)}. The last contact at Z${bedWposZ.toFixed(3)} mm was above the bed threshold ${bedThresholdZ.toFixed(3)} mm. Increase Search box width Y or correct the entered part dimensions.`);
        }
        candidateY = Math.max(outerLimitY, candidateY - stepOut);
    }
    throw new Error('Bed search ended without a valid bed reading.');
}

async function waitForSurfaceProbeRecovery(sampleLabel, reason, { x, y, clearanceZ, limits }) {
    const recovered = await waitForPolygonRecovery(sampleLabel, false, {
        message: `${sampleLabel}: ${reason} Inspect the probe, wiring, and path. Continue returns to this sample at full clearance and retries it; cancel preserves the partial map and stops the scan.`,
        resumeSupported: true
    });
    if (!recovered) return false;

    // A recovery jog may move away from this sample. Rejoin only after the
    // shared dialog has confirmed a fresh, homed Idle state and a clear input.
    const snapshot = await refreshScanStatus(3000);
    if (snapshot.state !== 'Idle' || !snapshot.homed || !state.probePinKnown || state.probePinActive
        || !snapshot.wpos?.every(Number.isFinite) || !snapshot.mpos?.every(Number.isFinite)) {
        throw new Error(`${sampleLabel}: could not confirm a fresh, idle, clear position after recovery.`);
    }
    const transitZ = Math.max(snapshot.wpos[2], clearanceZ);
    checkScanTravel([snapshot.wpos[0], snapshot.wpos[1], transitZ], limits);
    checkScanTravel([x, y, transitZ], limits);
    if (snapshot.wpos[2] < transitZ - 0.05) {
        await scanMove([snapshot.wpos[0], snapshot.wpos[1], transitZ], limits, `${sampleLabel}: raise vertically to recovery clearance`);
    }
    const raised = await currentSnapshot();
    if (Math.hypot(raised.wpos[0] - x, raised.wpos[1] - y) > 0.12) {
        await scanMove([x, y, transitZ], limits, `${sampleLabel}: return above the interrupted sample`);
    }
    const aligned = await currentSnapshot();
    if (Math.abs(aligned.wpos[2] - clearanceZ) > 0.12) {
        await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: lower to full-clearance retry height`);
    }
    logHomingDiagnostic('Interior probe recovery rejoined exact sample', { sampleLabel, target: [x, y, clearanceZ], recoveryJogged: recovered.recoveryJogged, workPosition: state.workPosition });
    return true;
}

async function ultraGuardedDescent(target,limits,label,cfg,feedOverride=null){
    checkScanTravel(target,limits);
    const start=await currentSnapshot();
    if(!start.wpos?.every(Number.isFinite)||start.wpos[2]<target[2]-0.01||!state.probePinKnown||state.probePinActive)throw Error(`${label}: a clear probe and confirmed clearance position are required.`);
    if(Math.abs(start.wpos[2]-target[2])<0.01)return;
    let z=start.wpos[2];const feed=feedOverride??(cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed);
    while(z>target[2]+.005){
        if(state.stopScan)throw Error('Scan stopped before the next guarded descent.');
        const next=Math.max(target[2],z-cfg.usableLength),step=[target[0],target[1],next];
        const command=`G21 G90 G54 G38.3 Z${next.toFixed(3)} F${feed}`;
        const response=await queryProbeController(command,{timeout:Math.max(60000,Math.ceil((z-next)/feed*60000+15000)),maxLines:80});
        const report=parseOptionalProbe(response);
        if(!response.complete||!response.ok||response.error||!report)throw Error(`${label}: guarded descent did not return a valid probe report.`);
        if(report.triggered)throw Error(`${label}: probe contacted the part during descent; the scan stopped.`);
        await waitForScanPosition(step);z=next;
    }
}

async function maybeRefineUltraCorner(history,record,captured,cfg,limits,bedWposZ,{raw=false}={}){
    if(cfg.probeMode!=='ultra')return;
    if(history.length&&Math.hypot(record.center[0]-history.at(-1).center[0],record.center[1]-history.at(-1).center[1])<cfg.diameter*.1)return;
    history.push(record);if(history.length>3)history.shift();
    const plan=planUltraCorner(history,cfg.diameter);
    if(!plan||!plan.samples.length)return;
    const sideZ=record.center[2],travel=Math.max(cfg.diameter*1.5,1),release=cfg.diameter*PERIMETER_RELEASE_DIAMETER_FACTOR;
    const within=(p)=>checkScanTravel(p,limits);
    const makeItem=p=>({t:p.t,normal:p.outward,start:[p.center[0]+p.outward[0]*travel,p.center[1]+p.outward[1]*travel,sideZ],end:[p.center[0]-p.outward[0]*travel,p.center[1]-p.outward[1]*travel]});
    const validateItem=item=>{within(item.start);within([item.end[0],item.end[1],sideZ]);};
    const sequence=plan.samples.map(makeItem);
    for(const item of sequence)validateItem(item);
    for(const p of [plan.previous.clear,plan.current.clear]){within(p);within([p[0],p[1],sideZ]);}
    logHomingDiagnostic('Ultra precise corner detected',{degrees:plan.degrees,spacing:plan.spacing,refinementPoints:sequence.length,previous:plan.previous.center,current:plan.current.center});
    let snap=await currentSnapshot();await scanMove([snap.wpos[0],snap.wpos[1],sideZ],limits,'Ultra precise: stay at bed-clearance height before returning to corner');
    await scanMove([plan.previous.clear[0],plan.previous.clear[1],sideZ],limits,'Ultra precise: return to previous probe position at bed-clearance height');
    const added=[],retained=new Set();
    const retainAdded=()=>{
        for(let i=captured.length-1;i>=0;i--)if(retained.has(captured[i]))captured.splice(i,1);
        const insert=captured.indexOf(record.point);if(insert<0)throw Error('Ultra precise corner position was lost; partial scan retained.');
        captured.splice(insert,0,...added.map(a=>a.point));added.forEach(a=>retained.add(a.point));captured.forEach((p,i)=>p.index=i+1);
    };
    const probeRefinement=async(item,i)=>{
        validateItem(item);
        if(state.stopScan)throw Error('Ultra precise corner refinement stopped by user.');
        snap=await currentSnapshot();
        await scanMove([snap.wpos[0],snap.wpos[1],sideZ],limits,`Ultra corner ${i+1}: stay at bed-clearance height`);
        await scanMove([item.start[0],item.start[1],sideZ],limits,`Ultra corner ${i+1}: position outside edge`);
        const touch=await probeTravelLine(item.start,item.end,limits,`Ultra corner ${i+1}: slow touch`,cfg.slowFeed);
        if(!touch.contact)throw Error(`Ultra corner ${i+1}: no contact at the predicted edge; partial scan retained.`);
        const zero=state.wposZeroMachine,confirmed=touch.contact.map((v,j)=>v-zero[j]);
        const clear=[confirmed[0]+item.normal[0]*release,confirmed[1]+item.normal[1]*release,sideZ];within(clear);
        await waitForProbeClearAfterRetract(limits,clear,`Ultra corner ${i+1}: release`,{preserveZ:true});
        const point={x:confirmed[0]-(raw?0:item.normal[0]*cfg.radius),y:confirmed[1]-(raw?0:item.normal[1]*cfg.radius),z:bedWposZ,contactZ:confirmed[2],rawMpos:touch.contact.slice(),approach:[-item.normal[0],-item.normal[1]],kind:raw?'raw probe center':'ultra corner contact'};
        point.angle=Math.atan2(point.y,point.x)*180/Math.PI;
        logHomingDiagnostic('Ultra precise corner contact',{number:i+1,total:sequence.length,contactWpos:confirmed,reported:point});
        return {t:item.t,point,center:confirmed};
    };
    for(let i=0;i<sequence.length;i++){added.push(await probeRefinement(sequence[i],i));retainAdded();}
    for(let extra=0;extra<64;extra++){
        const entries=[{t:0,center:plan.previous.center},...added,{t:1,center:plan.current.center}];
        let gap=0,at=-1;for(let i=0;i<entries.length-1;i++){const d=Math.hypot(entries[i+1].center[0]-entries[i].center[0],entries[i+1].center[1]-entries[i].center[1]);if(d>gap){gap=d;at=i;}}
        if(gap<=cfg.diameter*.5+0.005)break;
        if(extra===63||entries[at+1].t-entries[at].t<0.0001)throw Error(`Ultra precise: cannot resolve a ${gap.toFixed(3)} mm corner gap to 0.5D. Scan stopped for review.`);
        const t=(entries[at].t+entries[at+1].t)/2,item=makeItem(sampleUltraCorner(plan.previous,plan.current,t));
        added.splice(at,0,await probeRefinement(item,sequence.length+extra));retainAdded();
    }
    renderPerimeterResult();
    snap=await currentSnapshot();await scanMove([snap.wpos[0],snap.wpos[1],sideZ],limits,'Ultra precise: stay at bed-clearance height after corner');
    await scanMove([plan.current.clear[0],plan.current.clear[1],sideZ],limits,'Ultra precise: return to direction-change position at bed-clearance height');
    const measured=[plan.previous.center,...added.map(p=>p.center),plan.current.center];
    const maxGap=Math.max(...measured.slice(1).map((p,i)=>Math.hypot(p[0]-measured[i][0],p[1]-measured[i][1])));
    if(maxGap>cfg.diameter*.5+0.005)throw Error(`Ultra precise: measured contacts are up to ${maxGap.toFixed(3)} mm apart, exceeding 0.5D. Scan stopped with partial contacts retained.`);
}

async function waitForPolygonProbeStop(label,expectedPin,timeoutMs=8000,{allowOperatorRecovery=true}={}) {
    const deadline=Date.now()+timeoutMs;let previous=null;
    while(Date.now()<deadline){
        if(state.stopScan)throw Error('Polygon scan stopped by user.');
        const snapshot=await refreshScanStatus();
        const rawState=state.lastProbeStatusLine?.match(/^<([^|>]+)/)?.[1];
        const rawPin=state.lastProbeStatusLine?.match(/\|Pn:([^|>]+)/)?.[1];
        const rawPinActive=rawPin===undefined?null:/P/.test(rawPin);
        if(snapshot.state==='Alarm'||rawState==='Alarm')throw Error(`${label}: controller entered Alarm.`);
        const idle=snapshot.state==='Idle'&&(!rawState||rawState==='Idle')&&state.probePinKnown&&state.probePinActive===expectedPin&&(rawPinActive===null||rawPinActive===expectedPin)&&snapshot.mpos?.every(Number.isFinite)&&snapshot.wpos?.every(Number.isFinite);
        if(idle){
            if(previous&&snapshot.mpos.every((value,i)=>Math.abs(value-previous[i])<=.03))return snapshot;
            previous=snapshot.mpos.slice();
        }else{previous=null;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    if(!allowOperatorRecovery)return null;
    const recovered=await waitForPolygonRecovery(label,expectedPin,{
        resumeSupported: expectedPin,
        message: expectedPin
            ?`The controller has not confirmed a stable probe contact after “${label}”. Inspect the input and motion. Continue is allowed only after a fresh, homed Idle report and a clear probe; the reported contact must still be verified.`
            :`The probe did not confirm release after “${label}”. The scan cannot safely replay this perimeter point. Use small jog steps to clear the probe, then acknowledge to stop and preserve the captured map.`
    });
    if(!recovered)throw Error(`${label}: scan canceled from the probe recovery dialog.`);
    return recovered;
}

async function extendPolygonRelease(contact,reverse,initialDistance,cfg,limits,label){
    let settled=await waitForPolygonProbeStop(label,false,1000,{allowOperatorRecovery:false});
    if(settled)return settled;
    const increment=Math.max(0.25,cfg.diameter*0.25),maximumDistance=cfg.diameter*3;
    for(let distance=initialDistance+increment;distance<=maximumDistance+1e-6;distance+=increment){
        const target=[contact[0]+reverse[0]*distance,contact[1]+reverse[1]*distance,contact[2]];
        try{checkScanTravel(target,limits);}catch(error){logHomingDiagnostic('Automatic perimeter release reached travel boundary',{label,distance,target,message:error.message});break;}
        logHomingDiagnostic('Automatic perimeter release extension',{label,distance,increment,target,probePinActive:state.probePinActive});
        await scanMove(target,limits,`${label}: extend retract to ${distance.toFixed(2)} mm`,true);
        settled=await waitForPolygonProbeStop(label,false,1000,{allowOperatorRecovery:false});
        if(settled){
            logHomingDiagnostic('Automatic perimeter release recovered',{label,distance,position:settled.wpos});
            return settled;
        }
    }
    return waitForPolygonProbeStop(label,false,8000);
}

async function jogDuringPolygonRecovery(axis,sign,step){
    if(!['X','Y','Z'].includes(axis)||![-1,1].includes(sign)||![0.1,0.5,1,5].includes(step))throw Error('Invalid recovery jog request.');
    await refreshScanStatus(2000);
    const statusAt=Math.max(state.lastProbeStatusAt||0,state.lastControllerStatusAt||0);
    if(Date.now()-statusAt>1500)throw Error('Recovery jog requires a fresh controller status report.');
    const before=await currentSnapshot();
    if(before.state!=='Idle'||!before.homed||!before.mpos?.every(Number.isFinite))throw Error('Recovery jogging requires a fresh, homed, idle machine position.');
    const limits=await readProbeLimits(),index={X:0,Y:1,Z:2}[axis],travel=axis==='X'?limits.x:axis==='Y'?limits.y:limits.z,target=before.mpos[index]+sign*step;
    if(target<travel.min+Z_LIMIT_MARGIN||target>travel.max-Z_LIMIT_MARGIN)throw Error(`${axis} jog would exceed reported machine travel ${travel.min}..${travel.max} mm.`);
    const line=`G21 G91 G0 ${axis}${(sign*step).toFixed(3)}`;
    logHomingDiagnostic('Polygon recovery jog started',{axis,sign,step,mpos:before.mpos,wpos:before.wpos,probePinActive:state.probePinActive,line});
    let jogError=null;
    try{await sendJogCommand(line);await waitForIdle(30000);}
    catch(error){jogError=error;}
    try{await sendJogCommand('G90',5000);}catch(error){if(!jogError)jogError=error;}
    if(jogError)throw jogError;
    const after=await refreshScanStatus(3000);
    logHomingDiagnostic('Polygon recovery jog completed',{axis,sign,step,mpos:after.mpos,wpos:after.wpos,probePinKnown:state.probePinKnown,probePinActive:state.probePinActive});
    return after;
}

async function waitForPolygonRecovery(label,expectedPin,{message=null,resumeSupported=true}={}){
    const dialog=$('polygonRecoveryDialog'),reason=$('polygonRecoveryReason'),status=$('polygonRecoveryStatus'),position=$('polygonRecoveryPosition');
    const acknowledgement=$('polygonRecoveryAcknowledged'),continueButton=$('continuePolygonRecovery'),cancelButton=$('cancelPolygonRecovery');
    const exitButton=$('exitPolygonScan');
    const jogStep=$('polygonRecoveryJogStep'),feedHoldButton=$('requestRecoveryFeedHold');
    if(!resumeSupported){
        state.recoveryCanceled=false;state.recoveryDialogOpen=true;
        dialog.querySelector('h2').textContent='Non-recoverable scan error';
        reason.textContent=message??'A non-recoverable error occurred. Check the probe for a stuck state or other machine issue. Once resolved, select Start Probe. The machine will automatically raise to full clearance, return to the saved bed-probe position, and probe the bed again.';
        status.hidden=true;position.hidden=true;feedHoldButton.hidden=true;dialog.querySelector('.recovery-jog').hidden=true;dialog.querySelector('.recovery-ack').hidden=true;continueButton.hidden=true;
        cancelButton.hidden=true;exitButton.hidden=false;exitButton.disabled=false;
        dialog.showModal();
        return new Promise(resolve=>{
            let finished=false;
            const exit=()=>{
                if(finished)return;finished=true;
                exitButton.onclick=null;cancelButton.onclick=null;dialog.oncancel=null;dialog.close();
                state.recoveryDialogOpen=false;state.recoveryCanceled=true;state.stopScan=true;
                void machine.command('feedhold').catch(error=>logHomingDiagnostic('Exit Scan feed hold request failed',{label,message:error.message}));
                logHomingDiagnostic('Operator exited non-recoverable scan dialog',{label,motionState:state.motionState,workPosition:state.workPosition});
                resolve(null);
            };
            exitButton.onclick=exit;
            dialog.oncancel=event=>{event.preventDefault();exit();};
        });
    }
    dialog.querySelector('h2').textContent='Scan paused — check probe and position';
    status.hidden=false;position.hidden=false;feedHoldButton.hidden=false;dialog.querySelector('.recovery-jog').hidden=false;dialog.querySelector('.recovery-ack').hidden=false;continueButton.hidden=false;
    cancelButton.hidden=false;cancelButton.textContent='Cancel scan';exitButton.hidden=false;exitButton.disabled=false;
    acknowledgement.checked=false;continueButton.disabled=true;
    cancelButton.disabled=true;
    state.recoveryCanceled=false;state.recoveryDialogOpen=true;
    state.recoveryHoldInFlight=false;
    feedHoldButton.disabled=false;feedHoldButton.textContent='Request feed hold';
    continueButton.textContent=resumeSupported?'Continue scan':'Acknowledge and stop scan';
    reason.textContent=message??(expectedPin
        ?`The controller reported a probe contact, but its input did not remain stably active after “${label}”. Inspect the probe and path. Continue preserves the reported contact and resumes with a retract, but only after the probe input is clear.`
        :`The controller did not confirm a stable clear probe input after “${label}”. Inspect the probe and machine, use the small XYZ jog controls if needed, and continue only after the probe input is clear.`);
    status.textContent='Waiting for a fresh Idle status and a clear probe input.';status.dataset.state='error';dialog.showModal();
    logHomingDiagnostic('Polygon scan recovery dialog opened',{label,expectedPin,motionState:state.motionState,wpos:state.workPosition,mpos:state.machinePosition,probePinKnown:state.probePinKnown,probePinActive:state.probePinActive,lastStatusLine:state.lastProbeStatusLine});
    return new Promise(resolve=>{
        let finished=false,polling=false,jogging=false,jogged=false,confirmedIdle=false,pollTimer;
        const finish=(snapshot=null)=>{
            if(finished)return;finished=true;clearInterval(pollTimer);continueButton.onclick=null;cancelButton.onclick=null;exitButton.onclick=null;feedHoldButton.onclick=null;dialog.oncancel=null;
            document.querySelectorAll('[data-recovery-axis]').forEach(button=>button.onclick=null);
            if(dialog.open)dialog.close();
            state.recoveryDialogOpen=false;state.recoveryCanceled=!snapshot;
            continueButton.textContent='Continue scan';
            logHomingDiagnostic('Polygon scan recovery dialog finished',{label,resume:Boolean(snapshot),jogged,wpos:snapshot?.wpos,mpos:snapshot?.mpos,probePinKnown:state.probePinKnown,probePinActive:state.probePinActive});
            resolve(snapshot?{...snapshot,recoveryJogged:jogged}:null);
        };
        exitButton.onclick=()=>{
            if(finished)return;
            state.stopScan=true;
            void machine.command('feedhold').catch(error=>logHomingDiagnostic('Exit Scan feed hold request failed',{label,message:error.message}));
            logHomingDiagnostic('Operator exited scan recovery dialog',{label,motionState:state.motionState,workPosition:state.workPosition});
            finish(null);
        };
        const refreshReadiness=async()=>{
            if(finished||polling||jogging)return;polling=true;
            try{
                const snapshot=await refreshScanStatus(2000);
                const clear=state.probePinKnown&&!state.probePinActive;
                const statusAt=Math.max(state.lastProbeStatusAt||0,state.lastControllerStatusAt||0);
                const fresh=Date.now()-statusAt<=1500;
                confirmedIdle=fresh&&snapshot.state==='Idle'&&snapshot.homed;
                const canContinue=confirmedIdle&&clear&&acknowledgement.checked;
                document.querySelectorAll('[data-recovery-axis]').forEach(button=>button.disabled=!confirmedIdle||jogging);
                cancelButton.disabled=!confirmedIdle||polling||jogging;
                exitButton.disabled=false;
                position.textContent=`WPOS  X ${snapshot.wpos?.[0]?.toFixed(3)??'—'}   Y ${snapshot.wpos?.[1]?.toFixed(3)??'—'}   Z ${snapshot.wpos?.[2]?.toFixed(3)??'—'}     ·     Probe: ${!state.probePinKnown?'unknown':state.probePinActive?'active':'clear'}     ·     ${snapshot.state} · status ${fresh?'fresh':`${Math.max(0,Math.round((Date.now()-statusAt)/1000))}s old`}`;
                continueButton.disabled=!canContinue;
                status.textContent=canContinue
                    ?(resumeSupported?'Machine is idle and the probe input is clear. Continuing resumes this scan from the confirmed controller state; the captured probe result is retained.':'Machine is idle and the probe input is clear. Acknowledge to close this scan safely after operator review.')
                    :!fresh?'Waiting for a fresh controller status. Jog, Cancel, and Continue remain locked until the controller confirms Idle.'
                    :snapshot.state!=='Idle'?`Controller reports ${snapshot.state}. Jog, Cancel, and Continue remain locked until motion is stopped and a fresh Idle status arrives. Request feed hold again or use gSender's feed-hold control.`
                    :`Continue requires a fresh Idle status, a known clear probe input, and your inspection confirmation. Use small jog steps to clear the probe if needed.`;
                status.dataset.state=canContinue?'':'error';
            }catch(error){continueButton.disabled=true;status.textContent=`Waiting for a fresh, homed Idle status and a clear probe input. ${error.message}`;status.dataset.state='error';}
            finally{polling=false;}
        };
        document.querySelectorAll('[data-recovery-axis]').forEach(button=>{
            button.onclick=async()=>{
                if(finished||jogging||state.motionState!=='Idle')return;
                const axis=button.dataset.recoveryAxis,sign=Number(button.dataset.recoverySign),step=Number(jogStep.value);
                jogging=true;document.querySelectorAll('[data-recovery-axis]').forEach(item=>item.disabled=true);continueButton.disabled=true;acknowledgement.checked=false;
                try{status.textContent=`Jogging ${axis} ${sign>0?'+':'−'}${step} mm…`;status.dataset.state='';await jogDuringPolygonRecovery(axis,sign,step);jogged=true;}
                catch(error){status.textContent=`Recovery jog failed: ${error.message}`;status.dataset.state='error';}
                finally{jogging=false;document.querySelectorAll('[data-recovery-axis]').forEach(item=>item.disabled=false);void refreshReadiness();}
            };
        });
        feedHoldButton.onclick=async()=>{
            if(finished||state.recoveryHoldInFlight)return;
            state.recoveryHoldInFlight=true;feedHoldButton.disabled=true;feedHoldButton.textContent='Requesting…';
            logHomingDiagnostic('Operator requested recovery feed hold',{label,motionState:state.motionState,lastStatusLine:state.lastProbeStatusLine});
            try{
                const result=await machine.command('feedhold');
                logHomingDiagnostic('Operator recovery feed hold dispatched',{label,result,motionState:state.motionState});
                status.textContent='Feed-hold request sent. Waiting for a fresh Idle status; jogs and Continue remain locked until then.';status.dataset.state='error';
            }catch(error){
                logHomingDiagnostic('Operator recovery feed hold failed',{label,message:error.message});
                status.textContent=`Feed-hold request failed: ${error.message}. Use gSender's feed-hold control or the machine stop, then wait for fresh Idle status.`;status.dataset.state='error';
            }finally{
                state.recoveryHoldInFlight=false;
                if(!finished){feedHoldButton.disabled=false;feedHoldButton.textContent='Request feed hold';void refreshReadiness();}
            }
        };
        acknowledgement.onchange=()=>void refreshReadiness();
        continueButton.onclick=async()=>{
            if(finished||continueButton.disabled||polling||jogging)return;
            continueButton.disabled=true;polling=true;
            try{
                const snapshot=await refreshScanStatus(2500);
                if(snapshot.state!=='Idle'||!snapshot.homed||!state.probePinKnown||state.probePinActive||!acknowledgement.checked)throw Error('The machine must remain homed and idle with a confirmed clear probe input.');
                if(resumeSupported)await requirePolygonRecoveryFrame(snapshot);
                finish(snapshot);
            }catch(error){status.textContent=`Cannot continue yet: ${error.message}`;status.dataset.state='error';polling=false;void refreshReadiness();}
        };
        cancelButton.onclick=()=>{if(confirmedIdle)finish();};
        dialog.oncancel=event=>{event.preventDefault();if(confirmedIdle)finish();else{status.textContent='Cannot close the recovery dialog while the controller is moving or status is stale. Request feed hold and wait for a fresh Idle report.';status.dataset.state='error';}};
        pollTimer=setInterval(refreshReadiness,800);void refreshReadiness();
    });
}

async function waitForPolygonProbeIdle(label,timeoutMs=30000) {
    const deadline=Date.now()+timeoutMs;let previous=null;
    while(Date.now()<deadline){
        if(state.stopScan)throw Error('Polygon scan stopped by user.');
        const snapshot=await refreshScanStatus();
        const rawState=state.lastProbeStatusLine?.match(/^<([^|>]+)/)?.[1];
        const rawPin=state.lastProbeStatusLine?.match(/\|Pn:([^|>]+)/)?.[1];
        const rawPinActive=rawPin===undefined?null:/P/.test(rawPin);
        if(snapshot.state==='Alarm'||rawState==='Alarm')throw Error(`${label}: controller entered Alarm.`);
        const settled=snapshot.state==='Idle'&&(!rawState||rawState==='Idle')&&state.probePinKnown
            &&(rawPinActive===null||rawPinActive===state.probePinActive)
            &&snapshot.mpos?.every(Number.isFinite)&&snapshot.wpos?.every(Number.isFinite);
        if(settled){
            if(previous&&snapshot.mpos.every((value,i)=>Math.abs(value-previous[i])<=.03))return snapshot;
            previous=snapshot.mpos.slice();
        }else{previous=null;await new Promise(resolve=>setTimeout(resolve,100));}
    }
    throw Error(`${label}: controller did not settle after the probe command.`);
}

async function scanPolygonPrototype(cfg, limits, bedWposZ, options = {}) {
    const direction=options.direction ?? Number($('polygonDirection').value),clearance=options.clearance ?? Number($('polygonClearance').value),releaseLimit=Number($('polygonReleaseLimit').value);
    if (!(clearance>0) || !(releaseLimit>0)) throw new Error('Enter positive polygon clearance and maximum release distance.');
    const follower=createPolygonContour({step:options.step ?? cfg.spacing,clearance,direction,restore:options.cursor??null});
    const captured=options.contacts ?? state.perimeterPoints;
    const checkpointStage=options.checkpointStage??'outer-perimeter';
    const checkpointPhase=checkpointStage==='outer-perimeter'?'perimeter':'surface';
    const ultraHistory=[],ultraFirst=[];
    const zero=state.wposZeroMachine.slice();
    if(options.pendingObservation){
        const observation=options.pendingObservation;
        const observed=follower.observe({contact:observation.contact?.slice(0,2)??null,stopped:observation.stoppedWpos.slice(0,2)});
        if(observed.done)throw new Error(`Polygon stopped while restoring its saved contact: ${observed.reason}.`);
        state.scanCheckpoint={...state.scanCheckpoint,phase:checkpointPhase,cursor:follower.snapshot(),pendingObservation:null,traceContacts:captured===state.perimeterPoints?null:captured.slice()};
        persistScanProgressSoon();
    }
    const validate = target => checkScanTravel(target,limits);
    const defaultProbeFeed=options.feedOverride??(cfg.probeMode==='fast'?cfg.fastFeed:cfg.slowFeed);
    const command=async(code,from,to,expectedPin,label,feed=defaultProbeFeed,opts={})=>{
        if(state.stopScan)throw new Error('Polygon scan stopped by user.');
        const before=opts.immediateAfterProbe?currentSnapshot():await refreshScanStatus();
        if(opts.immediateAfterProbe){if(before.state==='Alarm'||!state.probePinKnown)throw new Error(`${label}: controller state or probe input is unavailable after contact.`);}
        else if(before.state!=='Idle'||!state.probePinKnown||state.probePinActive!==expectedPin)throw new Error(`${label}: expected an idle controller and ${expectedPin?'triggered':'clear'} probe.`);
        if(!opts.immediateAfterProbe&&(!before.mpos?.every(Number.isFinite)||!before.wpos?.every(Number.isFinite)||before.mpos.some((v,i)=>Math.abs(v-before.wpos[i]-zero[i])>.08)))throw new Error(`${label}: work offset changed or is unavailable.`);
        validate(to);
        const dist=Math.hypot(to[0]-from[0],to[1]-from[1]);
        if(dist<0.001)throw new Error(`${label}: zero-length probe.`);
        const text=`G21 G90 G54 ${code} X${to[0].toFixed(3)} Y${to[1].toFixed(3)} F${feed}`;
        const contactSequenceBefore=state.probeContactSequence;
        const response=await queryProbeController(text,{timeout:Math.max(30000,Math.ceil(dist/feed*60000+15000)),maxLines:80});
        logHomingDiagnostic('Polygon probe block',{label,command:text,lines:response.lines});
        if(!response.complete||!response.ok||response.error)throw new Error(`${label}: probe command failed.`);
        let report=parseOptionalProbe(response);
        if(!report){
            const parserDeadline=Date.now()+120;
            while(state.probeContactSequence<=contactSequenceBefore&&Date.now()<parserDeadline)await new Promise(resolve=>setTimeout(resolve,10));
            const parsedContact=state.lastProbeContact;
            if(parsedContact&&parsedContact.sequence>contactSequenceBefore){
                report=parseOptionalProbe({lines:[parsedContact.line]});
                if(report)logHomingDiagnostic('Polygon probe report captured from the live controller parser',{label,report:report.line,sequence:parsedContact.sequence});
            }
        }
        if(!report){
            logHomingDiagnostic('Polygon probe report missing from command response; waiting for controller idle',{label,command:text,lines:response.lines});
            const settled=await waitForPolygonProbeIdle(label,Math.max(30000,Math.ceil(dist/feed*60000+15000)));
            let parameterReport=null;
            for(let attempt=1;attempt<=3&&!parameterReport;attempt++){
                const parameters=await queryController('$#',{until:'ok-or-error',timeout:10000,maxLines:100});
                logHomingDiagnostic('Polygon probe parameters after missing report',{label,attempt,lines:parameters.lines});
                parameterReport=parseOptionalProbe(parameters);
                if(!parameterReport&&attempt<3)await new Promise(resolve=>setTimeout(resolve,150));
            }
            if(!parameterReport)throw Error(`${label}: controller settled at WPOS ${settled.wpos.map(v=>v.toFixed(3)).join(',')} but supplied no probe report.`);
            const segmentStart=from.map((v,i)=>v+zero[i]),segmentEnd=to.map((v,i)=>v+zero[i]);
            const line=segmentEnd.map((v,i)=>v-segmentStart[i]),lineLength2=line.reduce((sum,v)=>sum+v*v,0);
            const t=lineLength2?Math.max(0,Math.min(1,parameterReport.mpos.reduce((sum,v,i)=>sum+(v-segmentStart[i])*line[i],0)/lineLength2)):0;
            const errorDistance=Math.hypot(...parameterReport.mpos.map((v,i)=>v-(segmentStart[i]+line[i]*t)));
            if(errorDistance>.15)throw Error(`${label}: recovered probe report is ${errorDistance.toFixed(3)} mm off the commanded path; refusing to use a stale result.`);
            report=parameterReport;
            logHomingDiagnostic('Polygon probe report recovered from controller parameters',{label,report:report.line,errorDistance,settledWpos:settled.wpos});
        }
        if(code==='G38.3'&&report.triggered){
            // Do not queue a G38.5 release based only on the PRB response. Wait until
            // the controller is settled and still reports a triggered input, then
            // retract with a normal rapid move. Some controllers reject the away-probe
            // cycle with ALARM:4 even after a valid toward-probe contact.
            const stopped=await waitForPolygonProbeStop(label,true);
            if(stopped.mpos.some((v,i)=>Math.abs(v-stopped.wpos[i]-zero[i])>.08))throw new Error(`${label}: work offset changed.`);
            return {report,stopped};
        }
        const expectedAfter=code==='G38.5'?!report.triggered:report.triggered;
        // A G38.3 miss can be followed by a late active pin at settled idle.
        // Wait for idle first so we can safely retract instead of timing out.
        const stopped=code==='G38.3'&&!report.triggered
            ?await waitForPolygonProbeIdle(label,Math.max(30000,Math.ceil(dist/feed*60000+15000)))
            :await waitForPolygonProbeStop(label,expectedAfter);
        if(stopped.mpos.some((v,i)=>Math.abs(v-stopped.wpos[i]-zero[i])>.08))throw new Error(`${label}: work offset changed.`);
        if(!report.triggered&&stopped.wpos.slice(0,2).some((v,i)=>Math.abs(v-to[i])>.12))throw new Error(`${label}: stopped short without a transition.`);
        if(code==='G38.3'&&!report.triggered&&state.probePinActive){
            if(opts.latePinRetry){
                const recovered=await waitForPolygonRecovery(`${label}: repeated miss/input mismatch`,false);
                if(!recovered)throw Error(`${label}: scan canceled from the probe recovery dialog.`);
                return {report,stopped:recovered};
            }
            logHomingDiagnostic('Probe input activated after a reported polygon miss; retracting and retrying slowly',{label,from,to,report:report.line,wpos:stopped.wpos,feed,retryFeed:cfg.slowFeed});
            await scanMove(from.slice(0,3),limits,`${label}: retract to known-clear start after late probe input`,true);
            const released=await waitForPolygonProbeStop(`${label}: confirm probe release before retry`,false);
            if(released.mpos.some((v,i)=>Math.abs(v-released.wpos[i]-zero[i])>.08))throw Error(`${label}: work offset changed during safe retract.`);
            return command(code,from,to,expectedPin,`${label} slow retry`,cfg.slowFeed,{...opts,latePinRetry:true});
        }
        return {report,stopped};
    };
    while(true){
        if(state.stopScan)throw new Error('Polygon scan stopped by user.');
        const start=await refreshScanStatus();const req=follower.next(start.wpos.slice(0,2),options.initialTarget ?? [0,0]);
        if(req.done){
            if(!req.closed)throw new Error(`Polygon stopped: ${req.reason}.`);
            if(cfg.probeMode==='ultra')for(const first of ultraFirst)await maybeRefineUltraCorner(ultraHistory,first,captured,cfg,limits,bedWposZ,{raw:true});
            return captured;
        }
        const target=[...req.target,start.wpos[2]],dx=target[0]-start.wpos[0],dy=target[1]-start.wpos[1],len=Math.hypot(dx,dy),reverse=[-dx/len,-dy/len];
        const hit=await command('G38.3',start.wpos,target,false,'Polygon search');let contact=null,after=hit.stopped;
        if(hit.report.triggered){
            contact=hit.report.mpos.map((v,i)=>v-zero[i]);
            const distance=cfg.diameter,backoffTarget=[contact[0]+reverse[0]*distance,contact[1]+reverse[1]*distance,contact[2]];
            logHomingDiagnostic('Polygon contact backoff',{from:contact,to:backoffTarget,distance,reason:'settled contact; rapid retract avoids G38.5 initial-state alarm'});
            if(hit.stopped.recoveryJogged){
                const transitZ=Math.max(hit.stopped.wpos[2],fullClearanceHeight(cfg));
                await scanMove([hit.stopped.wpos[0],hit.stopped.wpos[1],transitZ],limits,'Recovery: raise to clearance before rejoining the contact backoff',true);
                await scanMove([backoffTarget[0],backoffTarget[1],transitZ],limits,'Recovery: return above the planned contact backoff',true);
                after=await scanMove(backoffTarget,limits,'Recovery: lower to the planned contact backoff');
            }else after=await scanMove(backoffTarget,limits,'Polygon contact backoff',true);
            after=await extendPolygonRelease(contact,reverse,distance,cfg,limits,'Polygon release');
            if(after.mpos.some((v,i)=>Math.abs(v-after.wpos[i]-zero[i])>.08))throw new Error('Polygon release: work offset changed.');
            let rawMpos=hit.report.mpos.slice();
            const point={index:captured.length+1,angle:Math.atan2(contact[1],contact[0])*180/Math.PI,x:contact[0],y:contact[1],z:bedWposZ,contactZ:contact[2],rawMpos,approach:[-reverse[0],-reverse[1]],kind:'raw probe center'};
            captured.push(point);renderPerimeterResult();
            state.scanCheckpoint={...state.scanCheckpoint,phase:checkpointPhase,stage:checkpointStage,cursor:follower.snapshot(),lastLocationWpos:after.wpos.slice(0,3),lastProbe:{x:contact[0],y:contact[1],z:contact[2]},pendingObservation:{contact:contact.slice(),stoppedWpos:after.wpos.slice(0,3)},traceContacts:captured===state.perimeterPoints?null:captured.slice()};
            persistScanProgressSoon();
            if(cfg.probeMode==='ultra'){
                const record={center:contact.slice(),outward:reverse,clear:after.wpos.slice(),point};
                if(ultraFirst.length<2&&(!ultraFirst.length||Math.hypot(record.center[0]-ultraFirst.at(-1).center[0],record.center[1]-ultraFirst.at(-1).center[1])>=cfg.diameter*.1))ultraFirst.push(record);
                await maybeRefineUltraCorner(ultraHistory,record,captured,cfg,limits,bedWposZ,{raw:true});
                after=await refreshScanStatus();
            }
        } else if(state.probePinActive)throw new Error('Probe active after a polygon miss.');
        if(!contact)state.scanCheckpoint={...state.scanCheckpoint,phase:checkpointPhase,stage:checkpointStage,cursor:follower.snapshot(),lastLocationWpos:after.wpos.slice(0,3),lastProbe:state.scanCheckpoint?.lastProbe??null,pendingObservation:{contact:null,stoppedWpos:after.wpos.slice(0,3)},traceContacts:captured===state.perimeterPoints?null:captured.slice()};
        const observed=follower.observe({contact:contact?.slice(0,2)??null,stopped:after.wpos.slice(0,2)});
        if(observed.done)throw new Error(`Polygon stopped: ${observed.reason}.`);
        state.scanCheckpoint={...state.scanCheckpoint,phase:checkpointPhase,stage:checkpointStage,cursor:follower.snapshot(),lastLocationWpos:after.wpos.slice(0,3),lastProbe:contact?{x:contact[0],y:contact[1],z:contact[2]}:(state.scanCheckpoint?.lastProbe??null),pendingObservation:null,traceContacts:captured===state.perimeterPoints?null:captured.slice()};
        persistScanProgressSoon();
        $('scanStatus').textContent=`${options.contacts?'Recess':'Polygon'} prototype: ${captured.length} raw contacts; ${req.phase} search.`;
    }
}

async function scanRectanglePerimeter(cfg, limits, safeZ, perimeterWposZ, bedWposZ, bedWposY, plan) {
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const ultraHistory=[];
    let lastClearance = null;
    let incomingSide = null;
    let lastFaceContactWpos = null;
    let lastMissTarget = null;
    const sides = [
        { side: 'front', inward: [0, 1], tangent: [1, 0] },
        { side: 'right', inward: [-1, 0], tangent: [0, 1] },
        { side: 'rear', inward: [0, -1], tangent: [-1, 0] },
        { side: 'left', inward: [1, 0], tangent: [0, -1] }
    ];
    let sideNumber = 0;
    let sample = { ...plan[0] };
    let hitsOnSide = 0;
    for (let index = 0; index < MAX_PERIMETER_SAMPLES; index += 1) {
        if (state.stopScan) throw new Error('Scan stopped by user before the next perimeter sample.');
        if (sideNumber >= 4 && sample.x >= -0.05) return;
        const inward = sample.inward;
        const outward = [-inward[0], -inward[1]];
        const normalAxis = Math.abs(inward[0]) > 0.5 ? 0 : 1;
        const tangentAxis = 1 - normalAxis;
        const approachDistance = cfg.radius + releaseDistance;
        let approach = [
            sample.x + outward[0] * approachDistance,
            sample.y + outward[1] * approachDistance,
            perimeterWposZ
        ];
        const label = `Rectangle sample ${index + 1} (${sample.side})`;
        let cornerFaceContact = null;

        $('scanStatus').textContent = `Rectangle perimeter ${index + 1}: probing the ${sample.side} edge until a complete miss.`;
        if (index === 0 && sample.side === 'front' && Math.abs(sample.x) < 0.001) {
            const atBed = await currentSnapshot();
            if (atBed.state !== 'Idle' || !atBed.wpos?.every(Number.isFinite)
                || Math.abs(atBed.wpos[0]) > 0.1 || Math.abs(atBed.wpos[1] - bedWposY) > 0.1
                || Math.abs(atBed.wpos[2] - perimeterWposZ) > 0.1
                || !state.probePinKnown || state.probePinActive) {
                throw new Error('The probe must be idle and clear at the bed-search position before the first rectangle edge probe.');
            }
            logHomingDiagnostic('First rectangle perimeter probe starts at the bed-search point', { label, positionWpos: atBed.wpos });
        } else if (!lastClearance) {
            const route = await moveToPerimeterApproachWithProbe(approach, [sample.x, sample.y], cfg, limits, `${label}: position outside edge`);
            if (route.maxContactRadius > 0) logHomingDiagnostic('Rectangle initial approach encountered contacts', { label, maxContactRadius: route.maxContactRadius });
        } else if (incomingSide) {
            // The full miss established a clear line through the current XY.
            // Position along that same line instead of adding an outward
            // offset that may unnecessarily leave the configured search box.
            const approachStart = lastClearance.slice();
            const nextNormalLimit = (normalAxis === 0 ? cfg.rectangleWidth : cfg.rectangleHeight) / 2;
            const normalRoom = Math.max(0, nextNormalLimit - outward[normalAxis] * approachStart[normalAxis]);
            approachStart[normalAxis] += outward[normalAxis] * Math.min(cfg.radius, normalRoom);
            approach = cornerApproachFromContact(approachStart, lastFaceContactWpos, sample.side, cfg.radius);
            const transferAxis = tangentAxis;
            const nextTangent = sides[sideNumber % sides.length].tangent;
            approach[transferAxis] += nextTangent[transferAxis] * 0.05;
            if (!lastMissTarget || approach[transferAxis] < Math.min(lastClearance[transferAxis], lastMissTarget[transferAxis]) - 0.05
                || approach[transferAxis] > Math.max(lastClearance[transferAxis], lastMissTarget[transferAxis]) + 0.05) {
                throw new Error(`${label}: the next edge approach is outside the confirmed clear path. Scan stopped for review.`);
            }
            if (Math.abs(approach[0]) > cfg.rectangleWidth / 2 || Math.abs(approach[1]) > cfg.rectangleHeight / 2) {
                throw new Error(`${label}: the next edge approach would leave the search box. Increase the search box or check part placement.`);
            }
            logHomingDiagnostic('Rectangle first face approach based on last contact', {
                label, incomingSide, nextSide: sample.side, lastFaceContactWpos,
                halfDiameter: cfg.radius, approach
            });
            const clearOutside = await probeTravelLine(lastClearance, approachStart, limits, `${label}: guarded outward corner clearance`, cfg.fastFeed);
            if (clearOutside.contact) throw new Error(`${label}: unexpected contact while moving outside the corner. Scan stopped for review.`);
            const arrived = await probeTravelLine(clearOutside.snapshot.wpos, approach, limits, `${label}: guarded move toward the new edge`, cfg.fastFeed);
            if (arrived.contact) throw new Error(`${label}: unexpected probe contact while approaching the next edge. Scan stopped for review.`);
            if (arrived.snapshot.state !== 'Idle' || arrived.snapshot.wpos?.some((value, axis) => Math.abs(value - approach[axis]) > 0.12)) throw new Error(`${label}: controller did not reach the face-normal probe start after following the corner.`);
            incomingSide = null;
        } else {
            const tangentTarget = lastClearance.slice(0, 3);
            tangentTarget[tangentAxis] = sample[tangentAxis === 0 ? 'x' : 'y'];
            const arrived = await moveRectangleAlongEdge(lastClearance, tangentTarget, sample.side, cfg, limits, label);
            lastClearance = arrived.wpos?.slice(0, 3) ?? tangentTarget;
        }

        // XY routing preserves the current Z. After recovering from a missed
        // rounded corner, lower only once positioned outside the new edge.
        const atApproach = await currentSnapshot();
        if (Math.abs(atApproach.wpos[2] - perimeterWposZ) > 0.1) {
            await scanMove([atApproach.wpos[0], atApproach.wpos[1], perimeterWposZ], limits, `Lowering at the outside of the ${sample.side} edge`);
        }

        const probeStart = (await currentSnapshot()).wpos;
        const fastTarget = probeStart.slice(0, 2);
        // Probe through the full configured search box: an offset origin or
        // an angled face can place a genuine contact beyond the centerline.
        const normalLimit = (normalAxis === 0 ? cfg.rectangleWidth : cfg.rectangleHeight) / 2;
        const farLimit = inward[normalAxis] * normalLimit;
        // While acquiring a new face, avoid accepting the opposite side of
        // the part as the new edge after a miss at an angled corner. Advance
        // along the new edge and retry a short guarded search instead.
        const acquireTarget = probeStart[normalAxis] + inward[normalAxis] * (cfg.spacing + 2 * cfg.diameter);
        fastTarget[normalAxis] = hitsOnSide === 0 && sideNumber > 0
            ? (inward[normalAxis] > 0 ? Math.min(acquireTarget, farLimit) : Math.max(acquireTarget, farLimit))
            : farLimit;
        const fastHit = cornerFaceContact
            ? { contact: cornerFaceContact, snapshot: atApproach, direction: inward }
            : await probeTravelLine(probeStart, fastTarget, limits, `${label}: fast face-normal touch`, cfg.fastFeed);
        if (!fastHit.contact) {
            if (!lastFaceContactWpos || (sideNumber === 0 && !hitsOnSide)) throw new Error(`${label}: complete miss before the first edge was acquired. Check the probe, part placement and search area.`);
            const stopped = await currentSnapshot();
            const retreat = await probeTravelLine(stopped.wpos, probeStart, limits, `${label}: return along missed probe path`, cfg.fastFeed);
            if (retreat.contact) throw new Error(`${label}: probe contacted while returning from a complete miss. Scan stopped for review.`);
            lastClearance = retreat.snapshot.wpos.slice(0, 3);
            if (!hitsOnSide) {
                const tangent = sides[sideNumber % sides.length].tangent;
                const nextXY = [probeStart[0] + tangent[0] * cfg.spacing, probeStart[1] + tangent[1] * cfg.spacing];
                const axis = Math.abs(tangent[0]) > 0.5 ? 0 : 1;
                const bound = (axis === 0 ? cfg.rectangleWidth : cfg.rectangleHeight) / 2;
                nextXY[axis] = Math.max(-bound, Math.min(bound, nextXY[axis]));
                if (Math.abs(nextXY[axis] - probeStart[axis]) > 0.001) {
                    sample = { ...sides[sideNumber % sides.length], x: nextXY[0], y: nextXY[1], corner: false };
                    logHomingDiagnostic('Rectangle next edge acquisition missed; advancing along new edge', { side: sample.side, probeStart, probeTarget: fastTarget, nextXY });
                    continue;
                }
                logHomingDiagnostic('Rectangle edge acquisition reached search-box limit with a complete miss', { side: sample.side, probeStart, probeTarget: fastTarget });
            }
            if (sideNumber >= 4) throw new Error(`${label}: the perimeter ended before returning to the starting point.`);
            incomingSide = sample.side;
            lastMissTarget = fastTarget.slice();
            sideNumber += 1;
            const next = sides[sideNumber % sides.length];
            sample = { ...next, x: probeStart[0], y: probeStart[1], corner: true };
            hitsOnSide = 0;
            logHomingDiagnostic('Rectangle edge ended with a complete miss', {
                side: incomingSide, nextSide: next.side, probeStart, probeTarget: fastTarget,
                lastFaceContactWpos, missedAt: stopped.wpos
            });
            continue;
        }
        hitsOnSide += 1;
        const zero = state.wposZeroMachine;
        const fastWpos = [fastHit.contact[0] - zero[0], fastHit.contact[1] - zero[1], fastHit.contact[2] - zero[2]];
        let contactWpos = fastWpos;
        let clearedAt = [fastWpos[0] + outward[0] * releaseDistance, fastWpos[1] + outward[1] * releaseDistance, fastWpos[2]];
        await waitForProbeClearAfterRetract(limits, clearedAt, `Rectangle fast-touch release ${index + 1}`, { preserveZ: true });

        if (state.stopScan) {
            await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Stopping safely after rectangle probe release');
            throw new Error('Scan stopped by user after the current probe move.');
        }

        if (cfg.probeMode === 'precise' || cfg.probeMode === 'ultra') {
            const preciseTarget = clearedAt.slice(0, 2);
            preciseTarget[normalAxis] = fastWpos[normalAxis] + inward[normalAxis] * 0.5;
            const preciseHit = await probeTravelLine(clearedAt, preciseTarget, limits, `${label}: slow face-normal confirm`, cfg.slowFeed);
            if (!preciseHit.contact) {
                await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Rectangle slow touch missed: raise to full clearance');
                throw new Error(`The slow confirm touch missed rectangle sample ${index + 1}. Scan stopped.`);
            }
            contactWpos = [preciseHit.contact[0] - zero[0], preciseHit.contact[1] - zero[1], preciseHit.contact[2] - zero[2]];
            clearedAt = [contactWpos[0] + outward[0] * releaseDistance, contactWpos[1] + outward[1] * releaseDistance, contactWpos[2]];
            await waitForProbeClearAfterRetract(limits, clearedAt, `Rectangle precise-touch release ${index + 1}`, { preserveZ: true });
            if (Math.abs(preciseHit.contact[normalAxis] - fastHit.contact[normalAxis]) > 0.75) {
                await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Touch mismatch: raise to full-clearance height');
                throw new Error(`Fast and precise contacts differed by ${(preciseHit.contact[normalAxis] - fastHit.contact[normalAxis]).toFixed(2)} mm at rectangle sample ${index + 1}; scan stopped for review.`);
            }
        }

        const surfacePoint = [contactWpos[0] + inward[0] * cfg.radius, contactWpos[1] + inward[1] * cfg.radius];
        const angleDegrees = Math.atan2(surfacePoint[1], surfacePoint[0]) * 180 / Math.PI;
        const point={ index: state.perimeterPoints.length + 1, side: sample.side, angle: angleDegrees, x: surfacePoint[0], y: surfacePoint[1], z: bedWposZ };
        state.perimeterPoints.push(point);
        renderPerimeterResult();
        if(cfg.probeMode==='ultra')await maybeRefineUltraCorner(ultraHistory,{center:contactWpos.slice(),outward,clear:clearedAt.slice(),point},state.perimeterPoints,cfg,limits,bedWposZ);
        logHomingDiagnostic('Rectangle perimeter point captured', {
            point: index + 1, side: sample.side,
            firstPointOffsetFromCorner: sample.corner ? sample.distanceFromCorner : undefined,
            cornerOffsetDistance: cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR,
            expectedWpos: [sample.x, sample.y], inwardAxis: inward, outwardRetractAxis: outward,
            retractDistance: releaseDistance, nextEdgeStep: cfg.spacing,
            fastContactWpos: fastWpos, measuredContactWpos: contactWpos,
            correctedSurfaceWpos: surfacePoint, probeMode: cfg.probeMode
        });
        lastClearance = (await currentSnapshot()).wpos.slice(0, 3);
        lastFaceContactWpos = contactWpos.slice();
        const tangent = sides[sideNumber % sides.length].tangent;
        const nextXY = [contactWpos[0] + tangent[0] * cfg.spacing, contactWpos[1] + tangent[1] * cfg.spacing];
        const axis = Math.abs(tangent[0]) > 0.5 ? 0 : 1;
        const bound = (axis === 0 ? cfg.rectangleWidth : cfg.rectangleHeight) / 2;
        nextXY[axis] = Math.max(-bound, Math.min(bound, nextXY[axis]));
        if (Math.abs(nextXY[axis] - contactWpos[axis]) < 0.001)
            throw new Error(`${label}: contact at the search-box limit did not establish a miss. Increase the search box or check part placement.`);
        sample = { ...sides[sideNumber % sides.length], x: nextXY[0], y: nextXY[1], corner: false };
        if (state.stopScan) {
            await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Stopping safely after rectangle probe release');
            throw new Error('Scan stopped by user after the current probe move.');
        }
    }
    throw new Error(`Perimeter exceeded ${MAX_PERIMETER_SAMPLES} samples without returning to the start. Scan stopped for review.`);
}

async function startPerimeterScan() {
    const readiness = scanReadiness();
    logHomingDiagnostic('Start scan button clicked', { ready: readiness.length === 0, blockedBy: readiness, connected: state.connected, homed: state.controllerHomed, motionState: state.motionState, busy: state.busy, workPosition: state.workPosition, latest: state.latest, probeSignalTested: state.probeSignalTested, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });
    if (readiness.length) {
        $('scanStatus').textContent = `Scan not started: ${readiness.join(' ')}`;
        return;
    }
    const dialog = $('scanConfirmDialog');
    const scanMode=document.querySelector('input[name="scanMode"]:checked')?.value??'both';
    dialog.querySelector('p').textContent = scanMode==='perimeter'
        ? 'The scan will trace the outside perimeter, then take one surface-height touch to set the flat top of the perimeter model.'
        : scanMode==='surface'
        ? 'The scan will trace the perimeter to define the boundary, then map the inside surface. The output will omit the vertical outside wall.'
        : 'The scan will trace the perimeter, then map the inside surface. The output will include the perimeter wall from the bed to the measured surface.';
    dialog.showModal();
    const accepted = await new Promise((resolve) => {
        const finish = (value) => { dialog.close(); $('confirmScan').onclick = null; $('cancelScan').onclick = null; dialog.oncancel = null; resolve(value); };
        $('confirmScan').onclick = () => finish(true);
        $('cancelScan').onclick = () => finish(false);
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    });
    if (!accepted) { logHomingDiagnostic('Perimeter scan confirmation canceled'); return; }
    const initial = await currentSnapshot();
    if (initial.state !== 'Idle' || !initial.homed) throw new Error('Home the machine and wait for Idle before starting a perimeter scan.');
    if (!initial.wpos?.every(Number.isFinite)) throw new Error('Waiting for current WPOS coordinates before scanning.');
    if (!state.probeSignalTested || !state.probePinKnown || state.probePinActive) throw new Error('The probe signal must be tested and reported clear before scanning.');
    if (!state.wposZeroMachine || !state.originSafeRetract) throw new Error('Probe WPOS Origin and confirm the safe retract before scanning.');
    await requireG54Active();
    const limits = await readProbeLimits();
    const cfg = state.latest;
    const circleScan = cfg.partShape === 'circle';
    const polygonScan = cfg.partShape === 'polygon';
    const rectangularScan = ['square', 'rectangle', 'triangle'].includes(cfg.partShape);
    if (polygonScan && !(await machine.getContext())?.polygonSimulator) throw new Error('Polygon prototype is available only in the dedicated simulator.');
    if (!circleScan && !rectangularScan && !polygonScan) throw new Error('This outline is not available for automated scanning.');
    const radius = cfg.partRadius;
    const rectanglePlan = rectangularScan ? startRectanglePlanAtFrontCenter(makeRectanglePerimeterPlan(cfg.boundsX, cfg.boundsY, cfg.spacing, cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR)) : null;
    const sampleCount = circleScan ? Math.max(16, Math.ceil((2 * Math.PI * radius) / cfg.spacing)) : rectangularScan ? rectanglePlan.length : 0;
    const perimeterSampleLimit = circleScan ? 360 : MAX_PERIMETER_SAMPLES;
    if (sampleCount > perimeterSampleLimit) throw new Error(`This scan would use ${sampleCount} perimeter points, above the ${perimeterSampleLimit}-point limit. Increase sample spacing.`);
    const center = [0, 0];
    const nominalContactRadius = circleScan ? radius + cfg.radius : NaN;
    const firstSearchEndRadius = circleScan ? Math.max(0.1, radius - 5) : NaN;
    const laterSearchEndRadius = circleScan ? Math.max(0.1, nominalContactRadius - radius) : NaN;
    const safeZ = fullClearanceHeight(cfg);
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const estimatedInnerRadius = circleScan ? radius : Math.min(cfg.boundsX, cfg.boundsY) / 2;
    const estimatedInteriorRings = Math.max(0, Math.floor((estimatedInnerRadius - releaseDistance) / cfg.spacing) + 1);
    const estimatedSurfacePoints = estimatedInteriorRings * sampleCount + 1;
    if (estimatedSurfacePoints > MAX_SURFACE_SAMPLES) throw new Error(`The requested interior scan would use about ${estimatedSurfacePoints.toLocaleString()} points, above the ${MAX_SURFACE_SAMPLES.toLocaleString()}-point safety limit. Increase Perimeter sample spacing.`);
    if (!state.bedOriginWpos || Math.abs(initial.wpos[0] - state.bedOriginWpos[0]) > 0.1 || Math.abs(initial.wpos[1] - state.bedOriginWpos[1]) > 0.1 || initial.wpos[2] < safeZ - 0.1) {
        throw new Error(`Return to the probed front-bed XY and raise to at least WPOS Z${safeZ.toFixed(2)} mm before starting the scan.`);
    }
    checkScanTravel([0, 0, safeZ], limits);
    checkScanTravel([0, 0, Math.max(initial.wpos[2], safeZ)], limits);
    const firstAngle = -Math.PI / 2;
    const frontBedY = state.bedOriginWpos[1];
    checkScanTravel([0, frontBedY, safeZ], limits);
    if (circleScan) {
        const maxReleaseRadius = nominalContactRadius + releaseDistance;
        for (let index = 0; index < sampleCount; index += 1) {
            const angle = firstAngle + (2 * Math.PI * index) / sampleCount;
            checkScanTravel([center[0] + Math.cos(angle) * maxReleaseRadius, center[1] + Math.sin(angle) * maxReleaseRadius, safeZ], limits);
            for (const possibleBedZ of [-cfg.maxThickness, -(cfg.minThickness * 0.5)]) {
                for (const endRadius of [firstSearchEndRadius, laterSearchEndRadius]) {
                    checkScanTravel([center[0] + Math.cos(angle) * endRadius, center[1] + Math.sin(angle) * endRadius, possibleBedZ + cfg.selectedHeight], limits);
                }
            }
        }
    } else if (rectangularScan) {
        for (const sample of rectanglePlan) {
            const boundaryRadius = Math.hypot(sample.x, sample.y);
            if (boundaryRadius <= 0.05) throw new Error('Rectangle scan plan contains a perimeter point at its center.');
            const outwardX = sample.x / boundaryRadius;
            const outwardY = sample.y / boundaryRadius;
            const approachRadius = boundaryRadius + cfg.radius + releaseDistance;
            const approach = [outwardX * approachRadius, outwardY * approachRadius];
            const radialEndpoint = [0, 0];
            checkScanTravel([...approach, safeZ], limits);
            checkScanTravel([...radialEndpoint, safeZ], limits);
            for (const possibleBedZ of [-cfg.maxThickness, -(cfg.minThickness * 0.5)]) {
                checkScanTravel([...radialEndpoint, possibleBedZ + cfg.selectedHeight], limits);
            }
        }
    }
    const machineSafeZ = scanMachinePosition([0, 0, safeZ], limits)[2];
    if (machineSafeZ < limits.z.min + Z_LIMIT_MARGIN || machineSafeZ > limits.z.max - Z_LIMIT_MARGIN) throw new Error('Calculated full-clearance Z height exceeds controller Z travel.');

    state.scanRunning = true;
    state.stopScan = false;
    state.busy = true;
    state.perimeterPoints = [];
    state.surfaceRings = [];
    state.surfaceCenter = null;
    state.surfaceComplete = false;
    state.polygonSurfacePoints = [];
    state.polygonMesh = null;
    state.recesses = [];
    state.tracingRecess = false;
    $('surfaceStl').value = '';
    $('surfaceStlStatus').textContent = '';
    const contactRadiusHistory = [];
    renderPerimeterResult();
    $('scanStatus').textContent = circleScan
        ? `Using confirmed bed height; starting ${sampleCount}-point circle scan…`
        : `Using confirmed bed height; starting contact-driven ${cfg.partShape} scan…`;
    logHomingDiagnostic('Perimeter scan started', {
        mode: cfg.probeMode,
        fastFeedMmMin: cfg.fastFeed,
        slowFeedMmMin: cfg.slowFeed,
        shape: cfg.partShape,
        sampleCount,
        partRadius: radius,
        partBounds: [cfg.boundsX, cfg.boundsY],
        nominalContactRadius,
        firstSearchEndRadius,
        laterSearchEndRadius,
        firstSearchInwardAllowance: Math.max(0, nominalContactRadius - firstSearchEndRadius),
        laterSearchInwardAllowance: radius,
        searchBox: [cfg.rectangleWidth, cfg.rectangleHeight],
        expectedFrontEdgeY: frontBedY,
        sampleSpacing: cfg.spacing,
        releaseDistance,
        initialWpos: initial.wpos
    });
    updateLiveStatus();
    let busyAnnounced = false;
    try {
        await machine.setBusy(true, `Scan ${cfg.partShape} perimeter from confirmed bed`);
        busyAnnounced = true;
        const bed = {bedWposZ:state.bedWposZ,wposY:state.bedOriginWpos[1]};
        const bedWposZ = bed.bedWposZ;
        const perimeterWposZ = bedWposZ + cfg.selectedHeight;
        if (!Number.isFinite(perimeterWposZ)) throw new Error('Could not calculate the perimeter probe height from the measured bed and part thickness range.');
        await scanMove([0,bed.wposY,perimeterWposZ], limits, 'Lowering at the confirmed bed position to perimeter height');
        $('scanStatus').textContent = `Bed found at WPOS Z${bedWposZ.toFixed(3)}. Perimeter probe height is WPOS Z${perimeterWposZ.toFixed(3)}.`;
        if (circleScan) {
        const ultraHistory=[];
        for (let index = 0; index < sampleCount; index += 1) {
            if (state.stopScan) throw new Error('Scan stopped by user after the previous sample.');
            const angle = firstAngle + (2 * Math.PI * index) / sampleCount;
            const ux = Math.cos(angle);
            const uy = Math.sin(angle);
            const predictedContactRadius = predictNextContactRadius(contactRadiusHistory, nominalContactRadius, cfg.spacing);
            // Begin at the actual bed-search Y and probe toward +Y for the first contact.
            const startRadius = index === 0 ? Math.abs(bed.wposY) : predictedContactRadius + releaseDistance;
            const searchEndRadius = index === 0
                ? firstSearchEndRadius
                : Math.max(0.1, predictedContactRadius - radius);
            $('scanStatus').textContent = index === 0
                ? 'First perimeter point: probing back toward +Y from bed-search Y' + bed.wposY.toFixed(2) + '.'
                : 'Point ' + (index + 1) + '/' + sampleCount + ': move outward ' + releaseDistance.toFixed(2) + ' mm, then search up to ' + radius.toFixed(2) + ' mm inward for the next wall.';
            const approach = [center[0] + ux * startRadius, center[1] + uy * startRadius, perimeterWposZ];
            if (index === 0) logHomingDiagnostic('First perimeter approach starts at the bed-search point', { positionWpos: approach });
            await moveToPerimeterApproachWithProbe(approach, [center[0] + ux * radius, center[1] + uy * radius], cfg, limits,
                'Point ' + (index + 1) + '/' + sampleCount + ': probing XY travel to outward approach');
            const fastHit = await probeRay({
                center, angle, startRadius, endRadius: searchEndRadius,
                feed: cfg.fastFeed, height: perimeterWposZ, limits,
                label: index === 0 ? 'First +Y perimeter touch' : 'Fast touch ' + (index + 1) + '/' + sampleCount
            });
            if (!fastHit) {
                const noContactPosition = await currentSnapshot();
                await scanMove([noContactPosition.wpos[0], noContactPosition.wpos[1], safeZ], limits, 'No contact: retracting vertically to full-clearance height');
                throw new Error('No contact at point ' + (index + 1) + '/' + sampleCount + '. Probed inward from radius ' + startRadius.toFixed(2) + ' to ' + searchEndRadius.toFixed(2) + ' mm. Check the approximate center, entered circle radius, and probe reach.');
            }
            const fastWpos = [fastHit.mpos[0] - state.wposZeroMachine[0], fastHit.mpos[1] - state.wposZeroMachine[1]];
            const fastRadius = (fastWpos[0] - center[0]) * ux + (fastWpos[1] - center[1]) * uy;
            logHomingDiagnostic('Perimeter fast contact captured', {
                point: index + 1, angleDegrees: angle * 180 / Math.PI,
                predictedContactRadius, startRadius, searchEndRadius,
                measuredContactRadius: fastRadius, measuredWpos: fastWpos,
                priorContactRadii: contactRadiusHistory.slice(-5)
            });
            const releaseRadius = fastRadius + releaseDistance;
            const releaseTarget = [center[0] + ux * releaseRadius, center[1] + uy * releaseRadius, perimeterWposZ];
            await waitForProbeClearAfterRetract(limits, releaseTarget, 'Fast-touch release at point ' + (index + 1));
            if (state.stopScan) {
                await scanMove([releaseTarget[0], releaseTarget[1], safeZ], limits, 'Stopping safely after probe release');
                throw new Error('Scan stopped by user after the current probe move.');
            }
            let measuredWpos = fastWpos;
            let measuredRadius = fastRadius;
            let clearedAt = releaseTarget;
            if (cfg.probeMode === 'precise' || cfg.probeMode === 'ultra') {
                const preciseHit = await probeRay({
                    center, angle, startRadius: releaseRadius, endRadius: fastRadius - 0.5,
                    feed: cfg.slowFeed,
                    height: perimeterWposZ, limits, label: 'Precise touch ' + (index + 1) + '/' + sampleCount
                });
                if (!preciseHit) {
                    await scanMove([releaseTarget[0], releaseTarget[1], safeZ], limits, 'Slow touch missed: retracting to full-clearance height');
                    throw new Error('The slow confirm touch missed point ' + (index + 1) + '/' + sampleCount + '. Scan stopped.');
                }
                measuredWpos = [preciseHit.mpos[0] - state.wposZeroMachine[0], preciseHit.mpos[1] - state.wposZeroMachine[1]];
                measuredRadius = (measuredWpos[0] - center[0]) * ux + (measuredWpos[1] - center[1]) * uy;
                clearedAt = [center[0] + ux * (measuredRadius + releaseDistance), center[1] + uy * (measuredRadius + releaseDistance), perimeterWposZ];
                await waitForProbeClearAfterRetract(limits, clearedAt, 'Precise-touch release at point ' + (index + 1));
                if (Math.abs(measuredRadius - fastRadius) > 0.75) {
                    await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Touch mismatch: raised to full-clearance height');
                    throw new Error('Fast and precise contacts differed by ' + (measuredRadius - fastRadius).toFixed(2) + ' mm at sample ' + (index + 1) + '; scan stopped for review.');
                }
            }
            const point={ index: state.perimeterPoints.length + 1, angle: angle * 180 / Math.PI, x: measuredWpos[0] - ux * cfg.radius, y: measuredWpos[1] - uy * cfg.radius, z: bedWposZ };
            state.perimeterPoints.push(point);
            if(cfg.probeMode==='ultra')await maybeRefineUltraCorner(ultraHistory,{center:[...measuredWpos,perimeterWposZ],outward:[ux,uy],clear:clearedAt.slice(),point},state.perimeterPoints,cfg,limits,bedWposZ);
            contactRadiusHistory.push(measuredRadius);
            renderPerimeterResult();
            if (state.stopScan) {
                await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Stopping safely after probe release');
                throw new Error('Scan stopped by user after the current probe move.');
            }
            $('scanStatus').textContent = 'Point ' + (index + 1) + '/' + sampleCount + ' captured; released outward and ready for next XY point.';
        }
        } else if (polygonScan) {
            await scanPolygonPrototype(cfg, limits, bedWposZ);
        } else {
            await scanRectanglePerimeter(cfg, limits, safeZ, perimeterWposZ, bedWposZ, bed.wposY, rectanglePlan);
        }
        const finalPosition = await currentSnapshot();
        await scanMove([finalPosition.wpos[0], finalPosition.wpos[1], safeZ], limits, 'Perimeter complete: raise to full-clearance height');
        if (polygonScan) {
            $('scanStatus').textContent = 'Polygon candidate closed. Planning simulator-only surface samples…';
            logHomingDiagnostic('Polygon candidate closure', { contacts: state.perimeterPoints.length, validated: false });
            await scanPolygonSurfacePrototype(cfg,limits,safeZ,bedWposZ);
            $('scanStatus').textContent=`Polygon surface scan complete: ${state.perimeterPoints.length} raw perimeter contacts and ${state.polygonSurfacePoints.length} surface samples. Map and open-surface STL are available.`;
            return;
        }
        $('scanStatus').textContent = 'Perimeter captured. Starting the interior Z surface scan…';
        await scanInteriorSurface(cfg, limits, safeZ, bedWposZ);
        $('scanStatus').textContent = `Surface scan complete: ${state.perimeterPoints.length} perimeter points and ${state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + 1} interior height points captured.`;
        logHomingDiagnostic('Perimeter and interior surface scan completed', { perimeterPoints: state.perimeterPoints.length, interiorRings: state.surfaceRings.length, interiorPoints: state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + 1, mode: cfg.probeMode });
    } catch (error) {
    const retainedSurfacePoints = polygonScan ? (state.polygonSurfacePoints?.length ?? 0) : state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + (state.surfaceCenter ? 1 : 0);
    $('scanStatus').textContent = `${error.message} ${state.perimeterPoints.length} perimeter points and ${retainedSurfacePoints} surface points retained.`;
        logHomingDiagnostic('Perimeter scan stopped', {
            error: error.message,
            pointsCaptured: state.perimeterPoints.length,
            lastPoints: state.perimeterPoints.slice(-5),
            lastStatusLine: state.lastProbeStatusLine,
            probePinKnown: state.probePinKnown,
            probePinActive: state.probePinActive
        });
        state.stopScan = false;
        if (!polygonScan && state.motionState !== 'Alarm' && state.connected) {
            try {
                const snapshot = await currentSnapshot();
                if (snapshot.state === 'Idle' && state.probePinKnown && !state.probePinActive && snapshot.wpos?.[2] < safeZ - 0.1) {
                    await scanMove([snapshot.wpos[0], snapshot.wpos[1], safeZ], limits, 'Recovering: raise to full-clearance height');
                }
            } catch { /* report the original scan failure; require the operator to inspect the machine */ }
        }
    } finally {
        state.scanRunning = false;
        state.busy = false;
        try { if (busyAnnounced) await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        updateLiveStatus();
        update();
    }
}

function downloadPerimeterCsv() {
    if (!state.perimeterPoints.length) return;
    const raw = state.perimeterPoints.some(point => point.kind === 'raw probe center');
    const rows = raw
        ? ['sample,x_wpos_mm,y_wpos_mm,z_wpos_mm,x_mpos_mm,y_mpos_mm,z_mpos_mm,raw_x_wpos_mm,raw_y_wpos_mm,approach_angle_deg', ...state.perimeterPoints.map(p=>`${p.index},${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)},${p.rawMpos?.map(v=>v.toFixed(3)).join(',') ?? ',,'},${Number.isFinite(p.rawX)?p.rawX.toFixed(3):''},${Number.isFinite(p.rawY)?p.rawY.toFixed(3):''},${Number.isFinite(p.approachAngle)?p.approachAngle.toFixed(2):''}`)]
        : ['sample,angle_deg,x_wpos_mm,y_wpos_mm,z_wpos_mm', ...state.perimeterPoints.map((point) => `${point.index},${point.angle.toFixed(3)},${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`)];
    const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cylinder-perimeter.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadPolygonSurfaceCsv() {
    if(!state.polygonSurfacePoints?.length)return;
    const rows=['sample,x_wpos_mm,y_wpos_mm,z_wpos_mm',...state.polygonSurfacePoints.map((p,i)=>`${i+1},${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`)];
    const url=URL.createObjectURL(new Blob([rows.join('\r\n')],{type:'text/csv'}));const link=document.createElement('a');link.href=url;link.download='polygon-surface.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}

async function copySurfaceStl() {
    if (!state.surfaceComplete) return;
    const field = $('surfaceStl');
    try {
        field.value = surfaceMeshToStl();
        await navigator.clipboard.writeText(field.value);
        $('surfaceStlStatus').textContent = 'ASCII STL copied to clipboard.';
    } catch (error) {
        field.focus();
        field.select();
        const copied = document.execCommand('copy');
        $('surfaceStlStatus').textContent = copied ? 'ASCII STL copied to clipboard.' : `Copy failed: ${error.message}. Select and copy the text above.`;
    }
}

function loadPolygonResult(saved) {
    if(!saved || !Array.isArray(saved.perimeter) || !Array.isArray(saved.surface))throw Error('Invalid polygon scan file.');
    const convert=(p,i)=>Array.isArray(p)?{x:p[0],y:p[1],z:p[2],index:i+1,kind:'raw probe center'}:p;
    const perimeter=saved.perimeter.map(convert),surface=saved.surface.map(convert);
    const spacing=Number(saved.spacing ?? number('sampleSpacing'));
    const bedZ=Number(saved.bedZ ?? state.bedWposZ ?? -number('maxThickness'));
    const recesses=Array.isArray(saved.recesses)?saved.recesses:[];
    const mesh=polygonMesh(perimeter,surface,spacing,bedZ,recesses,Number(saved.threshold ?? -Infinity));
    state.perimeterPoints=perimeter.map((p,i)=>({...p,index:i+1,kind:'raw probe center'}));
    state.polygonSurfacePoints=surface;state.polygonMesh=mesh;state.surfaceComplete=true;state.fullSurfaceAvailable=true;state.recesses=recesses;
    state.surfaceRings=[];state.surfaceCenter=null;
    $('scanStatus').textContent=`Loaded polygon scan: ${perimeter.length} outline points, ${surface.length} surface readings. No machine position was restored.`;
    renderPerimeterResult();
}

function waitForProbeStatus(previousSequence, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
        const poll = () => {
            if (state.probeStatusSequence > previousSequence) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(poll, 20);
        };
        poll();
    });
}

async function runProbeSignalCheck() {
    if (state.probeTestRunning) return;
    if (!state.connected || state.motionState !== 'Idle') return;
    state.probeSignalTested = false;
    state.probeTestRunning = true;
    state.cancelProbeTest = false;
    const dialog = $('probeTestDialog');
    const status = $('probeTestStatus');
    const action = $('continueProbeTest');
    const cancel = $('cancelProbeTest');
    let lastProbeReportAt = 0;
    const continueObserver = new MutationObserver((mutations) => {
        logHomingDiagnostic('Probe Continue DOM attribute mutation', {
            attributes: mutations.map((mutation) => mutation.attributeName),
            ...getProbeContinueSnapshot()
        });
    });
    continueObserver.observe(action, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
    dialog.dataset.probeActivated = 'false';
    dialog.dataset.probePassed = 'false';
    setProbeContinueEnabled(false);
    action.textContent = 'Continue';
    setProbeTestStatus('Waiting for the probe input to be clear. Status is checked every 0.7 seconds.', 'error');
    dialog.showModal();
    updateLiveStatus();
    logHomingDiagnostic('Probe signal test dialog opened', {
        connected: state.connected,
        motionState: state.motionState,
        probeStatusSequence: state.probeStatusSequence,
        probePinKnown: state.probePinKnown,
        probePinActive: state.probePinActive,
        continueButton: getProbeContinueSnapshot()
    });
    return new Promise((resolve) => {
        let finished = false;
        const finish = (accepted) => {
            if (finished) return;
            finished = true;
            if (accepted && dialog.dataset.probePassed === 'true') state.probeSignalTested = true;
            state.cancelProbeTest = !accepted;
            state.finishProbeTest = null;
            continueObserver.disconnect();
            logHomingDiagnostic('Probe signal test dialog finished', {
                accepted,
                passed: dialog.dataset.probePassed,
                continueButton: getProbeContinueSnapshot()
            });
            dialog.oncancel = null;
            action.onclick = null;
            cancel.onclick = null;
            if (dialog.open) dialog.close();
            resolve(accepted);
        };
        state.finishProbeTest = finish;
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
        cancel.onclick = () => finish(false);
        action.onclick = () => {
            logHomingDiagnostic('Probe Continue clicked', getProbeContinueSnapshot());
            if (state.probePinActive) {
                setProbeTestStatus('Probe activation detected. Release the probe before continuing.');
            } else if (dialog.dataset.probePassed === 'true' && state.probeSignalTested) finish(true);
            else {
                setProbeTestStatus('Release the probe to complete the signal check, then continue.');
            }
        };

        void (async () => {
            let clearBaselineSeen = false;
            let activationSeen = false;
            while (!finished && !state.cancelProbeTest && !state.probeSignalTested) {
                const cycleStarted = Date.now();
                const previousSequence = state.probeStatusSequence;
                try {
                    if (Date.now() - lastProbeReportAt > 5000) {
                        lastProbeReportAt = Date.now();
                        logHomingDiagnostic('Probe status poll sent', {
                            command: '?',
                            probeStatusSequence: previousSequence,
                            continueButton: getProbeContinueSnapshot()
                        });
                    }
                    await machine.command('?');
                    const reportDeadline = Date.now() + 450;
                    while (!finished && !state.cancelProbeTest && state.probeStatusSequence <= previousSequence && Date.now() < reportDeadline) {
                        await new Promise((wait) => setTimeout(wait, 20));
                    }
                    if (state.probeStatusSequence <= previousSequence) {
                        logHomingDiagnosticThrottled('probe-test-no-report', 'Probe status poll received no fresh report', {
                            previousSequence,
                            currentSequence: state.probeStatusSequence,
                            dialogOpen: dialog.open,
                            continueButton: getProbeContinueSnapshot()
                        }, String(state.probeStatusSequence), 5000);
                    }
                    if (state.probeStatusSequence > previousSequence) {
                        logHomingDiagnosticThrottled('probe-test-report', 'Probe status report received during test', {
                            sequence: state.probeStatusSequence,
                            probePinKnown: state.probePinKnown,
                            probePinActive: state.probePinActive,
                            dialogMessage: status.textContent,
                            continueButton: getProbeContinueSnapshot()
                        }, `${state.probePinKnown}:${state.probePinActive}`, 5000);
                        if (!state.probePinKnown) {
                            setProbeTestStatus('Waiting for gSender to report the probe-pin state (Pn:…).', 'error');
                        } else if (!state.probePinActive) {
                            if (!clearBaselineSeen) {
                                clearBaselineSeen = true;
                                setProbeTestStatus('Probe input is clear. Activate the probe now; monitoring continues automatically.');
                            } else if (activationSeen) {
                                state.probeSignalTested = true;
                                dialog.dataset.probeActivated = 'true';
                                dialog.dataset.probePassed = 'true';
                                setProbeContinueEnabled(true);
                                setProbeTestStatus('Probe activation and release detected. Continue to start the origin touch-off.', 'success');
                                logHomingDiagnostic('Probe signal test passed; enabled Continue', {
                                    probeSignalTested: state.probeSignalTested,
                                    probeTestRunning: state.probeTestRunning,
                                    dialogOpen: dialog.open,
                                    buttonDisabled: action.disabled,
                                    probePinKnown: state.probePinKnown,
                                    probePinActive: state.probePinActive
                                });
                            }
                        } else if (!clearBaselineSeen) {
                            setProbeTestStatus('Probe input is active. Release it first; monitoring will then wait for a new activation.', 'error');
                        } else if (!activationSeen) {
                            activationSeen = true;
                            dialog.dataset.probeActivated = 'true';
                            setProbeContinueEnabled(false);
                            setProbeTestStatus('Probe activation detected. Release the probe now.');
                            logHomingDiagnostic('Probe activation detected; enabled Continue', {
                                dialogOpen: dialog.open,
                                buttonDisabled: action.disabled,
                                probePinKnown: state.probePinKnown,
                                probePinActive: state.probePinActive
                            });
                        }
                    }
                } catch (error) {
                    logHomingDiagnostic('Probe status poll failed', { message: error.message, continueButton: getProbeContinueSnapshot() });
                    setProbeTestStatus(`Waiting for controller probe status: ${error.message}`, 'error');
                }
                const waitMs = Math.max(0, 700 - (Date.now() - cycleStarted));
                if (!finished && !state.cancelProbeTest && !state.probeSignalTested && waitMs) {
                    await new Promise((wait) => setTimeout(wait, waitMs));
                }
            }
            state.probeTestRunning = false;
            updateLiveStatus();
            update();
        })();
    });
}

function cancelProbeSignalCheck() {
    if (state.finishProbeTest) state.finishProbeTest(false);
    else if ($('probeTestDialog').open) $('probeTestDialog').close();
}

function legacyUpdate() {
    const diameter = number('tipDiameter');
    const radius = diameter / 2;
    const fastFeed = number('fastFeed');
    const slowFeed = number('slowFeed');
    const usableLength = number('usableLength');
    const verticalClearance = number('verticalClearance');
    const clearance = number('approachClearance');
    const minThickness = number('minThickness');
    const maxThickness = number('maxThickness');
    const partShape = $('partShape').value;
    const partRadius = number('partRadius');
    const partWidth = number('partWidth');
    const partHeight = number('partHeight');
    const polygonSides = Math.trunc(number('polygonSides'));
    const circleShape = partShape === 'circle';
    const shapeUsesTwoDimensions = ['oval', 'square', 'rectangle', 'triangle', 'polygon'].includes(partShape);
    $('partRadiusField').hidden = !circleShape;
    $('partWidthField').hidden = circleShape;
    $('partHeightWrap').hidden = !shapeUsesTwoDimensions;
    $('polygonSidesWrap').hidden = true;
    $('polygonControls').hidden = partShape !== 'polygon';
    $('polygonNotice').hidden = partShape !== 'polygon';
    $('partWidthLabel').textContent = partShape === 'oval' ? 'Oval X (mm)' : partShape === 'square' ? 'Square X (mm)' : partShape === 'rectangle' ? 'Rectangle X (mm)' : partShape === 'triangle' ? 'Base X (mm)' : 'Approximate part length X (mm)';
    $('partHeightWrap').firstChild.textContent = partShape === 'oval' ? 'Oval Y (mm)' : partShape === 'square' ? 'Square Y (mm)' : partShape === 'rectangle' ? 'Rectangle Y (mm)' : partShape === 'triangle' ? 'Height Y (mm)' : 'Approximate part width Y (mm)';
    $('rectangleWidthField').hidden = true;
    $('rectangleHeightField').hidden = true;
    const partShapeIllustration = document.querySelector('.part-shape');
    partShapeIllustration.classList.toggle('circle-shape', circleShape);
    partShapeIllustration.classList.toggle('square-shape', partShape === 'square');
    partShapeIllustration.classList.toggle('rectangle-shape', partShape === 'rectangle');
    $('shapeSupportMessage').textContent = partShape === 'circle'
        ? 'Circle samples use radial probes from the approximate WPOS center.'
        : ['square', 'rectangle', 'triangle'].includes(partShape)
            ? 'Straight-edge scans continue until a complete miss, then change probing direction. The search box must include clearance for each miss and corner transfer.'
            : partShape === 'polygon' ? 'Simulator-only: follow one connected outer boundary with guarded probe moves; no shape or side count is required.' : 'This outline is shown for planning, but automated perimeter motion is not enabled for this shape yet.';
    const spacing = number('sampleSpacing');
    const probeFeedsValid = positive(fastFeed) && positive(slowFeed) && slowFeed <= fastFeed;
    $('fastFeed').setCustomValidity(positive(fastFeed) ? '' : 'Enter a positive feed rate.');
    $('slowFeed').setCustomValidity(!positive(slowFeed) ? 'Enter a positive feed rate.' : slowFeed > fastFeed ? 'Slow feed must not exceed fast feed.' : '');
    const feedStatus = $('probeFeedStatus');
    feedStatus.textContent = probeFeedsValid
        ? 'Probe feeds are valid.'
        : !positive(fastFeed) || !positive(slowFeed)
            ? 'Enter a positive value for both probe feeds.'
            : `Slow feed (${slowFeed} mm/min) must not exceed Fast feed (${fastFeed} mm/min). Lower Slow or raise Fast.`;
    feedStatus.dataset.state = probeFeedsValid ? 'ready' : 'error';
    const probeInputsValid = positive(diameter) && positive(usableLength) && Number.isFinite(verticalClearance) && verticalClearance >= 0 && Number.isFinite(clearance) && clearance >= 0.5;
    const partInputsValid = positive(minThickness) && positive(maxThickness) && maxThickness >= minThickness;
    const areaInputsValid = (circleShape ? positive(partRadius) : positive(partWidth)) && (!shapeUsesTwoDimensions || positive(partHeight))
        ;
    const perimeterHeightLow = Math.max(radius + verticalClearance, maxThickness + verticalClearance - radius - usableLength);
    const perimeterHeightHigh = minThickness - radius - verticalClearance;
    const heightInputsValid = probeInputsValid && partInputsValid;
    const heightValid = probeInputsValid && partInputsValid && perimeterHeightLow <= perimeterHeightHigh;
    const selectedHeight = heightValid ? (perimeterHeightLow + perimeterHeightHigh) / 2 : NaN;
    $('heightResult').className = `height-result ${heightValid ? 'valid' : heightInputsValid ? 'invalid' : ''}`;
    $('heightResult').innerHTML = heightValid
        ? `<span>Calculated perimeter height (ball center above bed)</span><strong>${fmt(selectedHeight)}</strong><small>Safe range: ${fmt(perimeterHeightLow)} to ${fmt(perimeterHeightHigh)}</small>`
        : heightInputsValid
            ? `<strong>Probe not suitable at one perimeter height</strong><small>Required range ${fmt(perimeterHeightLow)} to ${fmt(perimeterHeightHigh)} does not overlap. Check probe length and part thickness range.</small>`
            : '<span>Enter valid probe and part-thickness dimensions to calculate a safe height.</span>';

    const perimeterReleaseDistance = diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const minimumStraightEdgeMargin = ['square', 'rectangle', 'triangle'].includes(partShape) ? 5 : 0;
    const boundsX = circleShape ? partRadius * 2 : partWidth;
    const boundsY = circleShape ? partRadius * 2 : shapeUsesTwoDimensions ? partHeight : partWidth;
    if(!state.rectangleOriginMachine) state.polygonOriginOffset=null;
    const polygonOriginOffsetX=state.polygonOriginOffset?.x ?? 0,polygonOriginOffsetY=state.polygonOriginOffset?.y ?? 0;
    $('polygonOriginOffsetX').value=state.polygonOriginOffset ? polygonOriginOffsetX.toFixed(3) : '';
    $('polygonOriginOffsetY').value=state.polygonOriginOffset ? polygonOriginOffsetY.toFixed(3) : '';
    const basePolygonBox=partShape==='polygon' ? polygonSearchBox({width:boundsX,height:boundsY,offsetX:polygonOriginOffsetX,offsetY:polygonOriginOffsetY,step:spacing,clearance:number('polygonClearance'),radius,releaseLimit:number('polygonReleaseLimit'),approachMargin:clearance}) : null;
    const ultraMode=document.querySelector('input[name="probeMode"]:checked')?.value==='ultra';
    const extraPolygonMargin=basePolygonBox&&ultraMode?Math.max(0,diameter*3-basePolygonBox.margin):0;
    const polygonBox=basePolygonBox?{...basePolygonBox,width:basePolygonBox.width+2*extraPolygonMargin,height:basePolygonBox.height+2*extraPolygonMargin,margin:basePolygonBox.margin+extraPolygonMargin}:null;
    const requiredMargin = polygonBox?.margin ?? Math.max(minimumStraightEdgeMargin, radius + clearance, perimeterReleaseDistance * 2, ultraMode ? diameter*3 : 0);
    const minimumRectangleWidth = polygonBox?.width ?? boundsX + 2 * requiredMargin;
    const minimumRectangleHeight = polygonBox?.height ?? boundsY + 2 * requiredMargin;
    $('rectangleWidth').readOnly=true;
    $('rectangleHeight').readOnly=true;
    if (areaInputsValid && probeInputsValid) {
        if (partShape !== 'polygon' || polygonBox) {
            const roundUp = value => (Math.ceil((value - 1e-9) * 10) / 10).toFixed(1);
            $('rectangleWidth').value = roundUp(minimumRectangleWidth);
            $('rectangleHeight').value = roundUp(minimumRectangleHeight);
        }
    }
    const rectangleWidth = number('rectangleWidth');
    const rectangleHeight = number('rectangleHeight');
    // Keep at least four perimeter samples across the smaller part dimension.
    // This geometry-based ceiling is independent of probe-tip diameter.
    const maxSpacing = Math.min(boundsX, boundsY) / 4;
    $('marginRecommendation').textContent = probeInputsValid ? `${fmt(requiredMargin)} each side` : '—';
    $('featureRecommendation').textContent = positive(diameter) ? fmt(diameter * FEATURE_WIDTH_MULTIPLIER) : '—';
    $('spacingRecommendation').textContent = positive(maxSpacing) ? `≤ ${fmt(maxSpacing)}` : '—';
    const rectangleValid = areaInputsValid && probeInputsValid && (partShape!=='polygon'||Boolean(polygonBox)) && rectangleWidth >= minimumRectangleWidth && rectangleHeight >= minimumRectangleHeight;
    const spacingValid = positive(spacing) && positive(maxSpacing) && spacing <= maxSpacing;
    const estimatedDiameter = circleShape ? partRadius * 2 : (boundsX + boundsY) / 2;
    const rectangularShape = ['square', 'rectangle', 'triangle'].includes(partShape);
    const rectanglePlan = rectangularShape && positive(boundsX) && positive(boundsY) && positive(spacing)
        ? makeRectanglePerimeterPlan(boundsX, boundsY, spacing, positive(diameter) ? diameter * PERIMETER_RELEASE_DIAMETER_FACTOR : 0) : null;
    const proposedSampleCount = positive(spacing) && positive(estimatedDiameter)
        ? circleShape
            ? Math.max(16, Math.ceil((Math.PI * estimatedDiameter) / spacing))
            : rectangularShape && rectanglePlan
                ? rectanglePlan.length
                : Math.ceil((2 * boundsX + 2 * boundsY) / spacing)
        : Infinity;
    const scanShapeSupported = circleShape || rectangularShape || partShape === 'polygon';
    const scanLimit = circleShape ? 360 : MAX_PERIMETER_SAMPLES;
    const scanValid = scanShapeSupported && areaInputsValid && proposedSampleCount <= scanLimit
        && (circleShape ? partRadius > diameter * PERIMETER_RELEASE_DIAMETER_FACTOR
            : Math.min(boundsX, boundsY) / 2 > diameter * PERIMETER_RELEASE_DIAMETER_FACTOR);
    const machineReady = state.connected && state.controllerHomed && state.motionState === 'Idle'
        && state.probeSignalTested && state.probePinKnown && !state.probePinActive;
    const originReady = machineReady && Boolean(state.rectangleOriginMachine) && state.originSafeRetract;
    $('gotoOrigin').disabled = !state.rectangleOriginMachine || !state.controllerHomed || state.motionState !== 'Idle'
        || state.busy || state.probeTestRunning || !Number.isFinite(state.workPosition?.[2])
        || state.workPosition[2] < maxThickness * 0.1;
    $('originCaptureStatus').textContent = state.originMessage ?? (state.rectangleOriginMachine
        ? `Part-center top origin captured at machine X${state.rectangleOriginMachine[0].toFixed(3)} Y${state.rectangleOriginMachine[1].toFixed(3)} Z${state.rectangleOriginMachine[2].toFixed(3)}.`
        : 'Ready when homed and positioned above the approximate center of the part.');
    const probeReady = probeInputsValid;
    const partReady = partInputsValid && heightValid;
    const areaDimensionsReady = partReady && rectangleValid;
    const areaReady = areaDimensionsReady && spacingValid;
    const setupReady = machineReady && probeInputsValid && probeFeedsValid && heightValid && rectangleValid && spacingValid && originReady;
    const safeWposZ = maxThickness * 0.1;

    // Homing and jog setup is independent of scan resolution. Keep the
    // Origin controls accessible while the user adjusts sample spacing.
    const unlockedSteps = [true, probeReady, partReady, areaDimensionsReady, originReady || state.scanRunning];
    document.querySelectorAll('.workflow-step').forEach((section, index) => {
        const locked = !unlockedSteps[index];
        section.classList.toggle('is-locked', locked);
        section.querySelector('.step-content').inert = locked;
    });

    setStepStatus('probeDimensionsStatus', probeReady ? 'Entered' : 'Needs input', probeReady ? 'ready' : 'waiting');
    setStepStatus('partStatus', heightValid ? 'Height available' : partInputsValid ? 'Not reachable' : 'Needs input', heightValid ? 'ready' : partInputsValid ? 'error' : 'waiting');
    setStepStatus('areaStatus', areaReady ? 'Valid' : areaInputsValid ? 'Adjust area' : 'Needs input', areaReady ? 'ready' : 'waiting');
    const originStatusMessage = !state.connected ? 'Connect in gSender'
        : !state.controllerHomed ? 'Home machine'
            : !state.rectangleOriginMachine ? 'Probe WPOS Origin'
                : !state.originSafeRetract ? 'Check Z clearance'
                    : originReady ? 'Origin ready' : 'Set work origin';
    setStepStatus('originStatus', originStatusMessage, originReady ? 'ready' : 'waiting');
    setStepStatus('planStatus', setupReady ? 'Ready to review' : 'Not ready', setupReady ? 'ready' : 'waiting');

    $('planSummary').textContent = setupReady && !scanValid
        ? !scanShapeSupported
            ? 'Automated perimeter scanning is available for Circle, Square, Rectangle and Triangle outlines.'
            : proposedSampleCount > scanLimit
                ? `This plan requires ${proposedSampleCount} perimeter samples, above the ${scanLimit}-point limit. Increase sample spacing.`
                : 'The part is too small to leave room for the probe release and an interior surface ring.'
        : !probeFeedsValid
            ? 'Set positive probe feed rates and keep Slow feed no greater than Fast feed.'
        : setupReady && circleShape
        ? `Circle radius ${fmt(partRadius)} (${fmt(estimatedDiameter)} diameter) · ${proposedSampleCount} radial samples · first ray searches to R−5 mm and later rays search up to R inward for bays · ${document.querySelector('input[name="probeMode"]:checked')?.value === 'fast' ? 'fast single-touch' : 'precise double-touch'} probing · perimeter height ${fmt(selectedHeight)} above bed · full-clearance height ${fmt(safeWposZ)} above part-top WPOS Z0.`
        : setupReady && partShape === 'polygon'
            ? `Simulator-only contact-driven scan · step ${fmt(spacing)} · ${ultraMode?'Ultra precise: double touch and corner refinement at 0.5D':document.querySelector('input[name="probeMode"]:checked')?.value==='fast'?'fast single touch':'precise double touch'} · raw probe-center contacts and inward surface passes.`
        : setupReady && rectangularShape
            ? `${partShape === 'square' ? 'Square' : partShape === 'triangle' ? 'Triangle' : 'Rectangle'} ${fmt(boundsX)} × ${fmt(boundsY)} · edges followed until a complete miss, then direction changes · ${document.querySelector('input[name="probeMode"]:checked')?.value === 'fast' ? 'fast single-touch' : 'precise double-touch'} probing · perimeter height ${fmt(selectedHeight)} above bed · full-clearance height ${fmt(safeWposZ)} above part-top WPOS Z0.`
        : !heightValid && partInputsValid && probeInputsValid
            ? 'The entered probe geometry cannot reach both the thinnest and thickest perimeter at one safe height.'
            : !rectangleValid && areaInputsValid && probeInputsValid
                ? `Search box must be at least ${fmt(minimumRectangleWidth)} × ${fmt(minimumRectangleHeight)} around the part center.`
                : !spacingValid && positive(maxSpacing)
                    ? `Choose a sample spacing no greater than ${fmt(maxSpacing)} to keep at least four samples across the smaller part dimension.`
                    : 'Complete the setup steps to review the perimeter plan.';
    $('saveSetup').disabled = !setupReady;
    state.latest = { diameter, radius, usableLength, clearance, verticalClearance, minThickness, maxThickness, partShape, partRadius, partWidth, partHeight, polygonSides, boundsX, boundsY, polygonOriginOffsetX, polygonOriginOffsetY, rectangleWidth, rectangleHeight, spacing, requiredMargin, perimeterHeightLow, perimeterHeightHigh, selectedHeight, fastFeed, slowFeed, probeFeedsValid, probeMode: document.querySelector('input[name="probeMode"]:checked')?.value ?? 'precise', setupReady, scanValid, proposedSampleCount };
    refreshScanButton();
}

function update(){
    const diameter=number('tipDiameter'),radius=diameter/2,usableLength=number('usableLength'),verticalClearance=FIXED_VERTICAL_CLEARANCE_MM;
    const fastFeed=number('fastFeed'),slowFeed=number('slowFeed'),spacing=number('sampleSpacing');
    const probeMode=document.querySelector('input[name="probeMode"]:checked')?.value??'precise';
    const scanMode=document.querySelector('input[name="scanMode"]:checked')?.value??'both';
    $('startPerimeterScan').textContent=scanMode==='perimeter'?'Scan outside perimeter':scanMode==='surface'?'Scan inside surface':'Scan perimeter and surface';
    const probeFeedsValid=positive(fastFeed)&&positive(slowFeed)&&slowFeed<=fastFeed;
    const inputsValid=positive(diameter)&&positive(usableLength)&&positive(verticalClearance)&&usableLength>verticalClearance&&positive(spacing)&&probeFeedsValid;
    const selectedHeight=0.75*diameter;
    $('polygonClearance').value=(diameter*.5).toFixed(3);$('polygonReleaseLimit').value=(diameter*1.5).toFixed(3);
    $('polygonControls').hidden=true;$('shapeDimensions').hidden=true;$('polygonNotice').hidden=true;
    $('shapeSupportMessage').textContent='Simulator-only: the probe follows one connected outer boundary within machine travel.';
    $('probeFeedStatus').textContent=probeFeedsValid?'Probe feeds are valid.':'Enter positive feed rates; Slow must not exceed Fast.';
    const mode=probeMode==='fast'?'fast':probeMode==='ultra'?'ultra precise':'precise';
    $('planSummary').textContent=inputsValid?`${mode} · ${fmt(spacing)} spacing · maximum ${fmt(usableLength)} per downward Z probe · bed is WPOS Z0.`:'Enter valid probe dimensions, spacing, and feeds. Clearance C must be positive and less than L.';
    state.latest={diameter,radius,usableLength,verticalClearance,fastFeed,slowFeed,spacing,probeMode,partShape:'polygon',selectedHeight,maxThickness:usableLength,minThickness:NaN,probeFeedsValid,inputsValid,scanValid:inputsValid,setupReady:inputsValid};
    const enabled=state.connected&&state.controllerHomed&&state.motionState==='Idle'&&!state.busy&&!state.workflowRunning&&!state.probeTestRunning&&inputsValid;
    $('probeOriginButton').disabled=!enabled;
    $('stopPerimeterScan').disabled=!state.workflowRunning&&!state.scanRunning;
    $('saveSetup').disabled=!inputsValid||state.workflowRunning;
    for(const id of ['step-probe','step-area','step-origin','step-plan']){$(id).classList.remove('is-locked');$(id).querySelector('.step-content').inert=(id==='step-probe'||id==='step-area')&&(state.workflowRunning||state.probeTestRunning);}
    setStepStatus('probeDimensionsStatus',inputsValid?'Entered':'Needs input',inputsValid?'ready':'waiting');
    setStepStatus('areaStatus',inputsValid?'Valid':'Needs input',inputsValid?'ready':'waiting');
    setStepStatus('originStatus',state.workflowRunning?'Scanning':state.controllerHomed?'Ready':'Home machine',state.controllerHomed?'ready':'waiting');
    setStepStatus('planStatus',state.surfaceComplete?'Complete':state.workflowRunning?'Scanning':'Waiting',state.surfaceComplete?'ready':'waiting');
    $('scanReadiness').textContent=enabled?'Ready to test the probe and start.':state.workflowRunning?'Scan in progress.':'Home the machine and enter valid probe settings.';
}

function scanReadiness(){
    const reasons=[];if(!state.connected)reasons.push('Connect to the controller.');if(!state.controllerHomed)reasons.push('Home the machine.');if(!state.latest?.inputsValid)reasons.push('Enter valid probe settings.');return reasons;
}

function legacyScanReadiness() {
    const cfg = state.latest;
    const reasons = [];
    if (!state.connected) reasons.push('Connect to the controller.');
    if (!state.controllerHomed) reasons.push('Home the machine.');
    if (state.motionState !== 'Idle') reasons.push(`Wait for Idle (current state: ${state.motionState}).`);
    if (state.busy) reasons.push('Wait for the current plugin operation to finish.');
    if (state.scanRunning) reasons.push('A perimeter scan is already running.');
    if (cfg?.probeFeedsValid === false) reasons.push('Set positive probe feeds and keep Slow feed no greater than Fast feed.');
    if (!cfg?.setupReady && cfg?.probeFeedsValid !== false) reasons.push('Complete the probe, thickness, search-area, and origin setup.');
    if (!cfg?.scanValid) reasons.push('Enter valid part dimensions and probe spacing.');
    if (cfg?.partShape==='polygon' && !state.polygonOriginOffset) reasons.push('Probe the origin in the dedicated simulator to calculate the part offset.');
    if (!state.probeSignalTested) reasons.push('Complete the probe signal test.');
    if (!state.probePinKnown) reasons.push('Waiting for a reported probe-pin state.');
    if (state.probePinActive) reasons.push('Clear the probe input.');
    if (!state.wposZeroMachine || !state.originSafeRetract) reasons.push('Probe WPOS Origin and confirm the safe retract.');
    const expectedHalfHeight=cfg?.partShape==='circle'?cfg.partRadius:cfg?.partHeight/2;
    if(state.bedSetup && (state.bedSetup.shape!==cfg?.partShape || Math.abs(state.bedSetup.maxThickness-cfg.maxThickness)>0.001 || Math.abs(state.bedSetup.halfHeight-expectedHalfHeight)>0.001 || Math.abs(state.bedSetup.tipDiameter-cfg.diameter)>0.001)) reasons.push('Probe the bed origin again after changing the part dimensions or tip diameter.');
    if (!cfg || state.workPosition?.length !== 3 || !state.workPosition.every(Number.isFinite)) reasons.push('Waiting for current WPOS coordinates.');
    else {
        const safeWposZ = fullClearanceHeight(cfg);
        if (!state.bedOriginWpos || Math.abs(state.workPosition[0]-state.bedOriginWpos[0])>0.1 || Math.abs(state.workPosition[1]-state.bedOriginWpos[1])>0.1) reasons.push('Return to the probed front-bed XY.');
        if (state.workPosition[2] < safeWposZ - 0.1) reasons.push(`Raise to at least WPOS Z${safeWposZ.toFixed(2)} mm (current Z${state.workPosition[2].toFixed(2)} mm).`);
    }
    return reasons;
}

function refreshScanButton() {
    const button = $('startPerimeterScan');
    if (!button) return;
    const reasons = scanReadiness();
    button.disabled = reasons.length > 0;
    const readinessText = reasons.length ? `Scan is not ready: ${reasons.join(' ')}` : 'Ready to start the scan.';
    const status = $('scanReadiness');
    if (status) status.textContent = readinessText;
    const key = JSON.stringify({ reasons, wpos: state.workPosition, motionState: state.motionState, busy: state.busy, probeSignalTested: state.probeSignalTested, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });
    if (key !== lastScanReadinessKey) {
        lastScanReadinessKey = key;
        logHomingDiagnostic('Scan readiness updated', { ready: reasons.length === 0, blockedBy: reasons, workPosition: state.workPosition, motionState: state.motionState, busy: state.busy, probeSignalTested: state.probeSignalTested, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });
    }
    $('stopPerimeterScan').disabled = !state.workflowRunning && !state.scanRunning;
}

async function checkConnection() {
    const wasConnected = state.connected;
    try {
        const context = await machine.getContext();
        state.connected = Boolean(context?.connected);
        logHomingDiagnosticThrottled('connection-context', 'gSender connection context', {
            connected: context?.connected,
            contextKeys: context && typeof context === 'object' ? Object.keys(context) : []
        }, String(context?.connected));
    } catch {
        state.connected = false;
        logHomingDiagnosticThrottled('connection-context-error', 'Could not read gSender connection context', {}, String(state.connected));
    }
    if (wasConnected !== state.connected) {
        logHomingDiagnostic('Plugin connection state changed', { wasConnected, connected: state.connected });
    }
    if (!state.connected) {
        controllerMaxProbeLengthMm = null;
        bedMaxProbeLengthMm = null;
        probeLengthLimitsLoaded = false;
        probeLengthLimitRetryAt = 0;
        probeLengthLimitMessage = 'Connect to the controller to calculate this machine’s maximum L.';
        updateProbeLengthLimitNote();
        $('usableLength').removeAttribute('max');
        state.controllerHomed = false;
        state.homingStateInitialized = false;
        state.homingEventReceived = false;
        state.homedPositionCaptured = false;
        state.motionState = 'Disconnected';
        state.machinePosition = null;
        state.workPosition = null;
        state.rectangleOriginMachine = null;
        state.wposZeroMachine = null;
        state.originSafeRetract = false;
        state.originMessage = null;
        state.probePinKnown = false;
        state.probePinActive = false;
        state.probePinReportingSeen = false;
        state.lastProbeStatusLine = null;
        state.lastProbeStatusHadPinField = false;
        state.probeSignalTested = false;
    }
    if (state.connected) {
        try {
            const redux = await getReduxState();
            const reduxHomed = redux?.controller?.hasHomed;
            const status = redux?.controller?.state?.status;
            const reduxSummary = {
                connectionIsConnected: redux?.connection?.isConnected,
                hasHomed: reduxHomed,
                hasHomedType: typeof reduxHomed,
                controllerKeys: redux?.controller && typeof redux.controller === 'object' ? Object.keys(redux.controller) : [],
                activeState: status?.activeState,
                mpos: positionVector(status?.mpos),
                wpos: positionVector(status?.wpos)
            };
            logHomingDiagnosticThrottled('redux-homing-snapshot', 'gSender Redux homing snapshot', reduxSummary,
                JSON.stringify([reduxSummary.connectionIsConnected, reduxSummary.hasHomedType, reduxSummary.hasHomed, reduxSummary.activeState]));
            // The plugin page can stay alive while the user homes from another
            // gSender screen. Re-read Redux on every connection refresh so a
            // missed homing event cannot leave this panel stuck at "not homed".
            if (typeof reduxHomed === 'boolean') {
                if (!state.homingStateInitialized || reduxHomed !== state.controllerHomed
                    || (reduxHomed && !state.homedPositionCaptured)) {
                    await adoptControllerHoming(reduxHomed);
                } else {
                    state.homingStateInitialized = true;
                }
            }
            if (status) {
                state.motionState = status.activeState ?? state.motionState;
                state.machinePosition = positionVector(status.mpos) ?? state.machinePosition;
                state.workPosition = positionVector(status.wpos) ?? state.workPosition;
            }
            void refreshProbeLengthLimitFromController();
        } catch (error) {
            logHomingDiagnosticThrottled('redux-read-error', 'Could not read gSender Redux state', { message: error.message }, error.message);
        }
    }
    $('connectionBadge').textContent = state.connected ? 'Connected' : 'Not connected';
    $('connectionBadge').dataset.state = state.connected ? 'connected' : 'disconnected';
    updateLiveStatus();
    update();
}

async function saveSetup() {
    update();
    if (!state.latest?.setupReady) return;
    const record = { ...readSettings(), calculated: state.latest, savedAt: new Date().toISOString() };
    try {
        await storage.set(STORAGE_KEY, record);
        $('saveStatus').textContent = 'Setup saved in gSender plugin storage.';
        $('saveStatus').dataset.state = 'ready';
    } catch (error) {
        $('saveStatus').textContent = `Could not save setup: ${error.message}`;
        $('saveStatus').dataset.state = 'error';
    }
}

async function initialize() {
    try {
        const savedLoggingEnabled = await storage.get(HOMING_LOG_ENABLED_KEY, true);
        diagnosticLoggingEnabled = savedLoggingEnabled !== false;
        $('diagnosticLoggingEnabled').checked = diagnosticLoggingEnabled;
        $('diagnosticLoggingStatus').textContent = diagnosticLoggingEnabled
            ? 'Logging is on.'
            : 'Logging is off; no new diagnostics are being collected.';
        const savedDiagnostics = await storage.get(HOMING_LOG_KEY, []);
        homingDiagnostics = Array.isArray(savedDiagnostics)
            ? savedDiagnostics.filter(keepMotionOrControllerDiagnosticLine).slice(-MAX_HOMING_DIAGNOSTICS)
            : [];
    } catch (error) {
        homingDiagnostics = [];
        console.warn('Could not load persisted homing diagnostics', error);
    }
    diagnosticLogReady = true;
    renderHomingDiagnostics();
    logHomingDiagnostic('Plugin diagnostics initialized', { version: '0.1.6', pageVisibility: document.visibilityState });
    for (const id of inputIds.filter(id => id !== 'usableLength')) $(id).addEventListener('input', () => { $('saveStatus').textContent = ''; update(); persistSettingsSoon(); });
    $('usableLength').addEventListener('input', () => {
        const limit = maximumProbeLengthMm();
        const clamped = Number.isFinite(limit) && enforceProbeLengthLimit(limit, 'available machine Z travel');
        if (!Number.isFinite(limit)) {
            probeLengthLimitMessage = state.connected
                ? 'Waiting for an Idle controller report to calculate this machine’s maximum L.'
                : 'Connect to the controller to calculate this machine’s maximum L.';
            updateProbeLengthLimitNote();
        } else if (!clamped && Number($('usableLength').value) <= Math.floor((limit - 1e-8) * 10) / 10) {
            probeLengthLimitMessage = '';
            updateProbeLengthLimitNote();
        }
        $('saveStatus').textContent = '';
        update();
        persistSettingsSoon();
    });
    $('jogStep').addEventListener('change', persistSettingsSoon);
    document.querySelectorAll('input[name="probeMode"]').forEach((radio) => radio.addEventListener('change', () => { update(); persistSettingsSoon(); }));
    $('skipProbeSignalTest').addEventListener('change', () => { update(); persistSettingsSoon(); });
    $('diagnosticLoggingEnabled').addEventListener('change', async () => {
        diagnosticLoggingEnabled = $('diagnosticLoggingEnabled').checked;
        if (!diagnosticLoggingEnabled) {
            window.clearTimeout(diagnosticPersistTimer);
            diagnosticPersistTimer = 0;
            $('diagnosticLoggingStatus').textContent = 'Logging is off; no new diagnostics are being collected or stored.';
        } else {
            $('diagnosticLoggingStatus').textContent = 'Logging is on.';
            renderHomingDiagnostics();
            logHomingDiagnostic('Diagnostic logging enabled by user');
        }
        try {
            await storage.set(HOMING_LOG_ENABLED_KEY, diagnosticLoggingEnabled);
        } catch (error) {
            $('diagnosticLoggingStatus').textContent = `Could not save logging preference: ${error.message}`;
        }
    });
    $('partShape').addEventListener('change', () => { update(); persistSettingsSoon(); });
    document.querySelectorAll('input[name="scanMode"]').forEach((radio) => radio.addEventListener('change', () => {
        const mode=document.querySelector('input[name="scanMode"]:checked')?.value??'both';
        $('resultRepresentation').value=mode;
        update();persistSettingsSoon();
    }));
    $('resultRepresentation').addEventListener('change', () => { renderPerimeterResult(); persistSettingsSoon(); });
    document.querySelectorAll('input[name="rectangleCorner"]').forEach((radio) => radio.addEventListener('change', persistSettingsSoon));
    $('probeOriginButton').addEventListener('click', () => { void startSimplifiedWorkflow(); });
    $('cancelProbeTest').addEventListener('click', cancelProbeSignalCheck);
    // Continue/cancel handlers are bound for each dialog run, matching the working
    // Surface Height Map probe dialog lifecycle.
    $('homeButton').addEventListener('click', homeMachine);
    $('copyHomingLog').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(homingDiagnostics.join('\n'));
            $('copyHomingLog').textContent = 'Copied';
            window.setTimeout(() => { $('copyHomingLog').textContent = 'Copy log'; }, 1500);
        } catch {
            $('homingDiagnosticLog').focus();
            $('homingDiagnosticLog').select();
        }
    });
    $('downloadHomingLog').addEventListener('click', () => {
        const blob = new Blob([homingDiagnostics.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `surface-perimeter-homing-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        anchor.click();
        URL.revokeObjectURL(url);
    });
    $('clearHomingLog').addEventListener('click', () => {
        homingDiagnostics = [];
        renderHomingDiagnostics();
        window.clearTimeout(diagnosticPersistTimer);
        void storage.set(HOMING_LOG_KEY, []).catch(error => {
            $('diagnosticLoggingStatus').textContent = `Could not clear saved log: ${error.message}`;
        });
    });
    $('coordinateMode').addEventListener('click', () => {
        state.positionMode = state.positionMode === 'mpos' ? 'wpos' : 'mpos';
        updateLiveStatus();
        persistSettingsSoon();
    });
    $('gotoXY').addEventListener('click', () => { void openGotoXYDialog(); });
    $('cancelGotoXY').addEventListener('click', () => $('gotoXYDialog').close());
    $('confirmGotoXY').addEventListener('click', () => { void executeGotoXY().catch((error) => setOriginMessage(`GOTO XY failed: ${error.message}`)); });
    $('gotoX').addEventListener('input', updateGotoXYValidation);
    $('gotoY').addEventListener('input', updateGotoXYValidation);
    $('gotoXYDialog').addEventListener('cancel', () => { state.gotoXYContext = null; });
    $('gotoOrigin').addEventListener('click', goToRectangleOrigin);
    const jogBindings = [
        ['jogXMinus', 'X', -1], ['jogXPlus', 'X', 1], ['jogYMinus', 'Y', -1],
        ['jogYPlus', 'Y', 1], ['jogZMinus', 'Z', -1], ['jogZPlus', 'Z', 1]
    ];
    for (const [id, axis, sign] of jogBindings) {
        const button = $(id);
        button.addEventListener('click', (event) => {
            if ($('jogStep').value === 'continuous') { event.preventDefault(); return; }
            void jog(axis, sign);
        });
        button.addEventListener('pointerdown', (event) => {
            if ($('jogStep').value !== 'continuous' || event.button !== 0) return;
            event.preventDefault();
            try { button.setPointerCapture(event.pointerId); } catch { /* global release listener is a fallback */ }
            void startContinuousJog(axis, sign, event);
        });
        button.addEventListener('keydown', (event) => {
            if ($('jogStep').value !== 'continuous' || !['Enter', ' '].includes(event.key) || event.repeat) return;
            event.preventDefault();
            void startContinuousJog(axis, sign, event);
        });
        button.addEventListener('keyup', requestContinuousJogStop);
    }
    window.addEventListener('pointerup', requestContinuousJogStop, true);
    window.addEventListener('pointercancel', requestContinuousJogStop, true);
    window.addEventListener('blur', () => requestContinuousJogStop());
    document.addEventListener('visibilitychange', () => { if (document.hidden) requestContinuousJogStop(); });
    $('saveSetup').addEventListener('click', saveSetup);
    $('startPerimeterScan').addEventListener('click', () => { void startPerimeterScan().catch((error) => { logHomingDiagnostic('Perimeter scan start failed', { message: error.message, stack: error.stack, blockedBy: scanReadiness() }); $('scanStatus').textContent = `Scan did not start: ${error.message}`; }); });
    $('downloadPolygonSurfaceCsv').addEventListener('click', downloadPolygonSurfaceCsv);
    $('loadPolygonScan').addEventListener('change', async event=>{try{const file=event.target.files?.[0];if(file)loadPolygonResult(JSON.parse(await file.text()));}catch(error){$('scanStatus').textContent=`Could not load polygon scan: ${error.message}`;}finally{event.target.value='';}});
    $('stopPerimeterScan').addEventListener('click', () => { state.stopScan = true; $('scanStatus').textContent = 'Stop requested; the current move will finish. Inspect the probe position.'; });
    $('downloadPerimeterCsv').addEventListener('click', downloadPerimeterCsv);
    $('surfaceExaggeration').addEventListener('input', drawSurfaceMesh);
    $('copySurfaceStl').addEventListener('click', () => { void copySurfaceStl(); });
    $('downloadSurfaceStl').addEventListener('click',()=>{try{const url=URL.createObjectURL(new Blob([surfaceMeshToStl()],{type:'model/stl'}));const link=document.createElement('a');link.href=url;link.download='measured-surface.stl';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){$('surfaceStlStatus').textContent=error.message;}});
    window.addEventListener('resize', drawSurfaceMesh);
    try {
        const saved = await storage.get(STORAGE_KEY, null);
        if (saved) writeSettings(saved);
        const savedScan = await storage.get(INCOMPLETE_SCAN_KEY, null);
        if (restoreIncompleteScan(savedScan)) {
            $('scanStatus').textContent = `An incomplete scan was saved ${new Date(savedScan.savedAt).toLocaleString()}. Start Probe to continue it or start a new scan.`;
            renderPerimeterResult();
        }
        if (!Number.isFinite(maximumProbeLengthMm())) {
            probeLengthLimitMessage = 'Connect to the controller to calculate this machine’s maximum L.';
            updateProbeLengthLimitNote();
        }
    } catch (error) {
        console.warn('Could not load saved perimeter setup', error);
    }
    machine.onParsed('perimeter-probe-status', receiveProbeStatus);
    machine.onParsed('perimeter-probe-contact', receiveProbeContact);
    machine.addListener('controller:state', (_type, controllerState) => {
        const status = controllerState?.status;
        const stateKey = status?.activeState ?? 'Unknown';
        if (stateKey !== lastControllerStateKey) {
            lastControllerStateKey = stateKey;
            logHomingDiagnostic('Controller state transition', {
                activeState: status?.activeState,
                controllerEventKeys: controllerState && typeof controllerState === 'object' ? Object.keys(controllerState) : [],
                statusKeys: status && typeof status === 'object' ? Object.keys(status) : [],
                mpos: positionVector(status?.mpos),
                wpos: positionVector(status?.wpos),
                controllerHomed: state.controllerHomed
            });
        }
        if (status) {
            state.lastControllerStatusAt = Date.now();
            state.statusQueryAttempts = 0;
            state.statusOutageStartedAt = 0;
            state.lastStatusQueryError = null;
            state.motionState = status.activeState ?? state.motionState;
            state.machinePosition = positionVector(status.mpos) ?? state.machinePosition;
            state.workPosition = positionVector(status.wpos) ?? state.workPosition;
        }
        updateLiveStatus();
        update();
        if (state.controllerHomed && !state.homedPositionCaptured && controllerState?.status?.activeState === 'Idle') {
            void adoptControllerHoming(true);
        }
    });
    machine.addListener('homing:has-homed', (hasHomed) => {
        state.homingEventReceived = true;
        logHomingDiagnostic('gSender homing event received', { hasHomed, type: typeof hasHomed });
        void adoptControllerHoming(hasHomed);
    });
    await checkConnection();
    window.setInterval(checkConnection, 2000);
    update();
}

initialize();
