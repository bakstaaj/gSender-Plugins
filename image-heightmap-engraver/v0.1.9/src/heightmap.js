export function toGrayscale(imageData, invert = false) {
  const { data, width, height } = imageData;
  const pixels = new Uint8Array(width * height), alpha = new Uint8Array(width * height);
  let minGray = 255, maxGray = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const gray = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    const value = invert ? 255 - gray : gray;
    pixels[p] = value;
    alpha[p] = data[i + 3];
    minGray = Math.min(minGray, value);
    maxGray = Math.max(maxGray, value);
  }
  return { pixels, alpha, width, height, minGray, maxGray };
}

export function detectOvalBounds({ pixels, alpha, width, height, minGray, maxGray }) {
  if (width < 16 || height < 16) return null;
  // Ignore small antialiasing alpha changes in otherwise opaque PNGs; this
  // image has a nearly opaque black canvas around the oval, not transparency.
  const transparent = alpha?.some((value) => value < 200) ?? false;
  const patch = Math.max(2, Math.min(8, Math.floor(Math.min(width, height) / 20)));
  const corners = [];
  if (!transparent) for (let y = 0; y < patch; y += 1) for (let x = 0; x < patch; x += 1) {
    for (const [cx, cy] of [[x, y], [width - 1 - x, y], [x, height - 1 - y], [width - 1 - x, height - 1 - y]]) corners.push(pixels[cy * width + cx]);
  }
  if (!transparent && !corners.length) return null;
  corners.sort((a, b) => a - b);
  const background = transparent ? 0 : corners[Math.floor(corners.length / 2)];
  if (!transparent && corners.at(-1) - corners[0] > 18) return null;
  const threshold = Math.max(4, (maxGray - minGray) * 0.02);
  let xMin = width, xMax = -1, yMin = height, yMax = -1, count = 0;
  const isForeground = (x, y) => {
    const i = y * width + x;
    return transparent ? alpha[i] > 16 : Math.abs(pixels[i] - background) > threshold;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) if (isForeground(x, y)) {
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); count += 1;
  }
  const boxWidth = xMax - xMin + 1, boxHeight = yMax - yMin + 1;
  if (boxWidth < width * 0.35 || boxHeight < height * 0.35 || boxWidth / boxHeight < 0.4 || boxWidth / boxHeight > 2.5) return null;
  const coverage = count / (boxWidth * boxHeight);
  if (coverage < 0.52 || coverage > 0.94) return null;
  let error = 0, checks = 0;
  for (let sample = 1; sample < 10; sample += 1) {
    const y = Math.round(yMin + (boxHeight - 1) * sample / 10), expected = (boxWidth - 1) * Math.sqrt(Math.max(0, 1 - ((y - (yMin + yMax) / 2) / ((boxHeight - 1) / 2)) ** 2)) / 2;
    let left = -1, right = -1;
    for (let x = xMin; x <= xMax; x += 1) if (isForeground(x, y)) { if (left < 0) left = x; right = x; }
    if (left >= 0) { const center = (xMin + xMax) / 2; error += (Math.abs((center - left) - expected) + Math.abs((right - center) - expected)) / Math.max(1, boxWidth); checks += 2; }
  }
  for (let sample = 1; sample < 10; sample += 1) {
    const x = Math.round(xMin + (boxWidth - 1) * sample / 10), expected = (boxHeight - 1) * Math.sqrt(Math.max(0, 1 - ((x - (xMin + xMax) / 2) / ((boxWidth - 1) / 2)) ** 2)) / 2;
    let top = -1, bottom = -1;
    for (let y = yMin; y <= yMax; y += 1) if (isForeground(x, y)) { if (top < 0) top = y; bottom = y; }
    if (top >= 0) { const center = (yMin + yMax) / 2; error += (Math.abs((center - top) - expected) + Math.abs((bottom - center) - expected)) / Math.max(1, boxHeight); checks += 2; }
  }
  return checks && error / checks < 0.16 ? { xMin, xMax, yMin, yMax } : null;
}

export function maskOutsideOval(map, bounds) {
  if (!bounds) return map;
  const { pixels, width, height } = map, { xMin, xMax, yMin, yMax } = bounds;
  let minGray = 255, maxGray = 0;
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2, rx = (xMax - xMin) / 2, ry = (yMax - yMin) / 2;
  for (let y = yMin; y <= yMax; y += 1) for (let x = xMin; x <= xMax; x += 1) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (dx * dx + dy * dy <= 1.02) { const value = pixels[y * width + x]; minGray = Math.min(minGray, value); maxGray = Math.max(maxGray, value); }
  }
  if (minGray > maxGray) return map;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const dx = (x - cx) / rx, dy = (y - cy) / ry;
    if (dx * dx + dy * dy > 1.02) pixels[y * width + x] = minGray;
  }
  map.minGray = minGray; map.maxGray = maxGray;
  return map;
}

