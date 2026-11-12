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

function edgesOf(points) {
  const edges = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    edges.push({ index: i, length, dx: dx / length, dy: dy / length, midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return edges;
}

function longestEdge(edges) {
  return edges.reduce((best, edge) => edge.length > best.length ? edge : best, { index: 0, length: 0 });
}

function opposingEdgePair(edges, tabWidth) {
  let best = null;
  for (let i = 0; i < edges.length; i += 1) {
    const first = edges[i];
    if (first.length < tabWidth * 1.5) continue;
    for (let j = i + 1; j < edges.length; j += 1) {
      const second = edges[j];
      if (second.length < tabWidth * 1.5) continue;
      const alignment = first.dx * second.dx + first.dy * second.dy;
      if (alignment > -0.85) continue;
      const separation = Math.hypot(second.midpoint[0] - first.midpoint[0], second.midpoint[1] - first.midpoint[1]);
      const score = first.length + second.length + separation * 0.1 + Math.abs(alignment) * Math.min(first.length, second.length) * 0.05;
      if (!best || score > best.score) best = { first, second, score };
    }
  }
  return best;
}

function leftRightEdgePair(edges, points, tabWidth) {
  const orientation = signedArea(points) >= 0 ? 1 : -1;
  const eligible = edges.filter((edge) => edge.length >= tabWidth);
  const leftSides = eligible.filter((edge) => orientation * edge.dy < -0.5).sort((a, b) => b.length - a.length);
  const rightSides = eligible.filter((edge) => orientation * edge.dy > 0.5).sort((a, b) => b.length - a.length);
  let left = leftSides[0]; let right = rightSides[0];
  if (!left) left = [...eligible].sort((a, b) => a.midpoint[0] - b.midpoint[0] || b.length - a.length)[0];
  if (!right || right.index === left?.index) right = [...eligible].filter((edge) => edge.index !== left?.index).sort((a, b) => b.midpoint[0] - a.midpoint[0] || b.length - a.length)[0];
  if (!left || !right || left.index === right.index) throw new Error('The left and right model sides must each fit a tab of the selected width. Reduce tab width or check the model outline.');
  return { first: left, second: right };
}

function pointAlong(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]; const b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-20) + a[0]) inside = !inside;
  }
  return inside;
}

function pointInMultiPolygon(point, multiPolygon) {
  return multiPolygon.some((polygon) => pointInRing(point, polygon[0]) && !polygon.slice(1).some((ring) => pointInRing(point, ring)));
}

function closeRing(points) {
  const ring = points.map(([x, y]) => [x, y]);
  if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ring.push([...ring[0]]);
  return ring;
}

function tabKeepouts(contours, tabWidth, toolDiameter, options = {}) {
  const outer = contours.filter((contour) => !contour.hole).sort((a, b) => b.area - a.area)[0];
  if (!outer) return [];
  const { path } = makeCutPath(outer.points, tabWidth, options);
  const margin = Math.max(toolDiameter * 2, tabWidth / 2);
  const keepouts = [];
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i]; const next = path[(i + 1) % path.length];
    if (!current.tab && !next.tab) continue;
    const dx = next.point[0] - current.point[0]; const dy = next.point[1] - current.point[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const outwardSign = signedArea(outer.points) >= 0 ? 1 : -1;
    const nx = outwardSign * dy / length; const ny = outwardSign * -dx / length;
    const a = current.point; const b = next.point;
    keepouts.push([[a[0], a[1]], [b[0], b[1]], [b[0] + nx * margin, b[1] + ny * margin], [a[0] + nx * margin, a[1] + ny * margin]]);
  }
  return keepouts;
}

function sideTabKeepoutsAtDepth(topKeepouts, side, stock, depth, toolDiameter, tabHeight) {
  if (side !== 'front' && side !== 'back') return [];
  const centerOrigin = stock.originMode === 'center';
  const faceY = side === 'front'
    ? (centerOrigin ? -stock.width / 2 + depth : depth)
    : (centerOrigin ? stock.width / 2 - depth : stock.width - depth);
  const radius = Number(toolDiameter) / 2;
  const verticalMin = side === 'front' ? -stock.thickness / 2 : stock.thickness / 2 - Number(tabHeight);
  const verticalMax = side === 'front' ? -stock.thickness / 2 + Number(tabHeight) : stock.thickness / 2;
  const result = [];
  for (const polygon of topKeepouts) {
    const minY = Math.min(...polygon.map((point) => point[1]));
    const maxY = Math.max(...polygon.map((point) => point[1]));
    if (faceY < minY - radius || faceY > maxY + radius) continue;
    const minX = Math.min(...polygon.map((point) => point[0])) - radius;
    const maxX = Math.max(...polygon.map((point) => point[0])) + radius;
    result.push([[minX, verticalMin - radius], [maxX, verticalMin - radius], [maxX, verticalMax + radius], [minX, verticalMax + radius]]);
  }
  return result;
}

function clipperPath(points, hole = false) {
  const path = points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
  if (path.length < 3) return null;
  const positive = ClipperLib.Clipper.Area(path) > 0;
  if (positive === hole) path.reverse();
  return path;
}

function multiPolygonPaths(multiPolygon) {
  const paths = [];
  for (const polygon of multiPolygon) {
    polygon.forEach((ring, index) => {
      const path = clipperPath(ring, index > 0);
      if (path) paths.push(path);
    });
  }
  return paths;
}

