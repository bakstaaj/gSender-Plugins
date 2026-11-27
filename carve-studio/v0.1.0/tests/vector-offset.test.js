import {test} from 'node:test';
import assert from 'node:assert/strict';
import {offsetVectorRegion, vectorPathContours} from '../src/closed-vector-geometry.js';

function limits(ring) {
  const xs = ring.map(([x])=>x), ys = ring.map(([,y])=>y);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}

function distanceToRing(point, ring) {
  const [x,y] = point;
  return Math.min(...ring.map((a,i)=>{
    const b = ring[(i+1)%ring.length];
    const dx=b.x-a.x, dy=b.y-a.y;
    const t = Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(x-a.x-t*dx,y-a.y-t*dy);
  }));
}

test('an SVG W that returns to its start offsets as one closed boundary', () => {
  const letter = {kind:'path',d:'M0 0 H20 L27 64 L37 0 H52 L61 64 L69 0 H89 L76 85 H61 L45 38 L29 85 H13 L0 0'};
  const [contour] = vectorPathContours(letter,100);
  assert.equal(contour.closed,true);
  assert.ok(contour.points.some(point=>point.x===45 && point.y===62));
  const result = offsetVectorRegion([contour.points],-1);
  assert.equal(result.length,1);
  assert.equal(result[0].length,1);
  assert.equal(result[0][0].length,contour.points.length-1);
  assert.ok(result[0][0].every(point=>distanceToRing(point,contour.points)>.99));
  assert.notDeepEqual(result[0][0][0],result[0][0].at(-1));
});

test('an acute inset corner reaches the intersection of the two shifted sides', () => {
  const shape = {kind:'path',d:'M0 0 H60 V60 H34 L30 16 L26 60 H0 Z'};
  const [contour] = vectorPathContours(shape,60);
  const [[ring]] = offsetVectorRegion([contour.points],-1);
  const expected = 44+Math.hypot(44,4)/4;
  assert.equal(ring.length,7);
  assert.ok(ring.some(([x,y])=>Math.abs(x-30)<.002 && Math.abs(y-expected)<.002));
});

test('a circular SVG outline stays smooth with mitered joins', () => {
  const shape = {kind:'path',d:'M20 0 A20 20 0 1 1 -20 0 A20 20 0 1 1 20 0 Z'};
  const [contour] = vectorPathContours(shape,0);
  const [[ring]] = offsetVectorRegion([contour.points],-2);
  assert.ok(ring.length>40);
  assert.ok(ring.every(([x,y])=>Math.abs(Math.hypot(x,y)-18)<.02));
});

test('a compound SVG offset moves its outer boundary and hole in opposite directions', () => {
  const shape = {kind:'path',d:'M0 0 H40 V40 H0 Z M10 10 H30 V30 H10 Z'};
  const rings = vectorPathContours(shape,40).map(contour=>contour.points);
  const [inward] = offsetVectorRegion(rings,-2);
  const [outward] = offsetVectorRegion(rings,2);
  assert.deepEqual(inward.map(limits),[[2,2,38,38],[8,8,32,32]]);
  assert.deepEqual(outward.map(limits),[[-2,-2,42,42],[12,12,28,28]]);
});

test('an inward offset splits a narrow bridge into separate closed contours', () => {
  const shape = {kind:'path',d:'M0 0 H10 V4.5 H20 V0 H30 V10 H20 V5.5 H10 V10 H0 Z'};
  const [contour] = vectorPathContours(shape,10);
  const result = offsetVectorRegion([contour.points],-1);
  assert.equal(result.length,2);
  assert.ok(result.every(component=>component.length===1));
  assert.deepEqual(offsetVectorRegion([contour.points],-6),[]);
});
