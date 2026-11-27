const gcodeWord = /([XYZ])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi;
const positive = value => Number.isFinite(value) && value > 0;

function readSegments(job) {
  const angle = job.tool?.angle ?? Number(job.gcode.match(/V-bit included angle ([.\d]+) degrees/i)?.[1]);
  const diameter = job.tool?.diameter ?? Number(job.gcode.match(/(?:actual drill diameter|tool diameter|cutter diameter) ([.\d]+) mm/i)?.[1]);
  const cone = job.operation === 'vgroove' || job.operation === 'vgroove-flat';
  const slope = cone && angle > 0 && angle < 180 ? Math.tan(angle * Math.PI / 360) : 0;
  const radius = positive(diameter) ? diameter / 2 : 0;
  const segments = [];
  let drawnRadius = 0;
  let position = {x: 0, y: 0, z: 0};
  // Carve Studio emits absolute G0/G1 moves with stock surface at Z0.
  for (const line of job.gcode.split(/\r?\n/)) {
    if (job.operation === 'drill' && line.startsWith('(Hole ')) {
      drawnRadius = Number(line.match(/drawn diameter ([.\d]+) mm/i)?.[1]) / 2;
    }
    const motion = line.match(/^G0?([01])\s/i);
    if (!motion) continue;
    const next = {...position};
    for (const [, axis, value] of line.matchAll(gcodeWord)) next[axis.toLowerCase()] = Number(value);
    const cutRadius = radius || (job.operation === 'drill' ? drawnRadius : 0);
    if (motion[1] === '1' && Math.min(position.z, next.z) < 0 && (cone ? slope : positive(cutRadius))) {
      segments.push({start: position, end: next, radius: cutRadius, slope});
    }
    position = next;
  }
  return {segments, estimatedDrill: job.operation === 'drill' && !radius && segments.length > 0};
}

function sweep(grid, {start, end, radius, slope}) {
  const {columns, rows, cellWidth, cellHeight, thickness, depths} = grid;
  const deepest = -Math.min(start.z, end.z);
  const reach = slope ? Math.min(radius || Infinity, deepest * slope) : radius;
  const firstX = Math.max(0, Math.ceil((Math.min(start.x, end.x) - reach) / cellWidth - .5));
  const lastX = Math.min(columns - 1, Math.floor((Math.max(start.x, end.x) + reach) / cellWidth - .5));
  const firstY = Math.max(0, Math.ceil((Math.min(start.y, end.y) - reach) / cellHeight - .5));
  const lastY = Math.min(rows - 1, Math.floor((Math.max(start.y, end.y) + reach) / cellHeight - .5));
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const ux = length ? dx / length : 0, uy = length ? dy / length : 0;
  const depthChange = start.z - end.z;
  const incline = length && slope ? depthChange * slope / length : 0;
  // A moving cone may cut deepest just before or after the closest point on the segment.
  const coneOffset = Math.abs(incline) < 1 ? incline / Math.sqrt(1 - incline * incline) : 0;
  for (let row = firstY; row <= lastY; row++) {
    const y = (row + .5) * cellHeight - start.y;
    for (let col = firstX; col <= lastX; col++) {
      const index = row * columns + col;
      if (depths[index] >= Math.min(thickness, deepest) - 1e-6) continue;
      const x = (col + .5) * cellWidth - start.x;
      let removed;
      if (!length) {
        const distance = Math.hypot(x, y);
        if (distance > reach) continue;
        removed = slope ? deepest - distance / slope : deepest;
      } else {
        const across = Math.abs(x * uy - y * ux);
        if (across > reach) continue;
        const along = x * ux + y * uy;
        const overlap = Math.sqrt(Math.max(0, reach * reach - across * across));
        const left = Math.max(0, along - overlap), right = Math.min(length, along + overlap);
        if (left > right) continue;
        const best = slope && Math.abs(incline) < 1
          ? Math.max(left, Math.min(right, along + across * coneOffset))
          : depthChange > 0 ? right : left;
        removed = -start.z + depthChange * best / length;
        if (slope) removed -= Math.hypot(across, best - along) / slope;
      }
      if (removed > depths[index]) depths[index] = Math.min(thickness, removed);
    }
  }
}

export async function simulateCut(stock, jobs, cancelled = () => false) {
  const {width, height, thickness} = stock;
  if (![width, height, thickness].every(positive)) throw Error('Enter valid stock dimensions.');
  const size = Math.max(width, height) / 840;
  const columns = Math.max(1, Math.ceil(width / size)), rows = Math.max(1, Math.ceil(height / size));
  const grid = {width, height, thickness, columns, rows, cellWidth: width / columns, cellHeight: height / rows,
    depths: new Float32Array(columns * rows), skipped: [], estimatedDrills: [], count: 0};
  let lastYield = performance.now();
  for (const job of jobs) {
    const {segments, estimatedDrill} = readSegments(job);
    if (!segments.length) {
      grid.skipped.push(job.name);
      continue;
    }
    grid.count++;
    if (estimatedDrill) grid.estimatedDrills.push(job.name);
    // Most toolpaths repeat XY at increasing depths. Applying deeper passes first skips covered cells.
    for (let i = segments.length - 1; i >= 0; i--) {
      sweep(grid, segments[i]);
      if (i % 128 === 0 && performance.now() - lastYield > 24) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (cancelled()) return null;
        lastYield = performance.now();
      }
    }
  }
  return grid;
}
