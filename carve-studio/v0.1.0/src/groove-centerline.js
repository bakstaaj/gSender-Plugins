import { Delaunay } from 'd3-delaunay';
import ClipperLib from 'clipper-lib';

const EPSILON = 1e-7;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t});
const cross = (a, b, c) => (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);

function segmentDistanceSquared(p, a, b) {
  const dx = b.x-a.x, dy = b.y-a.y;
  const length = dx*dx + dy*dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy)/length)) : 0;
  return (p.x-a.x-t*dx)**2 + (p.y-a.y-t*dy)**2;
}

// Carve Studio's text paths use absolute M/L/Q/C/Z. Flatten the actual curves
// before sampling, so resampling does not just subdivide existing facets.
export function flattenTextOutline(d, scaleX = 1, scaleY = 1) {
  const tokens = d.match(/[MLQCZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) || [];
  const result = [];
  let index = 0;
  const read = () => ({x: Number(tokens[index++])*scaleX, y: Number(tokens[index++])*scaleY});
  function flatten(points, recursion = 0) {
    const a = points[0], b = points.at(-1);
    if (recursion === 16 || points.slice(1, -1).every(p => segmentDistanceSquared(p, a, b) <= .008**2)) {
      result.push(b);
      return;
    }
    const left = [a], right = [b];
    while (points.length > 1) {
      points = points.slice(1).map((p, i) => lerp(points[i], p, .5));
      left.push(points[0]);
      right.push(points.at(-1));
    }
    flatten(left, recursion+1);
    flatten(right.reverse(), recursion+1);
  }
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M' || command === 'L') result.push(read());
    else if (command === 'Q' || command === 'C') {
      const a = result.at(-1), b = read(), c = read();
      flatten(command === 'Q' ? [a,b,c] : [a,b,c,read()]);
    } else if (command === 'Z' && result.length) result.push(result[0]);
    else return [];
  }
  return result;
}

function inkComponents(rings) {
  const scale = 100000;
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  const paths = rings.map(ring => ring.map(({x,y}) => ({X: Math.round(x*scale), Y: Math.round(y*scale)})));
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
  const components = [];
  function visit(node) {
    const contour = n => n.Contour().map(({X,Y}) => ({x:X/scale, y:Y/scale}));
    for (const outer of node.Childs()) {
      components.push([contour(outer), ...outer.Childs().map(contour)]);
      for (const hole of outer.Childs()) visit(hole);
    }
  }
  visit(tree);
  return components;
}

function boundaryOf(rings) {
  const edges = rings.flatMap(ring => ring.map((a,i) => {
    const b = ring[(i+1)%ring.length];
    return {a,b, x0:Math.min(a.x,b.x), x1:Math.max(a.x,b.x), y0:Math.min(a.y,b.y), y1:Math.max(a.y,b.y)};
  }));
  const inside = p => {
    let parity = false;
    for (const {a,b,y0,y1,x1} of edges) {
      if (p.y >= y0 && p.y < y1 && p.x < x1 && p.x < a.x + (p.y-a.y)*(b.x-a.x)/(b.y-a.y)) parity = !parity;
    }
    return parity;
  };
  const radius = p => {
    let best = Infinity;
    for (const {a,b,x0,x1,y0,y1} of edges) {
      const dx = Math.max(x0-p.x, 0, p.x-x1), dy = Math.max(y0-p.y, 0, p.y-y1);
      if (dx*dx+dy*dy < best) best = Math.min(best, segmentDistanceSquared(p,a,b));
    }
    return Math.sqrt(best);
  };
  function allows(a,b) {
    if (distance(a,b) < Math.max(a.radius || 0, b.radius || 0) - EPSILON) return true;
    const x0 = Math.min(a.x,b.x), x1 = Math.max(a.x,b.x), y0 = Math.min(a.y,b.y), y1 = Math.max(a.y,b.y);
    for (const e of edges) {
      if (x0 > e.x1 || x1 < e.x0 || y0 > e.y1 || y1 < e.y0) continue;
      if (cross(a,b,e.a)*cross(a,b,e.b) <= 0 && cross(e.a,e.b,a)*cross(e.a,e.b,b) <= 0) return false;
    }
    return true;
  }
  return {edges, inside, radius, allows};
}

