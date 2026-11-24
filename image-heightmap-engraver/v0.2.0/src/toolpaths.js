const fmt = (value) => Number(value).toFixed(3);
const ROUGH_TOOL_DIAMETER = 3.175;
const ROUGH_OVERLAP = 0.50;
const ROUGH_STEPOVER = ROUGH_TOOL_DIAMETER * (1 - ROUGH_OVERLAP);

function maxFilterLine(values, radius) {
  const result = new Float64Array(values.length), deque = new Int32Array(values.length);
  let head = 0, tail = 0, next = 0;
  for (let center = 0; center < values.length; center += 1) {
    const right = Math.min(values.length - 1, center + radius);
    while (next <= right) {
      while (head < tail && values[deque[tail - 1]] <= values[next]) tail -= 1;
      deque[tail++] = next++;
    }
    while (head < tail && deque[head] < center - radius) head += 1;
    result[center] = values[deque[head]];
  }
  return result;
}

function roughingSurface(targetZ, width, height, radiusX, radiusY, allowance) {
  const horizontal = new Float64Array(targetZ.length), result = new Float64Array(targetZ.length);
  for (let y = 0; y < height; y += 1) horizontal.set(maxFilterLine(targetZ.subarray(y * width, (y + 1) * width), radiusX), y * width);
  const column = new Float64Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = horizontal[y * width + x];
    const filtered = maxFilterLine(column, radiusY);
    for (let y = 0; y < height; y += 1) result[y * width + x] = Math.min(0, filtered[y] + allowance);
  }
  return result;
}

function roundedRectangle(x, y, width, height, radius, segments = 8) {
  const r = Math.min(radius, width / 2, height / 2);
  const corners = [
    { cx: x + width - r, cy: y + r, start: -Math.PI / 2 },
    { cx: x + width - r, cy: y + height - r, start: 0 },
    { cx: x + r, cy: y + height - r, start: Math.PI / 2 },
    { cx: x + r, cy: y + r, start: Math.PI },
  ];
  return corners.flatMap(({ cx, cy, start }) => Array.from({ length: segments + 1 }, (_, i) => {
    const angle = start + Math.PI / 2 * i / segments;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  }));
}

