import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restoreToolpathSettings} from '../src/toolpath-settings.js';

test('the shared Flat bottom toggle migrates its depth, passes, cutters and rates', () => {
  const bit = {id:'v-bit',type:'vbit',number:3};
  const endmill = {id:'endmill',type:'endmill',number:4};
  const vgroove = {depth:2.5,safeZ:8,feed:555,plunge:150,rpm:10000};
  const saved = {operations:{vgroove},tools:{vgroove:bit},vgrooveClearanceTool:endmill,
    vgrooveFlatBottom:true,vgrooveFlatStepdown:.65,vgrooveSingleLine:true};
  const settings = restoreToolpathSettings(saved,18);
  assert.deepEqual(settings.operations.vgroove,vgroove);
  assert.deepEqual(settings.operations['vgroove-flat'],{...vgroove,stepdown:.65});
  assert.deepEqual(settings.tools['vgroove-flat'],bit);
  assert.deepEqual(settings.vgrooveClearanceTool,endmill);
  assert.equal(settings.vgrooveSingleLine,true);
  assert.ok(!Object.hasOwn(settings,'vgrooveFlatBottom'));
  settings.operations['vgroove-flat'].depth = 1.25;
  assert.equal(settings.operations.vgroove.depth,2.5);
});

test('reopened jobs preserve separate groove settings and ignore obsolete form properties', () => {
  const saved = {
    operations:{vgroove:{depth:1,feed:500,obsolete:100},'vgroove-flat':{depth:3,feed:900,stepdown:.8}},
    tools:{vgroove:{id:'first'},'vgroove-flat':{id:'second'}}
  };
  const settings = restoreToolpathSettings(saved,18);
  assert.equal(settings.operations.vgroove.depth,1);
  assert.equal(settings.operations.vgroove.feed,500);
  assert.ok(!Object.hasOwn(settings.operations.vgroove,'obsolete'));
  assert.equal(settings.operations['vgroove-flat'].depth,3);
  assert.equal(settings.operations['vgroove-flat'].feed,900);
  assert.equal(settings.operations['vgroove-flat'].stepdown,.8);
  assert.equal(settings.tools['vgroove-flat'].id,'second');
  assert.equal(settings.tools.vgroove.id,'first');
});

test('projects from before flat-bottom grooves retain their standard settings', () => {
  const settings = restoreToolpathSettings({operations:{vgroove:{depth:1.4}},safeZ:9,stepdown:1.8},20);
  assert.equal(settings.operations.vgroove.depth,1.4);
  assert.equal(settings.operations.vgroove.safeZ,9);
  assert.equal(settings.operations.profile.stepdown,1.8);
  assert.equal(settings.operations['vgroove-flat'].depth,6);
  assert.equal(settings.operations['vgroove-flat'].stepdown,1);
});
