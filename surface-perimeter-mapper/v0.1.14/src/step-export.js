const formatNumber = (value) => {
    if (!Number.isFinite(value)) throw new Error('The selected mesh contains an invalid coordinate.');
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? '0' : String(rounded);
};

const normalize = (vector) => {
    const length = Math.hypot(...vector);
    if (!length) throw new Error('The selected mesh contains a degenerate triangle.');
    return vector.map((value) => value / length);
};

const stepString = (value) => String(value).replaceAll("'", "''");

/** Build an AP214 faceted B-rep STEP solid from a closed triangle mesh. */
export function buildFacetedBrepStep(mesh, name = 'Measured part') {
    if (mesh?.closed !== true || !Array.isArray(mesh.triangles) || !mesh.triangles.length) {
        throw new Error('STEP solid export requires a closed model. Select Both or Perimeter; the surface-only view is open.');
    }

    const bedZ = Number.isFinite(mesh.bedZ) ? mesh.bedZ : 0;
    const entities = [];
    let nextId = 16;
    const add = (definition) => {
        const id = nextId++;
        entities.push(`#${id}=${definition};`);
        return id;
    };
    const vertexIds = new Map();
    const vertices = [];
    const edgeUse = new Map();
    const pointFor = (point) => {
        if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) {
            throw new Error('The selected mesh contains an invalid coordinate.');
        }
        const xyz = [formatNumber(point.x), formatNumber(point.y), formatNumber(point.z - bedZ)];
        const key = xyz.join(',');
        if (vertexIds.has(key)) return vertexIds.get(key);
        const id = add(`CARTESIAN_POINT('',(${xyz.join(',')}))`);
        vertexIds.set(key, id);
        vertices.push(key);
        return id;
    };
    const faceIds = [];

    for (const triangle of mesh.triangles) {
        if (!Array.isArray(triangle) || triangle.length !== 3) {
            throw new Error('The selected mesh contains an invalid face.');
        }
        const points = triangle.map((point) => ({
            x: Number(formatNumber(point?.x)),
            y: Number(formatNumber(point?.y)),
            z: Number(formatNumber((point?.z ?? NaN) - bedZ))
        }));
        const ids = triangle.map(pointFor);
        if (new Set(ids).size !== 3) throw new Error('A mesh triangle has duplicate points at STEP export precision.');

        for (let index = 0; index < 3; index += 1) {
            const a = ids[index];
            const b = ids[(index + 1) % 3];
            const key = a < b ? `${a}|${b}` : `${b}|${a}`;
            const edge = edgeUse.get(key) ?? { count: 0, direction: 0 };
            edge.count += 1;
            edge.direction += a < b ? 1 : -1;
            edgeUse.set(key, edge);
        }

        const [a, b, c] = points;
        const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
        const ac = [c.x - a.x, c.y - a.y, c.z - a.z];
        const normal = normalize([
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0]
        ]);
        const reference = normalize(ab);
        const originId = ids[0];
        const axisId = add(`DIRECTION('',(${normal.map(formatNumber).join(',')}))`);
        const referenceId = add(`DIRECTION('',(${reference.map(formatNumber).join(',')}))`);
        const placementId = add(`AXIS2_PLACEMENT_3D('',#${originId},#${axisId},#${referenceId})`);
        const planeId = add(`PLANE('',#${placementId})`);
        const loopId = add(`POLY_LOOP('',(#${ids.join(',#')}))`);
        const boundId = add(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
        faceIds.push(add(`ADVANCED_FACE('',(#${boundId}),#${planeId},.T.)`));
    }

    const unmatched = [...edgeUse.values()].filter((edge) => edge.count !== 2 || edge.direction !== 0).length;
    if (unmatched) throw new Error(`STEP requires a watertight, consistently oriented mesh; found ${unmatched} unmatched or overlapping edges.`);
    if (!vertices.length) throw new Error('The selected mesh contains no usable vertices.');

    const shellChunks = [];
    for (let index = 0; index < faceIds.length; index += 12) {
        shellChunks.push(faceIds.slice(index, index + 12).map((id) => `#${id}`).join(','));
    }
    const shellId = add(`CLOSED_SHELL('',(\n${shellChunks.map((chunk) => `  ${chunk}`).join(',\n')}\n))`);
    const brepId = add(`FACETED_BREP('${stepString(name)}',#${shellId})`);
    const escapedName = stepString(name);
    const header = [
        'ISO-10303-21;',
        'HEADER;',
        "FILE_DESCRIPTION(('Faceted solid exported by gSender 3D Part Mapping'),'2;1');",
        `FILE_NAME('${escapedName}.step','${new Date().toISOString()}',('gSender user'),('Bakstaaj'),'gSender 3D Part Mapping','gSender','');`,
        "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
        'ENDSEC;',
        'DATA;',
        "#1=APPLICATION_CONTEXT('automotive design');",
        "#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#1);",
        "#3=PRODUCT_CONTEXT('',#1,'mechanical');",
        `#4=PRODUCT('${escapedName}','${escapedName}','',(#3));`,
        "#5=PRODUCT_DEFINITION_FORMATION('','',#4);",
        "#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
        "#7=PRODUCT_DEFINITION('','',#5,#6);",
        "#8=PRODUCT_DEFINITION_SHAPE('','',#7);",
        "#9=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));",
        "#10=(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.));",
        "#11=(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT());",
        "#12=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.001),#9,'distance_accuracy_value','confusion accuracy');",
        "#13=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#12)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#9,#10,#11)) REPRESENTATION_CONTEXT('',''));",
        `#14=SHAPE_REPRESENTATION('${escapedName}',(#${brepId}),#13);`,
        '#15=SHAPE_DEFINITION_REPRESENTATION(#8,#14);',
        ...entities,
        'ENDSEC;',
        'END-ISO-10303-21;'
    ];
    return `${header.join('\n')}\n`;
}
