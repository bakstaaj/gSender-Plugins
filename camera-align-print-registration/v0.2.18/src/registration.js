const WORD = /([A-Za-z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
const EPSILON = 1e-7;

export function solveSimilarity(sourceA, sourceB, targetA, targetB) {
  const sourceDx = sourceB.x - sourceA.x;
  const sourceDy = sourceB.y - sourceA.y;
  const targetDx = targetB.x - targetA.x;
  const targetDy = targetB.y - targetA.y;
  const sourceLength = Math.hypot(sourceDx, sourceDy);
  const targetLength = Math.hypot(targetDx, targetDy);
  if (sourceLength < 0.01) throw new Error('The two file registration marks are too close together. Choose marks at least 1 mm apart.');
  if (targetLength < 0.01) throw new Error('The two printed registration marks are too close together. Recheck both camera positions.');
  const scale = targetLength / sourceLength;
  if (scale < 0.5 || scale > 2) throw new Error(`Calculated print scale ${scale.toFixed(4)} is outside the supported 0.5–2.0 range. Check the selected marks and units.`);
  const angle = Math.atan2(targetDy, targetDx) - Math.atan2(sourceDy, sourceDx);
  const a = scale * Math.cos(angle);
  const b = -scale * Math.sin(angle);
  const c = scale * Math.sin(angle);
  const d = scale * Math.cos(angle);
  return {
    a, b, c, d, scale, angle,
    tx: targetA.x - a * sourceA.x - b * sourceA.y,
    ty: targetA.y - c * sourceA.x - d * sourceA.y,
  };
}

const mapPoint = (point, transform) => ({
  x: transform.a * point.x + transform.b * point.y + transform.tx,
  y: transform.c * point.x + transform.d * point.y + transform.ty,
});
const mapVector = (vector, transform) => ({
  x: transform.a * vector.x + transform.b * vector.y,
  y: transform.c * vector.x + transform.d * vector.y,
});

function splitComment(line) {
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '(') depth += 1;
    else if (line[index] === ')') depth = Math.max(0, depth - 1);
    else if (line[index] === ';' && depth === 0) return [line.slice(0, index), line.slice(index)];
  }
  return [line, ''];
}

function parseWords(code) {
  const words = [];
  WORD.lastIndex = 0;
  for (let match; (match = WORD.exec(code));) {
    words.push({ letter: match[1].toUpperCase(), value: Number(match[2]), start: match.index, end: WORD.lastIndex, raw: match[0] });
  }
  return words;
}

function replaceWords(code, words, replacements, additions = '') {
  let result = '';
  let cursor = 0;
  for (const word of words) {
    result += code.slice(cursor, word.start);
    if (replacements.has(word)) result += `${word.letter}${formatNumber(replacements.get(word))}`;
    else result += word.raw;
    cursor = word.end;
  }
  result += code.slice(cursor);
  if (additions) result += ` ${additions}`;
  return result;
}

function formatNumber(value) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function includes(words, letter) { return words.some((word) => word.letter === letter); }
function valueOf(words, letter) { return words.find((word) => word.letter === letter)?.value; }

const UNSUPPORTED_CODES = new Set([10, 28, 30, 38, 39, 43, 49, 51, 52, 53, 65, 68, 69, 73, 74, 76, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 92]);

/**
 * Transform an XY G-code program using a similarity transform. The conservative
 * parser rejects coordinate-changing features it cannot preserve faithfully.
 */
