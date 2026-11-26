import ClipperLib from 'clipper-lib';

const SCALE = 1000;
const {Clipper, ClipperOffset, PolyTree, PolyType, ClipType, PolyFillType, JoinType, EndType} = ClipperLib;

function closedPolygon(points) {
  if (points.some(({x,y}) => !Number.isFinite(x) || !Number.isFinite(y) ||
    Math.abs(x) > 1e8 || Math.abs(y) > 1e8)) {
    throw Error('A profile boundary has invalid coordinates.');
  }
  return points.map(({x,y}) => ({X:Math.round(x*SCALE),Y:Math.round(y*SCALE)}));
}

function treeShape(node) {
  return '(' + node.Childs().map(treeShape).sort().join('') + ')';
}

function collectContours(node, result, depth = 0) {
  for (const child of node.Childs()) {
    collectContours(child,result,depth+1);
    const points = child.Contour().map(({X,Y}) => ({x:X/SCALE,y:Y/SCALE}));
    result.push({points:[...points,{...points[0]}],closed:true,depth});
  }
}

export function compensateProfile(contours, side, diameter) {
  if (side === 'on') return contours;
  if (side !== 'inside' && side !== 'outside') throw Error('Select a valid profile cut side.');
  if (!Number.isFinite(diameter) || diameter < .01 || diameter > 10000) {
    throw Error('Enter a valid cutter diameter of at least 0.01 mm for compensation.');
  }
  if (!contours.length || contours.some(contour => !contour.closed)) {
    throw Error('Inside and Outside cuts require closed contours. Close the vectors or choose On vector.');
  }

  const paths = contours.map(({points}) => {
    const polygon = closedPolygon(points);
    const simplified = Clipper.SimplifyPolygon(polygon, PolyFillType.pftEvenOdd);
    if (simplified.length !== 1 || Math.abs(Clipper.Area(polygon)) !== Math.abs(Clipper.Area(simplified[0]))) {
      throw Error('A profile outline crosses itself or has no area. Repair the boundary before offsetting.');
    }
    return simplified[0];
  });
  const clipper = new Clipper(Clipper.ioStrictlySimple);
  clipper.AddPaths(paths,PolyType.ptSubject,true);
  const source = new PolyTree();
  if (!clipper.Execute(ClipType.ctUnion,source,PolyFillType.pftEvenOdd,PolyFillType.pftEvenOdd)) {
    throw Error('Could not resolve the profile outlines.');
  }
  const normalized = Clipper.PolyTreeToPaths(source);
  const areas = polygons => polygons.map(path => Math.abs(Clipper.Area(path))).sort((a,b)=>a-b).join(',');
  if (areas(paths) !== areas(normalized)) {
    throw Error('Profile outlines overlap or share an edge. Select separate closed boundaries.');
  }

  const offsetter = new ClipperOffset(2,2);
  offsetter.AddPaths(normalized,JoinType.jtRound,EndType.etClosedPolygon);
  const result = new PolyTree();
  offsetter.Execute(result,diameter*SCALE/2*(side==='inside'?-1:1));
  if (treeShape(result) !== treeShape(source)) {
    throw Error('The cutter changes the profile boundaries at this size. Try a smaller bit or split the cuts.');
  }
  const output = [];
  collectContours(result, output);
  // Cut nested outlines before releasing the outside part.
  return output.sort((a,b)=>b.depth-a.depth);
}
