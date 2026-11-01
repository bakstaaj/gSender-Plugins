export const DEFAULTS = Object.freeze({
    lengthX: 150,
    lengthY: 110,
    pointsX: 15,
    pointsY: 11,
    postProbeRetract: 3,
    probeTravel: 25.5,
    fastFeed: 100,
    slowFeed: 20,
    slowTravel: 3,
    retract: 2,
    puckThickness: 1.53,
    surfaceType: 'conductive',
});

export function makeGrid({ originX, originY, lengthX, lengthY, pointsX, pointsY }) {
    if (![originX, originY, lengthX, lengthY].every(Number.isFinite) || lengthX <= 0 || lengthY <= 0) {
        throw new Error('Map origin and dimensions must be finite; dimensions must be positive.');
    }
    if (!Number.isInteger(pointsX) || !Number.isInteger(pointsY) || pointsX < 2 || pointsY < 2 || pointsX > 101 || pointsY > 101) {
        throw new Error('Use 2–101 whole-number samples on each axis.');
    }
    return Array.from({ length: pointsY }, (_, iy) =>
        Array.from({ length: pointsX }, (_, ix) => ({
            ix, iy,
            x: originX + (lengthX * ix) / (pointsX - 1),
            y: originY + (lengthY * iy) / (pointsY - 1),
        })),
    );
}

export function validateMap({ originX, originY, lengthX, lengthY, pointsX, pointsY }, limits) {
    const grid = makeGrid({ originX, originY, lengthX, lengthY, pointsX, pointsY });
    if (!(limits.maxX > 0 && limits.maxY > 0 && limits.maxZ > 0)) throw new Error('Could not read valid $130/$131/$132 machine travel limits.');
    const eps = 1e-6;
    if (originX < -eps || originY < -eps || originX + lengthX > limits.maxX + eps || originY + lengthY > limits.maxY + eps) {
        throw new Error(`Map exceeds machine XY travel (${limits.maxX} × ${limits.maxY} mm). Move the origin or reduce map dimensions.`);
    }
    return grid;
}

export function validateMachineTarget({ x, y }, limits) {
    if (![limits.maxX, limits.maxY].every((limit) => Number.isFinite(limit) && limit > 0)) {
        throw new Error('Could not read valid machine XY travel limits from $130/$131.');
    }
    if (![x, y].every(Number.isFinite)) throw new Error('Enter valid machine-coordinate X and Y positions.');
    if (x < 0 || x > limits.maxX || y < 0 || y > limits.maxY) {
        throw new Error(`Start position must be within machine travel: X 0–${limits.maxX} mm, Y 0–${limits.maxY} mm.`);
    }
    return { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) };
}

export function computePostProbeRetract(currentZ, homeZ, requestedDistance) {
    if (![currentZ, homeZ, requestedDistance].every(Number.isFinite) || requestedDistance <= 0) {
        throw new Error('Could not calculate a valid Z retract from the last probe point to the homed Z position.');
    }
    const available = homeZ - currentZ;
    if (available <= 0) throw new Error('Probe position is at or above the recorded homed Z; cannot retract safely. Re-home before calibrating.');
    return Number(Math.min(requestedDistance, available).toFixed(4));
}