const fmt = (n) => Number(n).toFixed(3);
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
    for (let y = 0; y < height; y += 1) {
      const z = Math.min(0, filtered[y] + allowance);
      result[y * width + x] = x < radiusX || x >= width - radiusX || y < radiusY || y >= height - radiusY ? Math.max(-allowance, z) : z;
    }
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

export function generateHeightmapGcode({ pixels, width, height, sizeX, sizeY, maxDepth, feed, plunge, safeZ, spindleSpeed = 0, minGray, maxGray, originX = 0, originY = 0, frame = false, twoPass = false, crossHatch = false, roughAllowance = 0.3, radialBounds = null }) {
  if (!pixels || pixels.length !== width * height) throw new Error('Load an image before generating G-code.');
  if (![sizeX, sizeY, maxDepth, feed, plunge, safeZ].every((n) => Number.isFinite(Number(n)) && Number(n) > 0)) throw new Error('Dimensions, maximum depth, feed, plunge, and safe Z must be greater than zero.');
  if (!Number.isInteger(Number(spindleSpeed)) || Number(spindleSpeed) < 0 || Number(spindleSpeed) > 20000) throw new Error('Spindle speed must be a whole number from 0 to 20,000 RPM.');
  if (!Number.isFinite(Number(minGray)) || !Number.isFinite(Number(maxGray))) {
    minGray = 255; maxGray = 0;
    for (const value of pixels) { minGray = Math.min(minGray, value); maxGray = Math.max(maxGray, value); }
  }
  if (Number(minGray) < 0 || Number(maxGray) > 255 || Number(minGray) > Number(maxGray)) throw new Error('Image grayscale range must be between 0 and 255.');
  if (twoPass && (!Number.isFinite(Number(roughAllowance)) || Number(roughAllowance) < 0 || Number(roughAllowance) >= Number(maxDepth))) throw new Error('Roughing allowance must be zero or greater and less than maximum depth.');
  const grayRange = Number(maxGray) - Number(minGray);
  const dx = width > 1 ? sizeX / (width - 1) : 0, dy = height > 1 ? sizeY / (height - 1) : 0;
  const frameOffset = frame ? 5 : 0;
  const imageOriginX = Number(originX) + frameOffset, imageOriginY = Number(originY) + frameOffset;
  const targetZ = new Float64Array(width * height);
  for (let i = 0; i < targetZ.length; i += 1) targetZ[i] = grayRange === 0 ? 0 : -((pixels[i] - Number(minGray)) / grayRange) * Number(maxDepth);
  const roughZ = twoPass ? roughingSurface(targetZ, width, height, dx > 0 ? Math.ceil(1.5875 / dx) : 0, dy > 0 ? Math.ceil(1.5875 / dy) : 0, Number(roughAllowance)) : null;
  const point = (x, y, zMap = targetZ) => ({ x: imageOriginX + x * dx, y: imageOriginY + sizeY - y * dy, z: zMap[y * width + x] });
  const interpolatedPoint = (x, y, zMap = targetZ) => {
    const px = Math.max(0, Math.min(width - 1, x)), py = Math.max(0, Math.min(height - 1, y));
    const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const tx = px - x0, ty = py - y0;
    const z0 = zMap[y0 * width + x0] * (1 - tx) + zMap[y0 * width + x1] * tx;
    const z1 = zMap[y1 * width + x0] * (1 - tx) + zMap[y1 * width + x1] * tx;
    return { x: imageOriginX + px * dx, y: imageOriginY + sizeY - py * dy, z: z0 * (1 - ty) + z1 * ty };
  };
  const grayMapping = grayRange === 0 ? `${Number(minGray)}–${Number(maxGray)} grayscale (flat image) = Z0` : `${Number(minGray)} grayscale = Z0; ${Number(maxGray)} grayscale = Z-${fmt(maxDepth)} mm`;
  const lines = ['(Grayscale image heightmap generated by Image Heightmap Engraver)', `(Image ${width} x ${height} pixels; engraving area ${fmt(sizeX)} x ${fmt(sizeY)} mm)`, `(Grayscale mapping: ${grayMapping})`, `(Spindle speed: ${Number(spindleSpeed)} RPM)`, frame ? `(Origin: outside lower-left frame corner X${fmt(originX)} Y${fmt(originY)}; image inset ${fmt(frameOffset)} mm)` : `(Origin: image lower-left X${fmt(originX)} Y${fmt(originY)})`, '(Review and simulate before running; this plugin does not start jobs.)', 'G21', 'G90', 'G17', 'G94', 'G54', `G0 Z${fmt(safeZ)}`];
  const emitRaster = (zMap, axis = 'x') => {
    const lineCount = axis === 'x' ? height : width, lineLength = axis === 'x' ? width : height;
    for (let line = 0; line < lineCount; line += 1) {
      const reverse = line % 2 === 1;
      const pixelAt = (step) => axis === 'x' ? [reverse ? width - 1 - step : step, line] : [line, reverse ? height - 1 - step : step];
      const [startX, startY] = pixelAt(0), start = point(startX, startY, zMap);
      lines.push(`G0 X${fmt(start.x)} Y${fmt(start.y)}`, `G1 Z${fmt(start.z)} F${Math.round(plunge)}`);
      for (let step = 1; step < lineLength; step += 1) {
        const [x, y] = pixelAt(step), p = point(x, y, zMap);
        lines.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} Z${fmt(p.z)} F${Math.round(feed)}`);
      }
      lines.push(`G0 Z${fmt(safeZ)}`);
    }
  };
  const emitOvalSpiral = (zMap, bounds) => {
    const cx = (bounds.xMin + bounds.xMax) / 2, cy = (bounds.yMin + bounds.yMax) / 2;
    const rx = (bounds.xMax - bounds.xMin) / 2, ry = (bounds.yMax - bounds.yMin) / 2;
    const spacing = Math.max(0.01, Math.min(dx, dy));
    const outerRadius = Math.max(rx * dx, ry * dy), turns = Math.max(1, outerRadius / spacing);
    const pointsPerTurn = Math.max(24, Math.ceil(2 * Math.PI * outerRadius / spacing));
    const sampleCount = Math.ceil(turns * pointsPerTurn);
    lines.push('(FINISHING: detected oval; center-out elliptical spiral)');
    for (let i = 0; i <= sampleCount; i += 1) {
      const progress = i / sampleCount, angle = 2 * Math.PI * turns * progress;
      const p = interpolatedPoint(cx + rx * progress * Math.cos(angle), cy + ry * progress * Math.sin(angle), zMap);
      if (i === 0) lines.push(`G0 X${fmt(p.x)} Y${fmt(p.y)}`, `G1 Z${fmt(p.z)} F${Math.round(plunge)}`);
      else lines.push(`G1 X${fmt(p.x)} Y${fmt(p.y)} Z${fmt(p.z)} F${Math.round(feed)}`);
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
  };
  if (twoPass) {
    lines.push('(ROUGHING: 1/8 inch flat endmill; conservative 3.175 mm square envelope)', `(Roughing leaves ${fmt(roughAllowance)} mm above the target surface)`);
    if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
    emitRaster(roughZ);
    lines.push('M5', `G0 Z${fmt(safeZ)}`, '(MANUAL TOOL CHANGE: install the 60 degree V-bit with 0.1 mm tip.)', '(Set work Z0 to the stock surface, then resume the program.)', 'M0', `G0 Z${fmt(safeZ)}`, '(FINISHING: 60 degree V-bit, 0.1 mm tip)');
    if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
  } else if (Number(spindleSpeed) > 0) lines.push(`M3 S${Number(spindleSpeed)}`); else lines.push('M5');
  if (radialBounds) emitOvalSpiral(targetZ, radialBounds); else emitRaster(targetZ);
  if (twoPass && crossHatch) {
    lines.push('(OPTIONAL THIRD PASS: second finishing raster at 90 degrees with the same V-bit)');
    emitRaster(targetZ, 'y');
  }
  if (frame) {
    const cornerRadius = 1.5;
    const outer = [
      { x: Number(originX), y: Number(originY) },
      { x: Number(originX) + Number(sizeX) + frameOffset * 2, y: Number(originY) },
      { x: Number(originX) + Number(sizeX) + frameOffset * 2, y: Number(originY) + Number(sizeY) + frameOffset * 2 },
      { x: Number(originX), y: Number(originY) + Number(sizeY) + frameOffset * 2 },
    ];
    const inner = roundedRectangle(imageOriginX, imageOriginY, Number(sizeX), Number(sizeY), cornerRadius);
    lines.push(`(Frame outlines: outer lower-left is X${fmt(originX)} Y${fmt(originY)}; ${fmt(frameOffset)} mm outside image; inner corners radius ${fmt(cornerRadius)} mm; both at Z0)`);
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
  lines.push('M5', 'M30', ''); return lines.join('\n');
}
