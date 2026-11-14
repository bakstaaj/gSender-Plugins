const SKETCHUP_IMPORT_SCALE = 100;
const MESH_LAYER = 'MESH_100X';

const formatNumber = (value) => {
    if (!Number.isFinite(value)) throw new Error('The selected mesh contains an invalid coordinate.');
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? '0' : String(rounded);
};

function dxfHeader(layers = []) {
    const lines = [
        '0', 'SECTION', '2', 'HEADER',
        '9', '$ACADVER', '1', 'AC1009',
        '9', '$MEASUREMENT', '70', '1',
        '0', 'ENDSEC'
    ];
    const tableLayers = [...new Set(['0', ...layers])];
    lines.push(
        '0', 'SECTION', '2', 'TABLES',
        '0', 'TABLE', '2', 'LTYPE', '70', '1',
        '0', 'LTYPE', '2', 'CONTINUOUS', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
        '0', 'ENDTAB',
        '0', 'TABLE', '2', 'LAYER', '70', String(tableLayers.length)
    );
    for (const layer of tableLayers) {
        lines.push('0', 'LAYER', '2', layer, '70', '0', '62', '7', '6', 'CONTINUOUS');
    }
    lines.push(
        '0', 'ENDTAB', '0', 'ENDSEC',
        '0', 'SECTION', '2', 'BLOCKS',
        '0', 'BLOCK', '8', '0', '2', '*Model_Space', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*Model_Space', '1', '',
        '0', 'ENDBLK', '8', '0',
        '0', 'BLOCK', '8', '0', '2', '*Paper_Space', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*Paper_Space', '1', '',
        '0', 'ENDBLK', '8', '0',
        '0', 'ENDSEC',
        '0', 'SECTION', '2', 'ENTITIES'
    );
    return lines;
}

function normalizeLoop(loop, label) {
    if (!Array.isArray(loop) || loop.length < 3 || loop.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        throw new Error(`${label} needs at least three valid XY points.`);
    }
    const points = [];
    for (const point of loop) {
        const x = Number(formatNumber(point.x));
        const y = Number(formatNumber(point.y));
        const previous = points.at(-1);
        if (!previous || previous.x !== x || previous.y !== y) points.push({ x, y });
    }
    if (points.length > 1 && points[0].x === points.at(-1).x && points[0].y === points.at(-1).y) points.pop();
    if (points.length < 3 || new Set(points.map(p => `${p.x},${p.y}`)).size !== points.length) {
        throw new Error(`${label} contains duplicate perimeter vertices.`);
    }
    return points;
}

export function buildPerimeterDxf(outerBoundary, cutoutBoundaries = []) {
    const loops = [
        { layer: 'OUTER_PERIMETER', points: normalizeLoop(outerBoundary, 'The outer perimeter') },
        ...cutoutBoundaries.map((loop, index) => ({ layer: `CUTOUT_${index + 1}`, points: normalizeLoop(loop, `Cutout ${index + 1}`) }))
    ];
    const lines = dxfHeader(loops.map(loop => loop.layer));
    for (const { layer, points } of loops) {
        lines.push('0', 'POLYLINE', '8', layer, '66', '1', '70', '1', '10', '0.0', '20', '0.0', '30', '0.0');
        for (const point of points) {
            lines.push('0', 'VERTEX', '8', layer, '10', String(point.x), '20', String(point.y), '30', '0.0', '70', '0');
        }
        lines.push('0', 'SEQEND', '8', layer);
    }
    lines.push('0', 'ENDSEC', '0', 'EOF');
    return `${lines.join('\n')}\n`;
}

export function buildSurfaceMeshDxf(mesh) {
    if (!Array.isArray(mesh?.triangles) || !mesh.triangles.length) {
        throw new Error('The selected Results view does not have a completed triangle mesh.');
    }

    const bedZ = Number.isFinite(mesh.bedZ) ? mesh.bedZ : 0;
    const vertexIndex = new Map();
    const vertices = [];
    const faces = [];

    for (const triangle of mesh.triangles) {
        if (!Array.isArray(triangle) || triangle.length !== 3) {
            throw new Error('The selected mesh contains an invalid face.');
        }
        const face = triangle.map((point) => {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
                throw new Error('The selected mesh contains an invalid coordinate.');
            }
            const values = [
                Number(formatNumber(point.x * SKETCHUP_IMPORT_SCALE)),
                Number(formatNumber(point.y * SKETCHUP_IMPORT_SCALE)),
                Number(formatNumber((point.z - bedZ) * SKETCHUP_IMPORT_SCALE))
            ];
            const key = values.join(',');
            let index = vertexIndex.get(key);
            if (index === undefined) {
                index = vertices.length;
                vertexIndex.set(key, index);
                vertices.push(values);
            }
            return index;
        });
        if (new Set(face).size !== 3) {
            throw new Error('A mesh triangle has duplicate points at DXF export precision.');
        }
        faces.push(face);
    }

    const lines = [
        ...dxfHeader([MESH_LAYER]),
        '0', 'POLYLINE', '8', MESH_LAYER, '66', '1', '70', '64',
        '71', String(vertices.length), '72', String(faces.length),
        '10', '0', '20', '0', '30', '0'
    ];

    for (const point of vertices) {
        lines.push('0', 'VERTEX', '8', MESH_LAYER, '70', '192');
        lines.push('10', String(point[0]), '20', String(point[1]), '30', String(point[2]));
    }
    for (const [a, b, c] of faces) {
        lines.push('0', 'VERTEX', '8', MESH_LAYER, '70', '128');
        lines.push('10', '0', '20', '0', '30', '0');
        lines.push('71', String(a + 1), '72', String(b + 1), '73', String(c + 1));
    }
    lines.push('0', 'SEQEND', '8', MESH_LAYER, '0', 'ENDSEC', '0', 'EOF');
    return `${lines.join('\n')}\n`;
}
