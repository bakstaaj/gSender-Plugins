import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildSnapGeometry, nearestSnap} from '../src/object-snapping.js';

const segment = (a,b)=>buildSnapGeometry({kind:'line'},[{points:[a,b],closed:false}]);

test('finds endpoints and edge midpoints without changing the geometry coordinates',()=>{
  const line=segment({x:3.25,y:7.75},{x:17.25,y:9.75});
  assert.deepEqual(nearestSnap({x:3,y:8},1,[line]),{x:3.25,y:7.75,kind:'endpoint'});
  assert.deepEqual(nearestSnap({x:10.3,y:8.5},1,[line]),{x:10.25,y:8.75,kind:'midpoint'});
  assert.equal(nearestSnap({x:7,y:9},1,[line]),null);
});

test('finds exact crossings and native circle centers and quadrants',()=>{
  const horizontal=segment({x:0,y:3},{x:10,y:3});
  const vertical=segment({x:4,y:0},{x:4,y:10});
  assert.deepEqual(nearestSnap({x:3.8,y:3.1},1,[horizontal,vertical]),{x:4,y:3,kind:'intersection'});

  const circle=buildSnapGeometry({kind:'circle',cx:7,cy:5,r:4},[]);
  assert.deepEqual(nearestSnap({x:7.1,y:4.8},1,[circle]),{x:7,y:5,kind:'center'});
  assert.deepEqual(nearestSnap({x:7.1,y:8.8},1,[circle]),{x:7,y:9,kind:'quadrant'});
  const hit=nearestSnap({x:3.5,y:3.1},.5,[horizontal,circle]);
  assert.equal(hit.kind,'intersection');
  assert.ok(Math.abs(hit.x-(7-Math.sqrt(12)))<1e-12);
});

test('separate SVG contours create no phantom crossing between strokes',()=>{
  const shape=buildSnapGeometry({kind:'path'},[
    {points:[{x:1,y:1},{x:2,y:1}]},
    {points:[{x:8,y:8},{x:9,y:8}]}
  ]);
  const crossing=segment({x:5,y:3},{x:5,y:9});
  assert.equal(nearestSnap({x:5,y:4.5},.6,[shape,crossing]),null);
});