export function parseTravelLimits(lines) {
    const text = (Array.isArray(lines) ? lines : [lines]).map((line) => String(line)).join('\n');
    const settings = {};
    const pattern = /\$?(130|131|132)\s*=\s*(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi;
    for (const match of text.matchAll(pattern)) settings[Number(match[1])] = Number(match[2]);
    const limits = { maxX: settings[130], maxY: settings[131], maxZ: settings[132] };
    const missing = [[130, limits.maxX], [131, limits.maxY], [132, limits.maxZ]]
        .filter(([, value]) => !Number.isFinite(value) || value <= 0)
        .map(([setting]) => `$${setting}`);
    if (missing.length) throw new Error(`Could not find valid machine travel setting${missing.length > 1 ? 's' : ''} ${missing.join(', ')} in the controller's $$ response.`);
    return limits;
}

export function parseProbePosition(line) {
    const normalized = String(line ?? '').trim();
    const match = normalized.match(/^\[PRB:([-\d.]+),([-\d.]+),([-\d.]+)(?:,[-\d.]+)*:([01])\]$/i);
    if (!match) return null;
    if (match[4] !== '1') throw new Error('The probe report indicates that the probe did not trigger.');
    return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

export function parseWorkOffsetLine(line, name) {
    const normalized = String(line ?? '').trim();
    const prefix = `[${name}:`;
    if (normalized.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase()) return null;
    const close = normalized.indexOf(']', prefix.length);
    if (close < 0 || normalized.slice(close + 1).trim() !== '') return null;
    const components = normalized.slice(prefix.length, close).split(',');
    const values = components.map(Number);
    if (values.length < 3 || components.slice(0, 3).some((value) => value.trim() === '') || values.slice(0, 3).some((value) => !Number.isFinite(value))) return null;
    return values.slice(0, 3);
}

export function parseAbsoluteXYBounds(source) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('The selected file is empty.');
    const wordPattern = /([A-Za-z])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g;
    let units = null;
    let absolute = null;
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const code = raw.replace(/\([^)]*\)/g, '').split(';', 1)[0].trim();
        if (!code) continue;
        for (const match of code.matchAll(wordPattern)) {
            if (match[1].toUpperCase() !== 'G') continue;
            const g = Number(match[2]);
            if (g === 20) units = 'in';
            if (g === 21) units = 'mm';
            if (g === 90) absolute = true;
            if (g === 91) absolute = false;
        }
        const words = [...code.matchAll(wordPattern)];
        for (const match of words) {
            const axis = match[1].toUpperCase();
            if (axis !== 'X' && axis !== 'Y') continue;
            if (units !== 'mm') throw new Error('G-code must explicitly select metric units (G21) before XY coordinates.');
            if (absolute !== true) throw new Error('G-code must explicitly select absolute positioning (G90) before XY coordinates.');
            const value = Number(match[2]);
            bounds[`min${axis}`] = Math.min(bounds[`min${axis}`], value);
            bounds[`max${axis}`] = Math.max(bounds[`max${axis}`], value);
        }
    }
    if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(Number.isFinite)) {
        throw new Error('The selected file must contain absolute X and Y coordinates to align it with the map.');
    }
    return bounds;
}

export function computeG54ForMapOrigin(mapOrigin, bounds, g92 = [0, 0, 0]) {
    if (![mapOrigin?.x, mapOrigin?.y, bounds?.minX, bounds?.minY, g92?.[0], g92?.[1]].every(Number.isFinite)) {
        throw new Error('Could not calculate G54 alignment from the map origin, file bounds, and G92 offset.');
    }
    return {
        x: Number((mapOrigin.x - bounds.minX - g92[0]).toFixed(4)),
        y: Number((mapOrigin.y - bounds.minY - g92[1]).toFixed(4)),
    };
}

export function interpolate(map, x, y) {
    const { originX, originY, lengthX, lengthY, pointsX, pointsY, z } = map;
    const gx = ((x - originX) / lengthX) * (pointsX - 1);
    const gy = ((y - originY) / lengthY) * (pointsY - 1);
    if (gx < -1e-7 || gy < -1e-7 || gx > pointsX - 1 + 1e-7 || gy > pointsY - 1 + 1e-7) {
        throw new Error(`Toolpath leaves mapped area at X${x.toFixed(3)} Y${y.toFixed(3)}.`);
    }
    const x0 = Math.min(pointsX - 2, Math.max(0, Math.floor(gx)));
    const y0 = Math.min(pointsY - 2, Math.max(0, Math.floor(gy)));
    const tx = Math.min(1, Math.max(0, gx - x0));
    const ty = Math.min(1, Math.max(0, gy - y0));
    const z00 = z[y0][x0], z10 = z[y0][x0 + 1], z01 = z[y0 + 1][x0], z11 = z[y0 + 1][x0 + 1];
    return (z00 * (1 - tx) * (1 - ty)) + (z10 * tx * (1 - ty)) + (z01 * (1 - tx) * ty) + (z11 * tx * ty);
}

