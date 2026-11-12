import polygonClipping from 'polygon-clipping';
import ClipperLib from 'clipper-lib';

const SCALE = 1000;
const signedArea = (ring) => ring.reduce((sum, point, i) => {
  const next = ring[(i + 1) % ring.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;

function pointInside(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]; const b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-20) + a[0]) inside = !inside;
  }
  return inside;
}

function interiorSample(ring, area) {
  const a = ring[0]; const b = ring[1];
  const dx = b[0] - a[0]; const dy = b[1] - a[1]; const length = Math.hypot(dx, dy) || 1;
  const side = area >= 0 ? 1 : -1;
  const epsilon = Math.min(0.001, length / 1000);
  return [(a[0] + b[0]) / 2 - side * dy / length * epsilon, (a[1] + b[1]) / 2 + side * dx / length * epsilon];
}

function classifyRings(rings) {
  const prepared = rings.filter((ring) => ring.length >= 3).map((ring) => ({ points: ring, area: signedArea(ring) }));
  for (const loop of prepared) {
    const sample = interiorSample(loop.points, loop.area);
    loop.nesting = prepared.filter((other) => other !== loop && Math.abs(other.area) > Math.abs(loop.area) && pointInside(sample, other.points)).length;
    loop.hole = loop.nesting % 2 === 1;
    const desiredPositive = !loop.hole;
    if ((loop.area > 0) !== desiredPositive) { loop.points.reverse(); loop.area *= -1; }
  }
  return prepared;
}

function projectedUnion(triangles) {
  const regions = [];
  for (const tri of triangles) {
    const ring = tri.map(([x, y]) => [Number(x.toFixed(5)), Number(y.toFixed(5))]);
    const area2 = Math.abs((ring[1][0] - ring[0][0]) * (ring[2][1] - ring[0][1]) - (ring[2][0] - ring[0][0]) * (ring[1][1] - ring[0][1]));
    if (area2 < 1e-8) continue;
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
  return level[0];
}

export function analyzeModel(triangles) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const tri of triangles) for (const [x, y, z] of tri) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  const projected = projectedUnion(triangles);
  const external = projected.map((polygon) => polygon[0]).filter((ring) => ring?.length >= 4);
  const xy = external.flat();
  const minX = Math.min(...xy.map((p) => p[0])); const maxX = Math.max(...xy.map((p) => p[0]));
  const minY = Math.min(...xy.map((p) => p[1])); const maxY = Math.max(...xy.map((p) => p[1]));
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const polygons = projected.map((polygon) => polygon.map((ring) => ring.slice(0, -1).map(([x, y]) => [x - center.x, y - center.y])));
  const allOuter = classifyRings(polygons.flatMap((polygon) => polygon.filter((_, index) => index === 0)));
  allOuter.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  return {
    polygons,
    outline: allOuter[0]?.points || [],
    center,
    minZ: bounds.minZ,
    maxZ: bounds.maxZ,
    size: { length: maxX - minX, width: maxY - minY, height: bounds.maxZ - bounds.minZ },
  };
}

function pointKey(x, y) { return `${Math.round(x * SCALE)},${Math.round(y * SCALE)}`; }