function voronoiGraph(boundary, step) {
  const sites = [];
  for (const {a,b} of boundary.edges) {
    const pieces = Math.max(1, Math.ceil(distance(a,b)/step - EPSILON));
    for (let i=0; i<pieces; i++) sites.push(lerp(a,b,i/pieces));
  }
  sites.sort((a,b) => a.x-b.x || a.y-b.y);
  const {triangles, halfedges} = Delaunay.from(sites, p=>p.x, p=>p.y);
  const nodes = new Map(), centers = [];
  for (let i=0; i<triangles.length; i+=3) {
    const [a,b,c] = [sites[triangles[i]], sites[triangles[i+1]], sites[triangles[i+2]]];
    if (!c) continue;
    const d = 2*cross(a,b,c);
    if (Math.abs(d) < 1e-12) continue;
    const u = (b.x-a.x)**2 + (b.y-a.y)**2, v = (c.x-a.x)**2 + (c.y-a.y)**2;
    const p = {x:a.x+(u*(c.y-a.y)-v*(b.y-a.y))/d, y:a.y+(v*(b.x-a.x)-u*(c.x-a.x))/d};
    if (!boundary.inside(p)) continue;
    const key = `${Math.round(p.x*1e6)},${Math.round(p.y*1e6)}`;
    if (!nodes.has(key)) nodes.set(key, {...p, radius:boundary.radius(p), links:new Map()});
    centers[i/3] = nodes.get(key);
  }
  for (let e=0; e<halfedges.length; e++) {
    const twin = halfedges[e];
    if (twin <= e) continue;
    const a = centers[Math.floor(e/3)], b = centers[Math.floor(twin/3)];
    // Keep even tiny internal edges. Dropping them first breaks real strokes.
    if (!a || !b || a === b || a.links.has(b) || !boundary.allows(a,b)) continue;
    const edge = {length:distance(a,b), span:distance(sites[triangles[e]],sites[triangles[twin]])};
    a.links.set(b,edge);
    b.links.set(a,edge);
  }
  return [...nodes.values()];
}

function pruneLeaves(nodes, step) {
  let leaves = nodes.filter(node => node.links.size === 1);
  while (leaves.length) {
    const removals = new Map();
    for (const leaf of leaves) {
      if (leaf.links.size !== 1) continue;
      const branch = [leaf];
      let tip = leaf, previous = null, length = 0, opposing = 0;
      do {
        const [neighbor, edge] = [...tip.links].find(([node]) => node !== previous);
        length += edge.length;
        if (edge.span > .92*(tip.radius+neighbor.radius)) opposing += edge.length;
        previous = tip;
        tip = neighbor;
        if (tip.links.size === 2) branch.push(tip);
      } while (tip.links.size === 2);
      if (tip.links.size < 3) continue;
      // Terminal corner forks are shorter than the local stroke width and
      // touch adjacent sides. A real arm has opposing contacts or persists.
      if (length > Math.max(2.2*tip.radius, step*3) || opposing > Math.max(.35*tip.radius,step*1.5)) continue;
      if (!removals.has(tip)) removals.set(tip,[]);
      removals.get(tip).push(branch);
    }
    leaves = [];
    for (const [tip,branches] of removals) {
      for (const branch of branches) for (const node of branch) {
        for (const neighbor of node.links.keys()) neighbor.links.delete(node);
        node.links.clear();
      }
      if (tip.links.size === 1) leaves.push(tip);
    }
  }
}

function traceBranches(nodes) {
  const used = new Set(), branches = [];
  function trace(start,neighbor) {
    const points = [start];
    let a = start, b = neighbor;
    while (!used.has(a.links.get(b))) {
      used.add(a.links.get(b));
      points.push(b);
      if (b.links.size !== 2) break;
      [a,b] = [b,[...b.links.keys()].find(node => node !== a)];
    }
    if (points.length > 1) branches.push(points);
  }
  for (const node of nodes) if (node.links.size !== 2) for (const neighbor of node.links.keys()) trace(node,neighbor);
  for (const node of nodes) for (const neighbor of node.links.keys()) trace(node,neighbor);
  return branches;
}

function connectedGraph(nodes, step) {
  const visited = new Set(), components = [];
  for (const start of nodes) {
    if (visited.has(start) || !start.links.size) continue;
    const pending = [start], component = [];
    visited.add(start);
    let length = 0, radius = 0;
    while (pending.length) {
      const node = pending.pop();
      component.push(node);
      radius = Math.max(radius,node.radius);
      for (const [next,edge] of node.links) {
        length += edge.length/2;
        if (!visited.has(next)) {visited.add(next); pending.push(next);}
      }
    }
    components.push({component,length,radius});
  }
  if (components.length <= 1) return components[0]?.component || [];
  const substantial = components.filter(c => c.radius > 1.5*step || c.length > 2*step);
  if (substantial.length === 1) return substantial[0].component;
  return null;
}