function clipperArea(operation, subjectPaths, clipPaths = []) {
  if (!subjectPaths.length) return [];
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length) clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true);
  const tree = new ClipperLib.PolyTree();
  if (!clipper.Execute(operation, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)) {
    throw new Error('Could not calculate the top-side roughing area. Check the model mesh and stock dimensions.');
  }
  return ClipperLib.JS.PolyTreeToExPolygons(tree).map((polygon) => [polygon.outer, ...polygon.holes].map((path) => closeRing(path.map(({ X, Y }) => [X / SCALE, Y / SCALE]))));
}

function rasterClearance(area, spacing, gridMinY) {
  if (!area.length) return [];
  const allPoints = area.flat(2);
  const minY = Math.min(...allPoints.map((point) => point[1]));
  const maxY = Math.max(...allPoints.map((point) => point[1]));
  const paths = [];
  const firstRow = Math.max(0, Math.ceil((minY - gridMinY) / spacing - 0.5));
  let row = firstRow;
  for (let y = gridMinY + spacing / 2 + firstRow * spacing; y < maxY; y += spacing, row += 1) {
    const intersections = [];
    for (const polygon of area) for (const ring of polygon) {
      for (let i = 0; i < ring.length - 1; i += 1) {
        const a = ring[i]; const b = ring[i + 1];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          intersections.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
        }
      }
    }
    intersections.sort((a, b) => a - b);
    const xs = intersections.filter((x, index) => index === 0 || Math.abs(x - intersections[index - 1]) > 1e-5);
    const segments = [];
    for (let i = 0; i + 1 < xs.length; i += 1) {
      const left = xs[i]; const right = xs[i + 1];
      if (right - left > 1e-4 && pointInMultiPolygon([(left + right) / 2, y], area)) segments.push([[left, y], [right, y]]);
    }
    if (row % 2) segments.reverse();
    for (const segment of segments) paths.push(row % 2 ? segment.reverse() : segment);
  }
  return paths;
}

function clampKeepoutPaths(stock, side, clampXBounds) {
  if (!clampXBounds) return [];
  const stockMinX = stock.originMode === 'center' ? -stock.length / 2 : 0;
  const stockMaxX = stock.originMode === 'center' ? stock.length / 2 : stock.length;
  const sideFace = side === 'front' || side === 'back';
  const minY = sideFace ? -stock.thickness / 2 : (stock.originMode === 'center' ? -stock.width / 2 : 0);
  const maxY = sideFace ? stock.thickness / 2 : (stock.originMode === 'center' ? stock.width / 2 : stock.width);
  const clearance = 0.03;
  const zones = [];
  if (clampXBounds.minX - clearance > stockMinX) zones.push([[stockMinX, minY], [clampXBounds.minX - clearance, minY], [clampXBounds.minX - clearance, maxY], [stockMinX, maxY]]);
  if (clampXBounds.maxX + clearance < stockMaxX) zones.push([[clampXBounds.maxX + clearance, minY], [stockMaxX, minY], [stockMaxX, maxY], [clampXBounds.maxX + clearance, maxY]]);
  return zones.map((zone) => clipperPath(zone)).filter(Boolean);
}

function previousRoughingKeepouts(history, side, depth, stock) {
  const paths = [];
  const sideMinY = stock.originMode === 'center' ? -stock.width / 2 : 0;
  const sideMaxY = stock.originMode === 'center' ? stock.width / 2 : stock.width;
  for (const prior of history) {
    const radius = Number(prior.diameter) / 2;
    for (const layer of prior.layers) for (const line of layer.paths) {
      if (prior.side === 'top' && (side === 'front' || side === 'back')) {
        const targetY = side === 'front' ? sideMinY + depth : sideMaxY - depth;
        const lowY = Math.min(line[0][1], line[1][1]);
        const highY = Math.max(line[0][1], line[1][1]);
        const dy = targetY < lowY ? lowY - targetY : targetY > highY ? targetY - highY : 0;
        if (dy >= radius) continue;
        const crossRadius = Math.sqrt(Math.max(0, radius * radius - dy * dy));
        const top = stock.thickness / 2;
        const low = side === 'front' ? top - layer.depth : -top;
        const high = side === 'front' ? top : -top + layer.depth;
        let centerX1 = line[0][0];
        let centerX2 = line[1][0];
        if (Math.abs(line[1][1] - line[0][1]) > 1e-8 && dy > 0) {
          const endpoint = Math.abs(line[0][1] - targetY) < Math.abs(line[1][1] - targetY) ? line[0] : line[1];
          centerX1 = centerX2 = endpoint[0];
        } else if (Math.abs(line[1][1] - line[0][1]) > 1e-8) {
          const t = Math.max(0, Math.min(1, (targetY - line[0][1]) / (line[1][1] - line[0][1])));
          centerX1 = centerX2 = line[0][0] + t * (line[1][0] - line[0][0]);
        }
        const left = Math.min(centerX1, centerX2) - crossRadius;
        const right = Math.max(centerX1, centerX2) + crossRadius;
        const polygon = clipperPath([[left, low], [right, low], [right, high], [left, high]]);
        if (polygon) paths.push(polygon);
      } else if (prior.side === 'front' && side === 'back') {
        const distanceFromFront = stock.width - depth;
        if (layer.depth + radius < distanceFromFront) continue;
        const flipped = line.map(([x, y]) => [x, -y]);
        const pad = Math.max(0, radius - 0.02);
        const polygon = clipperPath([
          [Math.min(flipped[0][0], flipped[1][0]) - pad, Math.min(flipped[0][1], flipped[1][1]) - pad],
          [Math.max(flipped[0][0], flipped[1][0]) + pad, Math.min(flipped[0][1], flipped[1][1]) - pad],
          [Math.max(flipped[0][0], flipped[1][0]) + pad, Math.max(flipped[0][1], flipped[1][1]) + pad],
          [Math.min(flipped[0][0], flipped[1][0]) - pad, Math.max(flipped[0][1], flipped[1][1]) + pad],
        ]);
        if (polygon) paths.push(polygon);
      }
    }
  }
  return paths;
}