function sliceContoursAtPlane(triangles, z, center) {
  const segments = [];
  const edgeKeys = new Set();
  for (const tri of triangles) {
    const hits = [];
    for (const [ia, ib] of [[0, 1], [1, 2], [2, 0]]) {
      const a = tri[ia]; const b = tri[ib]; const da = a[2] - z; const db = b[2] - z;
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        const point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        if (!hits.some((item) => Math.hypot(item[0] - point[0], item[1] - point[1]) < 1e-7)) hits.push(point);
      }
    }
    if (hits.length !== 2) continue;
    const a = [Math.round(hits[0][0] * SCALE) / SCALE, Math.round(hits[0][1] * SCALE) / SCALE];
    const b = [Math.round(hits[1][0] * SCALE) / SCALE, Math.round(hits[1][1] * SCALE) / SCALE];
    const ka = pointKey(a[0], a[1]); const kb = pointKey(b[0], b[1]);
    if (ka === kb) continue;
    const edgeKey = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (edgeKeys.has(edgeKey)) continue;
    edgeKeys.add(edgeKey);
    segments.push({ a, b, ka, kb });
  }
  if (!segments.length) return [];

  const adjacency = new Map(); const coordinates = new Map();
  segments.forEach((segment, i) => {
    coordinates.set(segment.ka, segment.a); coordinates.set(segment.kb, segment.b);
    if (!adjacency.has(segment.ka)) adjacency.set(segment.ka, []);
    if (!adjacency.has(segment.kb)) adjacency.set(segment.kb, []);
    adjacency.get(segment.ka).push(i); adjacency.get(segment.kb).push(i);
  });
  if ([...adjacency.values()].some((edges) => edges.length !== 2)) {
    throw new Error('The model mesh has an open or non-manifold cross-section at this depth. Repair the STL/STEP mesh and retry.');
  }
  const visited = new Uint8Array(segments.length); const rings = [];
  for (let startEdge = 0; startEdge < segments.length; startEdge += 1) {
    if (visited[startEdge]) continue;
    const first = segments[startEdge]; const startKey = first.ka;
    let currentKey = startKey; let edgeIndex = startEdge; const ring = []; let closed = false;
    for (let guard = 0; guard <= segments.length; guard += 1) {
      if (visited[edgeIndex]) break;
      visited[edgeIndex] = 1; ring.push(coordinates.get(currentKey));
      const segment = segments[edgeIndex]; const nextKey = segment.ka === currentKey ? segment.kb : segment.ka;
      if (nextKey === startKey) { closed = true; break; }
      const candidates = (adjacency.get(nextKey) || []).filter((id) => !visited[id]);
      if (!candidates.length) break;
      if (candidates.length === 1) edgeIndex = candidates[0];
      else {
        const incoming = coordinates.get(nextKey).map((v, i) => v - coordinates.get(currentKey)[i]);
        const norm = Math.hypot(...incoming) || 1;
        edgeIndex = candidates.sort((left, right) => {
          const score = (id) => {
            const candidate = segments[id]; const dest = candidate.ka === nextKey ? candidate.b : candidate.a;
            const dx = dest[0] - coordinates.get(nextKey)[0]; const dy = dest[1] - coordinates.get(nextKey)[1];
            return (incoming[0] * dx + incoming[1] * dy) / (norm * (Math.hypot(dx, dy) || 1));
          };
          return score(right) - score(left);
        })[0];
      }
      currentKey = nextKey;
    }
    if (closed && ring.length >= 3) rings.push(ring.map(([x, y]) => [x - center.x, y - center.y]));
  }
  return classifyRings(rings);
}

