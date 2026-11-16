import * as THREE from 'three';

// Sweep the probe ball against the actual mesh triangles, including edges and
// corners. A centre-line ray alone cannot detect a grazing ball contact.
export function sweepProbeBall(root, from, to, radius) {
    const travel = to.clone().sub(from);
    const length = travel.length();
    if (!root || !length || !(radius > 0)) return null;
    const direction = travel.multiplyScalar(1 / length);
    const sweepBounds = new THREE.Box3().setFromPoints([from, to]).expandByScalar(radius + 0.001);
    const triangle = new THREE.Triangle();
    const closest = new THREE.Vector3();
    const point = new THREE.Vector3();
    const bounds = new THREE.Box3();
    let nearest = Infinity;
    root.updateWorldMatrix(true, true);
    root.traverse(mesh => {
        if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
        const geometry = mesh.geometry;
        const positions = geometry.attributes.position;
        const indices = geometry.index;
        const count = indices ? indices.count : positions.count;
        const vertex = (target, i) => target.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(mesh.matrixWorld);
        for (let i = 0; i + 2 < count; i += 3) {
            vertex(triangle.a, i); vertex(triangle.b, i + 1); vertex(triangle.c, i + 2);
            bounds.setFromPoints([triangle.a, triangle.b, triangle.c]);
            if (!bounds.intersectsBox(sweepBounds)) continue;
            let distance = 0;
            // Distance to a triangle is 1-Lipschitz, so advancing by the
            // current gap cannot step over a collision.
            for (let n = 0; n < 160 && distance <= length && distance < nearest; n++) {
                point.copy(from).addScaledVector(direction, distance);
                triangle.closestPointToPoint(point, closest);
                const gap = point.distanceTo(closest) - radius;
                if (gap <= 0.0001) { nearest = distance; break; }
                distance += gap;
            }
        }
    });
    return Number.isFinite(nearest) ? from.clone().addScaledVector(direction, nearest) : null;
}

export function probeBallTouches(root, center, radius) {
    if (!root) return false;
    const bounds = new THREE.Box3().setFromCenterAndSize(center,new THREE.Vector3(2*radius+0.001,2*radius+0.001,2*radius+0.001));
    const triangle=new THREE.Triangle(),closest=new THREE.Vector3(),triangleBounds=new THREE.Box3();
    let touches=false;root.updateWorldMatrix(true,true);
    root.traverse(mesh=>{
        if(touches||!mesh.isMesh||!mesh.geometry?.attributes.position)return;
        const g=mesh.geometry,p=g.attributes.position,idx=g.index,count=idx?idx.count:p.count;
        const vertex=(v,i)=>v.fromBufferAttribute(p,idx?idx.getX(i):i).applyMatrix4(mesh.matrixWorld);
        for(let i=0;i+2<count;i+=3){vertex(triangle.a,i);vertex(triangle.b,i+1);vertex(triangle.c,i+2);
            triangleBounds.setFromPoints([triangle.a,triangle.b,triangle.c]);if(!triangleBounds.intersectsBox(bounds))continue;
            triangle.closestPointToPoint(center,closest);if(center.distanceTo(closest)<=radius+0.0002){touches=true;break;}
        }
    });
    if(touches)return true;
    // For a closed solid a ball center can be farther than its radius from
    // every surface while still inside the solid. Such a position cannot be
    // interpreted as a release. Count unique ray crossings across all meshes.
    const ray=new THREE.Ray(center,new THREE.Vector3(0.873,0.391,0.289).normalize());
    const intersection=new THREE.Vector3(),crossings=[];
    root.traverse(mesh=>{
        if(!mesh.isMesh||!mesh.geometry?.attributes.position)return;
        const g=mesh.geometry,p=g.attributes.position,idx=g.index,count=idx?idx.count:p.count;
        const vertex=(v,i)=>v.fromBufferAttribute(p,idx?idx.getX(i):i).applyMatrix4(mesh.matrixWorld);
        for(let i=0;i+2<count;i+=3){vertex(triangle.a,i);vertex(triangle.b,i+1);vertex(triangle.c,i+2);
            if(ray.intersectTriangle(triangle.a,triangle.b,triangle.c,false,intersection)){
                const distance=intersection.distanceTo(center);if(distance>0.00001)crossings.push(distance);
            }
        }
    });
    crossings.sort((a,b)=>a-b);let unique=0,previous=-Infinity;
    for(const distance of crossings)if(distance-previous>0.0001){unique++;previous=distance;}
    return unique%2===1;
}

// Locate the first clear point on a bounded probe-away move. The simulator
// samples at 0.02 mm and refines the first transition by binary search.
export function findProbeRelease(from,to,touches) {
    const delta=to.clone().sub(from),length=delta.length();if(!length)return null;
    const samples=Math.ceil(length/0.02);let previous=0;
    for(let i=1;i<=samples;i++){
        const t=i/samples,p=from.clone().addScaledVector(delta,t);
        if(!touches(p)){let lo=previous,hi=t;for(let k=0;k<16;k++){const mid=(lo+hi)/2;if(touches(from.clone().addScaledVector(delta,mid)))lo=mid;else hi=mid;}
            return from.clone().addScaledVector(delta,hi);}
        previous=t;
    }
    return null;
}
