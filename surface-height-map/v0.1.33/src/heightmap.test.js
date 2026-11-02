import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MAX_STL_STORAGE_BYTES, appendMachineOriginReturn, compensateGcode, computeG54ForMapOrigin, computePostProbeRetract, interpolate, makeGrid, makeStlExportRecord, parseAbsoluteXYBounds, parseProbePosition, parseTravelLimits, parseWorkOffsetLine, surfaceMapToStl, validateMachineTarget, validateMap } from './heightmap.js';

test('returns to machine Z0 and XY origin before M30, including a shared M5 M30 line', () => {
    const output = appendMachineOriginReturn('G1 X10 Y10 Z1\nM5 M30 (end job)\n');
    assert.match(output, /G1 X10 Y10 Z1\nM5\nG21 G90 G53 G0 Z0\nG53 G0 X0 Y0\nM30 \(end job\)/);
});

test('appends machine-origin return when the source has no program-end code', () => {
    assert.match(appendMachineOriginReturn('G1 X1 Y1 Z0.2'), /G1 X1 Y1 Z0\.2\nG21 G90 G53 G0 Z0\nG53 G0 X0 Y0\n$/);
});

test('default slow probe travel exceeds the default retract distance', () => {
    assert.equal(DEFAULTS.slowTravel, 3);
    assert.ok(DEFAULTS.slowTravel > DEFAULTS.retract);
});

test('generates inclusive grid endpoints with requested sample counts', () => {
    const grid = makeGrid({ originX: 0, originY: 0, lengthX: 150, lengthY: 110, pointsX: 15, pointsY: 11 });
    assert.equal(grid.length, 11);
    assert.equal(grid[0].length, 15);
    assert.deepEqual([grid[10][14].x, grid[10][14].y], [150, 110]);
});

test('rejects a map extending beyond machine travel', () => {
    assert.throws(() => validateMap({ originX: 3, originY: 0, lengthX: 150, lengthY: 110, pointsX: 15, pointsY: 11 }, { maxX: 152, maxY: 113, maxZ: 39 }), /exceeds machine XY travel/);
});

test('accepts an in-travel machine start target and rejects out-of-travel coordinates', () => {
    const limits = { maxX: 152, maxY: 113, maxZ: 39 };
    assert.deepEqual(validateMachineTarget({ x: 8.69, y: 20.25 }, limits), { x: 8.69, y: 20.25 });
    assert.throws(() => validateMachineTarget({ x: 153, y: 20 }, limits), /within machine travel/);
});

test('parses travel limits when a query response prefixes or combines settings', () => {
    assert.deepEqual(parseTravelLimits([
        'controller settings: $130 = 152.000 (X max travel)',
        '$131=113.000 (Y max travel) $132=39.000 (Z max travel)',
        'ok',
    ]), { maxX: 152, maxY: 113, maxZ: 39 });
    assert.throws(() => parseTravelLimits(['$130=152', '$131=113']), /\$132/);
});

test('parses probe reports that arrive after ok with CRLF or trailing whitespace', () => {
    assert.deepEqual(parseProbePosition('[PRB:10.000,10.000,-19.999,0.000:1]\r'), { x: 10, y: 10, z: -19.999 });
    assert.deepEqual(parseProbePosition('[PRB:47.500,10.000,-20.385,0.000:1]  '), { x: 47.5, y: 10, z: -20.385 });
    assert.throws(() => parseProbePosition('[PRB:10.000,10.000,-19.999:0]'), /did not trigger/);
    assert.equal(parseProbePosition('ok'), null);
});

test('parses Cubiko work offsets with an additional rotary axis', () => {
    assert.deepEqual(parseWorkOffsetLine('[G54:1.000,2.000,3.000,4.000]\r', 'G54'), [1, 2, 3]);
    assert.deepEqual(parseWorkOffsetLine('[g54:1.000,2.000,3.000]', 'G54'), [1, 2, 3]);
    assert.deepEqual(parseWorkOffsetLine('[G92:0.000,0.000,0.000,0.000]', 'G92'), [0, 0, 0]);
    assert.equal(parseWorkOffsetLine('[G55:1,2]', 'G54'), null);
});

