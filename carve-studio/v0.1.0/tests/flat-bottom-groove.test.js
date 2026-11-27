import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flatGrooveDepthLimit,planFlatBottomGroove,writeFlatGrooveGcode} from '../src/flat-bottom-groove.js';
import {selectCutPreviewJobs,simulateCut} from '../src/cut-simulation.js';

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

test('the finishing preview includes the matching clearance and retains the flat floor', async () => {
  const depth=2;
  const {clearancePaths,finishPaths} = planFlatBottomGroove([rect(8,8,42,12)],
    {angle:60,depth,diameter:3.175,clearanceDiameter:3});
  const clearance = {id:1,operation:'vgroove-clearance',tool:{diameter:3},gcode:writeFlatGrooveGcode(clearancePaths,rates)};
  const otherClearance = {...clearance,id:2,gcode:['G0 Z5', 'G0 X28 Y26', 'G1 Z-3'].join('\n')};
  const finish = {id:3,requiresJobId:1,operation:'vgroove-flat',tool:{diameter:3.175,angle:60},
    gcode:writeFlatGrooveGcode(finishPaths,rates)};
  const selected = selectCutPreviewJobs([clearance,otherClearance,finish],'3');
  assert.deepEqual(selected.jobs,[clearance,finish]);
  assert.equal(selected.clearance,clearance);
  const stock = {width:56,height:32,thickness:6};
  const [combined,finishOnly] = await Promise.all([simulateCut(stock,selected.jobs),simulateCut(stock,[finish])]);
  const at=(grid,x,y)=>grid.depths[Math.floor(y/grid.cellHeight)*grid.columns+Math.floor(x/grid.cellWidth)];
  assert.equal(at(combined,28,16),2);
  assert.equal(at(combined,28,14),2);
  assert.ok(at(combined,28,8.7)>.8 && at(combined,28,8.7)<1.6);
  assert.equal(at(combined,28,26),0);
  assert.ok(at(finishOnly,28,16)<1);
  assert.equal(selectCutPreviewJobs([otherClearance,finish],'3').missingClearance,true);
  assert.deepEqual(selectCutPreviewJobs([clearance,finish],'1').jobs,[clearance]);
  assert.deepEqual(selectCutPreviewJobs([clearance,{...finish,requiresJobId:undefined}],'3').jobs,
    [{...finish,requiresJobId:undefined}]);
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
    /allows up to 3\.000 mm/);
});

test('a 60-degree, 3.175 mm V-bit reports a usable depth below the geometric limit', () => {
  const options = {angle:60,diameter:3.175,clearanceDiameter:3};
  const {maximum,ncDepth,stockLimited} = flatGrooveDepthLimit(options.angle,options.diameter,12);
  assert.equal(stockLimited,false);
  assert.equal(ncDepth,2.749);
  assert.ok(maximum>ncDepth && maximum<2.75);
  assert.throws(()=>planFlatBottomGroove(ring,{...options,depth:3}),
    /allows up to 2\.749 mm.*at least 3\.465 mm/);
  const result = planFlatBottomGroove(ring,{...options,depth:ncDepth});
  assert.ok(result.clearancePaths.length && result.floorPathCount);
  assert.equal(flatGrooveDepthLimit(options.angle,options.diameter,2.125).ncDepth,2.125);
  assert.equal(flatGrooveDepthLimit(options.angle,options.diameter,2.125).stockLimited,true);
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