function smoothBranch(points, boundary, step) {
  const lengths = [0];
  for (let i=1; i<points.length; i++) lengths.push(lengths.at(-1)+distance(points[i-1],points[i]));
  const length = lengths.at(-1), closed = points[0] === points.at(-1) && points[0].links.size === 2;
  const count = Math.max(closed ? 6 : 1, Math.ceil(length/step));
  let segment = 1;
  const samples = Array.from({length:count+1}, (_,i) => {
    if (i === 0) return points[0];
    if (i === count) return points.at(-1);
    const d = i*length/count;
    while (lengths[segment] < d) segment++;
    return lerp(points[segment-1],points[segment],(d-lengths[segment-1])/(lengths[segment]-lengths[segment-1]));
  });
  for (let pass=0; pass<3; pass++) {
    const before = samples.slice();
    for (let i=closed ? 0 : 1; i<count; i++) {
      const a = before[(i+count-1)%count], b = before[i], c = before[i+1 === count && closed ? 0 : i+1];
      const moved = lerp(b,lerp(a,c,.5),.5);
      if (boundary.inside(moved) && boundary.allows(samples[(i+count-1)%count],moved) && boundary.allows(moved,samples[i+1 === count && closed ? 0 : i+1])) samples[i] = moved;
    }
    if (closed) samples[count] = samples[0];
  }
  if (!samples.slice(1).every((p,i) => boundary.allows(samples[i],p))) return points;
  // Keep curve error bounded. A truly straight run reduces to one move.
  const keep = new Set([0,count]), pending = [[0,count]];
  while (pending.length) {
    const [first,last] = pending.pop();
    if (last-first < 2) continue;
    let split = -1, error = .018**2;
    for (let i=first+1; i<last; i++) {
      const deviation = segmentDistanceSquared(samples[i],samples[first],samples[last]);
      if (deviation > error) {error = deviation; split = i;}
    }
    if (split < 0 && !boundary.allows(samples[first],samples[last])) split = (first+last)>>1;
    if (split >= 0) {keep.add(split); pending.push([first,split],[split,last]);}
  }
  return samples.filter((_,i) => keep.has(i));
}

function pointAlong(points, target) {
  let length = 0;
  for (let i=1; i<points.length; i++) {
    const segment = distance(points[i-1],points[i]);
    if (Math.abs(length+segment-target)<EPSILON) return points[i];
    if (length+segment > target && segment > 0) return lerp(points[i-1],points[i],(target-length)/segment);
    length += segment;
  }
  return points.at(-1);
}

function fitStraightJunctions(branches,boundary) {
  const junctions = new Map();
  branches.forEach((path,index) => {
    if (path[0] === path.at(-1)) return;
    for (const reverse of [false,true]) {
      const points = reverse ? [...path].reverse() : path, node = points[0];
      if (node.links.size !== 3) continue;
      const length = points.slice(1).reduce((sum,p,i) => sum+distance(p,points[i]),0);
      const nearDistance = Math.min(1.55*node.radius,length*.67);
      const farDistance = Math.min(2.8*node.radius,points.at(-1).links?.size === 1 ? length : length*.72);
      const near = pointAlong(points,Math.min(nearDistance,farDistance*.8));
      const far = pointAlong(points,farDistance);
      if (!junctions.has(node)) junctions.set(node,[]);
      junctions.get(node).push({index,reverse,near,far,nearDistance:Math.min(nearDistance,farDistance*.8),farDistance});
    }
  });
  for (const [node,arms] of junctions) {
    if (arms.length !== 3) continue;
    for (let i=0; i<3; i++) {
      const stem = arms[i], left = arms[(i+1)%3], right = arms[(i+2)%3];
      const a = left.far, b = right.far, span = distance(a,b);
      const radius = node.radius, tolerance = Math.max(.012,radius*.016);
      if (span < 2*radius || [left.near,right.near].some(p=>segmentDistanceSquared(p,a,b)>tolerance**2)) continue;
      const dx = b.x-a.x, dy = b.y-a.y, t = ((node.x-a.x)*dx+(node.y-a.y)*dy)/span**2;
      const joint = lerp(a,b,t);
      if (t < .2 || t > .8 || distance(joint,node) > .55*radius || !boundary.inside(joint) || !boundary.allows(a,b)) continue;
      const changes = [];
      for (const arm of [left,right,stem]) {
        const path = branches[arm.index], directed = arm.reverse ? [...path].reverse() : path;
        const anchor = arm === stem ? arm.near : arm.far;
        const cutoff = arm === stem ? arm.nearDistance : arm.farDistance;
        let length = 0;
        const tail = directed.slice(1).filter((p,j) => {
          length += distance(p,directed[j]);
          return length > cutoff+EPSILON;
        });
        if (directed.at(-1) !== anchor && tail.at(-1) !== directed.at(-1)) tail.push(directed.at(-1));
        const points = [joint,anchor,...tail];
        if (!points.slice(1).every((p,j)=>boundary.allows(points[j],p))) break;
        changes.push({arm,points});
      }
      if (changes.length < 3) continue;
      joint.radius = boundary.radius(joint);
      for (const {arm,points} of changes) branches[arm.index] = arm.reverse ? points.reverse() : points;
      break;
    }
  }
}

