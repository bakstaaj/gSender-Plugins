import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionDurationMs, advanceMotion } from './motion-timing.js';

test('probe feed and distance determine the 1× travel time',()=>{
  assert.equal(motionDurationMs([0,0,0],[0,0,-30],false,100,[2000,2000,2000]),18000);
  assert.equal(motionDurationMs([0,0,0],[0,0,-15],false,100,[2000,2000,2000]),9000);
});
test('rapid travel respects each axis maximum',()=>{
  assert.equal(motionDurationMs([0,0,0],[30,10,0],true,100,[2000,500,2000]),1200);
});
test('multipliers scale travel and can change while moving',()=>{
  const duration=12000;
  assert.equal(advanceMotion(0,1000,1,duration),1/12);
  assert.equal(advanceMotion(0,1000,4,duration),1/3);
  assert.equal(advanceMotion(0,1000,12,duration),1);
  assert.equal(advanceMotion(2000,500,4,duration),1/3);
  assert.equal(advanceMotion(0,500,30,duration),1);
  assert.equal(advanceMotion(0,1,1,0),1);
});
