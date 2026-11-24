export const MAX_MODEL_TRIANGLES = 6000000;

export function parseStl(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const count = bytes.length >= 84 ? view.getUint32(80, true) : 0;
  if (bytes.length === 84 + count * 50) {
    if (count > MAX_MODEL_TRIANGLES) throw new Error(`This STL has ${count.toLocaleString()} triangles; the limit is ${MAX_MODEL_TRIANGLES.toLocaleString()}.`);
    const triangles = new Float32Array(count * 9);
    let target = 0;
    for (let i = 0; i < count; i += 1) {
      let source = 96 + i * 50;
      for (let j = 0; j < 9; j += 1) { triangles[target++] = view.getFloat32(source, true); source += 4; }
    }
    return triangles;
  }
  const text = new TextDecoder().decode(bytes);
  const matches = text.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g);
  const vertices = [];
  for (const match of matches) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (vertices.length / 9 > MAX_MODEL_TRIANGLES) throw new Error(`This STL has more than ${MAX_MODEL_TRIANGLES.toLocaleString()} triangles.`);
  }
  if (!vertices.length) throw new Error('This STL file could not be read.');
  return Float32Array.from(vertices);
}

export function stepTrianglesFromImport(result) {
  if (!result?.success || !Array.isArray(result.meshes) || !result.meshes.length) throw new Error('STEP import did not contain a usable mesh.');
  let triangleCount = 0;
  for (const mesh of result.meshes) {
    const positions = mesh.attributes?.position?.array;
    if (!positions?.length) continue;
    const indices = mesh.index?.array;
    const indexCount = indices?.length ? (Array.isArray(indices[0]) ? indices.reduce((sum, row) => sum + row.length, 0) : indices.length) : 0;
    triangleCount += indexCount ? indexCount / 3 : positions.length / 9;
    if (triangleCount > MAX_MODEL_TRIANGLES) throw new Error(`This STEP model has more than ${MAX_MODEL_TRIANGLES.toLocaleString()} triangles after tessellation.`);
  }
  const triangles = new Float32Array(triangleCount * 9);
  let target = 0;
  for (const mesh of result.meshes) {
    const positions = mesh.attributes?.position?.array;
    if (!positions?.length) continue;
    const indices = mesh.index?.array;
    if (indices?.length) {
      const flatIndices = Array.isArray(indices[0]) ? indices.flat() : indices;
      for (let i = 0; i + 2 < flatIndices.length; i += 3) {
        for (let j = 0; j < 3; j += 1) {
          const at = Number(flatIndices[i + j]) * 3;
          triangles[target++] = positions[at]; triangles[target++] = positions[at + 1]; triangles[target++] = positions[at + 2];
        }
      }
    } else {
      triangles.set(positions, target);
      target += positions.length;
    }
  }
  if (!triangles.length) throw new Error('STEP import returned no triangles.');
  return triangles;
}

export function getModelBounds(triangles) {
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < triangles.length; i += 3) {
    const x = triangles[i], y = triangles[i + 1], z = triangles[i + 2];
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  if (![bounds.minX, bounds.minY, bounds.minZ, bounds.maxX, bounds.maxY, bounds.maxZ].every(Number.isFinite)) throw new Error('The model has no finite geometry.');
  bounds.sizeX = bounds.maxX - bounds.minX;
  bounds.sizeY = bounds.maxY - bounds.minY;
  if (bounds.sizeX <= 0 || bounds.sizeY <= 0) throw new Error('The model needs a nonzero top-view width and height. Orient its engraving face toward +Z.');
  return bounds;
}

/** Sample only upward-facing triangles into a top-view image grid. Heights are relative to the model's highest Z. */
export function sampleTopSurface(triangles, width, height, maxSlopeDegrees = 60) {
  const bounds = getModelBounds(triangles);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) throw new Error('Load an image before sampling the model surface.');
  const minimumNormalZ = Math.cos(Number(maxSlopeDegrees) * Math.PI / 180);
  const topZ = new Float64Array(width * height);
  topZ.fill(-Infinity);
  const valid = new Uint8Array(width * height);
  const spanX = bounds.sizeX, spanY = bounds.sizeY;
  for (let t = 0; t < triangles.length; t += 9) {
    const ax = triangles[t], ay = triangles[t + 1], az = triangles[t + 2];
    const bx = triangles[t + 3], by = triangles[t + 4], bz = triangles[t + 5];
    const cx = triangles[t + 6], cy = triangles[t + 7], cz = triangles[t + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const normalLength = Math.hypot(nx, ny, nz);
    if (normalLength < 1e-12 || nz / normalLength < minimumNormalZ) continue;
    const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denominator) < 1e-12) continue;
    const minX = Math.max(0, Math.floor((Math.min(ax, bx, cx) - bounds.minX) / spanX * (width - 1)));
    const maxX = Math.min(width - 1, Math.ceil((Math.max(ax, bx, cx) - bounds.minX) / spanX * (width - 1)));
    const minY = Math.max(0, Math.floor((bounds.maxY - Math.max(ay, by, cy)) / spanY * (height - 1)));
    const maxY = Math.min(height - 1, Math.ceil((bounds.maxY - Math.min(ay, by, cy)) / spanY * (height - 1)));
    for (let iy = minY; iy <= maxY; iy += 1) {
      const y = bounds.maxY - iy / (height - 1) * spanY;
      for (let ix = minX; ix <= maxX; ix += 1) {
        const x = bounds.minX + ix / (width - 1) * spanX;
        const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / denominator;
        const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
        const z = wa * az + wb * bz + wc * cz;
        const index = iy * width + ix;
        if (z > topZ[index]) topZ[index] = z;
      }
    }
  }
  const heights = new Float32Array(width * height);
  let covered = 0;
  for (let i = 0; i < topZ.length; i += 1) {
    if (Number.isFinite(topZ[i])) { heights[i] = topZ[i] - bounds.maxZ; valid[i] = 1; covered += 1; }
  }
  if (!covered) throw new Error('No top-facing surface was found. Orient the engraving face toward +Z and lower the maximum slope if appropriate.');
  return { heights, valid, bounds, width, height, coverage: covered / topZ.length, covered };
}
