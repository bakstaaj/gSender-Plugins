import { getReduxState, machine, storage } from '@sienci/gsender-plugin-sdk';
import './style.css';

const $ = (id) => document.getElementById(id);
const inputIds = ['tipDiameter', 'usableLength', 'verticalClearance', 'approachClearance', 'minThickness', 'maxThickness', 'partRadius', 'partWidth', 'partHeight', 'polygonSides', 'rectangleWidth', 'rectangleHeight', 'sampleSpacing'];
const state = { connected: false, controllerHomed: false, homingStateInitialized: false, homingEventReceived: false, homedPositionCaptured: false, homingError: null, motionState: 'Unknown', machinePosition: null, workPosition: null, positionMode: 'wpos', busy: false, continuousJog: null, rectangleOriginMachine: null, wposZeroMachine: null, bedWposZ: null, originSafeRetract: false, originMessage: null, probePinKnown: false, probePinActive: false, probePinReportingSeen: false, lastProbeStatusLine: null, lastProbeStatusHadPinField: false, probeStatusSequence: 0, probeSignalTested: false, probeTestRunning: false, cancelProbeTest: false, finishProbeTest: null, scanRunning: false, stopScan: false, perimeterPoints: [], surfaceRings: [], surfaceCenter: null, surfaceComplete: false, latest: null };
const STORAGE_KEY = 'surface-perimeter-mapper.setup.v2';
const LEGACY_STORAGE_KEY = 'surface-perimeter-mapper.setup.v1';
const HOMING_LOG_KEY = 'surface-perimeter-mapper.homing-diagnostics.v1';
const FEATURE_WIDTH_MULTIPLIER = 4;
const ORIGIN_FAST_FEED = 100;
const ORIGIN_SLOW_FEED = 20;
const PERIMETER_RELEASE_DIAMETER_FACTOR = 0.75;
const Z_LIMIT_MARGIN = 0.5;
const MAX_SURFACE_SAMPLES = 12000;
let persistenceTimer = 0;
let diagnosticPersistTimer = 0;
let homingDiagnostics = [];
let diagnosticLogReady = false;
let lastDiagnosticThrottle = new Map();
let lastHomeDecisionKey = '';
let lastControllerStateKey = '';
let lastProbeContinueSnapshot = '';
let lastScanReadinessKey = '';
const number = (id) => Number($(id).value);
const positive = (value) => Number.isFinite(value) && value > 0;
const fmt = (value) => Number.isFinite(value) ? `${value.toFixed(1)} mm` : '—';
const fullClearanceHeight = (cfg) => cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR + cfg.maxThickness - cfg.minThickness;
const positionVector = (value) => Array.isArray(value) ? value.slice(0, 3).map(Number)
    : value && typeof value === 'object' ? [Number(value.x), Number(value.y), Number(value.z)] : null;

function readSettings() {
    return {
        ...Object.fromEntries(inputIds.map((id) => [id, $(id).value])),
        jogStep: $('jogStep').value,
        partShape: $('partShape').value,
        probeMode: document.querySelector('input[name="probeMode"]:checked')?.value ?? 'precise',
        rectangleCorner: document.querySelector('input[name="rectangleCorner"]:checked')?.value ?? 'center',
        positionMode: state.positionMode
    };
}

function writeSettings(settings = {}) {
    if (settings.partRadius === undefined && settings.partShape === 'circle' && positive(Number(settings.partWidth))) {
        settings = { ...settings, partRadius: Number(settings.partWidth) / 2 };
    }
    for (const id of inputIds) {
        if (settings[id] !== undefined) $(id).value = settings[id];
    }
    if (settings.jogStep !== undefined) $('jogStep').value = settings.jogStep;
    if (settings.partShape) $('partShape').value = settings.partShape;
    if (settings.probeMode === 'fast' || settings.probeMode === 'precise') {
        const mode = document.querySelector(`input[name="probeMode"][value="${settings.probeMode}"]`);
        if (mode) mode.checked = true;
    }
    if (settings.rectangleCorner) {
        const corner = document.querySelector(`input[name="rectangleCorner"][value="${settings.rectangleCorner}"]`);
        if (corner) corner.checked = true;
    }
    if (settings.positionMode === 'mpos' || settings.positionMode === 'wpos') state.positionMode = settings.positionMode;
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
    if (!output) return;
    output.value = homingDiagnostics.join('\n');
    output.scrollTop = output.scrollHeight;
}

function logHomingDiagnostic(event, details = {}) {
    let serialized;
    try { serialized = JSON.stringify(details); } catch { serialized = String(details); }
    const line = `${new Date().toISOString()} ${event}${serialized && serialized !== '{}' ? ` ${serialized}` : ''}`;
    homingDiagnostics.push(line);
    if (homingDiagnostics.length > 500) homingDiagnostics = homingDiagnostics.slice(-500);
    renderHomingDiagnostics();
    if (!diagnosticLogReady) return;
    window.clearTimeout(diagnosticPersistTimer);
    diagnosticPersistTimer = window.setTimeout(async () => {
        try { await storage.set(HOMING_LOG_KEY, homingDiagnostics); }
        catch (error) { console.warn('Could not persist homing diagnostics', error); }
    }, 250);
}