function continuousStrokes(branches) {
  const atNode = new Map(), links = new Map();
  branches.forEach((branch,i) => {
    if (branch[0] === branch.at(-1)) return;
    for (const end of [0,1]) {
      const directed = end ? [...branch].reverse() : branch, node = directed[0];
      const p = pointAlong(directed,Math.max(.07,(node.radius || 0)*1.2)), length = distance(node,p);
      if (!length) continue;
      if (!atNode.has(node)) atNode.set(node,[]);
      atNode.get(node).push({id:2*i+end, x:(p.x-node.x)/length, y:(p.y-node.y)/length});
    }
  });
  for (const ends of atNode.values()) {
    const pairs = [];
    for (let i=0;i<ends.length;i++) for (let j=i+1;j<ends.length;j++) {
      const a = ends[i], b = ends[j], dot = a.x*b.x + a.y*b.y;
      if (dot < -.45) pairs.push({a:a.id,b:b.id,dot});
    }
    pairs.sort((a,b) => a.dot-b.dot);
    for (const {a,b} of pairs) if (!links.has(a) && !links.has(b)) {links.set(a,b); links.set(b,a);}
  }
  const used = new Set(), strokes = [];
  function walk(id) {
    const points = [];
    while (id !== undefined && !used.has(id>>1)) {
      const branch = branches[id>>1], directed = id%2 ? [...branch].reverse() : branch;
      used.add(id>>1);
      points.push(...(points.length ? directed.slice(1) : directed));
      id = links.get(id^1);
    }
    if (points.length) strokes.push(points);
  }
  for (let i=0; i<2*branches.length; i++) if (!links.has(i)) walk(i);
  for (let i=0; i<branches.length; i++) walk(2*i);
  return strokes;
}

export function deriveGrooveCenterlines(rings) {
  return inkComponents(rings).map(component => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of component) for (const {x,y} of ring) {
      minX = Math.min(minX,x); minY = Math.min(minY,y);
      maxX = Math.max(maxX,x); maxY = Math.max(maxY,y);
    }
    const quantize = n => Math.round(n*1e5)/1e5;
    const local = component.map(ring => ring.map(({x,y}) => ({x:quantize(x-minX), y:quantize(y-minY)})));
    const boundary = boundaryOf(local);
    const perimeter = boundary.edges.reduce((sum,{a,b}) => sum+distance(a,b),0);
    let step = Math.max(.02, Math.min(.12, Math.min(maxX-minX,maxY-minY)/75), perimeter/10000);
    let nodes = voronoiGraph(boundary,step);
    pruneLeaves(nodes,step);
    let graph = connectedGraph(nodes,step);
    if (!graph) {
      // Refine the source samples when a narrow feature disconnects. Never
      // add an invented cutting link across a disconnected component.
      step = Math.max(step*.5,perimeter/15000,.01);
      nodes = voronoiGraph(boundary,step);
      pruneLeaves(nodes,step);
      graph = connectedGraph(nodes,step);
    }
    if (!graph) throw Error('Could not trace a continuous V Groove centerline. Check for narrow joins or touching outlines in the selection.');
    const branches = traceBranches(graph).map(points => smoothBranch(points,boundary,step));
    fitStraightJunctions(branches,boundary);
    const paths = continuousStrokes(branches);
    if (!paths.length && nodes.length) paths.push([nodes.reduce((a,b) => a.radius >= b.radius ? a : b)]);
    const radiusAt = p => boundary.radius({x:p.x-minX,y:p.y-minY});
    return {radiusAt, paths:paths.map(path => path.map(({x,y}) => ({x:x+minX,y:y+minY})))};
  });
}

// A long straight XY move can still need changing Z. Use the same stations
// for both modes so switching between fixed and variable depth preserves XY.
export function grooveCutPaths(component, {angle, depth, fixed}) {
  const toDepth = Math.tan(angle*Math.PI/360);
  function cutSegment(a,b,path) {
    const middle = lerp(a,b,.5);
    middle.radius = component.radiusAt(middle);
    const delta = Math.abs(middle.radius-(a.radius+b.radius)/2);
    if (distance(a,b) > .07 && (delta > .012 || distance(a,b) > 1.25)) {
      cutSegment(a,middle,path);
      cutSegment(middle,b,path);
    } else path.push(b);
  }
  return component.paths.map(stroke => {
    const radii = stroke.map(point=>({...point,radius:component.radiusAt(point)}));
    const path = [radii[0]];
    for (let i=1; i<radii.length; i++) cutSegment(radii[i-1],radii[i],path);
    return path.map(({x,y,radius})=>({x,y,z:fixed ? depth : Math.min(depth,radius/toDepth)}));
  });
}