function faceRoughingLayers(layers, stock, settings, tool, side, topTabContours = null, roughingExpansion = 0, previousRoughing = [], clampXBounds = null) {
  const sideFace = side === 'front' || side === 'back';
  const bounds = sideFace
    ? { minX: stock.originMode === 'center' ? -stock.length / 2 : 0, maxX: stock.originMode === 'center' ? stock.length / 2 : stock.length, minY: -stock.thickness / 2, maxY: stock.thickness / 2 }
    : stock.originMode === 'center'
      ? { minX: -stock.length / 2, maxX: stock.length / 2, minY: -stock.width / 2, maxY: stock.width / 2 }
      : { minX: 0, maxX: stock.length, minY: 0, maxY: stock.width };
  const stockPath = clipperPath([[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY], [bounds.minX, bounds.maxY]]);
  const topKeepoutPolygons = side === 'top'
    ? tabKeepouts(layers.at(-1)?.contours || [], Number(settings.tabWidth), Number(tool.diameter), { placement: 'left-right' })
    : topTabContours?.length
      ? tabKeepouts(topTabContours, Number(settings.tabWidth), Number(tool.diameter), { placement: 'left-right' })
      : [];
  const spacing = Math.max(0.25, Number(tool.diameter) * 0.7);
  const finalRoughDepth = layers.length > 1 ? Number(layers.at(-2).depth) : 0;
  const roughing = [];
  let protectedModel = [];
  for (const layer of layers) {
    if (layer.depth > finalRoughDepth + 1e-7) break;
    let sectionPaths = layer.contours.map((contour) => clipperPath(contour.points, contour.hole)).filter(Boolean);
    if (!sectionPaths.length) continue;
    if (roughingExpansion > 1e-6) {
      const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
      offsetter.AddPaths(sectionPaths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
      const expanded = new ClipperLib.Paths();
      offsetter.Execute(expanded, roughingExpansion * SCALE);
      sectionPaths = expanded;
    }
    protectedModel = clipperArea(ClipperLib.ClipType.ctUnion, [...multiPolygonPaths(protectedModel), ...sectionPaths]);
    let waste = clipperArea(ClipperLib.ClipType.ctDifference, [stockPath], multiPolygonPaths(protectedModel));
    const previousStock = previousRoughingKeepouts(previousRoughing, side, layer.depth, stock);
    if (previousStock.length && waste.length) {
      const previousStockUnion = clipperArea(ClipperLib.ClipType.ctUnion, previousStock);
      waste = clipperArea(ClipperLib.ClipType.ctDifference, multiPolygonPaths(waste), multiPolygonPaths(previousStockUnion));
    }
    const clampKeepouts = clampKeepoutPaths(stock, side, clampXBounds);
    if (clampKeepouts.length && waste.length) waste = clipperArea(ClipperLib.ClipType.ctDifference, multiPolygonPaths(waste), clampKeepouts);
    const layerKeepouts = side === 'top'
      ? topKeepoutPolygons.map((points) => clipperPath(points)).filter(Boolean)
      : sideTabKeepoutsAtDepth(topKeepoutPolygons, side, stock, layer.depth, tool.diameter, settings.tabHeight).map((points) => clipperPath(points)).filter(Boolean);
    if (layerKeepouts.length && waste.length) waste = clipperArea(ClipperLib.ClipType.ctDifference, multiPolygonPaths(waste), layerKeepouts);
    const paths = rasterClearance(waste, spacing, bounds.minY);
    if (paths.length) roughing.push({ depth: layer.depth, paths });
  }
  return roughing;
}

export function planRoughingPaths({ layers, stock, settings, tool, side = 'top', topTabContours = null, roughingExpansion = 0, previousRoughing = [], clampXBounds = null }) {
  return side === 'bottom' ? [] : faceRoughingLayers(layers, stock, settings, tool, side, topTabContours, roughingExpansion, previousRoughing, clampXBounds);
}

function segmentRectangleInterval(a, b, rectangle) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  let lo = 0; let hi = 1;
  for (const [p, q] of [
    [-dx, a[0] - rectangle.minX], [dx, rectangle.maxX - a[0]],
    [-dy, a[1] - rectangle.minY], [dy, rectangle.maxY - a[1]],
  ]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [Math.max(0, lo), Math.min(1, hi)];
}

function splitPathSegments(path, keepouts = []) {
  const rectangles = keepouts.map((points) => ({
    minX: Math.min(...points.map((point) => point[0])), maxX: Math.max(...points.map((point) => point[0])),
    minY: Math.min(...points.map((point) => point[1])), maxY: Math.max(...points.map((point) => point[1])),
  }));
  const segments = [];
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i]; const next = path[(i + 1) % path.length];
    const a = current.point || current; const b = next.point || next;
    const cuts = [0, 1];
    const intervals = rectangles.map((rectangle) => segmentRectangleInterval(a, b, rectangle)).filter(Boolean);
    for (const [lo, hi] of intervals) cuts.push(lo, hi);
    cuts.sort((left, right) => left - right);
    const unique = cuts.filter((value, index) => index === 0 || Math.abs(value - cuts[index - 1]) > 1e-8);
    for (let j = 0; j + 1 < unique.length; j += 1) {
      const lo = unique[j]; const hi = unique[j + 1];
      const mid = (lo + hi) / 2;
      const point = pointAlong(a, b, mid);
      const blocked = Boolean(current.tab) || rectangles.some((rectangle) => point[0] >= rectangle.minX - 1e-8 && point[0] <= rectangle.maxX + 1e-8 && point[1] >= rectangle.minY - 1e-8 && point[1] <= rectangle.maxY + 1e-8);
      segments.push({ a: pointAlong(a, b, lo), b: pointAlong(a, b, hi), blocked });
    }
  }
  return segments;
}

