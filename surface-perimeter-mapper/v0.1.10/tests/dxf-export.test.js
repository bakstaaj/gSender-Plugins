import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPerimeterDxf, buildSurfaceMeshDxf } from '../src/dxf-export.js';

function parseEntities(dxf) {
    const rows = dxf.trimEnd().split('\n');
    const pairs = [];
    for (let i = 0; i < rows.length; i += 2) pairs.push([rows[i], rows[i + 1]]);
    const entities = [];
    let current = null;
    for (const [code, value] of pairs) {
        if (code === '0') {
            if (current) entities.push(current);
            current = { type: value, values: {} };
        } else if (current) {
            current.values[code] = value;
        }
    }
    if (current) entities.push(current);
    return entities;
}

test('DXF writes a direct indexed polyface mesh enlarged 100x for CAD import', () => {
    const mesh = {
        bedZ: 10,
        triangles: [
            [
                { x: 5, y: 8, z: 10.1 },
                { x: 5.002, y: 8, z: 10.1 },
                { x: 5, y: 9, z: 10.1 }
            ],
            [
                { x: 5.002, y: 8, z: 10.1 },
                { x: 5.002, y: 9, z: 10.1 },
                { x: 5, y: 9, z: 10.1 }
            ]
        ]
    };
    const dxf = buildSurfaceMeshDxf(mesh);
    const entities = parseEntities(dxf);
    const polyline = entities.find((entity) => entity.type === 'POLYLINE');
    const coordinateVertices = entities.filter((entity) => entity.type === 'VERTEX' && entity.values['70'] === '192');
    const faceVertices = entities.filter((entity) => entity.type === 'VERTEX' && entity.values['70'] === '128');
    assert.equal(polyline.values['70'], '64');
    assert.equal(polyline.values['71'], '4');
    assert.equal(polyline.values['72'], '2');
    assert.equal(coordinateVertices.length, 4);
    assert.equal(faceVertices.length, 2);
    assert.equal(polyline.values['8'], 'MESH_100X');
    assert.equal(entities.some((entity) => entity.type === 'INSERT'), false);
    assert.equal(entities.some((entity) => entity.type === 'BLOCK'), false);
    assert.match(dxf, /\$INSUNITS\n70\n4\n/);

    const outputScaledVertices = coordinateVertices.map((vertex) => (
        [10, 20, 30].map((code) => Number(vertex.values[String(code)]))
    ));
    const expectedScaledVertices = [[500, 800, 10], [500.2, 800, 10], [500, 900, 10], [500.2, 900, 10]];
    for (const expected of expectedScaledVertices) {
        assert.ok(outputScaledVertices.some((scaled) => scaled.every((value, axis) => Math.abs(value - expected[axis]) < 1e-6)));
    }
    for (const face of faceVertices) {
        const ids = ['71', '72', '73'].map((code) => Number(face.values[code]));
        assert.equal(new Set(ids).size, 3);
        assert.ok(ids.every((id) => id >= 1 && id <= coordinateVertices.length));
        assert.equal(face.values['74'], undefined);
    }
});

test('DXF export rejects triangles that collapse at the export precision', () => {
    const mesh = {
        triangles: [[
            { x: 1, y: 1, z: 1 },
            { x: 1.000000001, y: 1, z: 1 },
            { x: 1, y: 2, z: 1 }
        ]]
    };
    assert.throws(() => buildSurfaceMeshDxf(mesh), /duplicate points at DXF export precision/);
});

test('2D DXF writes closed outer and cutout polylines in millimeters', () => {
    const dxf = buildPerimeterDxf(
        [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }, { x: 0, y: 0 }],
        [[{ x: 12, y: 10 }, { x: 12, y: 20 }, { x: 22, y: 20 }, { x: 22, y: 10 }]]
    );
    const entities = parseEntities(dxf);
    const polylines = entities.filter(entity => entity.type === 'LWPOLYLINE');

    assert.equal(polylines.length, 2);
    assert.match(dxf, /OUTER_PERIMETER\n90\n4\n70\n1\n38\n0/);
    assert.match(dxf, /CUTOUT_1\n90\n4\n70\n1\n38\n0/);
    assert.match(dxf, /\$INSUNITS\n70\n4/);
    assert.doesNotMatch(dxf, /\n(?:POLYLINE|VERTEX|INSERT|3DFACE)\n/);
    assert.match(dxf, /\n10\n40\n20\n30\n/);
});
