import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNodeModel, deleteNode, insertNode, nodeHandles, nodeObject, parseNodePath, updateNode} from '../src/node-editing.js';

test('inserting and moving a node keeps a rectangle closed and preserves its ID and layer', () => {
  const rectangle = {id: 7, kind: 'rect', x1: 5, y1: 10, x2: 25, y2: 30, layer: 'Signs'};
  const model = createNodeModel(rectangle, 100);
  assert.equal(insertNode(model, [5,20], 0.5), '0:4');
  const node = nodeHandles(model).find(handle => handle.key === '0:4');
  updateNode(model, node, [2,20]);
  assert.deepEqual(nodeObject(model), {id: 7, kind: 'polygon', layer: 'Signs',
    points: [[5,10],[25,10],[25,30],[5,30],[2,20]]});
  assert.equal(deleteNode(model, node), true);
  const first = nodeHandles(model)[0];
  assert.equal(deleteNode(model, first), true);
  assert.equal(deleteNode(model, first), false);
  assert.equal(rectangle.x1, 5);
});

test('editing a closed SVG seam moves its endpoints and attached Bézier handles together', () => {
  const shape = {kind: 'path', d: 'm10 20 c0 -10 10 -10 10 0 s-10 10 -10 0z', sx: 2, sy: 3, dx: 7, oy: 4};
  const model = createNodeModel(shape, 100);
  const [seam, second] = nodeHandles(model);
  assert.deepEqual([seam.point, second.point], [[27,36],[47,36]]);
  updateNode(model, seam, [31,30]);
  const [start, outbound, inbound] = parseNodePath(nodeObject(model).d)[0].nodes;
  assert.deepEqual(start.point, [12,22]);
  assert.deepEqual(inbound.point, start.point);
  assert.deepEqual(outbound.controls, [[12,12],[20,10]]);
  assert.deepEqual(inbound.controls, [[20,30],[12,32]]);
});

test('inserting a node on a Bézier splits the curve without flattening it', () => {
  const model = createNodeModel({kind: 'path', d: 'M0 0 C0 20 20 20 20 0'}, 100);
  assert.equal(insertNode(model, [10,85], .01), '0:1');
  const [, left, right] = parseNodePath(nodeObject(model).d)[0].nodes;
  const result = [left.controls, [left.point], right.controls].flat();
  const expected = [[0,10],[5,15],[10,15],[15,15],[20,10]];
  result.forEach(([x,y], i) => assert.ok(Math.hypot(x-expected[i][0], y-expected[i][1]) < .001));
  assert.equal(left.type, 'C');
  assert.equal(right.type, 'C');
});

test('redundant line commands in a glyph do not add overlapping nodes', () => {
  const model = createNodeModel({kind:'path', d:'M0 5 L0 5 Q0 0 5 0 L5 0 Q10 0 10 5'}, 100);
  assert.deepEqual(nodeHandles(model).map(handle=>handle.point), [[0,95],[5,100],[10,95]]);
});

test('inserting into an SVG arc preserves the arc and its corrected radii', () => {
  const model = createNodeModel({kind: 'path', d: 'M20 20 a5 5 0 0140 0'}, 100);
  assert.equal(insertNode(model, [40,100], .01), '0:1');
  const [, left, right] = parseNodePath(nodeObject(model).d)[0].nodes;
  assert.deepEqual(left.arc, [20,20,0,0,1]);
  assert.deepEqual(right.arc, left.arc);
  assert.ok(Math.hypot(left.point[0]-40,left.point[1]) < .001);
  assert.deepEqual(right.point, [60,20]);
});
