const FULL_TURN = 2 * Math.PI;
const ARC_TOLERANCE = .008;

function appendBulge(points, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  const bulge = start.bulge;
  if (!chord || Math.abs(bulge) < 1e-10) return;

  const sweep = 4 * Math.atan(bulge);
  const offset = chord * (1 / bulge - bulge) / 4;
  const radius = Math.hypot(chord / 2, offset);
  // The sagitta formula in terms of sin avoids loss of precision on flat arcs.
  const step = Math.min(Math.PI / 18, 4 * Math.asin(Math.min(1, Math.sqrt(ARC_TOLERANCE / (2 * radius)))));
  const segments = Math.min(4096, Math.max(2, Math.ceil(Math.abs(sweep) / step)));
  const ux = dx / chord, uy = dy / chord;

  for (let i = 1; i < segments; i++) {
    const angle = sweep * i / segments;
    const sin = Math.sin(angle), cosMinusOne = -2 * Math.sin(angle / 2) ** 2;
    const along = -chord / 2 * cosMinusOne + offset * sin;
    const left = -chord / 2 * sin - offset * cosMinusOne;
    points.push([start.x + along * ux - left * uy, start.y + along * uy + left * ux]);
  }
}

function lightweightPolyline(fields, closed, layer) {
  const vertices = [];
  let current;
  for (const [code, value] of fields) {
    if (code === 10) {
      current = {x: Number(value), y: 0, bulge: 0};
      vertices.push(current);
    } else if (current && code === 20) current.y = Number(value);
    else if (current && code === 42) current.bulge = Number(value);
  }
  if (vertices.length < 2 || vertices.some(p => ![p.x, p.y, p.bulge].every(Number.isFinite))) return null;

  const points = [];
  for (let i = 0; i < vertices.length; i++) {
    const start = vertices[i];
    points.push([start.x, start.y]);
    const end = vertices[i + 1] ?? (closed ? vertices[0] : null);
    if (end) appendBulge(points, start, end);
  }
  return {kind: closed ? 'polygon' : 'polyline', points, layer};
}

export function parseDxf(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([Number(lines[i].trim()), lines[i + 1].trim()]);
  }
  const items = [];
  let inEntities = false;
  for (let i = 0; i < pairs.length;) {
    const [code, type] = pairs[i++];
    if (code === 2 && type === 'ENTITIES') inEntities = true;
    if (inEntities && code === 0 && type === 'ENDSEC') break;
    if (!inEntities || code !== 0) continue;

    const fields = [];
    while (i < pairs.length && pairs[i][0] !== 0) fields.push(pairs[i++]);
    const field = key => fields.find(([code]) => code === key)?.[1];
    const number = key => Number(field(key) || 0);
    const layer = field(8) || 'Imported';
    if (type === 'LINE') {
      items.push({kind: 'line', x1: number(10), y1: number(20), x2: number(11), y2: number(21), layer});
    } else if (type === 'CIRCLE') {
      items.push({kind: 'circle', cx: number(10), cy: number(20), r: number(40), layer});
    } else if (type === 'ARC') {
      const start = number(50) * Math.PI / 180, end = number(51) * Math.PI / 180;
      const span = (end - start + FULL_TURN) % FULL_TURN;
      const count = Math.max(8, Math.ceil(span * 24));
      const cx = number(10), cy = number(20), radius = number(40);
      const points = Array.from({length: count + 1}, (_, j) => {
        const angle = start + span * j / count;
        return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
      });
      items.push({kind: 'polyline', points, layer});
    } else if (type === 'LWPOLYLINE') {
      const item = lightweightPolyline(fields, Boolean(number(70) & 1), layer);
      if (item) items.push(item);
    }
  }
  return items;
}
