import ClipperLib from 'clipper-lib';
import {normalizeVectorRings, VECTOR_SCALE as SCALE} from './closed-vector-geometry.js';
import {deriveGrooveCenterlines} from './groove-centerline.js';

const {Clipper, ClipperOffset, ClipType, EndType, JoinType, PolyFillType, PolyType} = ClipperLib;
const GEOMETRY_MARGIN = .02;
const MAX_MOVES = 200_000;
const length = (a,b) => Math.hypot(b.x-a.x,b.y-a.y);
const depthWord = value => (Math.floor(value*1000+1e-7)/1000).toFixed(3);

export function flatGrooveDepthLimit(angle,diameter,stockThickness=Infinity) {
  const bitDepth = diameter/(2*Math.tan(angle*Math.PI/360));
  const maximum = Math.min(bitDepth,stockThickness);
  return {maximum,ncDepth:Number(depthWord(maximum)),stockLimited:stockThickness<bitDepth};
}

function inset(paths,amount) {
  if (!paths.length) return [];
  const offset = new ClipperOffset(2, .002*SCALE);
  offset.AddPaths(paths,JoinType.jtRound,EndType.etClosedPolygon);
  const result = [];
  offset.Execute(result,-amount*SCALE);
  return result;
}

function raster(paths,spacing) {
  if (!paths.length) return [];
  const {top,bottom} = Clipper.GetBounds(paths);
  const rows = Math.max(1,Math.ceil((bottom-top)/(spacing*SCALE)));
  if (rows>20_000) throw Error('The floor needs too many clearing passes. Select a clearance end mill or machine fewer outlines at a time.');
  const edges = paths.flatMap(ring=>ring.flatMap((a,i)=>{
    const b = ring[(i+1)%ring.length];
    if (a.Y===b.Y) return [];
    const [low,high] = a.Y<b.Y ? [a,b] : [b,a];
    return [{low,high}];
  })).sort((a,b)=>a.low.Y-b.low.Y);
  const strokes = [];
  let edgeIndex = 0, active = [], previous = new Map();
  for (let row=0; row<rows; row++) {
    const Y = top+(row+.5)*(bottom-top)/rows;
    while (edges[edgeIndex]?.low.Y<=Y) active.push(edges[edgeIndex++]);
    active = active.filter(edge=>edge.high.Y>Y);
    const hits = active.map(edge=>{
      const {low,high} = edge;
      return {X:low.X+(high.X-low.X)*(Y-low.Y)/(high.Y-low.Y),Y,edge};
    }).sort((a,b)=>a.X-b.X);
    if (row%2) hits.reverse();
    const next = new Map();
    for (let i=0; i<hits.length-1; i+=2) {
      let a = hits[i], b = hits[i+1];
      if (Math.abs(a.X-b.X)<1) continue;
      if (!previous.has(a.edge) && previous.has(b.edge)) [a,b] = [b,a];
      // A connector along the same boundary edge stays in the allowed region.
      let stroke = previous.get(a.edge);
      if (stroke) previous.delete(a.edge);
      else {
        stroke = [];
        strokes.push(stroke);
      }
      stroke.push({X:a.X,Y},{X:b.X,Y});
      next.set(b.edge,stroke);
    }
    previous = next;
  }
  return strokes;
}

function remainingFloor(floor, centers, strokes, cutterRadius) {
  if (!centers.length || cutterRadius<=GEOMETRY_MARGIN) return floor;
  const sweep = new ClipperOffset(2, .004*SCALE);
  const integerStrokes = strokes.map(path=>path.map(({X,Y})=>({X:Math.round(X),Y:Math.round(Y)})));
  sweep.AddPaths(integerStrokes,JoinType.jtRound,EndType.etOpenRound);
  sweep.AddPaths(centers,JoinType.jtRound,EndType.etClosedLine);
  const covered = [];
  sweep.Execute(covered,(cutterRadius-GEOMETRY_MARGIN)*SCALE);
  if (!covered.length) return floor;
  const clipper = new Clipper(Clipper.ioStrictlySimple);
  clipper.AddPaths(floor,PolyType.ptSubject,true);
  clipper.AddPaths(covered,PolyType.ptClip,true);
  const result = [];
  if (!clipper.Execute(ClipType.ctDifference,result,PolyFillType.pftNonZero,PolyFillType.pftNonZero)) {
    throw Error('Could not calculate the remaining groove floor.');
  }
  return result;
}

function constantDepth(strokes,boundaries,depth) {
  return [...strokes,...boundaries.map(path=>[...path,path[0]])].map(path=>
    path.map(({X,Y})=>({x:X/SCALE,y:Y/SCALE,z:depth})));
}

