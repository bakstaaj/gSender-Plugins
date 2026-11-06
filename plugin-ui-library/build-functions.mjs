import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const mainSource = 'surface-height-map/v0.2.0/src/main.js';
const heightmapSource = 'surface-height-map/v0.2.0/src/heightmap.js';
const sources = new Map();
for (const path of [mainSource, heightmapSource]) {
  sources.set(path, (await readFile(join(root, path), 'utf8')).split(/\r?\n/));
}

function extract(path, name) {
  const lines = sources.get(path);
  const start = lines.findIndex((line) => new RegExp(`^(?:export )?(?:async )?function ${name}\\b`).test(line));
  if (start < 0) throw new Error(`Could not find ${name} in ${path}`);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '}') end += 1;
  if (end >= lines.length) throw new Error(`Could not find the end of ${name} in ${path}`);
  return { code: lines.slice(start, end + 1).join('\n'), path, line: start + 1 };
}

const blocks = [
  { id:'motion-lifecycle', category:'Motion lifecycle', title:'Wait for a settled Idle state', description:'Polls controller state until Idle remains stable, and fails on Alarm or timeout.', source:mainSource, fn:'waitIdle', requires:'controllerSnapshot(), pause()' },
  { id:'motion-lifecycle', category:'Motion lifecycle', title:'Send G-code and verify its acknowledgement', description:'Logs the request and response, then rejects incomplete or failed controller replies.', source:mainSource, fn:'sendAndWait', requires:'machine.query(), logCalibration()' },
  { id:'homing-jogging', category:'Homing and jogging', title:'Home through the controller query API', description:'Invalidates saved origin state, sends $H, waits for Idle, and captures machine Z after homing.', source:mainSource, fn:'homeMachine', requires:'state, machine.query(), waitIdle(), refreshUi(), setNotice()' },
  { id:'homing-jogging', category:'Homing and jogging', title:'One-step jog with travel validation', description:'Requires a homed, idle machine; checks axis travel, uses incremental mode for the move, then restores G90.', source:mainSource, fn:'jogMachine', requires:'statusSnapshot(), readTravelLimits(), validateMachineTarget(), sendAndWait(), waitIdle()' },
  { id:'homing-jogging', category:'Homing and jogging', title:'Hold-to-jog with bounded travel and cancel', description:'Bounds the jog to reported machine travel and sends the GRBL jog-cancel byte when the operator releases the control.', source:mainSource, fn:'startContinuousJog', requires:'state.continuousJog, requestContinuousJogStop(), machine.setBusy(), waitIdle()' },
  { id:'homing-jogging', category:'Homing and jogging', title:'Release and keyboard stop handler', description:'Matches pointer or key identity so a different input cannot accidentally stop the active hold-to-jog.', source:mainSource, fn:'requestContinuousJogStop', requires:'state.continuousJog; bind to pointerup, pointercancel, keyup, and lost focus' },
  { id:'probing', category:'Probing', title:'Confirm probe reporting, then treat omitted Pn as clear', description:'Keep the pin unknown until a Pn field confirms reporting. After that, omitted Pn means clear, so release is recognized and clear → pressed → released can complete.', sourceLabel:'Reusable GRBL status parser contract', code: `function updateProbePinState(statusFields, state) {
    const pins = statusFields.find((field) => field.startsWith('Pn:'));
    if (pins) state.probePinReportingSeen = true;

    // GRBL may omit Pn when no input pins are active. Only infer clear after
    // at least one Pn field has confirmed that pin reporting is available.
    state.probePinKnown = Boolean(pins) || state.probePinReportingSeen;
    state.probePinActive = Boolean(pins && pins.slice(3).includes('P'));
    state.probeStatusSequence += 1;
}` , requires:'Initialize probePinReportingSeen, probePinKnown, probePinActive to false; call for each valid status report' },
  { id:'probing', category:'Probing', title:'Verify clear → pressed → released probe input', description:'Requires confirmed probe-pin reporting; an omitted Pn after confirmation is the released/clear state. The signal gate waits for clear, press, then release.', source:mainSource, fn:'showProbeSignalDialog', requires:'Parser contract block above; state.probeStatusSequence, probePinKnown, probePinActive, machine.command(\'?\'), pause()' },
  { id:'probing', category:'Probing', title:'Limit a probe descent to available Z travel', description:'Leaves a small margin above the configured lower Z bound and rejects missing position data.', source:mainSource, fn:'safeProbeTravel', requires:'limits.minZ, current machine Z' },
  { id:'probing', category:'Probing', title:'Fast touch followed by a precise slow touch', description:'Runs a fast probe, retracts by the configured short amount, then limits and runs the slower repeat.', source:mainSource, fn:'probeSequenceOnce', requires:'queryProbe(), computePostProbeRetract(), sendAndWait(), waitIdle()' },
  { id:'probing', category:'Probing', title:'Retry one missed probe from a safe Z', description:'Retries only a detected probe miss, returns to a saved safe height, and stops after one retry. Keep the parser contract above active so omitted Pn reports the release state after reporting is confirmed.', source:mainSource, fn:'probeWithOneRetry', requires:'probeSequenceOnce(), statusSnapshot(), sendAndWait(), waitIdle(), confirmed probe parser contract for pin-state checks' },
  { id:'probing', category:'Probing', title:'Capture WPOS origin, set zero, and verify retract', description:'Full Surface Height Map origin workflow, including clear → pressed → released signal gating, G54 check, travel checks, probe, G10 L20 touch-off, and post-move position verification.', source:mainSource, fn:'probeWposOrigin', requires:'showProbeSignalDialog(), confirmed probe parser contract, readTravelLimits(), readActiveWcs(), probeWithOneRetry(), waitForMachinePosition(), G54' },
  { id:'coordinate-moves', category:'Coordinate moves', title:'Open GOTO XY only when position and homing are known', description:'Seeds the dialog from the active coordinate mode and derives allowed WPOS bounds from travel limits and offsets.', source:mainSource, fn:'openGotoXYDialog', requires:'state.positionMode, state.workPosition, state.machinePosition, readTravelLimits(), readCoordinateOffsets()' },
  { id:'coordinate-moves', category:'Coordinate moves', title:'Validate GOTO XY input in machine coordinates', description:'Converts the target into machine coordinates before checking controller travel.', source:mainSource, fn:'updateGotoXYValidation', requires:'state.gotoXYContext, validateMachineTarget()' },
  { id:'coordinate-moves', category:'Coordinate moves', title:'Execute GOTO XY with safe Z ordering', description:'Requires Idle, rechecks travel and offsets, raises to Full Retract when needed, guards the XY move using parser pin state, then verifies the reported destination.', source:mainSource, fn:'goToXYFromDialog', requires:'statusSnapshot(), readTravelLimits(), readFreshMachinePosition(), readCoordinateOffsets(), confirmed probe parser contract, moveXYWithProbeGuard(), waitForMachinePosition()' },
  { id:'coordinate-moves', category:'Coordinate moves', title:'Return to the captured WPOS origin', description:'Checks machine state and travel, raises to clearance when required, guards XY motion using parser pin state, and confirms arrival.', source:mainSource, fn:'goToWposOrigin', requires:'state.probedOrigin, readTravelLimits(), validateMachineTarget(), confirmed probe parser contract, moveXYWithProbeGuard(), statusSnapshot()' },
  { id:'travel-limits', category:'Travel limits', title:'Validate an X/Y target against machine travel', description:'Pure helper used before moves; rejects non-finite coordinates and out-of-range machine targets.', source:heightmapSource, fn:'validateMachineTarget', requires:'limits.minX/maxX/minY/maxY; limits.minZ/maxZPosition for Z where applicable' },
  { id:'travel-limits', category:'Travel limits', title:'Parse reported GRBL travel bounds', description:'Converts GRBL $130/$131/$132 travel settings into axis bounds while accounting for homing direction.', source:heightmapSource, fn:'parseTravelLimits', requires:'GRBL $$ response lines; readHomingMask()' },
];

const output = blocks.map((block) => block.code ? block : ({ ...block, ...extract(block.source, block.fn) }));
await writeFile(join(here, 'functions-data.js'), `window.FUNCTION_SNIPPETS = ${JSON.stringify(output, null, 2)};\n`);
console.log(`Wrote ${output.length} function blocks from ${sources.size} source files.`);
