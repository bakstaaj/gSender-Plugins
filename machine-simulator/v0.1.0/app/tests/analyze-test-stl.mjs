import fs from 'node:fs';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { Mesh, MeshBasicMaterial, DoubleSide, Raycaster, Vector3 } from 'three';
const file=process.argv[2];if(!file)throw Error('Supply an STL path');
const bytes=fs.readFileSync(file),data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const geometry=new STLLoader().parse(data),a=geometry.getAttribute('position');
if(!a||a.count<3||a.count%3)throw Error('STL has no complete triangles');
geometry.computeBoundingBox();const min=geometry.boundingBox.min.toArray(),max=geometry.boundingBox.max.toArray(),edges=new Map(),levels=new Map();let volume=0;
const key=p=>p.map(x=>(Math.abs(x)<1e-7?0:x).toFixed(5)).join(',');
for(let i=0;i<a.count;i+=3){
 const p=[0,1,2].map(j=>[a.getX(i+j),a.getY(i+j),a.getZ(i+j)]);
 if(p.flat().some(n=>!Number.isFinite(n)))throw Error('Invalid vertex');
 for(let j=0;j<3;j++){const k=[key(p[j]),key(p[(j+1)%3])].sort().join('|');edges.set(k,(edges.get(k)||0)+1);}
 const [u,v,w]=p;volume+=(u[0]*(v[1]*w[2]-v[2]*w[1])-u[1]*(v[0]*w[2]-v[2]*w[0])+u[2]*(v[0]*w[1]-v[1]*w[0]))/6;
 if(Math.max(...p.map(v=>v[2]))-Math.min(...p.map(v=>v[2]))<1e-5){const z=p[0][2].toFixed(4);levels.set(z,(levels.get(z)||0)+1);}
}
const mesh=new Mesh(geometry,new MeshBasicMaterial({side:DoubleSide}));mesh.updateMatrixWorld(true);
const samples=[0,5,10,15,20,25,29].map(offset=>{const hit=new Raycaster(new Vector3((min[0]+max[0])/2+offset,(min[1]+max[1])/2+.123,max[2]+5),new Vector3(0,0,-1)).intersectObject(mesh)[0];return {offset,top:hit?.point.z??null};});
console.log(JSON.stringify({file,triangles:a.count/3,min,max,dimensions:max.map((v,i)=>v-min[i]),volume,nonManifoldEdges:[...edges.values()].filter(v=>v!==2).length,horizontalLevels:Object.fromEntries(levels),samples},null,2));