test('finds file XY bounds for aligning the smallest XY point to the map origin', () => {
    assert.deepEqual(parseAbsoluteXYBounds('(job)\nG21 G90\nG0 X8 Y12\nG1 X-2 Y30\nG0 X10 Y5 ; end'), {
        minX: -2, maxX: 10, minY: 5, maxY: 30,
    });
    assert.throws(() => parseAbsoluteXYBounds('G21 G91\nG1 X1 Y2'), /G90/);
    assert.throws(() => parseAbsoluteXYBounds('G20 G90\nG1 X1 Y2'), /G21/);
});

test('computes G54 offsets so file minima map to the calibrated origin with G92 included', () => {
    assert.deepEqual(computeG54ForMapOrigin({ x: 10, y: 10 }, { minX: 0, minY: 0 }, [0, 0, 7.37]), { x: 10, y: 10 });
    assert.deepEqual(computeG54ForMapOrigin({ x: 10, y: 10 }, { minX: -5, minY: 3 }, [2, -1, 0]), { x: 13, y: 8 });
    assert.throws(() => computeG54ForMapOrigin({ x: NaN, y: 10 }, { minX: 0, minY: 0 }), /Could not calculate/);
});

test('compensates a 12 mm file from aligned G54 minima inside a 50 mm map', () => {
    const map = { originX: 10, originY: 10, lengthX: 50, lengthY: 50, pointsX: 5, pointsY: 5, referenceZ: 0, z: Array.from({ length: 5 }, () => Array(5).fill(0)) };
    const bounds = parseAbsoluteXYBounds('G21 G90 G54\nG0 X0 Y0 Z5\nG1 X12 Y12 Z-0.1 F100');
    const g54 = computeG54ForMapOrigin({ x: map.originX, y: map.originY }, bounds);
    const output = compensateGcode('G21 G90 G54\nG0 X0 Y0 Z5\nG1 X12 Y12 Z-0.1 F100', map, g54, 'G54');
    assert.deepEqual(g54, { x: 10, y: 10 });
    assert.match(output, /G1 X12 Y12 Z-0.1/);
});

test('uses a short post-probe retract and caps it at the homed Z coordinate', () => {
    assert.equal(DEFAULTS.postProbeRetract, 3);
    assert.equal(computePostProbeRetract(-20, 0, 3), 3);
    assert.equal(computePostProbeRetract(0, 2, 3), 2);
    assert.throws(() => computePostProbeRetract(1, 0, 3), /at or above the recorded homed Z/);
});

test('bilinear interpolation reproduces planar grid heights', () => {
    const map = { originX: 0, originY: 0, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 10], [20, 30]] };
    assert.equal(interpolate(map, 5, 5), 15);
});

test('exports a true-scale STL surface with Z relative to the first probe and no exaggeration', () => {
    const map = {
        lengthX: 10, lengthY: 4, pointsX: 2, pointsY: 2, referenceZ: -20,
        z: [[-20, -19], [-18, -17]],
    };
    const stl = surfaceMapToStl(map);
    assert.match(stl, /^solid surface_height_map_mm_z_relative_to_first_probe/m);
    assert.match(stl, /vertex 10 0 1/);
    assert.match(stl, /vertex 10 4 3/);
    assert.match(stl, /vertex 0 4 2/);
    assert.equal((stl.match(/\bfacet normal\b/g) ?? []).length, 2);
    assert.match(stl, /endsolid surface_height_map_mm_z_relative_to_first_probe/);
    assert.doesNotMatch(stl, /vertex 10 4 18/);
});

test('rejects incomplete saved data when exporting STL', () => {
    assert.throws(() => surfaceMapToStl({ lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, z: [[0, 0]] }), /incomplete or invalid/);
});