export function makeCutPath(points, tabWidth, options = {}) {
  const simplified = points.filter((point, index, all) => {
    const previous = all[(index + all.length - 1) % all.length];
    const next = all[(index + 1) % all.length];
    const ax = point[0] - previous[0]; const ay = point[1] - previous[1];
    const bx = next[0] - point[0]; const by = next[1] - point[1];
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return lengths < 1e-8 || Math.abs(ax * by - ay * bx) / lengths > 1e-5 || ax * bx + ay * by < 0;
  });
  if (simplified.length >= 3) points = simplified;
  const edges = edgesOf(points);
  const edge = longestEdge(edges);
  const opposing = options.placement === 'left-right'
    ? leftRightEdgePair(edges, points, tabWidth)
    : opposingEdgePair(edges, tabWidth);
  const intervalsByEdge = new Map();
  if (opposing) {
    for (const side of [opposing.first, opposing.second]) {
      intervalsByEdge.set(side.index, [[side.length / 2 - tabWidth / 2, side.length / 2 + tabWidth / 2]]);
    }
  } else {
    if (edge.length < tabWidth * 2.25) throw new Error('The longest model side is too short for two tabs of this width.');
    intervalsByEdge.set(edge.index, [edge.length / 3, edge.length * 2 / 3].map((center) => [center - tabWidth / 2, center + tabWidth / 2]));
  }
  const path = [];
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]; const b = points[(i + 1) % points.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cuts = [0, 1];
    const intervals = intervalsByEdge.get(i) || [];
    for (const [lo, hi] of intervals) cuts.push(lo / length, hi / length);
    cuts.sort((x, y) => x - y);
    const unique = cuts.filter((v, k) => k === 0 || Math.abs(v - cuts[k - 1]) > 1e-8);
    for (let k = 0; k < unique.length - 1; k += 1) {
      const t = unique[k];
      const distance = t * length;
      const onTab = intervals.some(([lo, hi]) => distance >= lo - 1e-7 && distance < hi - 1e-7);
      path.push({ point: pointAlong(a, b, t), tab: onTab });
    }
  }
  return { path, edgeLength: edge.length, oppositeSides: Boolean(opposing) };
}

export function planContourSweeps({ layers, stock, settings, side, toolDiameter, cutExtent = stock.thickness, topTabContours = null, clampXBounds = null, tabReleaseLayers = [] }) {
  const sideTabKeepoutPolygons = side === 'front' || side === 'back'
    ? tabKeepouts(topTabContours || [], Number(settings.tabWidth), Number(toolDiameter), { placement: 'left-right' })
    : [];
  const clampKeepouts = clampKeepoutPaths(stock, side, clampXBounds).map((path) => path.map(({ X, Y }) => [X / SCALE, Y / SCALE]));
  const plannedLayers = layers.map((layer) => {
    const mainOuter = layer.contours.filter((contour) => !contour.hole).sort((a, b) => b.area - a.area)[0];
    const paths = [];
    for (const contour of layer.contours) {
      const keepTabs = side === 'top' && layer.depth > Number(cutExtent) - Number(settings.tabHeight) + 1e-7 && contour === mainOuter;
      const path = keepTabs ? makeCutPath(contour.points, Number(settings.tabWidth), { placement: 'left-right' }).path : contour.points.map((point) => ({ point, tab: false }));
      const sideKeepouts = side === 'front' || side === 'back'
        ? sideTabKeepoutsAtDepth(sideTabKeepoutPolygons, side, stock, layer.depth, toolDiameter, settings.tabHeight)
        : [];
      for (const segment of splitPathSegments(path, [...sideKeepouts, ...clampKeepouts])) if (!segment.blocked) paths.push([segment.a, segment.b]);
    }
    return { depth: layer.depth, paths };
  });
  if (side === 'back' && tabReleaseLayers.length) {
    for (const layer of tabReleaseLayers) {
      const keepouts = sideTabKeepoutsAtDepth(sideTabKeepoutPolygons, 'back', stock, layer.depth, toolDiameter, settings.tabHeight);
      for (const contour of layer.contours.filter((item) => !item.hole)) {
        const path = contour.points.map((point) => ({ point, tab: false }));
        for (const segment of splitPathSegments(path, keepouts).filter((item) => item.blocked)) plannedLayers.push({ depth: layer.depth, paths: [[segment.a, segment.b]] });
      }
    }
  }
  return { side, diameter: Number(toolDiameter), layers: plannedLayers };
}

