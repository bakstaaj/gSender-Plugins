const EPSILON = 1e-9;

function round(value) {
  const normalized = Math.abs(value) < EPSILON ? 0 : value;
  return Number(normalized.toFixed(6)).toString();
}

function parseWords(code) {
  const words = [];
  const re = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?)/gi;
  for (const match of code.matchAll(re)) words.push({ letter: match[1].toUpperCase(), value: Number(match[2]), start: match.index, end: match.index + match[0].length });
  return words;
}

function stripComments(line) {
  return line.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
}

function replaceWords(line, replacements, additions = []) {
  let output = line;
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, item.start) + item.value + output.slice(item.end);
  }
  if (additions.length) {
    const commentStart = output.search(/[;(]/);
    const insertAt = commentStart < 0 ? output.length : commentStart;
    output = `${output.slice(0, insertAt).trimEnd()} ${additions.join(' ')}${output.slice(insertAt)}`;
  }
  return output;
}

function addPoint(bounds, x, y) {
  if (x === null || y === null) return;
  bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
}

function onSweep(angle, start, end, clockwise) {
  const tau = Math.PI * 2;
  const mod = (value) => ((value % tau) + tau) % tau;
  const span = clockwise ? mod(start - end) : mod(end - start);
  const delta = clockwise ? mod(start - angle) : mod(angle - start);
  return delta <= span + EPSILON;
}

function includeArcBounds(bounds, start, end, i, j, clockwise) {
  const cx = start.x + i, cy = start.y + j;
  const radius = Math.hypot(i, j);
  if (radius < EPSILON) throw new Error('Arc has an invalid I/J center offset.');
  const a0 = Math.atan2(start.y - cy, start.x - cx);
  const a1 = Math.atan2(end.y - cy, end.x - cx);
  addPoint(bounds, start.x, start.y); addPoint(bounds, end.x, end.y);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (onSweep(angle, a0, a1, clockwise)) addPoint(bounds, cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
}

export function rotateToolpathCW(source, angle = 90) {
  if (![90, 180, 270].includes(angle)) throw new Error('Choose a clockwise rotation of 90°, 180°, or 270°.');
  const lines = source.split(/\r?\n/);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const records = [];
  let x = null, y = null, motion = null, absolute = true, plane = 17, centerAbsolute = false;

  for (let index = 0; index < lines.length; index += 1) {
    const words = parseWords(stripComments(lines[index]));
    const gs = words.filter((w) => w.letter === 'G').map((w) => Math.round(w.value * 10) / 10);
    if (gs.includes(91)) absolute = false;
    if (gs.includes(90)) absolute = true;
    if (gs.includes(90.1)) centerAbsolute = true;
    if (gs.includes(91.1)) centerAbsolute = false;
    if (gs.some((g) => g === 18 || g === 19)) plane = gs.find((g) => g === 18 || g === 19);
    if (gs.includes(17)) plane = 17;
    for (const g of gs) if ([0, 1, 2, 3].includes(g)) motion = g;
    if (!absolute) throw new Error(`Line ${index + 1}: incremental positioning (G91) is not supported. Use absolute positioning (G90).`);
    if (plane !== 17) throw new Error(`Line ${index + 1}: only XY-plane motion (G17) is supported.`);
    if (centerAbsolute) throw new Error(`Line ${index + 1}: absolute arc centers (G90.1) are not supported. Use incremental I/J centers (G91.1).`);

    const axis = (letter, previous) => words.findLast((w) => w.letter === letter)?.value ?? previous;
    const nextX = axis('X', x), nextY = axis('Y', y);
    const hasXY = words.some((w) => w.letter === 'X' || w.letter === 'Y');
    const arc = motion === 2 || motion === 3;
    const hasArcOffset = words.some((w) => w.letter === 'I' || w.letter === 'J');

    if (hasXY && (nextX === null || nextY === null)) throw new Error(`Line ${index + 1}: both X and Y positions must be known before XY motion.`);
    if (hasXY) {
      if (arc && hasArcOffset && x !== null && y !== null) {
        const i = words.findLast((w) => w.letter === 'I')?.value ?? 0;
        const j = words.findLast((w) => w.letter === 'J')?.value ?? 0;
        includeArcBounds(bounds, { x, y }, { x: nextX, y: nextY }, i, j, motion === 2);
      } else if (!arc) {
        addPoint(bounds, x ?? nextX, y ?? nextY); addPoint(bounds, nextX, nextY);
      } else {
        throw new Error(`Line ${index + 1}: arc bounds require a known start and I/J center offsets; radius (R) arcs are not supported.`);
      }
    }
    records.push({ line: lines[index], words, nextX, nextY, hasXY, motion, arc, hasArcOffset, index });
    x = nextX; y = nextY;
  }

  if (!Number.isFinite(bounds.minX)) throw new Error('No XY toolpath moves were found.');
  const rotatePoint = (px, py) => {
    if (angle === 90) return { x: py, y: -px };
    if (angle === 180) return { x: -px, y: -py };
    return { x: -py, y: px };
  };
  const rotatedCorners = [
    rotatePoint(bounds.minX, bounds.minY), rotatePoint(bounds.minX, bounds.maxY),
    rotatePoint(bounds.maxX, bounds.minY), rotatePoint(bounds.maxX, bounds.maxY),
  ];
  const minRotatedX = Math.min(...rotatedCorners.map((point) => point.x));
  const minRotatedY = Math.min(...rotatedCorners.map((point) => point.y));
  const output = records.map((record) => {
    const { words, line, hasXY, nextX, nextY, arc, hasArcOffset, index } = record;
    const replacements = [];
    const additions = [];
    const set = (letter, value) => {
      const found = words.filter((w) => w.letter === letter);
      if (found.length > 1) throw new Error(`Line ${index + 1}: repeated ${letter} words are not supported.`);
      if (found.length) replacements.push({ start: found[0].start, end: found[0].end, value: `${letter}${round(value)}` });
    };
    if (hasXY) {
      const rotated = rotatePoint(nextX, nextY);
      const outX = rotated.x - minRotatedX, outY = rotated.y - minRotatedY;
      if (words.some((w) => w.letter === 'X')) set('X', outX);
      else additions.push(`X${round(outX)}`);
      if (words.some((w) => w.letter === 'Y')) set('Y', outY);
      else additions.push(`Y${round(outY)}`);
    }
    if (arc && hasArcOffset) {
      const i = words.findLast((w) => w.letter === 'I')?.value ?? 0;
      const j = words.findLast((w) => w.letter === 'J')?.value ?? 0;
      const rotatedCenter = rotatePoint(i, j);
      set('I', rotatedCenter.x); set('J', rotatedCenter.y);
    }
    return replaceWords(line, replacements, additions);
  }).join('\n');
  const rotatedBounds = rotatedCorners.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x), minY: Math.min(acc.minY, point.y),
    maxX: Math.max(acc.maxX, point.x), maxY: Math.max(acc.maxY, point.y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const resultBounds = { minX: 0, minY: 0, maxX: rotatedBounds.maxX - rotatedBounds.minX, maxY: rotatedBounds.maxY - rotatedBounds.minY };
  return { text: output, bounds: Object.fromEntries(Object.entries(resultBounds).map(([key, value]) => [key, Number(round(value))])) };
}