/**
 * Export the sampled surface as an ASCII STL in millimetres.
 * XY is local to the map origin and Z is the measured surface change from
 * the first probe point. This is an open surface mesh at true 1:1 scale.
 */
export function surfaceMapToStl(map) {
    const { lengthX, lengthY, pointsX, pointsY, z } = map ?? {};
    if (![lengthX, lengthY].every((value) => Number.isFinite(value) && value > 0)
        || !Number.isInteger(pointsX) || !Number.isInteger(pointsY) || pointsX < 2 || pointsY < 2
        || !Array.isArray(z) || z.length !== pointsY
        || z.some((row) => !Array.isArray(row) || row.length !== pointsX || row.some((value) => !Number.isFinite(value)))) {
        throw new Error('The saved height map is incomplete or invalid; cannot export an STL surface.');
    }
    const referenceZ = Number.isFinite(map.referenceZ) ? map.referenceZ : z[0][0];
    const point = (ix, iy) => [
        (lengthX * ix) / (pointsX - 1),
        (lengthY * iy) / (pointsY - 1),
        z[iy][ix] - referenceZ,
    ];
    const fmt = (value) => Number(value.toFixed(6)).toString();
    const facets = ['solid surface_height_map_mm_z_relative_to_first_probe'];
    const addFacet = (a, b, c) => {
        const ab = b.map((value, index) => value - a[index]);
        const ac = c.map((value, index) => value - a[index]);
        const normal = [
            (ab[1] * ac[2]) - (ab[2] * ac[1]),
            (ab[2] * ac[0]) - (ab[0] * ac[2]),
            (ab[0] * ac[1]) - (ab[1] * ac[0]),
        ];
        const magnitude = Math.hypot(...normal);
        const unitNormal = magnitude > 0 ? normal.map((value) => value / magnitude) : [0, 0, 1];
        facets.push(`  facet normal ${unitNormal.map(fmt).join(' ')}`, '    outer loop');
        for (const vertex of [a, b, c]) facets.push(`      vertex ${vertex.map(fmt).join(' ')}`);
        facets.push('    endloop', '  endfacet');
    };

    for (let iy = 0; iy < pointsY - 1; iy += 1) {
        for (let ix = 0; ix < pointsX - 1; ix += 1) {
            const lowerLeft = point(ix, iy);
            const lowerRight = point(ix + 1, iy);
            const upperLeft = point(ix, iy + 1);
            const upperRight = point(ix + 1, iy + 1);
            addFacet(lowerLeft, lowerRight, upperRight);
            addFacet(lowerLeft, upperRight, upperLeft);
        }
    }
    facets.push('endsolid surface_height_map_mm_z_relative_to_first_probe');
    return `${facets.join('\n')}\n`;
}

// gSender's current plugin bridge limits a single stored value to 256 KiB.
// Store generated STL text with its name in one plugin-storage value, but fail
// before writing when the serialized record would exceed that host limit.
export const MAX_STL_STORAGE_BYTES = 256 * 1024;

export function makeStlExportRecord(map, date = new Date()) {
    const text = surfaceMapToStl(map);
    const createdAt = date.toISOString();
    const filename = `surface-height-map-${createdAt.replace(/[:.]/g, '-')}.stl`;
    const record = { filename, createdAt, text };
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    if (bytes > MAX_STL_STORAGE_BYTES) {
        throw new Error(`This STL needs ${bytes.toLocaleString()} bytes, exceeding gSender plugin storage's ${MAX_STL_STORAGE_BYTES.toLocaleString()} byte per-value limit. Reduce the X/Y sample counts and recalibrate to create a smaller mesh.`);
    }
    return record;
}

const fmt = (n) => Number(n.toFixed(4)).toString();

/** Insert a safe machine-coordinate return before the program-end M-code. */
export function appendMachineOriginReturn(source) {
    const lines = String(source).replace(/\s*$/, '').split(/\r?\n/);
    const returnMoves = ['G21 G90 G53 G0 Z0', 'G53 G0 X0 Y0'];
    const endPattern = /\bM\s*(?:2|30)\b/i;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let code = line.replace(/\([^)]*\)/g, (comment) => ' '.repeat(comment.length));
        const semicolon = code.indexOf(';');
        if (semicolon >= 0) code = code.slice(0, semicolon).padEnd(line.length, ' ');
        const end = endPattern.exec(code);
        if (!end) continue;

        const prefix = line.slice(0, end.index).trimEnd();
        const terminal = line.slice(end.index);
        lines.splice(index, 1, ...(prefix ? [prefix] : []), ...returnMoves, terminal);
        return lines.join('\n') + '\n';
    }

    return [...lines, ...returnMoves].join('\n') + '\n';
}