function continuousPerimeterSpiral(layers, { side, stock, settings, tool, tabCutDepth, cutExtent, sideTabKeepoutPolygons, clampKeepouts, trackIndex = 0 }) {
  if (layers.length < 2) return null;
  const entries = [];
  let previousStart = null;
  const maxLink = Math.max(1, Number(tool.diameter) * 0.75, Number(settings.stepDown) * 3);

  for (const layer of layers) {
    const outer = layer.contours.filter((contour) => !contour.hole).sort((a, b) => b.area - a.area)[trackIndex];
    if (!outer || outer.points.length < 3) return null;
    const keepTabs = side === 'top' && layer.depth > Number(cutExtent) - Number(settings.tabHeight) + 1e-7;
    let path = keepTabs
      ? makeCutPath(outer.points, Number(settings.tabWidth), { placement: 'left-right' }).path
      : outer.points.map((point) => ({ point, tab: false }));
    const pathForCheck = path.map(({ point }) => ({ point, tab: false }));
    const sideKeepouts = side === 'front' || side === 'back'
      ? sideTabKeepoutsAtDepth(sideTabKeepoutPolygons, side, stock, layer.depth, tool.diameter, settings.tabHeight)
      : [];
    if (splitPathSegments(pathForCheck, [...sideKeepouts, ...clampKeepouts]).some((segment) => segment.blocked)) return null;

    const validStarts = path.map((_, index) => index).filter((index) => !path[index].tab && !path[(index + path.length - 1) % path.length].tab);
    if (!validStarts.length) return null;
    let startIndex = validStarts[0];
    if (previousStart) {
      startIndex = validStarts.reduce((best, index) => {
        const point = path[index].point;
        const bestPoint = path[best].point;
        return Math.hypot(point[0] - previousStart[0], point[1] - previousStart[1]) < Math.hypot(bestPoint[0] - previousStart[0], bestPoint[1] - previousStart[1]) ? index : best;
      }, validStarts[0]);
      const chosen = path[startIndex].point;
      if (Math.hypot(chosen[0] - previousStart[0], chosen[1] - previousStart[1]) > maxLink) return null;
    }
    path = path.slice(startIndex).concat(path.slice(0, startIndex));
    const totalLength = path.reduce((sum, item, index) => {
      const next = path[(index + 1) % path.length].point;
      return sum + Math.hypot(next[0] - item.point[0], next[1] - item.point[1]);
    }, 0);
    if (totalLength <= 1e-5) return null;
    entries.push({ layer, outer, path, totalLength, keepTabs });
    previousStart = path[0].point;
  }

  const output = ['(CONTINUOUS PERIMETER SPIRAL: linked waterline loops ramp down without safe-Z retracts between levels)'];
  let currentDepth = 0;
  let currentPoint = null;
  for (const { layer, outer, path, totalLength, keepTabs } of entries) {
    const start = path[0].point;
    if (!currentPoint) {
      output.push(`(Perimeter spiral entry through Z-${fmt(layer.depth)})`);
      output.push(`G0 Z${fmt(settings.safeZ)}`, `G0 X${fmt(start[0])} Y${fmt(start[1])}`, `G1 Z0.000 F${Math.round(settings.plunge)}`);
    } else if (Math.hypot(start[0] - currentPoint[0], start[1] - currentPoint[1]) > 1e-5) {
      output.push(`(Link perimeter loops at Z-${fmt(currentDepth)})`, `G1 X${fmt(start[0])} Y${fmt(start[1])} F${Math.round(settings.feed)}`);
    }

    const rampStartDepth = currentDepth;
    let traveled = 0;
    for (let index = 0; index < path.length; index += 1) {
      const current = path[index];
      const next = path[(index + 1) % path.length];
      const segmentLength = Math.hypot(next.point[0] - current.point[0], next.point[1] - current.point[1]);
      const baseStartDepth = rampStartDepth + (Number(layer.depth) - rampStartDepth) * (traveled / totalLength);
      const baseEndDepth = rampStartDepth + (Number(layer.depth) - rampStartDepth) * ((traveled + segmentLength) / totalLength);
      const tabbed = keepTabs && current.tab;
      const safeTabDepth = Math.max(0, tabCutDepth);
      const startDepth = tabbed ? Math.min(baseStartDepth, safeTabDepth) : baseStartDepth;
      const endDepth = tabbed ? Math.min(baseEndDepth, safeTabDepth) : baseEndDepth;
      if (Math.abs(currentDepth - startDepth) > 0.0005) output.push(`G1 Z-${fmt(startDepth)} F${Math.round(settings.plunge)}`);
      output.push(`G1 X${fmt(next.point[0])} Y${fmt(next.point[1])} Z-${fmt(endDepth)} F${Math.round(settings.feed)}`);
      currentDepth = endDepth;
      traveled += segmentLength;
    }
    currentPoint = [...start];
  }
  output.push(`G0 Z${fmt(settings.safeZ)}`);
  return { lines: output, outerContours: entries.map((entry) => entry.outer) };
}

function canonicalContourKey(contour) {
  const points = contour.points.map(([x, y]) => `${Number(x).toFixed(3)},${Number(y).toFixed(3)}`);
  if (!points.length) return '';
  const normalize = (sequence) => {
    let start = 0;
    for (let i = 1; i < sequence.length; i += 1) if (sequence[i] < sequence[start]) start = i;
    return sequence.slice(start).concat(sequence.slice(0, start)).join(';');
  };
  const forward = normalize(points);
  const reverse = normalize([...points].reverse());
  return `${contour.hole ? 'H' : 'O'}:${forward < reverse ? forward : reverse}`;
}

