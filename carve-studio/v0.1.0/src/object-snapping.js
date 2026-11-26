const EPSILON = 1e-8;
const squaredDistance = (a,b) => (a.x-b.x)**2 + (a.y-b.y)**2;
const midpoint = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});

export function intersectSegments(a,b,c,d) {
  const rx=b.x-a.x, ry=b.y-a.y, sx=d.x-c.x, sy=d.y-c.y;
  const denominator=rx*sy-ry*sx;
  if (Math.abs(denominator)<1e-10) return null;
  const qx=c.x-a.x, qy=c.y-a.y;
  const t=(qx*sy-qy*sx)/denominator, u=(qx*ry-qy*rx)/denominator;
  if (t< -EPSILON || t>1+EPSILON || u< -EPSILON || u>1+EPSILON) return null;
  return {x:a.x+t*rx,y:a.y+t*ry,t:Math.max(0,Math.min(1,t))};
}

function makeEdge(a,b) {
  return {a,b,minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),minY:Math.min(a.y,b.y),maxY:Math.max(a.y,b.y)};
}

function sharpVertex(a,b,c) {
  const dx=b.x-a.x, dy=b.y-a.y, ex=c.x-b.x, ey=c.y-b.y;
  const length=Math.hypot(dx,dy)*Math.hypot(ex,ey);
  return length>EPSILON && (dx*ex+dy*ey)/length < Math.cos(Math.PI/15);
}

function addContour({points,closed}, candidates, edges) {
  points=points.filter((p,i,all)=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&
    (!i || squaredDistance(p,all[i-1])>EPSILON**2));
  if (points.length<2) return;
  if (squaredDistance(points[0],points.at(-1))<EPSILON**2) {
    points.pop();
    closed=true;
  }
  if (points.length<2) return;
  const last=points.length-1, vertices=[], lengths=[0];
  for (let i=1;i<points.length;i++) {
    edges.push(makeEdge(points[i-1],points[i]));
    lengths.push(lengths.at(-1)+Math.sqrt(squaredDistance(points[i-1],points[i])));
  }
  if (closed) {
    edges.push(makeEdge(points[last],points[0]));
    lengths.push(lengths.at(-1)+Math.sqrt(squaredDistance(points[last],points[0])));
  }
  for (const [i,p] of points.entries()) {
    if ((!closed && (i===0 || i===last)) ||
        sharpVertex(points.at(i-1),p,points[(i+1)%points.length])) {
      vertices.push(i);
      candidates.push({...p,kind:'endpoint'});
    }
  }
  if (closed && vertices.length) vertices.push(vertices[0]+points.length);
  // Short facets from DXF arcs and glyph curves aren't drawing vertices.
  const lengthAt = i=>i<points.length?lengths[i]:lengths[i-points.length]+lengths.at(-1);
  for (let i=1;i<vertices.length;i++) {
    const start=vertices[i-1], end=vertices[i];
    const target=(lengthAt(start)+lengthAt(end))/2;
    let j=start;
    while (j+1<end && lengthAt(j+1)<target) j++;
    const a=points[j%points.length], b=points[(j+1)%points.length];
    const t=(target-lengthAt(j))/(lengthAt(j+1)-lengthAt(j));
    candidates.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,kind:'midpoint'});
  }
}

export function buildSnapGeometry(object, contours) {
  const candidates=[], edges=[];
  let circle=null;
  if (object.kind==='circle' || object.kind==='ellipse') {
    const {cx,cy}=object, rx=object.r??object.rx, ry=object.r??object.ry;
    if (rx>0 && ry>0) {
      candidates.push({x:cx,y:cy,kind:'center'});
      for (const [dx,dy] of [[rx,0],[-rx,0],[0,ry],[0,-ry]]) {
        candidates.push({x:cx+dx,y:cy+dy,kind:'quadrant'});
      }
      if (object.kind==='circle') circle={x:cx,y:cy,r:rx};
    }
  } else if (object.kind==='rect') {
    candidates.push({...midpoint({x:object.x1,y:object.y1},{x:object.x2,y:object.y2}),kind:'center'});
  }
  if (!circle) {
    for (const contour of contours) addContour(contour,
      object.kind==='ellipse'?[]:candidates,edges);
  }
  return {candidates,edges,circle};
}

function lineCircle(edge,circle,add) {
  const {a,b}=edge;
  const dx=b.x-a.x, dy=b.y-a.y, length=Math.hypot(dx,dy);
  const ux=dx/length, uy=dy/length, vx=circle.x-a.x, vy=circle.y-a.y;
  const along=vx*ux+vy*uy, normal=vx*uy-vy*ux;
  if (Math.abs(normal)>circle.r+EPSILON) return;
  const delta=Math.sqrt(Math.max(0,circle.r**2-normal**2));
  for (const distance of [along-delta,along+delta]) {
    if (distance>=-EPSILON && distance<=length+EPSILON) add({x:a.x+distance*ux,y:a.y+distance*uy});
  }
}

function circleCircle(a,b,add) {
  const dx=b.x-a.x, dy=b.y-a.y, distance=Math.hypot(dx,dy);
  if (distance<EPSILON || distance>a.r+b.r+EPSILON || distance<Math.abs(a.r-b.r)-EPSILON) return;
  const ux=dx/distance, uy=dy/distance;
  const along=(a.r**2-b.r**2+distance**2)/(2*distance);
  const normal=Math.sqrt(Math.max(0,a.r**2-along**2));
  const x=a.x+along*ux, y=a.y+along*uy;
  add({x:x-normal*uy,y:y+normal*ux});
  add({x:x+normal*uy,y:y-normal*ux});
}

export function nearestSnap(point,tolerance,geometries) {
  let found=null, best=tolerance**2;
  const consider=candidate=>{
    const distance=squaredDistance(point,candidate);
    if (distance<=best && (!found || distance < best - EPSILON**2)) {
      found=candidate;
      best=distance;
    }
  };
  const intersection=p=>{if(p) consider({x:p.x,y:p.y,kind:'intersection'})};
  const edgeSets=[], circles=[];
  for (const geometry of geometries) {
    geometry.candidates.forEach(consider);
    const local=geometry.edges.filter(edge=>
      point.x+tolerance>=edge.minX && point.x-tolerance<=edge.maxX &&
      point.y+tolerance>=edge.minY && point.y-tolerance<=edge.maxY);
    if (local.length) edgeSets.push(local);
    if (geometry.circle && Math.abs(Math.sqrt(squaredDistance(point,geometry.circle))-geometry.circle.r)<=tolerance) {
      circles.push(geometry.circle);
    }
  }
  for (const [i,edges] of edgeSets.entries()) {
    for (const other of edgeSets.slice(i+1)) {
      for (const a of edges) for (const b of other) {
        if (a.maxX>=b.minX && b.maxX>=a.minX && a.maxY>=b.minY && b.maxY>=a.minY) {
          intersection(intersectSegments(a.a,a.b,b.a,b.b));
        }
      }
    }
    for (const circle of circles) {
      for (const edge of edges) lineCircle(edge,circle,intersection);
    }
  }
  for (const [i,circle] of circles.entries()) {
    for (const other of circles.slice(i+1)) circleCircle(circle,other,intersection);
  }
  return found;
}