export function sliceContours(triangles, z, center = { x: 0, y: 0 }, retryDirection = 1) {
  let firstError = null;
  let result = null;
  try {
    result = sliceContoursAtPlane(triangles, z, center);
    if (result.length) return result;
  } catch (error) {
    firstError = error;
  }

  let coordinateScale = Math.max(1, Math.abs(z));
  let planeTouchesVertex = false;
  for (const triangle of triangles) for (const point of triangle) {
    coordinateScale = Math.max(coordinateScale, Math.abs(point[2]));
    if (Math.abs(point[2] - z) <= coordinateScale * Number.EPSILON * 16) planeTouchesVertex = true;
  }
  if (!firstError && !planeTouchesVertex) return result;

  // STEP tessellation planes often land exactly on a shared mesh edge or face.
  // A micron-scale nudge toward the prior pass avoids counting that edge twice
  // while keeping the toolpath effectively at the requested waterline.
  const baseNudge = Math.max(1e-6, coordinateScale * Number.EPSILON * 32);
  const nudges = [1, 2, 5, 10, 20].map((multiple) => baseNudge * multiple);
  const preferred = Math.sign(retryDirection) || 1;
  for (const direction of [preferred, -preferred]) {
    for (const nudge of nudges) {
      try {
        const nearby = sliceContoursAtPlane(triangles, z + direction * nudge, center);
        if (nearby.length) return nearby;
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  }
  if (firstError) throw firstError;
  return result || [];
}

export function offsetContours(contours, diameter, { allowMissingHoles = false } = {}) {
  if (!contours.length) return [];
  const paths = contours.map((loop) => loop.points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  paths.forEach((path, index) => {
    const positive = ClipperLib.Clipper.Area(path) > 0;
    if (positive === contours[index].hole) path.reverse();
  });
  const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * SCALE);
  offsetter.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  offsetter.Execute(solution, Number(diameter) * SCALE / 2);
  const result = solution.map((path) => {
    const area = ClipperLib.Clipper.Area(path);
    return { points: path.map(({ X, Y }) => [X / SCALE, Y / SCALE]), hole: area < 0, area: Math.abs(area) / (SCALE * SCALE) };
  });
  const inputHoles = contours.filter((loop) => loop.hole).length;
  const outputHoles = result.filter((loop) => loop.hole).length;
  const missingHoleCount = Math.max(0, inputHoles - outputHoles);
  if (missingHoleCount && !allowMissingHoles) throw new Error('The selected cutter is too large to preserve one or more holes or slots at this depth. Choose a smaller tool.');
  if (!result.some((loop) => !loop.hole)) throw new Error('The selected tool removes the entire contour at this depth.');
  result.sort((a, b) => Number(a.hole) - Number(b.hole) || b.area - a.area);
  result.missingHoleCount = missingHoleCount;
  return result;
}

function ringBounds(points) {
  return {
    minX: Math.min(...points.map((p) => p[0])), maxX: Math.max(...points.map((p) => p[0])),
    minY: Math.min(...points.map((p) => p[1])), maxY: Math.max(...points.map((p) => p[1])),
  };
}

function onBoundary(point, ring, tolerance) {
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]; const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const length2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
    if (Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)) <= tolerance) return true;
  }
  return false;
}

function isAccessible(point, contours, tolerance) {
  const containing = [];
  for (const contour of contours) {
    const box = contour.bounds || (contour.bounds = ringBounds(contour.points));
    if (point[0] < box.minX - tolerance || point[0] > box.maxX + tolerance || point[1] < box.minY - tolerance || point[1] > box.maxY + tolerance) continue;
    if (onBoundary(point, contour.points, tolerance)) return true;
    if (pointInside(point, contour.points)) containing.push(contour);
  }
  if (!containing.length) return true;
  containing.sort((a, b) => a.area - b.area);
  return containing[0].hole;
}

function sampleContour(contour, maxSamples = 192) {
  const points = contour.points; const lengths = points.map((point, i) => {
    const next = points[(i + 1) % points.length]; return Math.hypot(next[0] - point[0], next[1] - point[1]);
  });
  const perimeter = lengths.reduce((sum, value) => sum + value, 0);
  const count = Math.min(maxSamples, Math.max(points.length, Math.ceil(perimeter / 0.75)));
  const samples = []; let edge = 0; let edgeStart = 0;
  for (let i = 0; i < count; i += 1) {
    const distance = perimeter * i / count;
    while (edge < lengths.length - 1 && edgeStart + lengths[edge] < distance) { edgeStart += lengths[edge]; edge += 1; }
    const length = lengths[edge] || 1; const t = Math.max(0, Math.min(1, (distance - edgeStart) / length));
    const a = points[edge]; const b = points[(edge + 1) % points.length];
    samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return samples;
}

export function isContourAccessibleFrom(contour, upperLayers, tolerance = 0.05) {
  const samples = sampleContour(contour);
  return samples.every((point) => upperLayers.every((upper) => isAccessible(point, upper.contours, tolerance)));
}

export function ensureMillAccessible(layers, topAccess, tolerance = 0.05) {
  const above = [topAccess];
  for (const layer of layers) {
    for (const upper of above) {
      for (const contour of layer.contours) {
        for (const point of sampleContour(contour)) {
          if (!isAccessible(point, upper.contours, tolerance)) {
            const feature = contour.hole ? 'A hole or slot' : 'An outside contour';
            return { layerIndex: layers.indexOf(layer), depth: layer.depth, upperDepth: upper.depth, feature };
          }
        }
      }
    }
    above.push(layer);
  }
  return null;
}