function logHomingDiagnosticThrottled(key, event, details, signature, intervalMs = 15000) {
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
    $('probeOriginButton').disabled = state.probeTestRunning || !state.connected || !state.controllerHomed || state.motionState !== 'Idle' || state.busy;
    refreshScanButton();
    $('stopPerimeterScan').disabled = !state.scanRunning;
    const probeDialog = $('probeTestDialog');
    const probeContinueReady = probeDialog.open && probeDialog.dataset.probeActivated === 'true';
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
    const safeWposZ = fullClearanceHeight(state.latest ?? { diameter: Number($('tipDiameter').value), maxThickness: Number($('maxThickness').value), minThickness: Number($('minThickness').value) });
    $('gotoOrigin').disabled = !state.rectangleOriginMachine || !state.controllerHomed || state.motionState !== 'Idle'
        || state.busy || state.probeTestRunning || !Number.isFinite(state.workPosition?.[2]) || state.workPosition[2] < safeWposZ;
    $('originCaptureStatus').textContent = state.originMessage ?? (state.rectangleOriginMachine
        ? `Part-center top origin set. Machine position X${state.rectangleOriginMachine[0].toFixed(3)} Y${state.rectangleOriginMachine[1].toFixed(3)} Z${state.rectangleOriginMachine[2].toFixed(3)}.`
        : 'Ready when homed and positioned above the approximate center of the part.');
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
    const match = String(report?.line ?? '').trim().match(/^<([^>]*)>$/);
    if (!match) return;
    const fields = match[1].split('|');
    state.motionState = fields[0] ?? state.motionState;
    for (const field of fields) {
        if (field.startsWith('MPos:')) state.machinePosition = parsePosition(field.slice(5));
        if (field.startsWith('WPos:')) state.workPosition = parsePosition(field.slice(5));
    }
    const previousProbeState = { known: state.probePinKnown, active: state.probePinActive };
    const pins = fields.find((field) => field.startsWith('Pn:'));
    if (pins) state.probePinReportingSeen = true;
    // Grbl omits Pn entirely when no input pins are active. Once Pn reporting
    // has been confirmed, that omission is a clear probe signal, not an
    // unavailable/unknown state. Before the first Pn field, keep it unknown.
    state.probePinKnown = Boolean(pins) || state.probePinReportingSeen;
    state.probePinActive = Boolean(pins && pins.slice(3).includes('P'));
    state.lastProbeStatusLine = String(report?.line ?? '');
    state.lastProbeStatusHadPinField = Boolean(pins);
    state.probeStatusSequence += 1;
    if ($('probeTestDialog').open && (previousProbeState.known !== state.probePinKnown || previousProbeState.active !== state.probePinActive)) {
        logHomingDiagnostic('Probe status signal transition received', {
            sequence: state.probeStatusSequence,
            report: String(report?.line ?? ''),
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
        const result = await machine.query(command, { until: 'ok-or-error', timeout: timeoutMs, maxLines: 80 });
        if (!result.complete || !result.ok || result.error) throw new Error(`Controller did not accept ${command}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
        await waitForIdle(timeoutMs);
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* the controller may have disconnected */ }
        await checkConnection();
    }
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
    const result = await machine.query('$$', { until: 'ok-or-error', timeout: 10000, maxLines: 160 });
    if (!result.complete || !result.ok || result.error) throw new Error(`Could not read controller travel settings: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const settings = new Map();
    for (const line of result.lines ?? []) {
        const match = String(line).match(/^\$(\d+)=([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
        if (match) settings.set(Number(match[1]), Number(match[2]));
    }
    const homingMask = settings.get(23);
    const travels = [settings.get(130), settings.get(131), settings.get(132)];
    if (!Number.isFinite(homingMask) || travels.some((travel) => !Number.isFinite(travel) || travel <= 0)) {
        throw new Error('Controller must report valid $23 homing direction and $130/$131/$132 travel before probing.');
    }
    // Match the tested Surface Height Map interpretation of GRBL $23: set
    // bits indicate positive machine-coordinate travel toward the home end.
    const axis = (bit, travel) => {
        const direction = (Math.trunc(homingMask) & bit) ? 1 : -1;
        return { homePositive: direction > 0, min: direction < 0 ? -travel : 0, max: direction < 0 ? 0 : travel };
    };
    const x = axis(1, travels[0]);
    const y = axis(2, travels[1]);
    const zHomePositive = (Math.trunc(homingMask) & 4) === 0;
    const z = { homePositive: zHomePositive, min: zHomePositive ? -travels[2] : 0, max: zHomePositive ? 0 : travels[2] };
    return { x, y, z, zHomePositive: z.homePositive, minZ: z.min, maxZ: z.max };
}

async function sendJogCommand(line, timeout = 30000) {
    logHomingDiagnostic('Jog command TX', { line });
    const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 60 });
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

function probeContact(result, label) {
    const report = (result.lines ?? []).map(String).find((line) => line.startsWith('[PRB:'));
    const match = report?.match(/^\[PRB:([^\]]+)\]$/);
    const values = match?.[1].split(',').map(Number);
    if (!values || values.length < 4 || !values.slice(0, 3).every(Number.isFinite) || !match[1].endsWith(':1')) {
        throw new Error(`${label} did not produce a confirmed probe contact. Controller response: ${result.lines?.join(' ') ?? result.reason ?? 'no PRB report'}`);
    }
    return { report, mpos: values.slice(0, 3) };
}

async function probeWposOrigin() {
    if (state.busy || !state.connected || !state.controllerHomed) return;
    state.rectangleOriginMachine = null;
    state.wposZeroMachine = null;
    state.bedWposZ = null;
    state.originSafeRetract = false;
    state.originMessage = null;
    state.probeSignalTested = false;
    let busyAnnounced = false;
    update();
    try {
        setOriginMessage('Complete the probe signal test. The Z touch-off will start when you press Continue.');
        const accepted = await runProbeSignalCheck();
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
        const requiredProbeTravel = probeMode === 'precise' ? releaseDistance + 0.5 : 0.5;
        if (maxProbeTravel <= requiredProbeTravel) {
            throw new Error(`Not enough Z travel remains in the probing direction from machine Z${initial.mpos[2].toFixed(3)}. Available probe travel after safety margin: ${Math.max(0, maxProbeTravel).toFixed(3)} mm; the ${probeMode} origin probe needs at least ${requiredProbeTravel.toFixed(2)} mm.`);
        }
        const safeWposZ = tipDiameter * PERIMETER_RELEASE_DIAMETER_FACTOR + maxThickness - number('minThickness');
        state.busy = true;
        await machine.setBusy(true, 'Probe WPOS origin');
        busyAnnounced = true;
        setOriginMessage(`Fast Z probe in progress (maximum ${maxProbeTravel.toFixed(1)} mm from current position)…`);
        updateLiveStatus();
        const fastTimeout = Math.max(120000, Math.ceil((maxProbeTravel / ORIGIN_FAST_FEED) * 60000 + 30000));
        const fastResult = await machine.query(`G21 G91 G38.2 Z${(probeDirection * maxProbeTravel).toFixed(3)} F${ORIGIN_FAST_FEED}`, { until: 'ok-or-error', timeout: fastTimeout, maxLines: 80 });
        if (!fastResult.complete || !fastResult.ok || fastResult.error) throw new Error(`Origin fast probe was not accepted: ${fastResult.error ?? fastResult.lines?.join(' ') ?? fastResult.reason}`);
        const fastContact = probeContact(fastResult, 'Origin fast probe');
        let originContact = fastContact;
        if (probeMode === 'precise') {
            setOriginMessage(`First touch detected at machine Z${fastContact.mpos[2].toFixed(3)}. Releasing ${releaseDistance.toFixed(2)} mm for the precise touch…`);
            const releaseZ = fastContact.mpos[2] + zHomeDirection * releaseDistance;
            if (releaseZ < limits.minZ || releaseZ > limits.maxZ) throw new Error(`The ${releaseDistance.toFixed(2)} mm probe release move would exceed machine Z travel.`);
            const releaseResult = await machine.query(`G90 G53 G0 Z${releaseZ.toFixed(3)}`, { until: 'ok-or-error', timeout: 30000, maxLines: 60 });
            if (!releaseResult.complete || !releaseResult.ok || releaseResult.error) throw new Error(`Could not release the probe after its first touch: ${releaseResult.error ?? releaseResult.lines?.join(' ') ?? releaseResult.reason}`);
            const releaseSnapshot = await waitForIdle();
            if (Math.abs(releaseSnapshot.mpos[2] - releaseZ) > 0.1) throw new Error('Controller did not reach the expected probe-release height.');
            const slowResult = await machine.query(`G21 G91 G38.2 Z${(probeDirection * (releaseDistance + 0.5)).toFixed(3)} F${ORIGIN_SLOW_FEED}`, { until: 'ok-or-error', timeout: 30000, maxLines: 80 });
            if (!slowResult.complete || !slowResult.ok || slowResult.error) throw new Error(`Origin precise probe was not accepted: ${slowResult.error ?? slowResult.lines?.join(' ') ?? slowResult.reason}`);
            originContact = probeContact(slowResult, 'Origin precise probe');
        } else {
            setOriginMessage(`Fast mode: origin touch confirmed at machine Z${fastContact.mpos[2].toFixed(3)}; continuing without a second touch.`);
        }
        await machine.query('G90', { until: 'ok-or-error', timeout: 5000, maxLines: 20 });
        const stopped = await waitForIdle();
        if (stopped.mpos.slice(0, 2).some((value, index) => Math.abs(value - originContact.mpos[index]) > 0.1)) {
            throw new Error('Could not confirm the stopped machine position after the origin touch-off.');
        }
        const availableRetract = (zHomeDirection > 0 ? limits.maxZ - stopped.mpos[2] : stopped.mpos[2] - limits.minZ) - Z_LIMIT_MARGIN;
        if (availableRetract < 1) throw new Error('Less than 1 mm of machine Z travel remains toward the Z home end after probing; cannot safely retract. Resolve the position manually.');
        const actualRetract = Math.min(safeWposZ, availableRetract);
        const retractTargetZ = stopped.mpos[2] + zHomeDirection * actualRetract;
        setOriginMessage('Setting G54 WPOS X0 Y0 Z0 at the probed part-top center…');
        const zeroResult = await machine.query('G21 G90 G10 L20 P1 X0 Y0 Z0', { until: 'ok-or-error', timeout: 10000, maxLines: 40 });
        if (!zeroResult.complete || !zeroResult.ok || zeroResult.error) throw new Error(`Probe contact succeeded, but G54 zero was not accepted: ${zeroResult.error ?? zeroResult.lines?.join(' ') ?? zeroResult.reason}`);
        const retractResult = await machine.query(`G90 G53 G0 Z${retractTargetZ.toFixed(3)}`, { until: 'ok-or-error', timeout: 30000, maxLines: 60 });
        if (!retractResult.complete || !retractResult.ok || retractResult.error) throw new Error(`G54 was set, but the safe Z retract failed: ${retractResult.error ?? retractResult.lines?.join(' ') ?? retractResult.reason}`);
        const final = await waitForIdle();
        if (Math.abs(final.mpos[2] - retractTargetZ) > 0.1 || !final.wpos?.every(Number.isFinite)
            || Math.abs(final.wpos[0]) > 0.1 || Math.abs(final.wpos[1]) > 0.1 || Math.abs(final.wpos[2] - actualRetract) > 0.15) {
            throw new Error(`Controller did not confirm G54 origin and retract. Expected WPOS X0 Y0 Z${actualRetract.toFixed(3)}, reported ${final.wpos?.map((value) => value.toFixed(3)).join(', ') ?? 'unavailable'}.`);
        }
        state.machinePosition = final.mpos;
        state.workPosition = final.wpos;
        state.rectangleOriginMachine = final.mpos.slice(0, 3);
        state.wposZeroMachine = originContact.mpos.slice(0, 3);
        state.originSafeRetract = actualRetract + 0.1 >= safeWposZ;
        setOriginMessage(state.originSafeRetract
            ? `Part-top center probed and G54 X0 Y0 Z0 verified. Retracted to WPOS Z${actualRetract.toFixed(2)} mm.`
            : `G54 X0 Y0 Z0 was set, but Z travel only allowed a ${actualRetract.toFixed(2)} mm retract; ${safeWposZ.toFixed(2)} mm is needed to clear the part. The tool was raised as far as the travel margin allows. Reduce part thickness/clearance or increase available Z travel, then probe origin again.`);
    } catch (error) {
        setOriginMessage(error.message);
    } finally {
        state.busy = false;
        if (busyAnnounced) try { await machine.setBusy(false); } catch { /* controller may have disconnected */ }
        await checkConnection();
    }
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

async function refreshScanStatus(timeoutMs = 1000) {
    const sequence = state.probeStatusSequence;
    await machine.command('?');
    if (!await waitForProbeStatus(sequence, timeoutMs)) throw new Error('No fresh controller status report arrived during the perimeter scan.');
    if (state.motionState === 'Alarm') throw new Error('Controller entered Alarm during the perimeter scan. Resolve the alarm in gSender; the scan stopped.');
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

async function scanMove(target, limits, label, allowProbeActive = false) {
    if (state.stopScan) throw new Error('Scan stopped by user.');
    if (!state.probePinKnown || (state.probePinActive && !allowProbeActive)) throw new Error('Probe input is not confirmed clear before a non-probing move.');
    checkScanTravel(target, limits);
    $('scanStatus').textContent = label;
    const command = `G21 G90 G54 G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)}`;
    const result = await machine.query(command, { until: 'ok-or-error', timeout: 60000, maxLines: 80 });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const snapshot = await waitForScanPosition(target);
    if (state.probePinActive && !allowProbeActive) throw new Error(`Probe triggered during ${label}. Machine stopped during the current move; inspect the probe and part before continuing.`);
    return snapshot;
}

function parseOptionalProbe(result) {
    const line = (result.lines ?? []).map(String).find((value) => value.startsWith('[PRB:'));
    if (!line) return null;
    const match = line.match(/^\[PRB:([^\]]+)\]$/);
    const fields = match?.[1].split(',');
    const mpos = fields?.slice(0, 3).map(Number);
    if (!mpos || mpos.length !== 3 || !mpos.every(Number.isFinite)) throw new Error(`Invalid probe report: ${line}`);
    return { mpos, triggered: fields[fields.length - 1].endsWith(':1'), line };
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
    const result = await machine.query(command, { until: 'ok-or-error', timeout, maxLines: 80 });
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

async function waitForProbeClearAfterRetract(limits, target, label) {
    let machineTarget;
    try {
        machineTarget = checkScanTravel(target, limits);
    } catch (error) {
        logHomingDiagnostic('Perimeter probe release target rejected by travel check', { label, targetWpos: target, probePinActive: state.probePinActive, message: error.message });
        throw error;
    }
    const command = `G21 G90 G54 G0 X${target[0].toFixed(3)} Y${target[1].toFixed(3)} Z${target[2].toFixed(3)}`;
    $('scanStatus').textContent = `${label}: moving outward until the probe input clears…`;
    logHomingDiagnostic('Perimeter probe release TX', { label, targetWpos: target, targetMpos: machineTarget, probePinActive: state.probePinActive, command });
    const result = await machine.query(command, { until: 'ok-or-error', timeout: 60000, maxLines: 80 });
    logHomingDiagnostic('Perimeter probe release RX', { label, complete: result.complete, ok: result.ok, error: result.error, reason: result.reason, lines: result.lines });
    if (!result.complete || !result.ok || result.error) throw new Error(`${label}: ${result.error ?? result.lines?.join(' ') ?? result.reason}`);
    const snapshot = await waitForScanPosition(target);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        // After the controller has reported Pn once, Grbl omits Pn when no
        // pins are active. The status parser therefore treats no Pn:P as the
        // cleared state needed before continuing around the perimeter.
        if (state.probePinReportingSeen && state.probePinKnown && !state.probePinActive) {
            logHomingDiagnostic('Perimeter probe release confirmed', {
                label,
                targetWpos: target,
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

function renderPerimeterResult() {
    const result = $('perimeterResult');
    if (!state.perimeterPoints.length && !state.surfaceRings.length) {
        result.hidden = true;
        $('downloadPerimeterCsv').disabled = true;
        $('copySurfaceStl').disabled = true;
        return;
    }
    const xs = state.perimeterPoints.map((point) => point.x);
    const ys = state.perimeterPoints.map((point) => point.y);
    result.hidden = false;
    $('perimeterStats').textContent = state.perimeterPoints.length
        ? `${state.perimeterPoints.length} perimeter points · ${state.surfaceRings.reduce((sum, ring) => sum + ring.points.filter(Boolean).length, 0) + (state.surfaceCenter ? 1 : 0)} interior height points · X ${Math.min(...xs).toFixed(3)}…${Math.max(...xs).toFixed(3)} mm · Y ${Math.min(...ys).toFixed(3)}…${Math.max(...ys).toFixed(3)} mm.`
        : 'Preparing surface scan…';
    $('downloadPerimeterCsv').disabled = !state.perimeterPoints.length;
    $('copySurfaceStl').disabled = !state.surfaceComplete;
    if (state.surfaceComplete) {
        try { $('surfaceStl').value = surfaceMeshToStl(); }
        catch (error) { $('surfaceStlStatus').textContent = error.message; }
    }
    drawSurfaceMesh();
}

function drawSurfaceMesh() {
    const canvas = $('surfaceCanvas');
    const completedRings = state.surfaceRings.filter((ring) => ring.points.length && ring.points.every(Boolean));
    const allPoints = completedRings.flatMap((ring) => ring.points).concat(state.surfaceCenter ? [state.surfaceCenter] : []);
    if (!canvas || allPoints.length < 3) return;
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
    $('surfaceStats').textContent = `Lowest ${minZ.toFixed(3)} mm · highest ${maxZ.toFixed(3)} mm · range ${range.toFixed(3)} mm · ${allPoints.length} measured points`;
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
    const projected = completedRings.map((ring) => ring.points.map(project));
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
    for (let r = 0; r < projected.length - 1; r += 1) {
        for (let i = 0; i < projected[r].length; i += 1) {
            const next = (i + 1) % projected[r].length;
            drawTriangle(projected[r][i], projected[r][next], projected[r + 1][next]);
            drawTriangle(projected[r][i], projected[r + 1][next], projected[r + 1][i]);
        }
    }
    if (center && projected.length) {
        const inner = projected[projected.length - 1];
        for (let i = 0; i < inner.length; i += 1) drawTriangle(inner[i], inner[(i + 1) % inner.length], center);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const ring of projected) for (const point of ring) { ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, Math.PI * 2); ctx.fill(); }
    if (center) { ctx.beginPath(); ctx.arc(center.x, center.y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.textAlign = 'left'; ctx.fillText('X', width * 0.75, height * 0.76);
    ctx.textAlign = 'right'; ctx.fillText('Y', width * 0.25, height * 0.76);
    ctx.textAlign = 'left'; ctx.fillText('WPOS 0,0', width / 2 + 8, frontY + 14);
}

function surfaceMeshToStl() {
    const rings = state.surfaceRings.filter((ring) => ring.points.length && ring.points.every(Boolean));
    if (!state.surfaceComplete || rings.length < 1 || !state.surfaceCenter) throw new Error('The interior surface scan is not complete yet.');
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

async function probeSurfacePoint(x, y, cfg, limits, clearanceZ, bedWposZ, sampleLabel) {
    await scanMove([x, y, clearanceZ], limits, `${sampleLabel}: move XY at full clearance`);
    const endZ = bedWposZ;
    const target = [x, y, endZ];
    checkScanTravel(target, limits);
    const start = await currentSnapshot();
    if (!Number.isFinite(start.wpos?.[2]) || endZ >= start.wpos[2] - 0.05) throw new Error(`${sampleLabel}: calculated Z probe endpoint ${endZ.toFixed(3)} is not below the current clearance position.`);
    if (state.stopScan) throw new Error('Scan stopped by user before the next surface probe.');

    // gSender can acknowledge G38.3 before the controller's next status report
    // changes from Idle to Run. Do not interpret that brief stale Idle/clear
    // state as a missed touch and send a retract that interrupts the probe.
    const probeOnce = async (attempt, probeEndZ = endZ, feed = ORIGIN_FAST_FEED, phase = 'surface') => {
        const attemptStart = await currentSnapshot();
        const probeTarget = [x, y, probeEndZ];
        const command = `G21 G90 G54 G38.3 Z${probeEndZ.toFixed(3)} F${feed}`;
        const distance = Math.max(0, attemptStart.wpos[2] - probeEndZ);
        const timeout = Math.max(30000, Math.ceil((distance / feed) * 60000 + 15000));
        $('scanStatus').textContent = `${sampleLabel}: probing the ${phase}${attempt > 1 ? ` (retry ${attempt - 1}/1)` : ''}…`;
        logHomingDiagnostic('Interior Z probe TX', { sampleLabel, phase, attempt, targetWpos: probeTarget, startWpos: attemptStart.wpos, bedWposZ, probeMode: cfg.probeMode, command, timeout });
        const result = await machine.query(command, { until: 'ok-or-error', timeout, maxLines: 80 });
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

    let probeResult;
    while (!state.stopScan) {
        let retryAtThisPoint = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
                probeResult = await probeOnce(attempt);
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
                const resume = await waitForSurfaceProbeRecovery(sampleLabel, 'The probe move stopped before reaching the bed twice. Check the probe, wiring, and Z path before continuing.');
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
            const resume = await waitForSurfaceProbeRecovery(sampleLabel, `No probe contact was detected at the measured bed height WPOS Z${bedWposZ.toFixed(3)} mm after two attempts. Check the probe and the path to the bed.`);
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
    if (cfg.probeMode === 'precise') {
        if (hitWposZ <= bedWposZ + 0.1) {
            logHomingDiagnostic('Interior slow Z confirm skipped at measured bed', { sampleLabel, hitWposZ, bedWposZ, reason: 'A second downward touch would need to travel below the measured bed.' });
        } else {
            const releaseZ = hitWposZ + cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
            checkScanTravel([x, y, releaseZ], limits);
            await waitForProbeClearAfterRetract(limits, [x, y, releaseZ], `${sampleLabel}: precise-touch release`);
            const slowEndZ = Math.max(bedWposZ, hitWposZ - 0.5);
            checkScanTravel([x, y, slowEndZ], limits);
            const slowResult = await probeOnce(1, slowEndZ, ORIGIN_SLOW_FEED, 'slow confirm');
            if (!slowResult.triggered) throw new Error(`${sampleLabel}: slow confirm probe did not contact the surface before the measured bed.`);
            hit = slowResult.report?.triggered ? slowResult.report.mpos : slowResult.contactMpos ?? slowResult.snapshot.mpos;
            if (!hit?.every(Number.isFinite)) throw new Error(`${sampleLabel}: slow confirm triggered but its contact position was unavailable.`);
            hitWposZ = hit[2] - state.wposZeroMachine[2];
        }
    }
    await waitForProbeClearAfterRetract(limits, [x, y, clearanceZ], `${sampleLabel}: retract to full clearance`);
    const point = { x, y, z: hitWposZ };
    logHomingDiagnostic('Interior surface point captured', { sampleLabel, point, machinePosition: hit, mode: cfg.probeMode });
    return point;
}

async function scanCylinderInterior(cfg, limits, clearanceZ, bedWposZ, sampleCount, firstAngle) {
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const boundaryRadii = state.perimeterPoints.map((point) => point.x * Math.cos(point.angle * Math.PI / 180) + point.y * Math.sin(point.angle * Math.PI / 180));
    const minRadius = Math.min(...boundaryRadii);
    const ringCount = Math.max(0, Math.floor((minRadius - releaseDistance) / cfg.spacing) + 1);
    const estimated = ringCount * sampleCount + 1;
    if (estimated > MAX_SURFACE_SAMPLES) throw new Error(`Interior scan would require about ${estimated.toLocaleString()} Z probes, above the ${MAX_SURFACE_SAMPLES.toLocaleString()}-point safety limit. Increase Perimeter sample spacing.`);
    if (ringCount < 1) throw new Error(`The measured radius does not leave room for an interior scan starting ${releaseDistance.toFixed(2)} mm inside the perimeter. Use a smaller tip or larger part.`);
    const ringPlans = Array.from({ length: ringCount }, (_unused, ringIndex) => {
        const offset = releaseDistance + ringIndex * cfg.spacing;
        const points = Array.from({ length: sampleCount }, (_point, index) => {
            const angle = firstAngle + (2 * Math.PI * index) / sampleCount;
            const radius = boundaryRadii[index] - offset;
            return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
        });
        return { offset, points };
    });
    // Validate every planned XY and the full vertical probing span before
    // starting any interior motion, so a late out-of-travel point cannot
    // leave a partially executed unsafe scan.
    for (const [ringIndex, ring] of ringPlans.entries()) {
        for (const [index, point] of ring.points.entries()) {
            if (Math.hypot(point.x, point.y) <= 0) throw new Error(`Interior ring ${ringIndex + 1} crosses the part center at sample ${index + 1}.`);
            checkScanTravel([point.x, point.y, clearanceZ], limits);
            checkScanTravel([point.x, point.y, bedWposZ], limits);
        }
    }
    checkScanTravel([0, 0, clearanceZ], limits);
    checkScanTravel([0, 0, bedWposZ], limits);
    logHomingDiagnostic('Interior scan plan', { releaseDistance, minMeasuredRadius: minRadius, ringCount, sampleCount, estimatedSurfacePoints: estimated, spacing: cfg.spacing, clearanceZ, bedWposZ });
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
            ring.points.push(point);
            $('scanStatus').textContent = `Interior ring ${ringIndex + 1}/${ringCount}: ${index + 1}/${sampleCount} Z samples captured.`;
        }
        renderPerimeterResult();
    }
    state.surfaceCenter = await probeSurfacePoint(0, 0, cfg, limits, clearanceZ, bedWposZ, 'Interior center point');
    state.surfaceComplete = true;
    renderPerimeterResult();
}

async function findBedFromFrontEdge({ cfg, limits, safeZ, partRadius }) {
    const stepOut = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const frontEdgeY = -partRadius;
    let candidateY = frontEdgeY - stepOut;
    const outerLimitY = -cfg.rectangleHeight / 2;
    if (candidateY < outerLimitY - 0.05) {
        throw new Error(`The predicted front-edge bed probe at Y${candidateY.toFixed(2)} is outside the entered search box. Increase Search box width Y; it must leave room for the 0.75 × tip-diameter retry step.`);
    }
    const maxAttempts = Math.max(1, Math.floor((Math.abs(outerLimitY) - Math.abs(candidateY)) / stepOut + 1e-6) + 1);
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
        const command = `G21 G91 G38.3 Z${(zDirection * available).toFixed(3)} F${ORIGIN_FAST_FEED}`;
        $('scanStatus').textContent = `Bed search ${attempt}/${maxAttempts}: probing down at WPOS Y${candidateY.toFixed(2)}…`;
        logHomingDiagnostic('Bed search Z probe TX', { attempt, maxAttempts, wposY: candidateY, startMpos: start.mpos, availableZTravel: available, command });
        const result = await machine.query(command, { until: 'ok-or-error', timeout: Math.max(120000, Math.ceil((available / ORIGIN_FAST_FEED) * 60000 + 30000)), maxLines: 80 });
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
            throw new Error(`The last contact at WPOS Z${bedWposZ.toFixed(3)} mm is above the bed threshold ${bedThresholdZ.toFixed(3)} mm, and the search box has no room for another outward step. Increase Search box width Y or correct the entered part dimensions.`);
        }
        candidateY -= stepOut;
        if (candidateY < outerLimitY - 0.05) throw new Error('The next outward bed-search point would leave the entered search box. Increase Search box width Y and retry.');
    }
    throw new Error('Bed search ended without a valid bed reading.');
}

async function waitForSurfaceProbeRecovery(sampleLabel, reason) {
    const dialog = $('surfaceProbeRecoveryDialog');
    const status = $('surfaceProbeRecoveryStatus');
    const continueButton = $('continueSurfaceProbe');
    const cancelButton = $('cancelSurfaceProbe');
    status.textContent = `${sampleLabel}: ${reason} The machine is held at the full-clearance height. Check the probe, then continue to retry this exact point or cancel the scan.`;
    status.dataset.state = 'error';
    continueButton.disabled = true;
    dialog.showModal();
    logHomingDiagnostic('Interior probe recovery dialog opened', { sampleLabel, reason, workPosition: state.workPosition, motionState: state.motionState, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });

    return new Promise((resolve) => {
        let finished = false;
        let polling = false;
        let pollTimer;
        const finish = (resume) => {
            if (finished) return;
            finished = true;
            clearInterval(pollTimer);
            continueButton.onclick = null;
            cancelButton.onclick = null;
            dialog.oncancel = null;
            if (dialog.open) dialog.close();
            logHomingDiagnostic('Interior probe recovery dialog finished', { sampleLabel, resume, workPosition: state.workPosition, motionState: state.motionState, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });
            resolve(resume);
        };
        const refreshReadiness = async () => {
            if (finished || polling) return;
            polling = true;
            try {
                if (state.stopScan) { finish(false); return; }
                const snapshot = await refreshScanStatus(1500);
                const canContinue = snapshot.state === 'Idle' && state.probePinKnown && !state.probePinActive;
                continueButton.disabled = !canContinue;
                status.textContent = canContinue
                    ? `${sampleLabel}: ${reason} Probe input is clear and the machine is idle. Continue retries this same point; Cancel ends the scan.`
                    : `${sampleLabel}: ${reason} Continue is enabled only when the machine is idle and the probe input is confirmed clear. Clear the probe and wait for Idle.`;
                status.dataset.state = canContinue ? '' : 'error';
            } catch (error) {
                continueButton.disabled = true;
                status.textContent = `${sampleLabel}: ${reason} Waiting for a fresh idle status and a clear probe input. ${error.message}`;
                status.dataset.state = 'error';
            } finally {
                polling = false;
            }
        };
        continueButton.onclick = () => {
            if (continueButton.disabled || state.motionState !== 'Idle' || !state.probePinKnown || state.probePinActive) return;
            finish(true);
        };
        cancelButton.onclick = () => finish(false);
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
        pollTimer = setInterval(refreshReadiness, 700);
        refreshReadiness();
    });
}

async function startCylinderScan() {
    const readiness = scanReadiness();
    logHomingDiagnostic('Start scan button clicked', { ready: readiness.length === 0, blockedBy: readiness, connected: state.connected, homed: state.controllerHomed, motionState: state.motionState, busy: state.busy, workPosition: state.workPosition, latest: state.latest, probeSignalTested: state.probeSignalTested, probePinKnown: state.probePinKnown, probePinActive: state.probePinActive });
    if (readiness.length) {
        $('scanStatus').textContent = `Scan not started: ${readiness.join(' ')}`;
        return;
    }
    const dialog = $('scanConfirmDialog');
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
    if (cfg.partShape !== 'circle') throw new Error('Automated perimeter motion is currently available for Circle only.');
    const radius = cfg.partRadius;
    const sampleCount = Math.max(16, Math.ceil((2 * Math.PI * radius) / cfg.spacing));
    if (sampleCount > 360) throw new Error(`This scan would use ${sampleCount} points. Increase sample spacing so the scan is at most 360 points.`);
    const center = [0, 0];
    const nominalContactRadius = radius + cfg.radius;
    const firstSearchEndRadius = Math.max(0.1, radius - 5);
    const laterSearchEndRadius = Math.max(0.1, nominalContactRadius - radius);
    const safeZ = fullClearanceHeight(cfg);
    const releaseDistance = cfg.diameter * PERIMETER_RELEASE_DIAMETER_FACTOR;
    const estimatedInteriorRings = Math.max(0, Math.floor((radius - releaseDistance) / cfg.spacing) + 1);
    const estimatedSurfacePoints = estimatedInteriorRings * sampleCount + 1;
    if (estimatedSurfacePoints > MAX_SURFACE_SAMPLES) throw new Error(`The requested interior scan would use about ${estimatedSurfacePoints.toLocaleString()} points, above the ${MAX_SURFACE_SAMPLES.toLocaleString()}-point safety limit. Increase Perimeter sample spacing.`);
    if (Math.abs(initial.wpos[0]) > 0.1 || Math.abs(initial.wpos[1]) > 0.1 || initial.wpos[2] < safeZ - 0.1) {
        throw new Error(`Return to WPOS X0 Y0 and raise to at least Z${safeZ.toFixed(2)} mm before starting the scan.`);
    }
    checkScanTravel([0, 0, safeZ], limits);
    checkScanTravel([0, 0, Math.max(initial.wpos[2], safeZ)], limits);
    const firstAngle = -Math.PI / 2;
    const frontBedY = -radius - releaseDistance;
    if (Math.abs(frontBedY) > cfg.rectangleHeight / 2 + 0.05) throw new Error('The predicted front-edge bed search lies outside Search box width Y. Increase the search box dimensions.');
    checkScanTravel([0, frontBedY, safeZ], limits);
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
    const machineSafeZ = scanMachinePosition([0, 0, safeZ], limits)[2];
    if (machineSafeZ < limits.z.min + Z_LIMIT_MARGIN || machineSafeZ > limits.z.max - Z_LIMIT_MARGIN) throw new Error('Calculated full-clearance Z height exceeds controller Z travel.');

    state.scanRunning = true;
    state.stopScan = false;
    state.busy = true;
    state.perimeterPoints = [];
    state.surfaceRings = [];
    state.surfaceCenter = null;
    state.surfaceComplete = false;
    $('surfaceStl').value = '';
    $('surfaceStlStatus').textContent = '';
    const contactRadiusHistory = [];
    renderPerimeterResult();
    $('scanStatus').textContent = `Starting bed search, then ${sampleCount}-point circle scan…`;
    logHomingDiagnostic('Perimeter scan started', {
        mode: cfg.probeMode,
        sampleCount,
        partRadius: radius,
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
        await machine.setBusy(true, 'Find bed and scan circle perimeter');
        busyAnnounced = true;
        const travelZ = Math.max(initial.wpos[2], safeZ);
        await scanMove([0, 0, travelZ], limits, 'Moving to WPOS origin at full-clearance height');
        if (travelZ > safeZ + 0.1) await scanMove([0, 0, safeZ], limits, 'Lowering Z to the required full-clearance height');
        const bed = await findBedFromFrontEdge({ cfg, limits, safeZ, partRadius: radius });
        const bedWposZ = bed.bedWposZ;
        const perimeterWposZ = bedWposZ + cfg.selectedHeight;
        if (!Number.isFinite(perimeterWposZ)) throw new Error('Could not calculate the perimeter probe height from the measured bed and part thickness range.');
        checkScanTravel([0, 0, perimeterWposZ], limits);
        $('scanStatus').textContent = `Bed found at WPOS Z${bedWposZ.toFixed(3)}. Perimeter probe height is WPOS Z${perimeterWposZ.toFixed(3)}.`;
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
            if (index === 0) {
                logHomingDiagnostic('First perimeter approach already at bed-search point', { positionWpos: approach });
            } else {
                await scanMove(approach, limits, 'Point ' + (index + 1) + '/' + sampleCount + ': moving XY to outward approach');
            }
            const fastHit = await probeRay({
                center, angle, startRadius, endRadius: searchEndRadius,
                feed: 100, height: perimeterWposZ, limits,
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
            if (cfg.probeMode === 'precise') {
                const preciseHit = await probeRay({
                    center, angle, startRadius: releaseRadius, endRadius: fastRadius - 0.5,
                    feed: 20,
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
            state.perimeterPoints.push({ index: index + 1, angle: angle * 180 / Math.PI, x: measuredWpos[0] - ux * cfg.radius, y: measuredWpos[1] - uy * cfg.radius, z: perimeterWposZ });
            contactRadiusHistory.push(measuredRadius);
            renderPerimeterResult();
            if (state.stopScan) {
                await scanMove([clearedAt[0], clearedAt[1], safeZ], limits, 'Stopping safely after probe release');
                throw new Error('Scan stopped by user after the current probe move.');
            }
            $('scanStatus').textContent = 'Point ' + (index + 1) + '/' + sampleCount + ' captured; released outward and ready for next XY point.';
        }
        const finalPosition = await currentSnapshot();
        await scanMove([finalPosition.wpos[0], finalPosition.wpos[1], safeZ], limits, 'Perimeter complete: raise to full-clearance height');
        await scanMove([0, 0, safeZ], limits, 'Moving over the part at full-clearance height');
        $('scanStatus').textContent = 'Perimeter captured. Starting the interior Z surface scan…';
        await scanCylinderInterior(cfg, limits, safeZ, bedWposZ, sampleCount, firstAngle);
        $('scanStatus').textContent = `Surface scan complete: ${state.perimeterPoints.length} perimeter points and ${state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + 1} interior height points captured.`;
        logHomingDiagnostic('Perimeter and interior surface scan completed', { perimeterPoints: state.perimeterPoints.length, interiorRings: state.surfaceRings.length, interiorPoints: state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + 1, mode: cfg.probeMode });
    } catch (error) {
    $('scanStatus').textContent = `${error.message} ${state.perimeterPoints.length} perimeter points and ${state.surfaceRings.reduce((sum, ring) => sum + ring.points.length, 0) + (state.surfaceCenter ? 1 : 0)} surface points retained.`;
        logHomingDiagnostic('Perimeter scan stopped', {
            error: error.message,
            pointsCaptured: state.perimeterPoints.length,
            lastPoints: state.perimeterPoints.slice(-5),
            lastStatusLine: state.lastProbeStatusLine,
            probePinKnown: state.probePinKnown,
            probePinActive: state.probePinActive
        });
        state.stopScan = false;
        if (state.motionState !== 'Alarm' && state.connected) {
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
    const rows = ['sample,angle_deg,x_wpos_mm,y_wpos_mm,z_wpos_mm', ...state.perimeterPoints.map((point) => `${point.index},${point.angle.toFixed(3)},${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`)];
    const url = URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cylinder-perimeter.csv';
    link.click();
    URL.revokeObjectURL(url);
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
                            setProbeContinueEnabled(true);
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

function update() {
    const diameter = number('tipDiameter');
    const radius = diameter / 2;
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
    $('polygonSidesWrap').hidden = partShape !== 'polygon';
    $('partWidthLabel').textContent = partShape === 'oval' ? 'Oval X (mm)' : partShape === 'square' ? 'Square X (mm)' : partShape === 'rectangle' ? 'Rectangle X (mm)' : partShape === 'triangle' ? 'Base X (mm)' : 'Polygon X (mm)';
    $('partHeightWrap').firstChild.textContent = partShape === 'oval' ? 'Oval Y (mm)' : partShape === 'square' ? 'Square Y (mm)' : partShape === 'rectangle' ? 'Rectangle Y (mm)' : partShape === 'triangle' ? 'Height Y (mm)' : 'Polygon Y (mm)';
    $('rectangleWidthField').hidden = circleShape;
    $('rectangleHeightField').hidden = circleShape;
    document.querySelector('.part-shape').classList.toggle('circle-shape', circleShape);
    $('shapeSupportMessage').textContent = partShape === 'circle'
        ? 'Circle perimeter probing is available in this prototype. The circle is centered on the probed WPOS origin.'
        : 'This outline is captured as setup information, but perimeter motion is currently enabled for Circle only.';
    const spacing = number('sampleSpacing');
    const probeInputsValid = positive(diameter) && positive(usableLength) && Number.isFinite(verticalClearance) && verticalClearance >= 0 && Number.isFinite(clearance) && clearance >= 0.5;
    const partInputsValid = positive(minThickness) && positive(maxThickness) && maxThickness >= minThickness;
    const areaInputsValid = (circleShape ? positive(partRadius) : positive(partWidth)) && (!shapeUsesTwoDimensions || positive(partHeight))
        && (partShape !== 'polygon' || polygonSides >= 3);
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
    const requiredMargin = Math.max(radius + clearance, perimeterReleaseDistance * 2);
    const boundsX = circleShape ? partRadius * 2 : partWidth;
    const boundsY = circleShape ? partRadius * 2 : shapeUsesTwoDimensions ? partHeight : partWidth;
    const minimumRectangleWidth = boundsX + 2 * requiredMargin;
    const minimumRectangleHeight = boundsY + 2 * requiredMargin;
    if (areaInputsValid && probeInputsValid) {
        if (circleShape) {
            $('rectangleWidth').value = minimumRectangleWidth.toFixed(1);
            $('rectangleHeight').value = minimumRectangleHeight.toFixed(1);
        } else {
            if (!positive(number('rectangleWidth')) || number('rectangleWidth') < minimumRectangleWidth) $('rectangleWidth').value = minimumRectangleWidth.toFixed(1);
            if (!positive(number('rectangleHeight')) || number('rectangleHeight') < minimumRectangleHeight) $('rectangleHeight').value = minimumRectangleHeight.toFixed(1);
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
    const rectangleValid = areaInputsValid && probeInputsValid && rectangleWidth >= minimumRectangleWidth && rectangleHeight >= minimumRectangleHeight;
    const spacingValid = positive(spacing) && positive(maxSpacing) && spacing <= maxSpacing;
    const estimatedDiameter = circleShape ? partRadius * 2 : (boundsX + boundsY) / 2;
    const proposedSampleCount = positive(spacing) && positive(estimatedDiameter)
        ? Math.max(16, Math.ceil((Math.PI * estimatedDiameter) / spacing)) : Infinity;
    const cylinderRadius = circleShape ? partRadius : estimatedDiameter / 2;
    const cylinderValid = partShape === 'circle' && areaInputsValid && positive(cylinderRadius)
        && cylinderRadius + radius > 0.5 && proposedSampleCount <= 360;
    const machineReady = state.connected && state.controllerHomed && state.motionState === 'Idle'
        && state.probeSignalTested && state.probePinKnown && !state.probePinActive;
    const originReady = machineReady && Boolean(state.rectangleOriginMachine) && state.originSafeRetract;
    $('gotoOrigin').disabled = !state.rectangleOriginMachine || !state.controllerHomed || state.motionState !== 'Idle'
        || state.busy || state.probeTestRunning || !Number.isFinite(state.workPosition?.[2])
        || state.workPosition[2] < diameter * PERIMETER_RELEASE_DIAMETER_FACTOR + maxThickness - minThickness;
    $('originCaptureStatus').textContent = state.originMessage ?? (state.rectangleOriginMachine
        ? `Part-center top origin captured at machine X${state.rectangleOriginMachine[0].toFixed(3)} Y${state.rectangleOriginMachine[1].toFixed(3)} Z${state.rectangleOriginMachine[2].toFixed(3)}.`
        : 'Ready when homed and positioned above the approximate center of the part.');
    const probeReady = probeInputsValid;
    const partReady = partInputsValid && heightValid;
    const areaDimensionsReady = partReady && rectangleValid;
    const areaReady = areaDimensionsReady && spacingValid;
    const setupReady = machineReady && probeInputsValid && heightValid && rectangleValid && spacingValid && originReady;
    const safeWposZ = diameter * PERIMETER_RELEASE_DIAMETER_FACTOR + maxThickness - minThickness;

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

    $('planSummary').textContent = setupReady && !cylinderValid
        ? partShape !== 'circle'
            ? 'The selected outline is saved for planning. Automated perimeter scanning is currently available for Circle only.'
            : 'This spacing would create over 360 probe points. Increase the perimeter sample spacing.'
        : setupReady
        ? `Circle radius ${fmt(partRadius)} (${fmt(estimatedDiameter)} diameter) · ${proposedSampleCount} radial samples · first ray searches to R−5 mm and later rays search up to R inward for bays · ${document.querySelector('input[name="probeMode"]:checked')?.value === 'fast' ? 'fast single-touch' : 'precise double-touch'} probing · perimeter height ${fmt(selectedHeight)} above bed · full-clearance height ${fmt(safeWposZ)} above part-top WPOS Z0.`
        : !heightValid && partInputsValid && probeInputsValid
            ? 'The entered probe geometry cannot reach both the thinnest and thickest perimeter at one safe height.'
            : !rectangleValid && areaInputsValid && probeInputsValid
                ? `Search box must be at least ${fmt(minimumRectangleWidth)} × ${fmt(minimumRectangleHeight)} around the part center.`
                : !spacingValid && positive(maxSpacing)
                    ? `Choose a sample spacing no greater than ${fmt(maxSpacing)} to keep at least four samples across the smaller part dimension.`
                    : 'Complete the setup steps to review the perimeter plan.';
    $('saveSetup').disabled = !setupReady;
    state.latest = { diameter, radius, usableLength, clearance, verticalClearance, minThickness, maxThickness, partShape, partRadius, partWidth, partHeight, polygonSides, boundsX, boundsY, rectangleWidth, rectangleHeight, spacing, requiredMargin, perimeterHeightLow, perimeterHeightHigh, selectedHeight, probeMode: document.querySelector('input[name="probeMode"]:checked')?.value ?? 'precise', setupReady, cylinderValid };
    refreshScanButton();
}

function scanReadiness() {
    const cfg = state.latest;
    const reasons = [];
    if (!state.connected) reasons.push('Connect to the controller.');
    if (!state.controllerHomed) reasons.push('Home the machine.');
    if (state.motionState !== 'Idle') reasons.push(`Wait for Idle (current state: ${state.motionState}).`);
    if (state.busy) reasons.push('Wait for the current plugin operation to finish.');
    if (state.scanRunning) reasons.push('A perimeter scan is already running.');
    if (!cfg?.setupReady) reasons.push('Complete the probe, thickness, search-area, and origin setup.');
    if (!cfg?.cylinderValid) reasons.push('Automated scanning currently requires a valid Circle setup.');
    if (!state.probeSignalTested) reasons.push('Complete the probe signal test.');
    if (!state.probePinKnown) reasons.push('Waiting for a reported probe-pin state.');
    if (state.probePinActive) reasons.push('Clear the probe input.');
    if (!state.wposZeroMachine || !state.originSafeRetract) reasons.push('Probe WPOS Origin and confirm the safe retract.');
    if (!cfg || state.workPosition?.length !== 3 || !state.workPosition.every(Number.isFinite)) reasons.push('Waiting for current WPOS coordinates.');
    else {
        const safeWposZ = fullClearanceHeight(cfg);
        if (Math.abs(state.workPosition[0]) > 0.1 || Math.abs(state.workPosition[1]) > 0.1) reasons.push('Move to WPOS X0 Y0.');
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
    $('stopPerimeterScan').disabled = !state.scanRunning;
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
        const savedDiagnostics = await storage.get(HOMING_LOG_KEY, []);
        homingDiagnostics = Array.isArray(savedDiagnostics) ? savedDiagnostics.slice(-500) : [];
    } catch (error) {
        homingDiagnostics = [];
        console.warn('Could not load persisted homing diagnostics', error);
    }
    diagnosticLogReady = true;
    renderHomingDiagnostics();
    logHomingDiagnostic('Plugin diagnostics initialized', { version: '0.1.0', pageVisibility: document.visibilityState });
    for (const id of inputIds) $(id).addEventListener('input', () => { $('saveStatus').textContent = ''; update(); persistSettingsSoon(); });
    $('jogStep').addEventListener('change', persistSettingsSoon);
    document.querySelectorAll('input[name="probeMode"]').forEach((radio) => radio.addEventListener('change', () => { update(); persistSettingsSoon(); }));
    $('partShape').addEventListener('change', () => { update(); persistSettingsSoon(); });
    document.querySelectorAll('input[name="rectangleCorner"]').forEach((radio) => radio.addEventListener('change', persistSettingsSoon));
    $('probeOriginButton').addEventListener('click', probeWposOrigin);
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
        logHomingDiagnostic('Diagnostic log cleared by user');
    });
    $('coordinateMode').addEventListener('click', () => {
        state.positionMode = state.positionMode === 'mpos' ? 'wpos' : 'mpos';
        updateLiveStatus();
        persistSettingsSoon();
    });
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
    $('startPerimeterScan').addEventListener('click', () => { void startCylinderScan().catch((error) => { logHomingDiagnostic('Perimeter scan start failed', { message: error.message, stack: error.stack, blockedBy: scanReadiness() }); $('scanStatus').textContent = `Scan did not start: ${error.message}`; }); });
    $('stopPerimeterScan').addEventListener('click', () => { state.stopScan = true; $('scanStatus').textContent = 'Stop requested; the current probe move will finish, then the probe will retract.'; });
    $('downloadPerimeterCsv').addEventListener('click', downloadPerimeterCsv);
    $('surfaceExaggeration').addEventListener('input', drawSurfaceMesh);
    $('copySurfaceStl').addEventListener('click', () => { void copySurfaceStl(); });
    window.addEventListener('resize', drawSurfaceMesh);
    try {
        const saved = await storage.get(STORAGE_KEY, null);
        if (saved) writeSettings(saved);
    } catch (error) {
        console.warn('Could not load saved perimeter setup', error);
    }
    machine.onParsed('perimeter-probe-status', receiveProbeStatus);
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