/**
 * Deliberately bounded G-code preprocessor: metric, absolute, linear G0/G1 only.
 * It splits XY moves to at most half a grid cell and interpolates surface delta.
 */
export function compensateGcode(source, map, workOffset = { x: 0, y: 0 }, activeWcs = 'G54', initialWorkPosition = { x: 0, y: 0 }) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('The selected file is empty.');
    if (!Number.isFinite(workOffset.x) || !Number.isFinite(workOffset.y)) throw new Error('Could not determine the active work offset.');
    const words = /([A-Za-z])\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/g;
    const unsupported = /(?:^|\s)G\s*(?:20|28|30|38\.[0-9]+|5[3]|5[4-9]\.\d+|8[0-9]|9[1]|9[2](?:\.\d+)?|10|50|51|52|54\.1|68|69|93)(?:\s|$)/i;
    const rows = [];
    let x = initialWorkPosition?.x ?? null, y = initialWorkPosition?.y ?? null, z = null, motion = null, feed = null, units = null, absolute = null;
    const dx = map.lengthX / (map.pointsX - 1);
    const dy = map.lengthY / (map.pointsY - 1);
    const maxSegment = Math.max(0.1, Math.min(dx, dy) / 2);

    for (const raw of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!raw.trim()) { rows.push(raw); continue; }
        if (/[%#\[\]]/.test(raw)) throw new Error('Macro expressions and subprogram blocks are not supported yet.');
        const code = raw.replace(/\([^)]*\)/g, '').split(';', 1)[0].trim();
        if (!code) { rows.push(raw); continue; }
        if (/(?:^|\s)G\s*(?:2|3)(?:\s|$)/i.test(code)) throw new Error(`Arc moves G2/G3 are not supported yet: ${code}`);
        if (unsupported.test(code)) throw new Error(`Unsupported coordinate or motion command: ${code}`);
        if (/(?:^|\s)G\s*20(?:\s|$)/i.test(code)) throw new Error('This version only accepts metric G-code (G21).');
        const parsed = [...code.matchAll(words)].map((m) => [m[1].toUpperCase(), Number(m[2])]);
        if (!parsed.length) { rows.push(raw); continue; }
        if (parsed.some(([letter]) => letter === 'N' || letter === '*')) throw new Error('Line numbers or checksums are not supported; export plain G-code.');
        for (const [letter, value] of parsed) {
            if (letter !== 'G') continue;
            if (value === 20) units = 'in';
            if (value === 21) units = 'mm';
            if (value === 90) absolute = true;
            if (value === 91) absolute = false;
            if (value === 0 || value === 1) motion = value;
            if ([2, 3].includes(value)) throw new Error('Arc moves G2/G3 are not supported yet.');
            if (value === 53 || value === 92) throw new Error(`Coordinate-system command G${value} is not supported in compensated files.`);
            if (value >= 54 && value <= 59 && `G${value}` !== activeWcs) throw new Error(`File selects G${value}, but current controller coordinate system is ${activeWcs}.`);
        }
        if (units === 'in') throw new Error('This version only accepts metric G-code (G21).');
        if (absolute === false) throw new Error('This version only accepts absolute positioning (G90), not G91.');
        if (parsed.some(([letter, value]) => letter === 'G' && [81, 82, 83, 84, 85, 86, 87, 88, 89].includes(value))) {
            throw new Error('Canned drilling cycles are not supported yet.');
        }
        const feedWord = parsed.find(([letter]) => letter === 'F');
        if (feedWord) feed = feedWord[1];
        if (parsed.some(([letter]) => ['A', 'B', 'C', 'U', 'V', 'W'].includes(letter))) throw new Error('Rotary and additional-axis moves are not supported.');
        const get = (axis, fallback) => parsed.find(([letter]) => letter === axis)?.[1] ?? fallback;
        const hasX = parsed.some(([letter]) => letter === 'X');
        const hasY = parsed.some(([letter]) => letter === 'Y');
        const hasZ = parsed.some(([letter]) => letter === 'Z');
        if ((hasX || hasY) && parsed.some(([letter]) => ['M', 'S', 'T'].includes(letter))) {
            throw new Error('Put spindle/tool M, S, or T words on a separate line from XY movement before compensating this file.');
        }
        const nextX = hasX ? get('X', x) : x;
        const nextY = hasY ? get('Y', y) : y;
        const nextZ = hasZ ? get('Z', z) : z;
        if (motion === null && (hasX || hasY || hasZ)) throw new Error(`Axis move has no known G0/G1 mode: ${code}`);
        if (units !== 'mm' && (hasX || hasY || hasZ)) throw new Error('G-code must explicitly select metric units (G21) before axis moves.');
        if (absolute !== true && (hasX || hasY || hasZ)) throw new Error('G-code must explicitly select absolute positioning (G90) before axis moves.');

        if ((hasX || hasY) && (nextX === null || nextY === null || ((x === null || y === null) && !(hasX && hasY)))) {
            throw new Error('Could not determine the start and end of an XY move.');
        }
        if ((hasX || hasY) && motion !== 0 && motion !== 1) throw new Error('Only G0/G1 XY toolpaths can be compensated.');
        if (hasX || hasY) {
            if (x === null || y === null) {
                if (motion !== 0 || !hasX || !hasY) {
                    throw new Error('The file must start with a rapid XY positioning move (G0 with both X and Y) before any mapped cutting moves.');
                }
                // The first G0 establishes the file start. Its travel from the
                // machine's live position is a setup move, not part of the map.
                rows.push(raw);
                x = nextX; y = nextY;
                if (hasZ) z = nextZ;
                continue;
            }
            const sx = x, sy = y, ex = nextX, ey = nextY;
            const distance = Math.hypot(ex - sx, ey - sy);
            const steps = Math.max(1, Math.ceil(distance / maxSegment));
            const startZ = z ?? nextZ;
            const endZ = nextZ ?? startZ;
            if (startZ === null && motion === 1) throw new Error('A cutting XY move appears before any Z position is set. Add a safe-Z move before cutting.');
            for (let i = 1; i <= steps; i += 1) {
                const t = i / steps;
                const px = sx + (ex - sx) * t, py = sy + (ey - sy) * t;
                const correction = interpolate(map, px + workOffset.x, py + workOffset.y) - map.referenceZ;
                const pz = startZ === null ? null : startZ + (endZ - startZ) * t + correction;
                const final = i === steps;
                const tokens = [`G${motion}`, `X${fmt(px)}`, `Y${fmt(py)}`];
                if (pz !== null) tokens.push(`Z${fmt(pz)}`);
                if (i === 1 && parsed.some(([letter]) => letter === 'F') && feed !== null) tokens.push(`F${fmt(feed)}`);
                if (final) {
                    for (const [letter, value] of parsed) if (!['G', 'X', 'Y', 'Z', 'F'].includes(letter)) tokens.push(`${letter}${fmt(value)}`);
                }
                rows.push(tokens.join(' '));
            }
        } else if (hasZ) {
            if (x === null || y === null) {
                // A safe-Z command may precede the first XY positioning move.
                // It has no known surface location yet, so preserve it as-is.
                rows.push(raw);
                z = nextZ;
                continue;
            }
            const correction = interpolate(map, x + workOffset.x, y + workOffset.y) - map.referenceZ;
            const tokens = [];
            for (const [letter, value] of parsed) {
                if (letter === 'Z') tokens.push(`Z${fmt(value + correction)}`);
                else tokens.push(`${letter}${fmt(value)}`);
            }
            rows.push(tokens.join(' '));
        } else {
            rows.push(raw);
        }
        if (hasX || hasY) { x = nextX; y = nextY; }
        if (hasZ) z = nextZ;
    }
    return ['(Surface Height Map compensated copy)', ...rows].join('\n');
}
