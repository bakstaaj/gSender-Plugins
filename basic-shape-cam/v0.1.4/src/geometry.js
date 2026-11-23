const TAU = Math.PI * 2;

export function shapePoints(shape, values, segments = 144) {
  const width = Number(values.width);
  const height = Number(values.height);
  if (shape === 'circle' || shape === 'oval') {
    const rx = (shape === 'circle' ? width : width) / 2;
    const ry = (shape === 'circle' ? width : height) / 2;
    return Array.from({ length: segments }, (_, index) => {
      const angle = -Math.PI / 2 + TAU * index / segments;
      return { x: rx * Math.cos(angle), y: ry * Math.sin(angle) };
    });
  }
  if (shape === 'slot') {
    const length = width;
    const radius = height / 2;
    const endCenter = (length - height) / 2;
    const arcSegments = Math.max(24, Math.round(segments / 2));
    const points = [];
    for (let index = 0; index <= arcSegments; index += 1) {
      const angle = -Math.PI / 2 + Math.PI * index / arcSegments;
      points.push({ x: endCenter + radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    for (let index = 0; index <= arcSegments; index += 1) {
      const angle = Math.PI / 2 + Math.PI * index / arcSegments;
      points.push({ x: -endCenter + radius * Math.cos(angle), y: radius * Math.sin(angle) });
    }
    return points;
  }
  if (shape === 'rectangle' || shape === 'square') {
    const w = shape === 'square' ? width : width;
    const h = shape === 'square' ? width : height;
    return [
      { x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 },
    ];
  }
  if (shape === 'triangle') {
    return [
      { x: -width / 2, y: -height / 2 },
      { x: width / 2, y: -height / 2 },
      { x: 0, y: height / 2 },
    ];
  }
  if (shape === 'polygon') {
    const count = Math.max(3, Math.min(32, Math.floor(Number(values.sides))));
    const radius = width / 2;
    return Array.from({ length: count }, (_, index) => {
      const angle = -Math.PI / 2 + TAU * index / count;
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
    });
  }
  throw new Error('Choose a supported shape.');
}

function lineIntersection(p1, d1, p2, d2) {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-8) throw new Error('Tool offset is too large for this shape.');
  const delta = { x: p2.x - p1.x, y: p2.y - p1.y };
  const t = (delta.x * d2.y - delta.y * d2.x) / cross;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

export function offsetConvexPolygon(points, distance) {
  if (Math.abs(distance) < 1e-8) return points.map((point) => ({ ...point }));
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  const orientation = Math.sign(area) || 1;
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const dx = next.x - point.x; const dy = next.y - point.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-7) throw new Error('Shape contains a zero-length edge.');
    return {
      direction: { x: dx / length, y: dy / length },
      normal: { x: orientation * dy / length, y: -orientation * dx / length },
    };
  });
  return points.map((point, index) => {
    const before = edges[(index + points.length - 1) % points.length];
    const after = edges[index];
    const d1 = before.direction; const d2 = after.direction;
    const p1 = { x: point.x + before.normal.x * distance, y: point.y + before.normal.y * distance };
    const p2 = { x: point.x + after.normal.x * distance, y: point.y + after.normal.y * distance };
    return lineIntersection(p1, d1, p2, d2);
  });
}

export function makeToolpath(shape, values, compensation, toolDiameter, origin) {
  const source = shapePoints(shape, values);
  const offset = compensation === 'outside' ? toolDiameter / 2 : compensation === 'inside' ? -toolDiameter / 2 : 0;
  const path = shape === 'circle' || shape === 'oval'
    ? source.map((point) => {
      const rx = Number(values.width) / 2;
      const ry = shape === 'circle' ? rx : Number(values.height) / 2;
      const nx = point.x / (rx * rx); const ny = point.y / (ry * ry);
      const normalLength = Math.hypot(nx, ny) || 1;
      return { x: point.x + offset * nx / normalLength, y: point.y + offset * ny / normalLength };
    })
    : offsetConvexPolygon(source, offset);
  return path.map((point) => ({ x: point.x + Number(origin.x), y: point.y + Number(origin.y) }));
}

function fmt(value) { return Number(value).toFixed(3); }

export function generateGcode({ shape, shapeName, path, values, material, tool, settings }) {
  const totalDepth = Number(settings.depth);
  const stepDown = Number(settings.stepDown);
  const passes = Math.ceil(totalDepth / stepDown);
  const safeZ = Number(settings.safeZ);
  const depths = Array.from({ length: passes }, (_, index) => -Math.min(totalDepth, stepDown * (index + 1)));
  const sizeText = shape === 'circle' || shape === 'square'
    ? `${values.width} mm`
    : shape === 'slot'
      ? `${values.width} mm long x ${values.height} mm wide; end radius ${Number(values.height) / 2} mm`
    : shape === 'polygon'
      ? `${values.sides} sides, ${values.width} mm across corners`
      : `${values.width} x ${values.height} mm`;
  const lines = [
    `(${shapeName} profile generated by Basic Shape CAM)`,
    `(Centered at X${fmt(settings.originX)} Y${fmt(settings.originY)}; ${sizeText})`,
    `(Tool: ${tool.name}, diameter ${fmt(tool.diameter)} mm; material: ${material.name})`,
    '(Review this file in gSender before running. The plugin does not start jobs.)',
    'G21', 'G90', 'G17', 'G94', 'G54',
    `T${Math.max(1, Math.floor(Number(tool.number) || 1))} M6`,
    `S${Math.round(material.rpm)} M3`,
    `G0 Z${fmt(safeZ)}`,
    `G0 X${fmt(path[0].x)} Y${fmt(path[0].y)}`,
  ];
  for (const depth of depths) {
    lines.push(`G1 Z${fmt(depth)} F${Math.round(material.plunge)}`);
    for (let index = 1; index <= path.length; index += 1) {
      const point = path[index % path.length];
      lines.push(`G1 X${fmt(point.x)} Y${fmt(point.y)} F${Math.round(material.feed)}`);
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
    if (depth !== depths.at(-1)) lines.push(`G0 X${fmt(path[0].x)} Y${fmt(path[0].y)}`);
  }
  lines.push('M5', 'M30', '');
  return lines.join('\n');
}
