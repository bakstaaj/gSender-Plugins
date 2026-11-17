import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sweepProbeBall } from '../src/probe-collision.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const box = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
const near = (actual, expected, tolerance = 0.002) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('a ball hits a face at its radius', () => {
    near(sweepProbeBall(box, v(-10, 0, 0), v(10, 0, 0), 1).x, -6);
});
test('a ball catches an edge even when its centre ray misses the part', () => {
    const hit = sweepProbeBall(box, v(-10, 5.6, 0), v(10, 5.6, 0), 1);
    assert.ok(hit);
    near(hit.x, -5.8);
});
test('an overlapping tip reports immediate contact instead of crossing the solid', () => {
    near(sweepProbeBall(box, v(-5.5, 0, 0), v(10, 0, 0), 1).x, -5.5);
});
test('a clear path remains a miss', () => {
    assert.equal(sweepProbeBall(box, v(-10, 6.1, 0), v(10, 6.1, 0), 1), null);
});
test('transformed indexed geometry is respected', () => {
    const group = new THREE.Group(); group.position.set(10, 3, 0); group.add(box.clone());
    near(sweepProbeBall(group, v(0, 3, 0), v(20, 3, 0), 1).x, 4);
});

test('the actual STEP triangle catches the reported crossing near its diagonal', async () => {
    const require = createRequire(import.meta.url);
    const occt = await require('occt-import-js')();
    const bytes = await readFile(new URL('../probe-test-parts/right-triangle-70x50-6.5mm.step', import.meta.url));
    const result = occt.ReadStepFile(bytes, null);
    assert.ok(result.success);
    const part = new THREE.Group();
    for (const mesh of result.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.attributes.position.array, 3));
        geometry.setIndex(Array.from(mesh.index.array));
        part.add(new THREE.Mesh(geometry));
    }
    part.rotation.x = -Math.PI / 2;
    let bounds = new THREE.Box3().setFromObject(part);
    const center = bounds.getCenter(new THREE.Vector3());
    part.position.set(-center.x, -bounds.min.y, -center.z);
    const hit = sweepProbeBall(part, v(-34.48,3.2,-25.215), v(-34.48,3.2,30), 1);
    assert.ok(hit, 'probe must not pass through the triangle');
    assert.ok(hit.z < -23, `contact was too far inside the part: ${hit.z}`);
});
