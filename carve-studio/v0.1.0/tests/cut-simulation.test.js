import {test} from 'node:test';
import assert from 'node:assert/strict';
import {simulateCut} from '../src/cut-simulation.js';

const stock = {width: 84, height: 44, thickness: 6};
const at = (grid, x, y) => grid.depths[Math.floor(y / grid.cellHeight) * grid.columns + Math.floor(x / grid.cellWidth)];

test('a flat cutter removes its full width, preserves raised tabs, and ignores rapids', async () => {
  const job = {name: 'Profile', operation: 'profile', gcode: [
    '(Cut side: Outside; cutter diameter 4.000 mm.)',
    'G0 Z5', 'G0 X10 Y10', 'G1 Z-6', 'G1 X25', 'G1 X28 Z-4', 'G1 X40', 'G1 X43 Z-6', 'G1 X55',
    'G0 Z5', 'G0 X66 Y25', 'G1 Z-2',
  ].join('\n')};
  const grid = await simulateCut(stock, [job]);
  assert.equal(at(grid, 17, 11.7), 6);
  assert.equal(at(grid, 17, 12.4), 0);
  assert.equal(at(grid, 34, 10), 4);
  assert.equal(at(grid, 60, 17), 0);
  assert.equal(at(grid, 66, 25), 2);
});

test('a V-bit ramps continuously and cuts a wider groove at greater Z depth', async () => {
  const job = {name: 'Letters', operation: 'vgroove', gcode: [
    '(V-bit included angle 90 degrees; maximum depth 4.000 mm.)',
    'G0 Z5', 'G0 X10 Y20', 'G1 Z-1', 'G1 X34 Z-4', 'G1 X50',
  ].join('\n')};
  const grid = await simulateCut(stock, [job]);
  assert.equal(at(grid, 11, 22), 0);
  assert.ok(at(grid, 42, 22) > 1.8 && at(grid, 42, 22) < 2.1);
  assert.ok(at(grid, 22, 20) > 2.4 && at(grid, 22, 20) < 2.7);
  assert.equal(at(grid, 42, 24.2), 0);
});

test('cutter snapshots, legacy drill diameters and missing profile sizes are handled', async () => {
  const drill = {name: 'Holes', operation: 'drill', gcode: [
    '(Hole 1 drawn diameter 4.000 mm)', 'G0 Z5', 'G0 X10 Y10', 'G1 Z-6', 'G0 Z5',
    '(Hole 2 drawn diameter 8.000 mm)', 'G0 X26 Y10', 'G1 Z-3',
  ].join('\n')};
  const profile = {name: 'Unknown', operation: 'profile', gcode: 'G0 Z5\nG0 X40 Y25\nG1 Z-2\nG1 X70'};
  const grid = await simulateCut(stock, [drill, profile]);
  assert.equal(at(grid, 10, 10), 6);
  assert.equal(at(grid, 13, 10), 0);
  assert.equal(at(grid, 29, 10), 3);
  assert.equal(at(grid, 55, 25), 0);
  assert.deepEqual(grid.estimatedDrills, ['Holes']);
  assert.deepEqual(grid.skipped, ['Unknown']);

  const selected = await simulateCut(stock, [{...drill, tool: {diameter: 2}}]);
  assert.equal(at(selected, 10, 10), 6);
  assert.equal(at(selected, 11.5, 10), 0);
  assert.equal(at(selected, 29, 10), 0);
  assert.deepEqual(selected.estimatedDrills, []);
});
