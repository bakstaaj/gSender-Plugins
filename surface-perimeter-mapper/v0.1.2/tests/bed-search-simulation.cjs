const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const routine = source.slice(source.indexOf('async function findBedFromFrontEdge('), source.indexOf('async function waitForSurfaceProbeRecovery('));

async function run(shape, boxHeight, frontExtent, bedStartsAt, noContact = false) {
  const positions = [], diagnostics = [];
  const cfg = { partShape: shape, diameter: 2, rectangleHeight: boxHeight, minThickness: 6.4, selectedHeight: 3.2, fastFeed: 100 };
  const state = { wposZeroMachine: [0,0,-31.5], probePinKnown: true, probePinActive: false, stopScan: false, probeStatusSequence: 1 };
  let y = 0;
  const snapshot = () => ({state:'Idle',wpos:[0,y,1.6],mpos:[0,y,-29.9]});
  const ctx = { state, Math, Number, Error, PERIMETER_RELEASE_DIAMETER_FACTOR:.75, Z_LIMIT_MARGIN:.5,
    $:()=>({textContent:''}), checkScanTravel:()=>{}, logHomingDiagnostic:(kind,data)=>diagnostics.push({kind,data}),
    scanMove:async target=>{y=target[1];return snapshot();}, currentSnapshot:async()=>snapshot(),
    machine:{query:async()=>{positions.push(y);return {complete:true,ok:true,lines:['ok']};}},
    parseOptionalProbe:()=>noContact ? null : {triggered:true,mpos:[0,y,y<=bedStartsAt ? -38 : -31.5]},
    refreshScanStatus:async()=>snapshot(), waitForProbeClearAfterRetract:async()=>snapshot()
  };
  vm.createContext(ctx);vm.runInContext(routine,ctx);
  try { const result=await ctx.findBedFromFrontEdge({cfg,limits:{zHomePositive:true,z:{min:-39,max:0}},safeZ:1.6,frontExtent});return {positions,result,diagnostics}; }
  catch(error){return {positions,error:error.message,diagnostics};}
}

(async()=>{
  for(const shape of ['circle','square','rectangle','triangle']){
    const result=await run(shape,60,25,-30);
    assert.equal(result.error,undefined);assert.deepEqual(result.positions,[-26.5,-28,-29.5,-30]);assert.equal(result.result.wposY,-30);
    console.log(`${shape}: found bed on exact boundary after ${result.positions.length} touches`);
  }
  const failed=await run('triangle',60,25,-31.4);
  assert.match(failed.error,/No bed found by the search-box boundary/);assert.deepEqual(failed.positions,[-26.5,-28,-29.5,-30]);
  const correctSize=await run('triangle',70.622,30.311,-31.311);
  assert.equal(correctSize.error,undefined);assert.ok(correctSize.result.wposY >= -35.311);
  const lostSignal=await run('circle',60,25,-30,true);
  assert.match(lostSignal.error,/No bed contact/);assert.equal(lostSignal.positions.length,1);
  console.log('undersized box stops at its limit; correct equilateral dimensions reach bed; missing contact stops');
})().catch(error=>{console.error(error);process.exitCode=1;});
