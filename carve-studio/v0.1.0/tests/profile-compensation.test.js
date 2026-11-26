import assert from 'node:assert/strict';
import test from 'node:test';
import {compensateProfile} from '../src/profile-compensation.js';

function rectangle(left,bottom,right,top) {
  return {closed:true,points:[
    {x:left,y:bottom},{x:right,y:bottom},{x:right,y:top},{x:left,y:top},{x:left,y:bottom},
  ]};
}

function bounds({points}) {
  const xs=points.map(point=>point.x), ys=points.map(point=>point.y);
  assert.deepEqual(points[0],points.at(-1));
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}

test('profile offsets the cutter center by half the diameter on either side',()=>{
  const input=[rectangle(10,10,70,40)];
  assert.equal(compensateProfile(input,'on',0),input);
  assert.deepEqual(bounds(compensateProfile(input,'outside',6)[0]),[7,7,73,43]);
  assert.deepEqual(bounds(compensateProfile(input,'inside',6)[0]),[13,13,67,37]);
  assert.deepEqual(bounds(input[0]),[10,10,70,40]);
});

test('nested holes reverse the cut side and run before the outside outline',()=>{
  const outer=rectangle(0,0,60,60);
  const hole=rectangle(15,15,45,45);
  const island=rectangle(25,25,35,35);
  const input=[outer,hole,island];
  hole.points.reverse();
  assert.deepEqual(compensateProfile(input,'outside',4).map(bounds),[
    [23,23,37,37],[17,17,43,43],[-2,-2,62,62],
  ]);
  assert.deepEqual(compensateProfile(input,'inside',4).map(bounds),[
    [27,27,33,33],[13,13,47,47],[2,2,58,58],
  ]);
});

test('rejects an open, crossing, overlapping, collapsed or merged compensated contour',()=>{
  assert.throws(()=>compensateProfile([{...rectangle(0,0,20,20),closed:false}],'inside',4),/closed contours/);
  const points=[{x:0,y:0},{x:20,y:20},{x:0,y:20},{x:20,y:0},{x:0,y:0}];
  assert.throws(()=>compensateProfile([{closed:true,points}],'outside',4),/crosses itself/);
  assert.throws(()=>compensateProfile([rectangle(0,0,20,20),rectangle(10,10,30,30)],'outside',4),/overlap/);
  assert.throws(()=>compensateProfile([rectangle(0,0,4,20)],'inside',5),/changes the profile boundaries/);
  assert.throws(()=>compensateProfile([rectangle(0,0,20,20),rectangle(22,0,42,20)],'outside',4),/changes the profile boundaries/);
});
