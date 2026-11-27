import {test} from 'node:test';
import assert from 'node:assert/strict';
import {combineVectorRegions, vectorRings} from '../src/closed-vector-geometry.js';

const rectangle = (x,y,w,h) => [[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]];
const ringArea = ring => Math.abs(ring.reduce((sum,[x,y],i)=>{
  const [nx,ny] = ring[(i+1)%ring.length];
  return sum+x*ny-y*nx;
},0))/2;
const area = components => components.reduce((sum,[outer,...holes])=>
  sum+ringArea(outer)-holes.reduce((subtotal,hole)=>subtotal+ringArea(hole),0),0);

test('weld merges overlapping vectors and retains disjoint components', () => {
  const a = rectangle(0,0,10,10), b = rectangle(5,0,10,10), c = rectangle(20,0,5,5);
  const welded = combineVectorRegions('weld',[a,b,c]);
  assert.equal(welded.length,2);
  assert.equal(area(welded),175);
});

test('subtract preserves nested holes and unions overlapping cutters', () => {
  const a = rectangle(0,0,20,20), b = rectangle(3,3,8,6), c = rectangle(7,3,8,6);
  const cut = combineVectorRegions('subtract',[a,b,c]);
  assert.equal(cut.length,1);
  assert.equal(cut[0].length,2);
  assert.equal(area(cut),328);
  const reusable = cut[0].map(ring=>ring.map(([x,y])=>({x,y})));
  const filledPart = combineVectorRegions('weld',[reusable,rectangle(5,4,2,2)]);
  assert.equal(filledPart.length,2);
  assert.equal(area(filledPart),332);
});

test('intersection finds the area shared by every operand', () => {
  const a = rectangle(0,0,10,10), b = rectangle(5,0,10,10), c = rectangle(6,5,10,10);
  assert.equal(area(combineVectorRegions('intersect',[a,b,c])),20);
  assert.deepEqual(combineVectorRegions('intersect',[a,rectangle(10,0,10,10)]),[]);
  assert.deepEqual(combineVectorRegions('subtract',[a,b,a]),[]);
});

test('sampling preserves sharp SVG endpoints while approximating curves at machining scale', () => {
  const svg = {kind:'path',d:'m0 0 h20 a10 10 0 0 1 0 20 h-20 z',sx:2,dy:10};
  const [ring] = vectorRings(svg,100);
  for (const corner of [{x:0,y:90},{x:40,y:90},{x:40,y:70},{x:0,y:70}]) {
    assert.ok(ring.some(point=>point.x===corner.x && point.y===corner.y));
  }
  assert.ok(Math.abs(ringArea(ring.map(({x,y})=>[x,y]))-(800+Math.PI*100)) < 0.5);
});
