import polygonClipping from 'polygon-clipping';
import ClipperLib from 'clipper-lib';

const SCALE = 1000;
const fmt = (value) => Number(value).toFixed(3);

export function parseStl(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  const triangles = [];
  if (bytes.length === 84 + count * 50) {
    let offset = 84;
    for (let i = 0; i < count; i += 1) {
      offset += 12;
      const tri = [];
      for (let j = 0; j < 3; j += 1) {
        tri.push([view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)]);
        offset += 12;
      }
      triangles.push(tri);
      offset += 2;
    }
    return triangles;
  }
  const text = new TextDecoder().decode(bytes);
  const matches = text.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g);
  let tri = [];
  for (const match of matches) {
    tri.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    if (tri.length === 3) { triangles.push(tri); tri = []; }
  }
  if (!triangles.length) throw new Error('This STL file could not be read.');
  return triangles;
}

function signedArea(ring) {
  return ring.reduce((sum, point, i) => {
    const next = ring[(i + 1) % ring.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
}

function unionTriangles(triangles) {
  const regions = [];
  for (const tri of triangles) {
    const ring = tri.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]);
    const area = Math.abs((ring[1][0] - ring[0][0]) * (ring[2][1] - ring[0][1]) - (ring[2][0] - ring[0][0]) * (ring[1][1] - ring[0][1]));
    if (area < 1e-8) continue;
    ring.push(ring[0]);
    regions.push([[ring]]);
  }
  if (!regions.length) throw new Error('The model has no measurable top-view footprint. Check its orientation and mesh.');
  let level = regions;
  while (level.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 24) nextLevel.push(polygonClipping.union(...level.slice(i, i + 24)));
    level = nextLevel;
  }
  const merged = level[0];
  const candidates = merged.map((poly) => poly[0]).filter((ring) => ring?.length >= 4);
  candidates.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  if (!candidates.length) throw new Error('Could not find a closed outer outline in this model.');
  return candidates[0].slice(0, -1).map(([x, y]) => [x, y]);
}

export function outlineFromTriangles(triangles) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const tri of triangles) for (const [x, y, z] of tri) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  const ring = unionTriangles(triangles);
  const minX = Math.min(...ring.map((p) => p[0])); const maxX = Math.max(...ring.map((p) => p[0]));
  const minY = Math.min(...ring.map((p) => p[1])); const maxY = Math.max(...ring.map((p) => p[1]));
  const centerX = (minX + maxX) / 2; const centerY = (minY + maxY) / 2;
  return {
    points: ring.map(([x, y]) => [x - centerX, y - centerY]),
    size: { length: maxX - minX, width: maxY - minY, height: bounds.maxZ - bounds.minZ },
  };
}

export function offsetOutline(points, diameter) {
  const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  if (ClipperLib.Clipper.Area(path) < 0) path.reverse();
  const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  offsetter.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  offsetter.Execute(solution, diameter * SCALE / 2);
  if (!solution.length) throw new Error('The selected tool could not offset this model outline.');
  solution.sort((a, b) => Math.abs(ClipperLib.Clipper.Area(b)) - Math.abs(ClipperLib.Clipper.Area(a)));
  return solution[0].map(({ X, Y }) => [X / SCALE, Y / SCALE]);
}

function longestEdge(points) {
  let best = { index: 0, length: 0 };
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > best.length) best = { index: i, length };
  }
  return best;
}

function pointAlong(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

export function makeCutPath(points, tabWidth) {
  const simplified = points.filter((point, index, all) => {
    const previous = all[(index + all.length - 1) % all.length];
    const next = all[(index + 1) % all.length];
    const ax = point[0] - previous[0]; const ay = point[1] - previous[1];
    const bx = next[0] - point[0]; const by = next[1] - point[1];
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return lengths < 1e-8 || Math.abs(ax * by - ay * bx) / lengths > 1e-5 || ax * bx + ay * by < 0;
  });
  if (simplified.length >= 3) points = simplified;
  const edge = longestEdge(points);
  if (edge.length < tabWidth * 2.25) throw new Error('The longest model side is too short for two tabs of this width.');
  const tabCenters = [edge.length / 3, edge.length * 2 / 3];
  const intervals = tabCenters.map((center) => [center - tabWidth / 2, center + tabWidth / 2]);
  const path = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cuts = [0, 1];
    if (i === edge.index) for (const [lo, hi] of intervals) cuts.push(lo / length, hi / length);
    cuts.sort((x, y) => x - y);
    const unique = cuts.filter((v, k) => k === 0 || Math.abs(v - cuts[k - 1]) > 1e-8);
    for (let k = 0; k < unique.length - 1; k += 1) {
      const t = unique[k];
      const distance = t * length;
      const onTab = i === edge.index && intervals.some(([lo, hi]) => distance >= lo - 1e-7 && distance < hi - 1e-7);
      path.push({ point: pointAlong(a, b, t), tab: onTab });
    }
  }
  return { path, edgeLength: edge.length };
}