test('creates a named STL storage record and rejects records above the current gSender storage limit', () => {
    const date = new Date('2026-10-10T22:07:41.278Z');
    const smallMap = { lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 0], [0, 0]] };
    const record = makeStlExportRecord(smallMap, date);
    assert.equal(record.filename, 'surface-height-map-2026-10-10T22-07-41-278Z.stl');
    assert.match(record.text, /endsolid/);
    const largeMap = {
        lengthX: 100, lengthY: 100, pointsX: 32, pointsY: 32, referenceZ: 0,
        z: Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => x + y)),
    };
    assert.throws(() => makeStlExportRecord(largeMap, date), new RegExp(`exceeding gSender plugin storage's ${MAX_STL_STORAGE_BYTES.toLocaleString()} byte per-value limit`));
});

test('compensates and subdivides a metric absolute line using machine offset', () => {
    const map = { originX: 10, originY: 20, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 1, z: [[1, 3], [1, 3]] };
    const result = compensateGcode('G21\nG90\nG0 X0 Y0 Z5\nG1 X10 Y0 Z-1 F100', map, { x: 10, y: 20 }, 'G54', { x: 0, y: 0 });
    assert.match(result, /G1 X5 Y0 Z3/);
    assert.match(result, /G1 X5 Y0 Z3 F100/);
    assert.match(result, /G1 X10 Y0 Z1/);
});

test('rejects arcs, incremental moves and out-of-map paths', () => {
    const map = { originX: 0, originY: 0, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 0], [0, 0]] };
    assert.throws(() => compensateGcode('G21 G90\nG2 X1 Y1', map), /Arc moves/);
    assert.throws(() => compensateGcode('G21 G91\nG1 X1 Y1', map), /G91/);
    assert.throws(() => compensateGcode('G21 G90\nG0 X20 Y1 Z2', map), /leaves mapped area/);
});

test('accepts the active work system and refuses a different one', () => {
    const map = { originX: 0, originY: 0, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 0], [0, 0]] };
    assert.doesNotThrow(() => compensateGcode('G21 G90 G54\nG0 X0 Y0 Z5', map, { x: 0, y: 0 }, 'G54'));
    assert.throws(() => compensateGcode('G21 G90 G55\nG0 X0 Y0 Z5', map, { x: 0, y: 0 }, 'G54'), /current controller coordinate system is G54/);
});

test('allows an initial Z-unknown rapid but refuses cutting before a known Z', () => {
    const map = { originX: 0, originY: 0, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 0], [0, 0]] };
    assert.match(compensateGcode('G21 G90\nG0 X0 Y0', map), /G0 X0 Y0/);
    assert.throws(() => compensateGcode('G21 G90\nG1 X1 Y1 F100', map), /before any Z position is set/);
});

test('keeps the initial file positioning move out of map compensation when live position is unknown', () => {
    const map = { originX: 10, originY: 10, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 2], [0, 2]] };
    const source = 'G21 G90 G54\nG0 Z10\nG0 X0 Y0\nG1 X10 Y0 Z10 F100';
    const result = compensateGcode(source, map, { x: 10, y: 10 }, 'G54', null);
    assert.match(result, /G0 Z10/);
    assert.match(result, /G0 X0 Y0/);
    assert.doesNotMatch(result, /G0 X5 Y5/);
    assert.match(result, /G1 X5 Y0 Z11/);
    assert.match(result, /G1 X10 Y0 Z12/);
});

test('requires the file to establish its start with a rapid XY move before mapped cutting', () => {
    const map = { originX: 0, originY: 0, lengthX: 10, lengthY: 10, pointsX: 2, pointsY: 2, referenceZ: 0, z: [[0, 0], [0, 0]] };
    assert.throws(() => compensateGcode('G21 G90\nG1 X1 Y1 Z-0.1 F100', map, { x: 0, y: 0 }, 'G54', null), /rapid XY positioning move/);
});
