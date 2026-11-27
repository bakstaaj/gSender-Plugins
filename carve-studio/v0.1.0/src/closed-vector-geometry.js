import ClipperLib from 'clipper-lib';
import {flattenTextOutline} from './groove-centerline.js';
import {ellipticalArc, parseNodePath} from './node-editing.js';

const {Clipper, ClipperOffset, ClipType, EndType, JoinType, PolyFillType, PolyTree, PolyType} = ClipperLib;
export const VECTOR_SCALE = 1000;
const CURVE_TOLERANCE = .008;
const OFFSET_MITER_LIMIT = 20;

function divisions(radius, span) {
  const step = Math.min(Math.PI/12, Math.sqrt(8*CURVE_TOLERANCE/radius));
  return Math.min(8192, Math.ceil(Math.abs(span)/step));
}

export function vectorRings(object, stockHeight, geometryPoints) {
  if (object.kind === 'circle' || object.kind === 'ellipse') {
    const rx = object.r ?? object.rx, ry = object.r ?? object.ry;
    const count = divisions(Math.max(rx,ry),2*Math.PI);
    return [Array.from({length:count}, (_,i) => {
      const angle = i*2*Math.PI/count;
      return {x:object.cx+rx*Math.cos(angle), y:object.cy+ry*Math.sin(angle)};
    })];
  }
  if (object.kind !== 'path') return [geometryPoints(object)];
  const contours = vectorPathContours(object,stockHeight);
  if (contours.some(contour => !contour.closed)) {
    throw Error('Close every subpath before combining this SVG vector.');
  }
  return contours.map(contour=>contour.points);
}

export function vectorPathContours(object,stockHeight) {
  const contours = parseNodePath(object.d);
  const sx = object.sx || 1, sy = object.sy || 1;
  const dx = (object.dx || 0)+(object.ox || 0), dy = (object.dy || 0)+(object.oy || 0);
  const place = (x,y) => ({x:x+dx,y:stockHeight-y-dy});
  const placeLocal = ([x,y]) => place(x*sx,y*sy);
  return contours.map(({nodes,closed}) => {
    const points = [placeLocal(nodes[0].point)];
    for (let i=1; i<nodes.length; i++) {
      const node = nodes[i], start = nodes[i-1].point;
      if (node.controls) {
        const d = 'M'+start.join(' ')+' '+node.type+[...node.controls.flat(),...node.point].join(' ');
        for (const {x,y} of flattenTextOutline(d,sx,sy).slice(1)) points.push(place(x,y));
        continue;
      }
      const arc = node.arc && ellipticalArc(start,node.point,node.arc);
      if (arc) {
        const count = divisions(arc.radius*Math.max(Math.abs(sx),Math.abs(sy)),arc.span);
        for (let step=1; step<count; step++) points.push(placeLocal(arc.pointAt(step/count)));
      }
      points.push(placeLocal(node.point));
    }
    const first = points[0], last = points.at(-1);
    const closedAtEnds = !object.centerlineFont && points.length>2 && Math.hypot(first.x-last.x,first.y-last.y)<=.02;
    return {points,closed:closed || (object.outlineClosed && contours.length===1) || closedAtEnds};
  });
}

function clip(type, subject, clipPaths, result, fill = PolyFillType.pftNonZero) {
  const engine = new Clipper(Clipper.ioStrictlySimple);
  engine.AddPaths(subject,PolyType.ptSubject,true);
  if (clipPaths.length) engine.AddPaths(clipPaths,PolyType.ptClip,true);
  if (!engine.Execute(type,result,fill,fill)) throw Error('Could not resolve the selected outlines.');
}

export function normalizeVectorRings(rings) {
  const paths = rings.map(points => points.map(({x,y}) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x)>1e8 || Math.abs(y)>1e8) {
      throw Error('A selected outline has invalid coordinates.');
    }
    return {X:Math.round(x*VECTOR_SCALE),Y:Math.round(y*VECTOR_SCALE)};
  })).filter(path => path.length>=3);
  const normalized = [];
  if (paths.length) clip(ClipType.ctUnion,paths,[],normalized,PolyFillType.pftEvenOdd);
  if (!normalized.length) throw Error('Each selected shape must enclose an area.');
  return normalized;
}

function componentsOf(tree) {
  const components = [];
  const ring = node => node.Contour().map(({X,Y}) => [X/VECTOR_SCALE,Y/VECTOR_SCALE]);
  function visit(node) {
    for (const outer of node.Childs()) {
      components.push([ring(outer),...outer.Childs().map(ring)]);
      for (const hole of outer.Childs()) visit(hole);
    }
  }
  visit(tree);
  return components;
}

export function combineVectorRegions(operation, regions) {
  if (regions.length < 2) throw Error('Select at least two closed shapes.');
  const [base,...others] = regions.map(normalizeVectorRings);
  const tree = new PolyTree();
  if (operation === 'weld') {
    clip(ClipType.ctUnion,[base,...others].flat(),[],tree);
  } else if (operation === 'subtract') {
    clip(ClipType.ctDifference,base,others.flat(),tree);
  } else if (operation === 'intersect') {
    let current = base;
    for (const paths of others.slice(0,-1)) {
      const next = [];
      clip(ClipType.ctIntersection,current,paths,next);
      if (!next.length) return [];
      current = next;
    }
    clip(ClipType.ctIntersection,current,others.at(-1),tree);
  } else {
    throw Error('Unknown outline operation.');
  }
  return componentsOf(tree);
}

export function offsetVectorRegion(rings, distance) {
  // Keep acute letter corners while bounding the extension at nearly parallel edges.
  const offset = new ClipperOffset(OFFSET_MITER_LIMIT);
  offset.AddPaths(normalizeVectorRings(rings),JoinType.jtMiter,EndType.etClosedPolygon);
  const paths = [];
  offset.Execute(paths,distance*VECTOR_SCALE);
  if (!paths.length) return [];
  const tree = new PolyTree();
  clip(ClipType.ctUnion,paths,[],tree);
  return componentsOf(tree);
}
