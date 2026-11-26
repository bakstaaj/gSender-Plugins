import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rectangularArray, circularArray, cornerOutline, cornerTargets, shapeCorners, arcThroughThreePoints} from '../src/drawing-tools.js';

const rectangle = cornerOutline({kind:'rect',x1:10,y1:10,x2:50,y2:40});
const roundedOffsets = points=>points.map(point=>point.map(n=>Math.round(n * 1000) / 1000 || 0));

test('rectangular arrays count the original and support signed spacing',()=>{
  assert.deepEqual(rectangularArray(3,2,12,-8), [[12,0],[24,0],[0,-8],[12,-8],[24,-8]]);
  assert.throws(()=>rectangularArray(2,1,0,0), /nonzero spacing/);
});

test('circular arrays close without repeating the seed and include both partial sweep endpoints',()=>{
  const full = circularArray(4,360,[9,3],[19,3]);
  assert.deepEqual(full.seedOffset,[0,0]);
  assert.deepEqual(roundedOffsets(full.offsets), [[-10,10],[-20,0],[-10,-10]]);
  assert.deepEqual(roundedOffsets(circularArray(3,-180,[9,3],[19,3]).offsets), [[-10,-10],[-20,0]]);
  assert.throws(()=>circularArray(4,360,[3,3],[3,3]), /away from the array center/);
});

test('an explicit circular array radius moves the seed and places every copy on the same ring',()=>{
  const {seedOffset,offsets} = circularArray(4,360,[9,3],[19,3],15);
  assert.deepEqual(seedOffset,[5,0]);
  assert.deepEqual(roundedOffsets(offsets),[[-10,15],[-25,0],[-10,-15]]);
  assert.deepEqual(circularArray(4,360,[3,3],[3,3],8).seedOffset,[8,0]);
  assert.throws(()=>circularArray(4,360,[9,3],[19,3],0), /positive array radius/);
});

test('fillet and inward fillet have the same endpoints and different arc centers',()=>{
  const normal = shapeCorners(rectangle,'fillet',5,1);
  const inward = shapeCorners(rectangle,'concave',5,1);
  const middle = result=>result.points[1 + Math.floor((result.points.length - 4) / 2)];
  assert.deepEqual(normal.points[1], [45,10]);
  assert.deepEqual(normal.points.at(-3), [50,15]);
  assert.deepEqual(normal.points[1], inward.points[1]);
  assert.deepEqual(normal.points.at(-3), inward.points.at(-3));
  assert.ok(Math.abs(Math.hypot(middle(normal)[0]-45,middle(normal)[1]-15)-5) < 1e-8);
  assert.ok(Math.abs(Math.hypot(middle(inward)[0]-50,middle(inward)[1]-10)-5) < 1e-8);
  assert.equal(cornerTargets(cornerOutline(normal),'fillet').length,3);
});

test('chamfers preserve open endpoints and reject shared-edge overlap',()=>{
  const open = cornerOutline({kind:'polyline',points:[[0,0],[15,0],[15,15]]});
  assert.deepEqual(shapeCorners(open,'chamfer',3),{kind:'polyline',points:[[0,0],[12,0],[15,3],[15,15]]});
  assert.throws(()=>shapeCorners(rectangle,'fillet',17), /too large/);
  assert.deepEqual(cornerTargets(open,'concave'),[]);
  assert.equal(shapeCorners(rectangle,'chamfer',5).points.length, 8);
});

test('3-point arcs preserve all selected points and the requested direction',()=>{
  const start=[17,6], top=[10,13], end=[3,6];
  const points=arcThroughThreePoints(start,top,end);
  assert.deepEqual(points[0],start);
  assert.ok(points.includes(top));
  assert.deepEqual(points.at(-1),end);
  for(const [x,y] of points) assert.ok(Math.abs(Math.hypot(x-10,y-6)-7)<1e-9);
  assert.ok(points.every(([,y])=>y>=6));
  const reverse=arcThroughThreePoints(end,top,start);
  assert.ok(reverse.every(([,y])=>y>=6));
  assert.deepEqual(reverse.at(-1),start);
});

test('arc sweeps through the middle point even when that requires a major arc',()=>{
  const points=arcThroughThreePoints([100,0],[-100,0],[0,100]);
  assert.ok(points.some(([,y])=>y< -99));
  assert.ok(points.some(([x,y])=>x===-100 && y===0));
  for(let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i];
    assert.ok(100-Math.hypot((a[0]+b[0])/2,(a[1]+b[1])/2)<=.01000001);
  }
  assert.throws(()=>arcThroughThreePoints([0,0],[1,1],[2,2]),/straight line/);
  assert.throws(()=>arcThroughThreePoints([0,0],[1,1],[0,0]),/distinct/);
});