export function generateGcode({ layers, stock, settings, tool, side = 'top' }) {
  const tabCutDepth = Number(stock.thickness) - Number(settings.tabHeight);
  const bottomSide = side === 'bottom';
  const lines = [
    `(CAMLab ${bottomSide ? 'bottom-side' : 'top-side'} waterline contours generated from an STL/STEP mesh)`,
    `(Stock ${fmt(stock.length)} x ${fmt(stock.width)} x ${fmt(stock.thickness)} mm; XY origin: ${stock.originMode === 'center' ? 'stock center' : 'imported model coordinates'}; Z0 at ${bottomSide ? 'flipped exposed face' : 'stock top'})`,
    bottomSide
      ? `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; internal undercut paths only; outside perimeter and tab cuts omitted)`
      : `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; two tabs ${fmt(settings.tabWidth)} mm wide x ${fmt(settings.tabHeight)} mm high)`,
    ...(bottomSide ? [
      '(BOTTOM-SIDE PROGRAM: INTERNAL UNDERCUT CONTOURS ONLY)',
      '(OUTSIDE PERIMETER AND TAB CUTS ARE OMITTED; TOP-SIDE TABS MUST REMAIN IN PLACE)',
      '(FLIP STOCK 180 DEGREES ABOUT Y AXIS THROUGH STOCK CENTER: X MIRRORS, Y IS UNCHANGED)',
      '(KEEP THE SAME STOCK XY ORIGIN AND G54 WORK OFFSET; REGISTER PART TO STOCK CENTERLINES)',
      '(RESET Z0 TO THE NEWLY EXPOSED FACE; DO NOT CHANGE THE XY WORK OFFSET)',
    ] : []),
    bottomSide
      ? '(Bottom-side file contains only internal paths detected as hidden from the top-side tool access check. No outside perimeter is cut. Review and simulate; no job is started.)'
      : layers.undercutFallback
      ? `(Undercut at Z-${fmt(layers.undercutFallback.depth)} mm; ${bottomSide ? 'bottom-side' : 'top-side'} paths use last reachable profile from Z-${fmt(layers.undercutFallback.continuationDepth)} mm to stock bottom. Hidden geometry may need the opposite-side file. Review and simulate; no job is started.)`
      : '(Contour finishing only; vertical tool-access check passed. Review and simulate before cutting. No job is started.)',
    'G21', 'G90', 'G17', 'G94', 'G54', `T${Math.max(1, Math.floor(Number(tool.number) || 1))} M6`, `S${Math.round(settings.rpm)} M3`,
    `G0 Z${fmt(settings.safeZ)}`,
  ];
  for (const layer of layers) {
    lines.push(`(Waterline finishing depth Z-${fmt(layer.depth)})`);
    const contours = [...layer.contours].sort((a, b) => Number(b.hole) - Number(a.hole) || b.area - a.area);
    const mainOuter = contours.find((contour) => !contour.hole);
    for (const contour of contours) {
      const keepTabs = layer.depth > tabCutDepth + 1e-7 && contour === mainOuter;
      const path = keepTabs ? makeCutPath(contour.points, Number(settings.tabWidth)).path : contour.points.map((point) => ({ point, tab: false }));
      const skipTabs = keepTabs;
      let penDown = false;
      for (let i = 0; i < path.length; i += 1) {
        const current = path[i]; const next = path[(i + 1) % path.length];
        if (skipTabs && current.tab) {
          if (penDown) { lines.push(`G0 Z${fmt(settings.safeZ)}`); penDown = false; }
          continue;
        }
        if (!penDown) {
          lines.push(`G0 Z${fmt(settings.safeZ)}`);
          lines.push(`G0 X${fmt(current.point[0])} Y${fmt(current.point[1])}`);
          lines.push(`G1 Z-${fmt(layer.depth)} F${Math.round(settings.plunge)}`);
          penDown = true;
        }
        lines.push(`G1 X${fmt(next.point[0])} Y${fmt(next.point[1])} F${Math.round(settings.feed)}`);
        if (skipTabs && next.tab) { lines.push(`G0 Z${fmt(settings.safeZ)}`); penDown = false; }
      }
      if (penDown) lines.push(`G0 Z${fmt(settings.safeZ)}`);
    }
  }
  lines.push('M5', 'M30', '');
  return lines.join('\n');
}

export function bounds(points) {
  return {
    minX: Math.min(...points.map((p) => p[0])), maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])), maxY: Math.max(...points.map((p) => p[1])),
  };
}