function vBitStrokes(components,depth,slope) {
  return components.flatMap(component=>component.paths.map(path=>{
    const points = [path[0]];
    for (let i=1; i<path.length; i++) {
      const a=path[i-1], b=path[i];
      const count=Math.ceil(length(a,b)/.15);
      for (let step=1; step<=count; step++) {
        const t=step/count;
        points.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
      }
    }
    return points.map((point,i)=>{
      // Distance to the boundary can drop between stations. Reserve half
      // the adjacent move length so interpolated Z stays inside the outline.
      const adjacent=Math.max(length(point,points[i-1]||point),length(point,points[i+1]||point));
      const radius=Math.max(0,component.radiusAt(point)-adjacent/2-GEOMETRY_MARGIN);
      return {...point,z:Math.min(depth,radius/slope)};
    });
  })).filter(path=>path.some(point=>point.z>=.001));
}

export function planFlatBottomGroove(rings,{angle,depth,diameter,clearanceDiameter=0}) {
  if (![angle,depth,diameter].every(value=>Number.isFinite(value)&&value>0) || angle>=180 ||
    !Number.isFinite(clearanceDiameter) || clearanceDiameter<0) throw Error('Enter valid cutters and a positive flat depth.');
  const slope = Math.tan(angle*Math.PI/360);
  const radiusAtSurface = depth*slope;
  if (radiusAtSurface>diameter/2+1e-9) {
    const {ncDepth} = flatGrooveDepthLimit(angle,diameter);
    const requiredDiameter = Math.ceil(radiusAtSurface*2000-1e-7)/1000;
    throw Error(`The selected ${angle}° V-bit with a ${diameter} mm cutting diameter allows up to ${ncDepth.toFixed(3)} mm flat depth. A ${depth.toFixed(3)} mm flat depth needs a cutting diameter of at least ${requiredDiameter.toFixed(3)} mm at the same angle.`);
  }
  const outline = normalizeVectorRings(rings);
  const floor = inset(outline,radiusAtSurface+GEOMETRY_MARGIN);
  const cutterRadius = clearanceDiameter/2;
  const centers = cutterRadius ? inset(floor,cutterRadius+GEOMETRY_MARGIN) : [];
  const clearing = cutterRadius ? raster(centers,clearanceDiameter/2) : [];
  const rest = remainingFloor(floor,centers,clearing,cutterRadius);
  const floorPaths = constantDepth(raster(rest,Math.min(.25,.08*slope)),rest,depth);
  const groovePaths = vBitStrokes(deriveGrooveCenterlines(rings),depth,slope);
  const finishPaths = [...groovePaths,...floorPaths];
  if (!finishPaths.length) throw Error('No usable V-bit path could be derived for these outlines.');
  return {clearancePaths:constantDepth(clearing,centers,depth),finishPaths,floorPathCount:floorPaths.length};
}

export function writeFlatGrooveGcode(paths,{stepdown,safeZ,feed,plunge,rpm,comment}) {
  if (![stepdown,safeZ,feed,plunge,rpm].every(value=>Number.isFinite(value)&&value>0) ||
    stepdown<.001 || safeZ<.001 || feed<.1 || plunge<.1 || rpm<1) {
    throw Error('Enter valid pass depth, clearance, feeds and speed.');
  }
  const records = paths.map(path=>({path,depth:path.reduce((max,p)=>Math.max(max,p.z),0)}));
  const maxDepth = records.reduce((max,item)=>Math.max(max,item.depth),0);
  const step = Number(depthWord(stepdown));
  const levels = Math.ceil(maxDepth/step-1e-9);
  const moves = records.reduce((count,{depth,path})=>count+(path.length+2)*Math.ceil(depth/step-1e-9),0);
  if (moves>MAX_MOVES) throw Error('The flat-bottom job is too dense. Use a clearance end mill or generate fewer outlines at a time.');
  const rapid = 'G0 Z'+safeZ.toFixed(3);
  const lines = [comment,'G21 G90 G17 G94',rapid,'M3 S'+Math.round(rpm)];
  for (let pass=1; pass<=levels; pass++) {
    const cap = pass*step;
    for (const {path,depth} of records) {
      if (depth<=Math.max(.000999,(pass-1)*step+1e-9)) continue;
      const [first,...rest] = path;
      const z = p=>depthWord(Math.min(p.z,cap));
      lines.push(rapid,`G0 X${first.x.toFixed(3)} Y${first.y.toFixed(3)}`,`G1 Z-${z(first)} F${plunge.toFixed(1)}`);
      for (const p of rest) lines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z-${z(p)} F${feed.toFixed(1)}`);
    }
  }
  return [...lines,rapid,'M5','M30'].join('\n')+'\n';
}
