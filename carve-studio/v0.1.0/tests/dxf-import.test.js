import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {parseDxf} from '../src/dxf-import.js';
import {deriveGrooveCenterlines, grooveCutPaths} from '../src/groove-centerline.js';

function polyline(flags, fields) {
  return ['0','SECTION','2','ENTITIES','0','LWPOLYLINE','70',flags,...fields,'0','ENDSEC','0','EOF'].join('\n');
}

test('a closed two-vertex polyline keeps both semicircles', () => {
  const [shape] = parseDxf(polyline(129,[10,0,20,0,42,1,10,10,20,0,42,1]));
  assert.equal(shape.kind,'polygon');
  assert.ok(shape.points.some(([,y]) => y < -4.99));
  assert.ok(shape.points.some(([,y]) => y > 4.99));
  for (const [x,y] of shape.points) assert.ok(Math.abs(Math.hypot(x-5,y)-5) < 1e-9);
  const [component] = deriveGrooveCenterlines([shape.points.map(([x,y]) => ({x,y}))]);
  assert.ok(component.paths.length);
});

test('an optional bulge belongs to its own vertex and an open path ignores its last bulge', () => {
  const [shape] = parseDxf(polyline(0,[10,0,20,0,10,10,20,0,42,-1,10,20,20,0,42,1]));
  assert.equal(shape.kind,'polyline');
  assert.deepEqual(shape.points.slice(0,2),[[0,0],[10,0]]);
  assert.deepEqual(shape.points.at(-1),[20,0]);
  assert.ok(shape.points.slice(2,-1).every(([x,y]) => x > 10 && x < 20 && y > 0));
});

const doorSign = process.env.CARVE_DOOR_SIGN_DXF;
test('Door sign lettering imports and generates V Groove in both depth modes', {skip:!doorSign}, () => {
  const shapes = parseDxf(readFileSync(doorSign,'utf8'));
  assert.equal(shapes.length,178);
  const lettering = shapes.filter(o => o.kind === 'polygon' && o.points.every(([x]) => x > 210));
  assert.equal(lettering.length,23);
  const regions = deriveGrooveCenterlines(lettering.map(o => o.points.map(([x,y]) => ({x,y}))));
  assert.equal(regions.length,15);
  assert.ok(regions.every(c => c.paths.length));
  for (const region of regions) {
    const variable = grooveCutPaths(region,{angle:90,depth:2,fixed:false});
    const fixed = grooveCutPaths(region,{angle:90,depth:2,fixed:true});
    const xy = paths => paths.map(path => path.map(({x,y}) => [x,y]));
    assert.deepEqual(xy(variable),xy(fixed));
    assert.ok(variable.flat().every(p => p.z > 0 && p.z <= 2));
    assert.ok(fixed.flat().every(p => p.z === 2));
  }
});
