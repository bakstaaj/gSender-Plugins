import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseNodePath} from '../src/node-editing.js';
import {closeVectors, joinVectors} from '../src/vector-joining.js';

const line = (id,[x1,y1],[x2,y2],layer='Draft')=>({id,kind:'line',layer,x1,y1,x2,y2});

test('joins out-of-order vectors into a closed polygon when their endpoints form a loop', () => {
  const vectors = [
    line(1,[20,10],[20,40]),
    line(2,[40,40],[40,10]),
    line(3,[40,40],[20,40]),
    line(4,[20,10],[40,10])
  ];
  const [joined] = joinVectors(vectors,100,0);
  assert.equal(joined.object.kind,'polygon');
  assert.equal(joined.object.layer,'Draft');
  assert.deepEqual([...joined.ids].sort(),[1,2,3,4]);
  assert.deepEqual(joined.object.points.map(point=>point.join(',')).sort(),['20,10','20,40','40,10','40,40']);
});

test('bridges short gaps and leaves unrelated and cross-layer vectors alone', () => {
  const vectors = [line(1,[0,0],[10,0]),line(2,[10.25,0],[10,10]),
    line(3,[10,10],[0,10],'Cut'),line(4,[50,50],[55,55])];
  assert.deepEqual(joinVectors(vectors,100,.2),[]);
  const [joined] = joinVectors(vectors,100,.35);
  assert.deepEqual(joined.ids,[1,2]);
  assert.deepEqual(joined.object.points,[[0,0],[10,0],[10.25,0],[10,10]]);
  assert.equal(joined.object.kind,'polyline');
});

test('rejects ambiguous branches instead of choosing a connection arbitrarily', () => {
  const vectors = [line(1,[0,0],[10,0]),line(2,[10,0],[10,10]),line(3,[10,0],[10,-10])];
  assert.throws(()=>joinVectors(vectors,100,.35),/More than two endpoints/);
});

test('join reverses and transforms Bézier handles with their path', () => {
  const curve = {id:2,layer:'Draft',kind:'path',d:'M10 5 C6 5 3 4 1 2',sx:2,sy:-3,dx:-2,dy:106};
  const [joined] = joinVectors([line(1,[-10,0],[0,0]),curve],100,0);
  const [{nodes,closed}] = parseNodePath(joined.object.d);
  assert.equal(closed,false);
  assert.deepEqual(nodes.map(node=>node.point),[[-10,100],[0,100],[18,91]]);
  assert.deepEqual(nodes.at(-1).controls,[[4,94],[10,91]]);
});

test('join preserves a reflected elliptical arc and reverses sweep for a reversed traversal', () => {
  const curve = {id:2,layer:'Draft',kind:'path',d:'M10 0 A6 4 0 0 1 0 0',sx:2,sy:-2,dy:100};
  const [joined] = joinVectors([line(1,[-10,0],[0,0]),curve],100,0);
  const arc = parseNodePath(joined.object.d)[0].nodes.at(-1);
  assert.equal(arc.type,'A');
  assert.deepEqual(arc.arc,[12,8,0,0,1]);
  assert.deepEqual(arc.point,[20,100]);
});

test('close preserves curved segments and ignores straight lines and closed vectors', () => {
  const curve = {id:1,layer:'Draft',kind:'path',d:'M0 15 Q5 0 10 15',dx:2,sy:3};
  const outline = {id:2,kind:'polyline',layer:'Draft',points:[[0,0],[5,0],[5,5]]};
  const [curved,polygon] = closeVectors([curve,outline,line(3,[0,0],[5,5])],100);
  assert.equal(curved.object.d,curve.d+' Z');
  assert.equal(curved.object.sy,3);
  assert.equal(polygon.object.kind,'polygon');
  assert.deepEqual(polygon.object.points,outline.points);
  assert.deepEqual(closeVectors([curved.object,polygon.object],100),[]);
});
