import {createNodeModel, nodeObject} from './node-editing.js';

const epsilon = 1e-7;
const distance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1]);

export function isOpenVectorCandidate(object) {
  if (object.kind === 'path') return typeof object.d === 'string' && !object.outlineClosed && !/[zZ]\s*$/.test(object.d);
  if (object.kind === 'polyline') {
    const {points} = object;
    return points?.length >= 2 && distance(points[0],points.at(-1)) > epsilon;
  }
  return object.kind === 'line';
}

function openContour(object, stockHeight) {
  if (!isOpenVectorCandidate(object)) return null;
  const model = createNodeModel(object, stockHeight);
  const [contour] = model.contours;
  return model.contours.length === 1 && !contour.closed ? contour : null;
}

function canEnclose(nodes) {
  if (nodes.some((node, i) => node.type === 'A' && node.arc[0] && node.arc[1] &&
    distance(node.point, nodes[i-1].point) > epsilon)) return true;
  const points = nodes.flatMap(node => [node.point, ...(node.controls || [])]);
  const [origin] = points;
  const axis = points.find(point => distance(point, origin) > epsilon);
  if (!axis) return false;
  const dx = axis[0]-origin[0], dy = axis[1]-origin[1];
  const threshold = epsilon*Math.hypot(dx,dy);
  return points.some(([x,y]) => Math.abs(dx*(y-origin[1])-dy*(x-origin[0])) > threshold);
}

// Apply the path's SVG scale to the ellipse axes. The largest principal axis gives the
// ellipse rotation, and the determinant gives the other radius and the sweep direction.
function scaleArc([rx, ry, angle, large, sweep], sx, sy) {
  if (!rx || !ry) return null;
  const radians = angle*Math.PI/180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const a = sx*rx*cos, b = -sx*ry*sin, c = sy*rx*sin, d = sy*ry*cos;
  const xx = a*a+b*b, yy = c*c+d*d, xy = a*c+b*d;
  const major = Math.sqrt((xx+yy+Math.hypot(xx-yy,2*xy))/2);
  const minor = Math.abs(sx*sy*rx*ry)/major;
  const rotation = Math.atan2(2*xy,xx-yy)*90/Math.PI;
  return [major, minor, rotation, large, sx*sy < 0 ? 1-sweep : sweep];
}

function svgNodes(contour, object, stockHeight) {
  if (object.kind !== 'path') {
    return contour.nodes.map(node => ({...node, point:[node.point[0],stockHeight-node.point[1]]}));
  }
  const sx = object.sx || 1, sy = object.sy || 1;
  const dx = (object.dx || 0)+(object.ox || 0), dy = (object.dy || 0)+(object.oy || 0);
  const transform = ([x,y]) => [x*sx+dx, y*sy+dy];
  return contour.nodes.map(node => {
    const point = transform(node.point);
    if (node.controls) return {...node, point, controls:node.controls.map(transform)};
    if (node.arc) {
      const arc = scaleArc(node.arc,sx,sy);
      return arc ? {...node, point, arc} : {type:'L',point};
    }
    return {...node, point};
  });
}

function reverseNodes(nodes) {
  const reversed = [{type:'M',point:nodes.at(-1).point}];
  for (let i=nodes.length-1; i>0; i--) {
    const node = nodes[i], point = nodes[i-1].point;
    if (node.controls) reversed.push({...node, point, controls:[...node.controls].reverse()});
    else if (node.arc) reversed.push({...node, point, arc:[...node.arc.slice(0,4),1-node.arc[4]]});
    else reversed.push({...node, point});
  }
  return reversed;
}

export function closeVectors(objects, stockHeight) {
  return objects.flatMap(object => {
    const contour = openContour(object, stockHeight);
    if (!contour || !canEnclose(contour.nodes)) return [];
    contour.closed = true;
    const closed = nodeObject({object, contours:[contour]});
    if (closed.centerlineFont) {
      delete closed.centerlineFont;
      delete closed.textGroupId;
      delete closed.textFont;
    }
    return [{ids:[object.id], object:closed}];
  });
}

function endpointLinks(pieces, tolerance) {
  const endpoints = pieces.flatMap(({nodes, object}, i) => [
    {index:i*2, point:nodes[0].point, layer:object.layer || 'Default'},
    {index:i*2+1, point:nodes.at(-1).point, layer:object.layer || 'Default'}
  ]).sort((a,b) => a.point[0]-b.point[0]);
  const links = new Map();
  for (let i=0; i<endpoints.length; i++) {
    const a = endpoints[i];
    for (let j=i+1; j<endpoints.length; j++) {
      const b = endpoints[j];
      if (b.point[0]-a.point[0] > tolerance) break;
      if ((a.index ^ 1) === b.index || a.layer !== b.layer || distance(a.point,b.point) > tolerance) continue;
      if (links.has(a.index) || links.has(b.index)) {
        throw Error('More than two endpoints can join at the same location. Reduce the gap or select one chain at a time.');
      }
      links.set(a.index,b.index);
      links.set(b.index,a.index);
    }
  }
  return links;
}

function joinedObject(nodes, closed, members, stockHeight) {
  const {id,layer} = members[0];
  const metadata = {id,layer};
  if (!closed && members.every(member => member.centerlineFont)) metadata.centerlineFont = true;
  if (nodes.every(node => node.type === 'M' || node.type === 'L')) {
    const points = nodes.map(node => [node.point[0],stockHeight-node.point[1]]);
    if (closed && distance(points[0],points.at(-1)) <= epsilon) points.pop();
    return {...metadata,kind:closed?'polygon':'polyline',points};
  }
  const object = {...metadata,kind:'path'};
  return nodeObject({object,contours:[{nodes,closed}]});
}

export function joinVectors(objects, stockHeight, maxGap) {
  if (!Number.isFinite(maxGap) || maxGap < 0) throw Error('Enter a maximum gap of zero or more millimeters.');
  const pieces = objects.flatMap(object => {
    const contour = openContour(object, stockHeight);
    return contour ? [{object,nodes:svgNodes(contour,object,stockHeight)}] : [];
  });
  const links = endpointLinks(pieces,Math.max(maxGap,epsilon));
  const linked = [...links.keys()];
  // Start open chains at their unpaired end. The remaining components are loops.
  const starts = [...linked.filter(index => !links.has(index^1)).map(index => index^1), ...linked];
  const visited = new Set();
  const results = [];
  for (const start of starts) {
    const members = [], nodes = [];
    let current = start;
    while (current !== undefined && !visited.has(current >> 1)) {
      const piece = pieces[current >> 1];
      visited.add(current >> 1);
      members.push(piece.object);
      const [first,...rest] = current%2 ? reverseNodes(piece.nodes) : piece.nodes;
      if (!nodes.length) nodes.push(first);
      else if (distance(nodes.at(-1).point,first.point) > epsilon) nodes.push({type:'L',point:first.point});
      for (const node of rest) nodes.push(node);
      current = links.get(current^1);
    }
    if (!members.length) continue;
    const closed = current === start;
    if (closed && !canEnclose(nodes)) throw Error('The joined loop needs to enclose an area.');
    results.push({ids:members.map(member => member.id),object:joinedObject(nodes,closed,members,stockHeight)});
  }
  return results;
}
