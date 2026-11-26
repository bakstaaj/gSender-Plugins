import ClipperLib from 'clipper-lib';

const EPSILON = 1e-7;
const sizeOf = ([x, y]) => Math.hypot(x, y);
const subtract = ([ax, ay], [bx, by]) => [ax - bx, ay - by];
const advance = ([x, y], [dx, dy], t) => [x + t * dx, y + t * dy];
const cross = ([ax, ay], [bx, by]) => ax * by - ay * bx;
const countOk = value => Number.isSafeInteger(value) && value > 0 && value <= 1000;
// A segment deviates at most 0.01 mm from the circle it approximates.
const arcStep = radius => Math.min(Math.PI / 36, 4 * Math.asin(Math.min(1, Math.sqrt(.005 / radius))));

export function arcThroughThreePoints(start, through, end) {
  const first = subtract(through, start), last = subtract(end, start);
  const firstLength = sizeOf(first), lastLength = sizeOf(last);
  if (Math.min(firstLength, lastLength, sizeOf(subtract(end, through))) < EPSILON) {
    throw Error('Pick three distinct points for the arc.');
  }
  const turn = cross(first, last);
  if (Math.abs(turn) <= EPSILON * firstLength * lastLength) {
    throw Error('Those points are on a straight line. Pick a different point.');
  }
  const firstSquare = firstLength ** 2, lastSquare = lastLength ** 2;
  const center = [
    start[0] + (firstSquare * last[1] - lastSquare * first[1]) / (2 * turn),
    start[1] + (first[0] * lastSquare - last[0] * firstSquare) / (2 * turn),
  ];
  const radius = sizeOf(subtract(start, center));
  if (!Number.isFinite(radius)) throw Error('The arc is outside the drawing coordinate range.');
  const direction = Math.sign(turn), tau = 2 * Math.PI;
  const angle = ([x, y]) => Math.atan2(y - center[1], x - center[0]);
  const points = [start];
  for (const [a, b] of [[start, through], [through, end]]) {
    const from = angle(a), to = angle(b);
    const sweep = direction * ((direction * (to - from) + tau) % tau);
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep(radius)));
    if (count > 10000) throw Error('The arc radius is too large for this drawing.');
    for (let i = 1; i < count; i++) {
      const t = from + sweep * i / count;
      points.push(advance(center, [Math.cos(t), Math.sin(t)], radius));
    }
    points.push(b);
  }
  return points;
}

export function rectangularArray(columns, rows, pitchX, pitchY) {
  if (!countOk(columns) || !countOk(rows) || columns * rows > 1000) {
    throw Error('Enter whole rows and columns with at most 1,000 total positions.');
  }
  if (![pitchX, pitchY].every(Number.isFinite) ||
      (columns > 1 && Math.abs(pitchX) < EPSILON) || (rows > 1 && Math.abs(pitchY) < EPSILON)) {
    throw Error('Enter nonzero spacing for each repeated direction.');
  }
  if (!Number.isFinite((columns - 1) * pitchX) || !Number.isFinite((rows - 1) * pitchY)) {
    throw Error('The array spacing exceeds the coordinate range.');
  }
  const offsets = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (row || column) offsets.push([column * pitchX || 0, row * pitchY || 0]);
    }
  }
  return offsets;
}

export function circularArray(count, sweep, center, seed, radius) {
  if (!countOk(count) || count < 2) throw Error('Enter 2 to 1,000 positions.');
  if (!Number.isFinite(sweep) || Math.abs(sweep) < .01 || Math.abs(sweep) > 360) {
    throw Error('Enter a sweep between 0.01° and 360° in either direction.');
  }
  if (![...center, ...seed].every(Number.isFinite)) throw Error('Enter a valid array center.');
  const [dx, dy] = subtract(seed, center);
  const distance = Math.hypot(dx, dy);
  if (radius === undefined && distance < EPSILON) throw Error('Enter a radius or move the selection away from the array center.');
  if (radius !== undefined && (!Number.isFinite(radius) || radius <= 0)) throw Error('Enter a positive array radius.');
  const [x, y] = radius === undefined ? [dx, dy] :
    distance < EPSILON ? [radius, 0] : [dx / distance * radius, dy / distance * radius];
  const seedOffset = [x - dx, y - dy];
  const step = sweep * Math.PI / 180 / (Math.abs(sweep) === 360 ? count : count - 1);
  const offsets = Array.from({length: count - 1}, (_, i) => {
    const angle = (i + 1) * step;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return [x * cos - y * sin - dx, x * sin + y * cos - dy];
  });
  if (![seedOffset,...offsets].every(offset => offset.every(Number.isFinite))) {
    throw Error('The array radius exceeds the coordinate range.');
  }
  return {seedOffset, offsets};
}

