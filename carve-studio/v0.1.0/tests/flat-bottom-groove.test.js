import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planFlatBottomGroove,writeFlatGrooveGcode} from '../src/flat-bottom-groove.js';
import {simulateCut} from '../src/cut-simulation.js';

const rect = (x,y,w,h)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}];
const ring = [rect(6,6,42,26),rect(20,14,12,10)];
const rates = {stepdown:1,safeZ:5,feed:800,plunge:250,rpm:12000,comment:'(Flat groove test)'};

function boundaryClearance(x,y) {
  const outside = Math.min(x-6,y-6,48-x,32-y);
  const hole = Math.hypot(Math.max(20-x,x-32,0),Math.max(14-y,y-24,0));
  return Math.min(outside,hole);
}

test('the clearance sweep and V-bit finish stay inside the outline and outside its counter', () => {
  const depth=2, radius=1.5;
  const {clearancePaths,finishPaths,floorPathCount} = planFlatBottomGroove(ring,
    {angle:90,depth,diameter:12.7,clearanceDiameter:radius*2});
  assert.ok(clearancePaths.length && floorPathCount>0);
  assert.ok(clearancePaths.flat().every(point=>point.z===depth));
  for (const [paths,reach] of [[clearancePaths,()=>radius+depth],[finishPaths,z=>z]]) {
    for (const path of paths) {
      for (let i=0; i<path.length; i++) {
        const a=path[i], b=path[i+1]||a;
        for (const t of [0,.25,.5,.75,1]) {
          const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t, z=a.z+(b.z-a.z)*t;
          assert.ok(z<=depth && boundaryClearance(x,y)>=reach(z)-.004,
            `tool footprint crosses an outline at ${x},${y},${z}`);
        }
      }
    }
  }
});

test('cut simulation shows a flat floor, a sloped wall, and intact material inside a counter', async () => {
  const depth=2;
  const {clearancePaths,finishPaths} = planFlatBottomGroove(ring,
    {angle:90,depth,diameter:12.7,clearanceDiameter:3});
  const jobs = [
    {operation:'vgroove-clearance',tool:{diameter:3},gcode:writeFlatGrooveGcode(clearancePaths,rates)},
    {operation:'vgroove-flat',tool:{diameter:12.7,angle:90},gcode:writeFlatGrooveGcode(finishPaths,rates)}
  ];
  const grid = await simulateCut({width:55,height:39,thickness:6},jobs);
  const at=(x,y)=>grid.depths[Math.floor(y/grid.cellHeight)*grid.columns+Math.floor(x/grid.cellWidth)];
  assert.equal(grid.count,2);
  assert.ok(at(12,20)>1.98 && at(42,20)>1.98 && at(12,8.5)>1.93);
  assert.ok(at(12,7)>.85 && at(12,7)<1.1);
  assert.equal(at(26,19),0);
  assert.equal(at(12,5),0);
});

test('narrow strokes retain variable-depth cuts and an oversized end mill leaves V-bit-only clearing', () => {
  const narrow = planFlatBottomGroove([rect(0,0,25,1.5)],{angle:60,depth:2,diameter:6,clearanceDiameter:3});
  assert.equal(narrow.floorPathCount,0);
  assert.equal(narrow.clearancePaths.length,0);
  assert.ok(narrow.finishPaths.flat().every(point=>point.z<1.3));
  const small = planFlatBottomGroove([rect(0,0,12,8)],{angle:90,depth:1.5,diameter:6,clearanceDiameter:10});
  assert.equal(small.clearancePaths.length,0);
  assert.ok(small.floorPathCount>0);
  assert.throws(()=>planFlatBottomGroove([rect(0,0,12,8)],{angle:90,depth:4,diameter:6}),
    /exceeds the cutting diameter/);
});

test('the post retracts before XY rapids and keeps cut depth within the pass limit', () => {
  const paths = [[{x:4,y:4,z:2.3},{x:5,y:4,z:2.3}]];
  const lines = writeFlatGrooveGcode(paths,{...rates,stepdown:.8564}).trim().split('\n');
  const entries = lines.flatMap((line,i)=>{
    if (!line.startsWith('G0 X')) return [];
    assert.equal(lines[i-1],'G0 Z5.000');
    return [Number(lines[i+1].match(/Z-([\d.]+)/)[1])];
  });
  assert.deepEqual(entries,[.856,1.712,2.3]);
  assert.deepEqual(lines.slice(-3),['G0 Z5.000','M5','M30']);
});
