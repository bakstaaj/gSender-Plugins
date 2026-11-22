const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const AXIS_WORD = new RegExp(`([XYZ])\\s*(${NUMBER})`, 'gi');
const ARC_IJ = new RegExp(`([IJ])\\s*(${NUMBER})`, 'gi');

export function analyzeNc(text) {
  let x = 0, y = 0, z = 0;
  let absolute = true, arcCenterAbsolute = false, units = 1, motion = null, cycle = null, cycleR = 0, cycleZ = 0;
  let knownX = false, knownY = false;
  const points = [];
  const cuttingZ = [];
  const holeFeatures = new Map();
  let commandedHoleDiameter = null, toolDiameter = null;
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const add = (px, py, pz, draw = false) => {
    if (!knownX || !knownY) return;
    points.push({ x: px, y: py, z: pz, draw });
    bounds.minX = Math.min(bounds.minX, px); bounds.maxX = Math.max(bounds.maxX, px);
    bounds.minY = Math.min(bounds.minY, py); bounds.maxY = Math.max(bounds.maxY, py);
    bounds.minZ = Math.min(bounds.minZ, pz); bounds.maxZ = Math.max(bounds.maxZ, pz);
  };
  const word = (line, letter) => {
    const match = line.match(new RegExp(`\\b${letter}\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:E[-+]?\\d+)?)`, 'i'));
    return match ? Number(match[1]) * units : null;
  };
  const lineMove = (nx, ny, nz, draw) => {
    if (draw && points.length === 0) add(x, y, z, false);
    // Record only descending feed moves and feed moves across the part. G0
    // retracts and feed retracts must not enlarge the planned cut envelope.
    if (draw && nz < z - 1e-9) add(x, y, z, true);
    if (draw && nz < z - 1e-9) cuttingZ.push(nz);
    else if (draw && Math.abs(nz-z) <= 1e-9 && (nx !== x || ny !== y)) cuttingZ.push(nz);
    add(nx, ny, nz, draw);
    x = nx; y = ny; z = nz;
  };
  for (const raw of text.split(/\r?\n/)) {
    const holeComment = raw.match(/\(\s*HOLE\s+DRILL\s+([-+]?(?:\d+\.?\d*|\.\d+))\s*MM\s*\)/i);
    const toolComment = raw.match(/\(\s*T\d+\s*:\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*\)/i);
    if (holeComment) commandedHoleDiameter = Number(holeComment[1]) * units;
    if (toolComment) toolDiameter = Number(toolComment[1]) * units;
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const gCodes = [...line.matchAll(/\bG\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
    for (const g of gCodes) {
      if (g === 20) units = 25.4;
      else if (g === 21) units = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 90.1) arcCenterAbsolute = true;
      else if (g === 91.1) arcCenterAbsolute = false;
      else if ([0,1,2,3].includes(g)) motion = g;
      else if ([73,81,82,83].includes(g)) cycle = g;
      else if (g === 80) cycle = null;
    }
    if (/\bG\s*(?:28|30|53)\b/.test(line)) continue;
    const words = new Map([...line.matchAll(AXIS_WORD)].map(m => [m[1], Number(m[2]) * units]));
    if (!words.size) continue;
    if (words.has('X')) knownX = true;
    if (words.has('Y')) knownY = true;
    const nx = words.has('X') ? absolute ? words.get('X') : x + words.get('X') : x;
    const ny = words.has('Y') ? absolute ? words.get('Y') : y + words.get('Y') : y;
    const nz = words.has('Z') ? absolute ? words.get('Z') : z + words.get('Z') : z;
    if (cycle !== null) {
      const rv = word(line, 'R'), zv = word(line, 'Z');
      if (rv !== null) cycleR = absolute ? rv : z + rv;
      if (zv !== null) cycleZ = absolute ? zv : z + zv;
      if (words.has('X') || words.has('Y')) {
        lineMove(nx, ny, cycleR, false);
        lineMove(nx, ny, cycleZ, true);
        lineMove(nx, ny, cycleR, false);
      }
      continue;
    }
    if (motion === null) continue;
    if (motion === 2 || motion === 3) {
      const ij = new Map([...line.matchAll(ARC_IJ)].map(m => [m[1], Number(m[2]) * units]));
      if (ij.has('I') && ij.has('J')) {
        const cx = arcCenterAbsolute ? ij.get('I') : x + ij.get('I'), cy = arcCenterAbsolute ? ij.get('J') : y + ij.get('J');
        const start = Math.atan2(y - cy, x - cx), end = Math.atan2(ny - cy, nx - cx);
        const cw = motion === 2;
        let sweep = end - start;
        if (cw && sweep >= 0) sweep -= 2 * Math.PI;
        if (!cw && sweep <= 0) sweep += 2 * Math.PI;
        const radius = Math.hypot(x - cx, y - cy);
        if (radius > 0.05) {
          const diameter = commandedHoleDiameter || (toolDiameter ? 2 * radius + toolDiameter : 2 * radius);
          const feature = { x: cx, y: cy, diameter };
          const key = `${Math.round(cx * 100)}:${Math.round(cy * 100)}:${Math.round(diameter * 100)}`;
          holeFeatures.set(key, feature);
        }
        const segments = Math.max(8, Math.ceil(Math.abs(sweep) * radius / 1));
        if (points.length === 0) add(x, y, z, false);
        for (let i = 1; i <= segments; i++) {
          const t = i / segments, a = start + sweep * t;
          add(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z + (nz - z) * t, true);
          if (nz <= z + 1e-9) cuttingZ.push(z + (nz - z) * t);
        }
        x = nx; y = ny; z = nz;
        continue;
      }
    }
    lineMove(nx, ny, nz, motion !== 0);
  }
  if (!points.length || !Number.isFinite(bounds.minX)) throw new Error('No absolute or incremental X/Y/Z motion was found in the selected NC file.');
  const cutMinZ = cuttingZ.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const cutMaxZ = cuttingZ.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const hasCutZ = Number.isFinite(cutMinZ) && Number.isFinite(cutMaxZ);
  // For a conventional top-at-Z0 file, the stock surface is the top of the
  // cutting envelope even if no feed move ends exactly at Z0. For CAMLab's
  // positive-down output, report the span of positive cutting coordinates.
  const zEnvelope = !hasCutZ ? 0 : cutMinZ < -1e-6 ? Math.abs(cutMinZ) : cutMaxZ - cutMinZ;
  return { bounds, points, holes: [...holeFeatures.values()], width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY, depth: zEnvelope, depthBasis: 'cut-moves-only', motionDepth: bounds.maxZ - bounds.minZ, centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2, displayUnits: units === 25.4 ? 'in' : 'mm' };
}