export function cornerOutline(object) {
  if (object.kind === 'rect') {
    const {x1, y1, x2, y2} = object;
    return {points: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], closed: true};
  }
  if (!['polygon', 'polyline'].includes(object.kind) || !(object.points?.length >= 3)) return null;
  const points = object.points.filter((point, i, all) => !i || sizeOf(subtract(point, all[i - 1])) > EPSILON);
  const repeated = sizeOf(subtract(points[0], points.at(-1))) <= EPSILON;
  if (repeated) points.pop();
  const closed = repeated || object.kind === 'polygon';
  return points.length >= 3 ? {points, closed} : null;
}

function corners({points, closed}, mode) {
  const winding = closed ? Math.sign(points.reduce((area, point, i) =>
    area + cross(point, points[(i + 1) % points.length]), 0)) : 0;
  return points.map((vertex, i) => {
    if (!closed && (!i || i === points.length - 1)) return null;
    const incoming = subtract(points.at(i - 1), vertex);
    const outgoing = subtract(points[(i + 1) % points.length], vertex);
    const before = sizeOf(incoming), after = sizeOf(outgoing);
    if (before < EPSILON || after < EPSILON) return null;
    const u = incoming.map(value => value / before), v = outgoing.map(value => value / after);
    const turn = -cross(u, v);
    const angle = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    // Ignore nearly straight vertices, including the facets used to display a rounded corner.
    if (angle <= EPSILON || Math.PI - angle < Math.PI / 24) return null;
    if (mode === 'concave' && (!closed || turn * winding <= 0)) return null;
    return {vertex, u, v, angle, turn};
  });
}

export function cornerTargets(outline, mode) {
  return corners(outline, mode).flatMap((corner, index) => corner ? [{index, point: corner.vertex}] : []);
}

export function shapeCorners(outline, mode, size, onlyIndex) {
  if (!Number.isFinite(size) || size <= 0) throw Error('Enter a positive corner size.');
  const {points, closed} = outline;
  const changed = corners(outline, mode).map((corner, i) => {
    if (!corner || (onlyIndex !== undefined && i !== onlyIndex)) return null;
    const {vertex, u, v, angle, turn} = corner;
    const setback = mode === 'fillet' ? size / Math.tan(angle / 2) : size;
    const a = advance(vertex, u, setback), b = advance(vertex, v, setback);
    if (mode === 'chamfer') return {setback, points: [a, b]};
    const bisector = [u[0] + v[0], u[1] + v[1]];
    const center = mode === 'concave' ? vertex :
      advance(vertex, bisector, size / (sizeOf(bisector) * Math.sin(angle / 2)));
    const start = Math.atan2(a[1] - center[1], a[0] - center[0]);
    const sweep = Math.sign(turn) * (mode === 'concave' ? -angle : Math.PI - angle);
    // Limit the sagitta to 0.01 mm and keep gentle arc facets below the corner angle threshold.
    const step = arcStep(size);
    const count = Math.max(2, Math.ceil(Math.abs(sweep) / step));
    if (count > 5000) throw Error('The corner radius is too large to draw.');
    const arc = [a];
    for (let segment = 1; segment < count; segment++) {
      const t = start + sweep * segment / count;
      arc.push(advance(center, [Math.cos(t), Math.sin(t)], size));
    }
    arc.push(b);
    return {setback, points: arc};
  });
  if (!changed.some(Boolean)) throw Error('No eligible corners on this selection.');
  for (let i = closed ? 0 : 1; i < points.length; i++) {
    const available = sizeOf(subtract(points.at(i - 1), points[i]));
    const used = (changed.at(i - 1)?.setback || 0) + (changed[i]?.setback || 0);
    if (used > 0 && used >= available - EPSILON) throw Error('The corner size is too large for the adjoining edges.');
  }
  const result = points.flatMap((point, i) => changed[i]?.points || [point]);
  if (closed) {
    const {Clipper, PolyFillType} = ClipperLib;
    const ring = result.map(([x, y])=>({X:Math.round(x * 1000),Y:Math.round(y * 1000)}));
    const resolved = Clipper.SimplifyPolygon(ring,PolyFillType.pftEvenOdd);
    if (resolved.length !== 1 || Math.abs(Clipper.Area(ring)) !== Math.abs(Clipper.Area(resolved[0]))) {
      throw Error('The corner treatment crosses or collapses the outline. Try a smaller size.');
    }
  }
  return {kind: closed ? 'polygon' : 'polyline', points: result};
}
