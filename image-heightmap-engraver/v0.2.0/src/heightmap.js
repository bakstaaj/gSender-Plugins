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
