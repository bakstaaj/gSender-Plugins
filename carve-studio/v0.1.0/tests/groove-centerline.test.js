import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import test from 'node:test';
import opentype from 'opentype.js';
import {deriveGrooveCenterlines, flattenTextOutline, grooveCutPaths} from '../src/groove-centerline.js';

function glyphs(file, text, height) {
  const font = opentype.parse(Uint8Array.from(readFileSync(file)).buffer);
  const path = font.getPath(text, 0, 0, 1000);
  const {x1,y1,y2} = path.getBoundingBox();
  const scale = height/(y2-y1);
  const fmt = value => Number(value.toFixed(4));
  const d = path.commands.map(command => {
    const sets = {M:['x','y'], L:['x','y'], Q:['x1','y1','x','y'], C:['x1','y1','x2','y2','x','y'], Z:[]};
    return command.type+sets[command.type].map((key,i) => fmt((command[key]-(i%2 ? y1 : x1))*scale)).join(' ');
  }).join(' ');
  return d.match(/M[^M]*/g).map(part => flattenTextOutline(part));
}

const mm = p => [p.x,p.y].map(value=>value.toFixed(4)).join(',');
const size = path => path.slice(1).reduce((sum,p,i) => sum+Math.hypot(p.x-path[i].x,p.y-path[i].y),0);
const endpoints = paths => new Set(paths.flatMap(path => [mm(path[0]),mm(path.at(-1))]));

function distanceToPaths(point,paths) {
  let best = Infinity;
  for (const path of paths) for (let i=1; i<path.length; i++) {
    const a=path[i-1], b=path[i], dx=b.x-a.x, dy=b.y-a.y;
    const length=dx*dx+dy*dy;
    const t=length ? Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/length)) : 0;
    best=Math.min(best,Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy));
  }
  return best;
}

function connected(paths) {
  const touched = new Set(paths[0].map(mm));
  const remaining = paths.slice(1);
  let merged;
  do {
    merged = false;
    for (let i=remaining.length-1; i>=0; i--) {
      if (!remaining[i].some(p => touched.has(mm(p)))) continue;
      for (const p of remaining.splice(i,1)[0]) touched.add(mm(p));
      merged = true;
    }
  } while (merged);
  return !remaining.length;
}

const testFont = process.env.CARVE_TEST_FONT || new URL('../fonts/BebasNeue-Regular.ttf',import.meta.url);
test('TEST has continuous glyphs, a single S stroke and matching T geometry', () => {
  for (const height of [5,25,100]) {
    const outlines = glyphs(testFont,'TEST',height);
    const result = deriveGrooveCenterlines(outlines).sort((a,b) => Math.min(...a.paths.flat().map(p=>p.x))-Math.min(...b.paths.flat().map(p=>p.x)));
    assert.equal(result.length,4);
    const [left,e,s,right] = result.map(x=>x.paths);
    if (height===25 && process.env.CARVE_DEBUG_SVG) {
      const line = (path,color) => `<polyline points="${path.map(mm).join(' ')}" fill="none" stroke="${color}" stroke-width=".16"/>`;
      writeFileSync(process.env.CARVE_DEBUG_SVG,`<svg xmlns="http://www.w3.org/2000/svg" width="1000" viewBox="-2 -2 ${Math.max(...outlines.flat().map(p=>p.x))+4} 29">${outlines.map(r=>line(r,'#ef8300')).join('')}${result.flatMap(r=>r.paths.map(p=>line(p,'#7140be'))).join('')}</svg>`);
    }
    for (const [i,paths] of [left,e,s,right].entries()) {
      assert.ok(connected(paths),`letter ${i+1} has disconnected paths at ${height} mm`);
    }
    assert.equal(left.length,2,`T stroke count at ${height} mm`);
    assert.equal(e.length,2,`E stroke count at ${height} mm`);
    assert.equal(s.length,1,`S stroke count at ${height} mm`);
    assert.ok(size(s[0])>height*1.25,'S path reaches both ends');
    const normalized = paths => {
      const minX = Math.min(...paths.flat().map(p=>p.x));
      return paths.map(path=>path.map(p=>({x:p.x-minX,y:p.y})));
    };
    const a = normalized(left), b = normalized(right);
    for (const [one,other] of [[a,b],[b,a]]) for (const path of one) {
      assert.ok(path.every(p=>distanceToPaths(p,other)<.01),'Repeated T strokes should agree within .01 mm');
      assert.ok(path.every(p=>distanceToPaths(p,[[path[0],path.at(-1)]])<.015),'T strokes should be straight');
    }
    for (const component of result) {
      const variable = grooveCutPaths(component,{angle:60,depth:3,fixed:false});
      const fixed = grooveCutPaths(component,{angle:60,depth:3,fixed:true});
      assert.deepEqual(variable.map(path=>path.map(mm)),fixed.map(path=>path.map(mm)));
      assert.ok(variable.flat().every(p=>p.z>0 && p.z<=3));
      assert.ok(fixed.flat().every(p=>p.z===3));
    }
  }
});

test('O stays closed and its center remains uncut', () => {
  const [o] = deriveGrooveCenterlines(glyphs(testFont,'O',25));
  assert.equal(o.paths.length,1);
  assert.equal(endpoints(o.paths).size,1);
  assert.ok(o.paths[0].length>8);
  assert.ok(o.paths[0].every(p=>o.radiusAt(p)>.2));
});