function optimizeLayers(layers) {
  const optimized = layers.map((layer) => {
    const seen = new Set();
    const contours = layer.contours.filter((contour) => {
      const key = canonicalContourKey(contour);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...layer, contours };
  });
  for (const key of ['undercutFallback', 'rawLayers', 'accessContours']) if (layers[key]) optimized[key] = layers[key];
  return optimized;
}

function isCircularContour(contour) {
  if (!contour.hole || contour.points.length < 8) return false;
  const center = contour.points.reduce((sum, point) => [sum[0] + point[0] / contour.points.length, sum[1] + point[1] / contour.points.length], [0, 0]);
  const radii = contour.points.map((point) => Math.hypot(point[0] - center[0], point[1] - center[1]));
  const mean = radii.reduce((sum, radius) => sum + radius, 0) / radii.length;
  return mean > 0 && (Math.max(...radii) - Math.min(...radii)) / mean < 0.04;
}

function optimizeRoughing(roughing) {
  return roughing.map((layer) => {
    const seen = new Set();
    const paths = layer.paths.filter((path) => {
      const a = path[0].map((v) => Number(v).toFixed(3)).join(',');
      const b = path[1].map((v) => Number(v).toFixed(3)).join(',');
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...layer, paths };
  });
}

function optimizeSamePositionRetracts(lines, safeZ) {
  const output = [];
  let x = null; let y = null; let z = null; let lastXYWasCut = false;
  const words = (line) => Object.fromEntries([...line.matchAll(/([XYZ])(-?\d+(?:\.\d+)?)/g)].map((match) => [match[1], Number(match[2])]));
  const isComment = (line) => !line.trim() || line.trim().startsWith('(');
  const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.0005;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const retract = line.match(/^G0 Z(-?\d+(?:\.\d+)?)$/);
    if (retract && same(Number(retract[1]), safeZ) && lastXYWasCut && z !== null && z < safeZ && x !== null && y !== null) {
      let cursor = i + 1;
      while (cursor < lines.length && (isComment(lines[cursor]) || (lines[cursor].match(/^G0 Z(-?\d+(?:\.\d+)?)$/) && same(Number(lines[cursor].match(/^G0 Z(-?\d+(?:\.\d+)?)$/)[1]), safeZ)))) cursor += 1;
      const rapidXY = cursor < lines.length ? lines[cursor].match(/^G0 X(-?\d+(?:\.\d+)?) Y(-?\d+(?:\.\d+)?)$/) : null;
      if (rapidXY && same(Number(rapidXY[1]), x) && same(Number(rapidXY[2]), y)) {
        let plungeIndex = cursor + 1;
        while (plungeIndex < lines.length && isComment(lines[plungeIndex])) plungeIndex += 1;
        const plunge = plungeIndex < lines.length ? lines[plungeIndex].match(/^G1 Z(-?\d+(?:\.\d+)?) F(-?\d+(?:\.\d+)?)$/) : null;
        if (plunge) {
          for (let j = i + 1; j < cursor; j += 1) if (isComment(lines[j])) output.push(lines[j]);
          for (let j = cursor + 1; j < plungeIndex; j += 1) if (isComment(lines[j])) output.push(lines[j]);
          i = plungeIndex - 1;
          continue;
        }
      }
    }

    output.push(line);
    const command = line.trim();
    if (command === 'M5' || command.endsWith(' M6')) lastXYWasCut = false;
    const motion = command.match(/^G([01])\s/);
    if (!motion) continue;
    const coords = words(command);
    const isCut = motion[1] === '1';
    if (coords.X !== undefined) x = coords.X;
    if (coords.Y !== undefined) y = coords.Y;
    if (coords.Z !== undefined) z = coords.Z;
    if (coords.X !== undefined || coords.Y !== undefined) lastXYWasCut = isCut && z !== null && z < safeZ;
  }
  return output;
}

export function generateGcode({ layers, stock, settings, tool, roughingTool = tool, roughingExpansion = 0, omittedFeatureSections = 0, preplannedRoughing = null, previousRoughing = [], clampXBounds = null, side = 'top', cutExtent = stock.thickness, topTabContours = null, roughingLayers = layers, tabReleaseLayers = [] }) {
  const tabCutDepth = Number(cutExtent) - Number(settings.tabHeight);
  const bottomSide = side === 'bottom';
  const undercutOnly = bottomSide || side === 'back';
  const sideRotation = side === 'front' ? -90 : side === 'back' ? 90 : 0;
  const sideLabel = `${side}-side`;
  layers = optimizeLayers(layers);
  const roughing = optimizeRoughing(preplannedRoughing || (bottomSide ? [] : faceRoughingLayers(roughingLayers, stock, settings, roughingTool, side, topTabContours, roughingExpansion, previousRoughing, clampXBounds)));
  const sideTabKeepoutPolygons = side === 'front' || side === 'back'
    ? tabKeepouts(topTabContours || [], Number(settings.tabWidth), Number(tool.diameter), { placement: 'left-right' })
    : [];
  const clampKeepouts = clampKeepoutPaths(stock, side, clampXBounds).map((path) => path.map(({ X, Y }) => [X / SCALE, Y / SCALE]));
  const roughingDepth = roughing.at(-1)?.depth || 0;
  const initialTool = roughing.length ? roughingTool : tool;
  const lines = [
    `(CAMLab ${sideLabel} waterline contours generated from an STL/STEP mesh)`,
    '(MACHINING ORDER: TOP, FRONT, BACK, BOTTOM; USE THE FOUR PROGRAMS IN THIS ORDER)',
    '(PATH OPTIMIZATION: duplicate contours and same-depth raster segments are removed; rasters, circular holes, pockets/slots, and perimeter cuts are grouped)',
    '(PATH OPTIMIZATION: compatible outside waterline contours are linked into a continuous spiral; tab and clamp keepouts remain protected)',
    '(PATH LINKING: a safe-Z retract and repeated XY rapid are removed when the next plunge starts at the exact previous cut endpoint)',
    `(Stock ${fmt(stock.length)} x ${fmt(stock.width)} x ${fmt(stock.thickness)} mm; XY origin: ${stock.originMode === 'center' ? 'stock center' : 'imported model coordinates'}; Z0 at ${bottomSide ? 'flipped exposed face' : side === 'front' || side === 'back' ? 'newly exposed side face' : 'stock top'})`,
    ...(clampXBounds ? [`(CLAMP RAILS: no cuts outside X${fmt(clampXBounds.minX)} to X${fmt(clampXBounds.maxX)}; left and right stock rails remain clamped)`] : []),
    ...(previousRoughing.length ? [`(STOCK STATE: ${previousRoughing.map((item) => item.side).join(' and ')} swept paths are used to exclude previously cleared areas from this side's roughing; this is not a full 3D stock simulation)`] : []),
    roughing.length && Number(roughingTool.diameter) !== Number(tool.diameter)
      ? `(Tool plan: T${roughingTool.number} ${fmt(roughingTool.diameter)} mm roughing; T${tool.number} ${fmt(tool.diameter)} mm contours)`
      : `(Tool plan: T${tool.number} ${fmt(tool.diameter)} mm for generated paths)`,
    ...(omittedFeatureSections ? [`(WARNING: ${omittedFeatureSections} hole/slot contour sections are omitted because they are too small for the smallest available cutter.)`] : []),
    undercutOnly
      ? side === 'back'
        ? `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; missed internal undercuts plus tab-support undercut segments; no complete outside perimeter)`
        : `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; missed internal undercut paths only; outside perimeter and tab cuts omitted)`
      : side === 'front'
        ? `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; no front-side tabs; top-side tab supports are preserved)`
        : `(Tool T${tool.number}, diameter ${fmt(tool.diameter)} mm; spindle ${Math.round(settings.rpm)} RPM; two left/right tabs ${fmt(settings.tabWidth)} mm wide x ${fmt(settings.tabHeight)} mm high)`,
    ...(bottomSide ? [
      '(BOTTOM-SIDE PROGRAM: INTERNAL UNDERCUT CONTOURS ONLY)',
      '(OUTSIDE PERIMETER AND TAB CUTS ARE OMITTED; TOP-SIDE TABS MUST REMAIN IN PLACE)',
      '(FLIP STOCK 180 DEGREES ABOUT X AXIS THROUGH STOCK CENTER: X IS UNCHANGED, Y MIRRORS ACROSS THE STOCK CENTERLINE (FRONT/BACK FLIPS; LEFT/RIGHT STAYS FIXED))',
      '(KEEP THE SAME STOCK XY ORIGIN AND G54 WORK OFFSET; REGISTER PART TO STOCK CENTERLINES)',
      '(RESET Z0 TO THE NEWLY EXPOSED FACE; DO NOT CHANGE THE XY WORK OFFSET)',
    ] : []),
    ...(side === 'back' ? [
      '(BACK-SIDE PROGRAM: INTERNAL UNDERCUT CONTOURS MISSED BY THE FRONT-SIDE PROGRAM ONLY)',
      '(GENERAL OUTSIDE PERIMETER IS OMITTED; ONLY THE PERIMETER SEGMENTS UNDER THE TWO TOP-SIDE TABS ARE CUT HERE)',
    ] : []),
    ...(side === 'front' || side === 'back' ? [
      `(${side.toUpperCase()} SIDE: ROTATE STOCK ${sideRotation > 0 ? '+' : ''}${sideRotation} DEGREES ABOUT STOCK-CENTERED X; ${side === 'front' ? 'Y-MINUS FACE' : 'Y-PLUS FACE'} UP)`,
      '(KEEP THE SELECTED X DATUM; MACHINE Y FOLLOWS STOCK THICKNESS ABOUT ITS CENTERLINE)',
      '(RESET Z0 TO THE NEWLY EXPOSED FACE; REVIEW XY REGISTRATION AND SIMULATE BEFORE CUTTING)',
    ] : []),
    undercutOnly
      ? side === 'back'
        ? '(Back-side file contains internal paths missed from the front plus perimeter undercuts beneath the retained top-side tabs. The full outside perimeter is not repeated. Review and simulate; no job is started.)'
        : '(Bottom-side file contains only internal paths detected as hidden from the top-side tool access check. No outside perimeter is cut. Review and simulate; no job is started.)'
      : layers.undercutFallback
      ? `(Undercut at depth ${fmt(layers.undercutFallback.depth)} mm; ${sideLabel} paths use the last reachable profile from depth ${fmt(layers.undercutFallback.continuationDepth)} mm through the remaining stock. Hidden geometry may need another side file. Review and simulate; no job is started.)`
      : '(Contour finishing only; vertical tool-access check passed. Review and simulate before cutting. No job is started.)',
    ...(roughing.length ? [
      `(${side.toUpperCase()}-SIDE AREA ROUGHING: raster-clear accessible stock outside each tool-offset model section, including hole and slot waste, through Z-${fmt(roughingDepth)}; one contour level remains)`,
      side === 'back'
        ? '(Top-side tab support zones are reserved during roughing. Missed internal feature contours run after roughing; outside profile and tabs are omitted.)'
        : side === 'front'
          ? '(Top-side tab support zones are reserved. The front-side perimeter and reachable features run after roughing; no front-side tabs are added.)'
          : '(Tab support zones are reserved during roughing. All perimeter, hole, and slot contour passes run after roughing.)',
    ] : []),
    'G21', 'G90', 'G17', 'G94', 'G54', `T${Math.max(1, Math.floor(Number(initialTool.number) || 1))} M6`, `S${Math.round(settings.rpm)} M3`,
    `G0 Z${fmt(settings.safeZ)}`,
  ];
  for (const layer of roughing) {
    lines.push(`(Area roughing depth Z-${fmt(layer.depth)})`);
    for (const path of layer.paths) {
      lines.push(`G0 Z${fmt(settings.safeZ)}`);
      lines.push(`G0 X${fmt(path[0][0])} Y${fmt(path[0][1])}`);
      lines.push(`G1 Z-${fmt(layer.depth)} F${Math.round(settings.plunge)}`);
      lines.push(`G1 X${fmt(path[1][0])} Y${fmt(path[1][1])} F${Math.round(settings.feed)}`);
    }
  }
  if (roughing.length && Number(roughingTool.diameter) !== Number(tool.diameter)) {
    lines.push(`(Change to finishing tool T${Math.max(1, Math.floor(Number(tool.number) || 1))}, diameter ${fmt(tool.diameter)} mm)`);
    lines.push(`G0 Z${fmt(settings.safeZ)}`, 'M5', `T${Math.max(1, Math.floor(Number(tool.number) || 1))} M6`, `S${Math.round(settings.rpm)} M3`);
  }
  const finishGroups = [
    { label: 'CIRCULAR HOLE CONTOURS (END-MILL INTERPOLATION)', match: isCircularContour },
    { label: 'POCKET / SLOT CONTOURS', match: (contour) => contour.hole && !isCircularContour(contour) },
    { label: 'PERIMETER CONTOURS', match: (contour) => !contour.hole },
  ];
  for (const group of finishGroups) {
    lines.push(`(${group.label})`);
    let spiraledOuters = null;
    if (group.label === 'PERIMETER CONTOURS') {
      spiraledOuters = [];
      const trackCount = Math.max(0, ...layers.map((layer) => layer.contours.filter((contour) => !contour.hole).length));
      for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
        const spiral = continuousPerimeterSpiral(layers, { side, stock, settings, tool, tabCutDepth, cutExtent, sideTabKeepoutPolygons, clampKeepouts, trackIndex });
        if (!spiral) continue;
        lines.push(...spiral.lines);
        spiraledOuters.push(...spiral.outerContours);
      }
    }
    for (const layer of layers) {
      lines.push(`(Waterline finishing depth Z-${fmt(layer.depth)})`);
      const contours = layer.contours.filter((contour) => group.match(contour) && !spiraledOuters?.includes(contour)).sort((a, b) => b.area - a.area);
      const mainOuter = layer.contours.find((contour) => !contour.hole);
      for (const contour of contours) {
      const keepTabs = side === 'top' && layer.depth > tabCutDepth + 1e-7 && contour === mainOuter;
      const path = keepTabs ? makeCutPath(contour.points, Number(settings.tabWidth), { placement: 'left-right' }).path : contour.points.map((point) => ({ point, tab: false }));
      const sideKeepouts = (side === 'front' || side === 'back')
        ? sideTabKeepoutsAtDepth(sideTabKeepoutPolygons, side, stock, layer.depth, tool.diameter, settings.tabHeight)
        : [];
      const segments = splitPathSegments(path, [...sideKeepouts, ...clampKeepouts]);
      let penDown = false;
      for (const segment of segments) {
        if (segment.blocked) {
          if (penDown) { lines.push(`G0 Z${fmt(settings.safeZ)}`); penDown = false; }
          continue;
        }
        if (!penDown) {
          lines.push(`G0 Z${fmt(settings.safeZ)}`);
          lines.push(`G0 X${fmt(segment.a[0])} Y${fmt(segment.a[1])}`);
          lines.push(`G1 Z-${fmt(layer.depth)} F${Math.round(settings.plunge)}`);
          penDown = true;
        }
        lines.push(`G1 X${fmt(segment.b[0])} Y${fmt(segment.b[1])} F${Math.round(settings.feed)}`);
      }
        if (penDown) lines.push(`G0 Z${fmt(settings.safeZ)}`);
      }
    }
  }
  if (side === 'back' && tabReleaseLayers.length) {
    lines.push('(BACK-SIDE UNDERCUT BENEATH THE RETAINED TOP-SIDE TABS)');
    for (const layer of tabReleaseLayers) {
      const keepouts = sideTabKeepoutsAtDepth(sideTabKeepoutPolygons, 'back', stock, layer.depth, tool.diameter, settings.tabHeight);
      if (!keepouts.length) continue;
      for (const contour of layer.contours.filter((item) => !item.hole)) {
        const path = contour.points.map((point) => ({ point, tab: false }));
        for (const segment of splitPathSegments(path, keepouts).filter((item) => item.blocked && Math.hypot(item.b[0] - item.a[0], item.b[1] - item.a[1]) > 1e-4)) {
          lines.push(`(Tab-support undercut perimeter depth Z-${fmt(layer.depth)})`);
          lines.push(`G0 Z${fmt(settings.safeZ)}`);
          lines.push(`G0 X${fmt(segment.a[0])} Y${fmt(segment.a[1])}`);
          lines.push(`G1 Z-${fmt(layer.depth)} F${Math.round(settings.plunge)}`);
          lines.push(`G1 X${fmt(segment.b[0])} Y${fmt(segment.b[1])} F${Math.round(settings.feed)}`);
          lines.push(`G0 Z${fmt(settings.safeZ)}`);
        }
      }
    }
  }
  lines.push('M5', 'M30', '');
  return optimizeSamePositionRetracts(lines, Number(settings.safeZ)).join('\n');
}

export function bounds(points) {
  return {
    minX: Math.min(...points.map((p) => p[0])), maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])), maxY: Math.max(...points.map((p) => p[1])),
  };
}