export function transformGcode(text, transform, { units = 'G21', wcs = 'G54' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Choose a non-empty G-code file.');
  if (text.length > 25 * 1024 * 1024) throw new Error('G-code files larger than 25 MB are not supported.');
  if (!['G20', 'G21'].includes(units)) throw new Error('The controller units are unknown. Reconnect and try again.');
  const nativeToMm = units === 'G20' ? 25.4 : 1;
  const mmToNative = 1 / nativeToMm;
  const sourceState = { x: null, y: null, absolute: true, centerAbsolute: false, motion: null, plane: 'G17', unit: units, wcs: null };
  const result = [];
  let transformedPoints = 0;
  let sawXY = false;

  for (const [lineIndex, originalLine] of text.split(/\r?\n/).entries()) {
    const [code, comment] = splitComment(originalLine);
    if (/[\[\]#]/.test(code)) throw new Error(`Line ${lineIndex + 1} uses a macro or expression. Only plain numeric G-code can be aligned.`);
    if (/\*\s*[+-]?\d+\s*$/.test(code)) throw new Error(`Line ${lineIndex + 1} contains a line-number checksum. Remove checksums before aligning so the output remains valid.`);
    const words = parseWords(code);
    if (words.some((word) => ['O'].includes(word.letter) || (word.letter === 'M' && [98, 99].includes(word.value)))) {
      throw new Error(`Line ${lineIndex + 1} uses a subprogram. Aligning files with subprograms is not supported.`);
    }
    const gCodes = words.filter((word) => word.letter === 'G').map((word) => word.value);
    for (const value of gCodes) {
      const normalized = Number(value.toFixed(1));
      const baseCode = Math.floor(normalized + EPSILON);
      if (UNSUPPORTED_CODES.has(baseCode)
        || (!Number.isInteger(normalized) && baseCode >= 54 && baseCode <= 59)) {
        throw new Error(`Line ${lineIndex + 1} uses G${formatNumber(value)}, which changes coordinates or motion in a way the aligner cannot safely transform.`);
      }
      if ([18, 19].includes(normalized)) sourceState.plane = `G${normalized}`;
      if (normalized === 17) sourceState.plane = 'G17';
      if (normalized === 20) sourceState.unit = 'G20';
      if (normalized === 21) sourceState.unit = 'G21';
      if (normalized === 90) sourceState.absolute = true;
      if (normalized === 91) sourceState.absolute = false;
      if (normalized === 90.1) sourceState.centerAbsolute = true;
      if (normalized === 91.1) sourceState.centerAbsolute = false;
      if ([0, 1, 2, 3].includes(normalized)) sourceState.motion = normalized;
      if ([54, 55, 56, 57, 58, 59].includes(normalized)) sourceState.wcs = `G${normalized}`;
    }
    if (sourceState.plane !== 'G17' && (includes(words, 'X') || includes(words, 'Y') || includes(words, 'I') || includes(words, 'J'))) {
      throw new Error(`Line ${lineIndex + 1} moves in ${sourceState.plane}. XY registration supports the G17 plane only.`);
    }
    if (sourceState.wcs && sourceState.wcs !== wcs) throw new Error(`Line ${lineIndex + 1} switches to ${sourceState.wcs}; this registration was captured in ${wcs}.`);

    const hasX = includes(words, 'X');
    const hasY = includes(words, 'Y');
    const hasXY = hasX || hasY;
    const replacements = new Map();
    let additions = '';
    if (hasXY) {
      sawXY = true;
      if (![0, 1, 2, 3].includes(sourceState.motion)) {
        throw new Error(`Line ${lineIndex + 1} has XY coordinates without a supported G0/G1/G2/G3 move.`);
      }
      if (sourceState.x === null || sourceState.y === null) {
        if (!hasX || !hasY || !sourceState.absolute) throw new Error(`Line ${lineIndex + 1} starts XY motion without a known position. Begin with an absolute X and Y move (G90).`);
        sourceState.x = 0;
        sourceState.y = 0;
      }
      const factor = sourceState.unit === 'G20' ? 25.4 : 1;
      const oldStart = { x: sourceState.x, y: sourceState.y };
      const xValue = valueOf(words, 'X');
      const yValue = valueOf(words, 'Y');
      const sourceEnd = sourceState.absolute
        ? { x: xValue ?? oldStart.x, y: yValue ?? oldStart.y }
        : { x: oldStart.x + (xValue ?? 0), y: oldStart.y + (yValue ?? 0) };
      const oldStartMm = { x: oldStart.x * factor, y: oldStart.y * factor };
      const sourceEndMm = { x: sourceEnd.x * factor, y: sourceEnd.y * factor };
      const outputEndMm = sourceState.absolute ? mapPoint(sourceEndMm, transform) : mapVector({ x: (xValue ?? 0) * factor, y: (yValue ?? 0) * factor }, transform);
      const outputEnd = sourceState.absolute
        ? { x: outputEndMm.x / factor, y: outputEndMm.y / factor }
        : { x: outputEndMm.x / factor, y: outputEndMm.y / factor };
      if (sourceState.absolute) {
        if (hasX) replacements.set(words.find((word) => word.letter === 'X'), outputEnd.x);
        else additions += `X${formatNumber(outputEnd.x)}`;
        if (hasY) replacements.set(words.find((word) => word.letter === 'Y'), outputEnd.y);
        else additions += `${additions ? ' ' : ''}Y${formatNumber(outputEnd.y)}`;
      } else {
        if (hasX) replacements.set(words.find((word) => word.letter === 'X'), outputEnd.x);
        else if (Math.abs(outputEnd.x) > EPSILON) additions += `X${formatNumber(outputEnd.x)}`;
        if (hasY) replacements.set(words.find((word) => word.letter === 'Y'), outputEnd.y);
        else if (Math.abs(outputEnd.y) > EPSILON) additions += `${additions ? ' ' : ''}Y${formatNumber(outputEnd.y)}`;
      }

      if (sourceState.motion === 2 || sourceState.motion === 3) {
        const iWord = words.find((word) => word.letter === 'I');
        const jWord = words.find((word) => word.letter === 'J');
        const hasI = Boolean(iWord);
        const hasJ = Boolean(jWord);
        if ((hasI || hasJ) && sourceState.centerAbsolute) {
          const center = { x: hasI ? iWord.value : oldStart.x, y: hasJ ? jWord.value : oldStart.y };
          const centerMapped = mapPoint({ x: center.x * factor, y: center.y * factor }, transform);
          if (hasI) replacements.set(iWord, centerMapped.x / factor);
          else additions += `${additions ? ' ' : ''}I${formatNumber(centerMapped.x / factor)}`;
          if (hasJ) replacements.set(jWord, centerMapped.y / factor);
          else additions += `${additions ? ' ' : ''}J${formatNumber(centerMapped.y / factor)}`;
        } else if (hasI || hasJ) {
          const centerVector = mapVector({ x: (valueOf(words, 'I') ?? 0) * factor, y: (valueOf(words, 'J') ?? 0) * factor }, transform);
          if (hasI) replacements.set(iWord, centerVector.x / factor);
          else additions += `${additions ? ' ' : ''}I${formatNumber(centerVector.x / factor)}`;
          if (hasJ) replacements.set(jWord, centerVector.y / factor);
          else additions += `${additions ? ' ' : ''}J${formatNumber(centerVector.y / factor)}`;
        }
        const rWord = words.find((word) => word.letter === 'R');
        if (rWord) replacements.set(rWord, rWord.value * transform.scale);
        if (!hasI && !hasJ && !rWord) throw new Error(`Line ${lineIndex + 1} contains an arc without I/J or R center data.`);
      }
      sourceState.x = sourceEnd.x;
      sourceState.y = sourceEnd.y;
      transformedPoints += 1;
      void oldStartMm;
      void sourceEndMm;
    }

    result.push(`${replaceWords(code, words, replacements, additions)}${comment}`);
  }
  if (!sawXY || transformedPoints === 0) throw new Error('No XY toolpath moves were found in the selected file.');
  const header = [
    `(Camera Align registration: ${wcs}, scale ${transform.scale.toFixed(6)}, rotation ${(transform.angle * 180 / Math.PI).toFixed(4)} deg)`,
    `(Captured print marks mapped to the calibrated camera-to-spindle position.)`,
    wcs,
    units,
  ];
  const openingDelimiter = result.findIndex((line) => line.trim() === '%');
  if (openingDelimiter >= 0) result.splice(openingDelimiter + 1, 0, ...header);
  else result.unshift(...header);
  return { text: result.join('\n'), transformedPoints };
}