export function generateHeightmapGcode({
  pixels, width, height, sizeX, sizeY, maxDepth, feed, plunge, safeZ, spindleSpeed = 0,
  minGray, maxGray, originX = 0, originY = 0, frame = false, twoPass = false,
  roughAllowance = 0.3, radialBounds = null, baseHeights = null, validMask = null,
  pattern = 'auto', stepover = 0.5, modelName = '', surfaceOnly = false,
}) {
  if (surfaceOnly && !baseHeights) throw new Error('Load a top-surface model before generating a surface toolpath.');
  if (!surfaceOnly && (!pixels || pixels.length !== width * height)) throw new Error('Load an image or top-surface model before generating G-code.');
  if (baseHeights && baseHeights.length !== width * height) throw new Error('The sampled model surface does not match the image grid. Reload the image or model.');
  if (validMask && validMask.length !== width * height) throw new Error('The model coverage mask does not match the image grid. Reload the image or model.');
  if (![sizeX, sizeY, maxDepth, feed, plunge, safeZ, stepover].every((n) => Number.isFinite(Number(n)) && Number(n) > 0)) throw new Error('Dimensions, depth, feed, plunge, safe Z, and stepover must be greater than zero.');
  if (!Number.isInteger(Number(spindleSpeed)) || Number(spindleSpeed) < 0 || Number(spindleSpeed) > 20000) throw new Error('Spindle speed must be a whole number from 0 to 20,000 RPM.');
  if (!surfaceOnly && (!Number.isFinite(Number(minGray)) || !Number.isFinite(Number(maxGray)))) {
    minGray = 255; maxGray = 0;
    for (const value of pixels) { minGray = Math.min(minGray, value); maxGray = Math.max(maxGray, value); }
  }
  if (!surfaceOnly && (Number(minGray) < 0 || Number(maxGray) > 255 || Number(minGray) > Number(maxGray))) throw new Error('Image grayscale range must be between 0 and 255.');
  if (twoPass && (!Number.isFinite(Number(roughAllowance)) || Number(roughAllowance) < 0 || Number(roughAllowance) >= Number(maxDepth))) throw new Error('Roughing allowance must be zero or greater and less than maximum depth.');
  const grayRange = surfaceOnly ? 0 : Number(maxGray) - Number(minGray);
  const dx = width > 1 ? Number(sizeX) / (width - 1) : 0, dy = height > 1 ? Number(sizeY) / (height - 1) : 0;
  const frameOffset = frame && !baseHeights ? 5 : 0;
  const imageOriginX = Number(originX) + frameOffset, imageOriginY = Number(originY) + frameOffset;
  const targetZ = new Float64Array(width * height);
  for (let i = 0; i < targetZ.length; i += 1) {
    const relief = surfaceOnly || grayRange === 0 ? 0 : ((pixels[i] - Number(minGray)) / grayRange) * Number(maxDepth);
    const target = (baseHeights?.[i] || 0) - relief;
    targetZ[i] = baseHeights ? Math.max(-Number(maxDepth), target) : target;
  }
  const roughZ = twoPass ? roughingSurface(targetZ, width, height, dx > 0 ? Math.ceil(1.5875 / dx) : 0, dy > 0 ? Math.ceil(1.5875 / dy) : 0, Number(roughAllowance)) : null;
  const samplePoint = (px, py, zMap = targetZ) => {
    const x = Math.max(0, Math.min(width - 1, px)), y = Math.max(0, Math.min(height - 1, py));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const samples = [
      [y0 * width + x0, (1 - tx) * (1 - ty)], [y0 * width + x1, tx * (1 - ty)],
      [y1 * width + x0, (1 - tx) * ty], [y1 * width + x1, tx * ty],
    ];
    if (validMask && samples.some(([index, weight]) => weight > 1e-8 && !validMask[index])) return null;
    let z = 0;
    for (const [index, weight] of samples) z += zMap[index] * weight;
    return { x: imageOriginX + x * dx, y: imageOriginY + Number(sizeY) - y * dy, z, gridX: x, gridY: y };
  };
  const patternName = ({ auto: 'Automatic', raster: 'Raster with retracts', crosshatch: 'Crosshatch', radial: 'Elliptical spiral', 'makera-parallel': '3D relief parallel / reciprocating', 'offset-inside': '3D relief linked spiral / inside-out', 'offset-outside': '3D relief linked spiral / outside-in' })[pattern] || 'Raster with retracts';
  const modelHeader = surfaceOnly ? `(Model topography: ${modelName || 'imported model'}; Z0 is at model maximum Z)` : baseHeights ? `(Top-facing model surface: ${modelName || 'imported model'}; Z0 is at model maximum Z)` : '(Flat image-only surface; Z0 is the work surface)';
  const grayMapping = surfaceOnly ? `model surface heights are machined directly and clipped at ${fmt(maxDepth)} mm below model Z0; no image overlay` : baseHeights ? `${Number(minGray)} grayscale = no added relief; image relief over model surface, combined target clipped at ${fmt(maxDepth)} mm below model Z0` : grayRange === 0 ? `${Number(minGray)}–${Number(maxGray)} grayscale (flat image) = no added relief` : `${Number(minGray)} grayscale = no added relief; ${Number(maxGray)} grayscale = ${fmt(maxDepth)} mm below the starting surface`;
  const lines = [
    '(Heightmap Engraver)', `(Image ${width} x ${height} pixels; engraving area ${fmt(sizeX)} x ${fmt(sizeY)} mm)`,
    modelHeader, ...(baseHeights ? [`(Model and image target clipped to ${fmt(maxDepth)} mm below model Z0)`] : []), `(Finish path: ${patternName}; stepover ${fmt(stepover)} mm)`, `(Image mapping: ${grayMapping})`,
    `(Spindle speed: ${Number(spindleSpeed)} RPM)`, `(Image lower-left origin X${fmt(originX)} Y${fmt(originY)})`,
    `(Sampling grid ${width} x ${height}; ${surfaceOnly ? 'model topography only' : baseHeights ? 'image over model topography' : 'image on flat surface'})`,
    '(Only sampled top-facing model areas are machined. Review and simulate before running.)',
    'G21', 'G90', 'G17', 'G94', 'G54', `G0 Z${fmt(safeZ)}`,
  ];
  const emitRun = (run) => {
    if (!run.length) return;
    const first = run[0];
    lines.push(`G0 Z${fmt(safeZ)}`, `G0 X${fmt(first.x)} Y${fmt(first.y)}`, `G1 Z${fmt(first.z)} F${Math.round(plunge)}`);
    for (let i = 1; i < run.length; i += 1) {
      const p = run[i];
      lines.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} Z${fmt(p.z)} F${Math.round(feed)}`);
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
  };
  const emitRaster = (zMap, axis = 'x') => {
    const crossCount = axis === 'x' ? height : width;
    const crossSize = axis === 'x' ? Number(sizeY) : Number(sizeX);
    const intervals = Math.max(1, Math.min(Math.max(1, crossCount - 1), Math.ceil(crossSize / Number(stepover))));
    const lineCount = intervals + 1, alongCount = axis === 'x' ? width : height;
    for (let line = 0; line < lineCount; line += 1) {
      const crossPosition = line * Math.max(0, crossCount - 1) / intervals;
      const reverse = line % 2 === 1, run = [];
      for (let step = 0; step < alongCount; step += 1) {
        const alongPosition = reverse ? alongCount - 1 - step : step;
        const p = axis === 'x' ? samplePoint(alongPosition, crossPosition, zMap) : samplePoint(crossPosition, alongPosition, zMap);
        if (p) run.push(p);
        else { emitRun(run); run.length = 0; }
      }
      emitRun(run);
    }
  };
  const emitReciprocatingParallel = (zMap, axis = 'x', passStepover = Number(stepover)) => {
    const crossCount = axis === 'x' ? height : width;
    const crossSize = axis === 'x' ? Number(sizeY) : Number(sizeX);
    const intervals = Math.max(1, Math.min(Math.max(1, crossCount - 1), Math.ceil(crossSize / Number(passStepover))));
    const lineCount = intervals + 1, alongCount = axis === 'x' ? width : height;
    let path = [];
    const flush = () => { emitRun(path); path = []; };
    const at = (along, cross) => axis === 'x' ? samplePoint(along, cross, zMap) : samplePoint(cross, along, zMap);
    const bridge = (from, to) => {
      const distance = Math.max(Math.abs(to.gridX - from.gridX), Math.abs(to.gridY - from.gridY));
      const steps = Math.max(1, Math.ceil(distance));
      const points = [];
      for (let i = 1; i <= steps; i += 1) {
        const fraction = i / steps;
        const point = samplePoint(from.gridX + (to.gridX - from.gridX) * fraction, from.gridY + (to.gridY - from.gridY) * fraction, zMap);
        if (!point) return null;
        points.push(point);
      }
      return points;
    };
    for (let line = 0; line < lineCount; line += 1) {
      const crossPosition = line * Math.max(0, crossCount - 1) / intervals;
      const reverse = line % 2 === 1;
      const runs = [];
      let run = [];
      for (let step = 0; step < alongCount; step += 1) {
        const alongPosition = reverse ? alongCount - 1 - step : step;
        const point = at(alongPosition, crossPosition);
        if (point) run.push(point);
        else if (run.length) { runs.push(run); run = []; }
      }
      if (run.length) runs.push(run);
      if (!runs.length) { flush(); continue; }
      for (let index = 0; index < runs.length; index += 1) {
        const segment = runs[index];
        if (!path.length) path = segment;
        else {
          const connector = bridge(path[path.length - 1], segment[0]);
          if (connector) path.push(...connector, ...segment.slice(1));
          else { flush(); path = segment; }
        }
        if (index + 1 < runs.length) flush();
      }
    }
    flush();
  };
  const emitSpiral = (zMap, bounds) => {
    const box = bounds || { xMin: 0, xMax: width - 1, yMin: 0, yMax: height - 1 };
    const cx = (box.xMin + box.xMax) / 2, cy = (box.yMin + box.yMax) / 2;
    const rx = Math.max(0.5, (box.xMax - box.xMin) / 2), ry = Math.max(0.5, (box.yMax - box.yMin) / 2);
    const outerRadius = Math.max(rx * dx, ry * dy);
    const turns = Math.max(1, outerRadius / Number(stepover));
    const pixelSpacing = Math.max(0.01, Math.min(dx || 1, dy || 1));
    const pointsPerTurn = Math.max(24, Math.ceil(2 * Math.PI * outerRadius / pixelSpacing));
    const sampleCount = Math.max(1, Math.min(500000, Math.ceil(turns * pointsPerTurn)));
    let run = [];
    for (let i = 0; i <= sampleCount; i += 1) {
      const progress = i / sampleCount, angle = 2 * Math.PI * turns * progress;
      const p = samplePoint(cx + rx * progress * Math.cos(angle), cy + ry * progress * Math.sin(angle), zMap);
      if (p) run.push(p);
      else { emitRun(run); run = []; }
    }
    emitRun(run);
  };
  const emitLinkedOffsetSpiral = (zMap, bounds, insideOut) => {
    const box = bounds || { xMin: 0, xMax: width - 1, yMin: 0, yMax: height - 1 };
    const cx = (box.xMin + box.xMax) / 2, cy = (box.yMin + box.yMax) / 2;
    const rx = Math.max(0.5, (box.xMax - box.xMin) / 2), ry = Math.max(0.5, (box.yMax - box.yMin) / 2);
    const maxRadius = Math.max(rx * dx, ry * dy), pixelSpacing = Math.max(0.01, Math.min(dx || 1, dy || 1));
    const radii = [];
    const innerRadius = Math.min(maxRadius, Math.max(pixelSpacing / 2, 0.01));
    for (let radius = innerRadius; radius < maxRadius; radius += Number(stepover)) radii.push(radius);
    if (radii.length === 0 || radii[radii.length - 1] < maxRadius) radii.push(maxRadius);
    if (!insideOut) radii.reverse();
    let path = [];
    const flush = () => { emitRun(path); path = []; };
    const connectTo = (segment) => {
      if (!path.length) { path = segment; return; }
      const from = path[path.length - 1], to = segment[0];
      const distance = Math.max(Math.abs(to.gridX - from.gridX), Math.abs(to.gridY - from.gridY));
      const steps = Math.max(1, Math.ceil(distance)), connector = [];
      for (let i = 1; i <= steps; i += 1) {
        const fraction = i / steps;
        const point = samplePoint(from.gridX + (to.gridX - from.gridX) * fraction, from.gridY + (to.gridY - from.gridY) * fraction, zMap);
        if (!point) { flush(); path = segment; return; }
        connector.push(point);
      }
      path.push(...connector, ...segment.slice(1));
    };
    for (const radius of radii) {
      const scale = radius / maxRadius, ringRx = rx * scale, ringRy = ry * scale;
      const pointCount = Math.max(24, Math.min(500000, Math.ceil(2 * Math.PI * radius / pixelSpacing)));
      const segments = [];
      let segment = [];
      for (let i = 0; i < pointCount; i += 1) {
        const angle = 2 * Math.PI * i / pointCount;
        const point = samplePoint(cx + ringRx * Math.cos(angle), cy + ringRy * Math.sin(angle), zMap);
        if (point) segment.push(point);
        else if (segment.length) { segments.push(segment); segment = []; }
      }
      if (segment.length) segments.push(segment);
      if (!segments.length) { flush(); continue; }
      for (let i = 0; i < segments.length; i += 1) {
        connectTo(segments[i]);
        if (i + 1 < segments.length) flush();
      }
    }
    flush();
  };
  if (twoPass) {
    lines.push('(ROUGHING: T1, 1/8 inch flat endmill; reciprocating zigzag)', `(Roughing stepover ${fmt(ROUGH_STEPOVER)} mm; ${Math.round(ROUGH_OVERLAP * 100)}% overlap for ${fmt(ROUGH_TOOL_DIAMETER)} mm tool)`, `(Roughing leaves ${fmt(roughAllowance)} mm above the target surface)`, 'T1 M6');
    if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
    emitReciprocatingParallel(roughZ, 'x', ROUGH_STEPOVER);
    lines.push('M5', `G0 Z${fmt(safeZ)}`, '(FINISHING TOOL: T2, 60 degree V-bit with 0.1 mm tip.)', '(Set work Z0 to the original top surface after tool change if required.)', 'T2 M6', `G0 Z${fmt(safeZ)}`, '(FINISHING: 60 degree V-bit, 0.1 mm tip)');
    if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
  } else {
    lines.push('(FINISHING TOOL: T2, 60 degree V-bit with 0.1 mm tip.)', 'T2 M6');
    if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
  }
  if (pattern === 'crosshatch') {
    lines.push('(FINISHING: crosshatch; two perpendicular raster directions)');
    emitRaster(targetZ, 'x'); emitRaster(targetZ, 'y');
  } else if (pattern === 'radial') {
    lines.push('(FINISHING: center-out elliptical spiral; rectangular corners may remain uncut)');
    emitSpiral(targetZ, radialBounds);
  } else if (pattern === 'makera-parallel') {
    lines.push('(FINISHING: Makera-style 3D relief parallel; reciprocating rows with no retract between adjacent rows)');
    emitReciprocatingParallel(targetZ, 'x');
  } else if (pattern === 'offset-inside' || pattern === 'offset-outside') {
    const insideOut = pattern === 'offset-inside';
    lines.push(`(FINISHING: Makera-style 3D relief linked offset spiral; ${insideOut ? 'inside-out' : 'outside-in'}, clipped to valid top-surface cells)`);
    emitLinkedOffsetSpiral(targetZ, radialBounds, insideOut);
  } else if (pattern === 'auto' && surfaceOnly) {
    lines.push('(FINISHING: automatic model topography; inside-out 3D relief linked offset spiral)');
    emitLinkedOffsetSpiral(targetZ, radialBounds, true);
  } else if (pattern === 'auto' && radialBounds) {
    lines.push('(FINISHING: detected oval; center-out elliptical spiral)');
    emitSpiral(targetZ, radialBounds);
  } else {
    lines.push('(FINISHING: raster / parallel)');
    emitRaster(targetZ, 'x');
  }
  if (frame && !baseHeights) {
    const cornerRadius = 1.5;
    const outer = [
      { x: Number(originX), y: Number(originY) },
      { x: Number(originX) + Number(sizeX) + frameOffset * 2, y: Number(originY) },
      { x: Number(originX) + Number(sizeX) + frameOffset * 2, y: Number(originY) + Number(sizeY) + frameOffset * 2 },
      { x: Number(originX), y: Number(originY) + Number(sizeY) + frameOffset * 2 },
    ];
    const inner = roundedRectangle(imageOriginX, imageOriginY, Number(sizeX), Number(sizeY), cornerRadius);
    lines.push(`(Frame outlines at Z0; outer lower-left X${fmt(originX)} Y${fmt(originY)})`);
    for (const [label, path] of [['outer', outer], ['inner', inner]]) {
      const start = path[0];
      lines.push(`(${label} frame outline)`, `G0 X${fmt(start.x)} Y${fmt(start.y)}`, `G1 Z0.000 F${Math.round(plunge)}`);
      for (let i = 1; i <= path.length; i += 1) {
        const p = path[i % path.length];
        lines.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} Z0.000 F${Math.round(feed)}`);
      }
      lines.push(`G0 Z${fmt(safeZ)}`);
    }
  }
  lines.push('M5', 'M30', '');
  return lines.join('\n');
}
