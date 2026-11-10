import Delaunator from 'delaunator';
import cdt2d from 'cdt2d';

const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function inside(p,poly){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[j],b=poly[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;}
function crosses(a,b,c,d){return cross(a,b,c)*cross(a,b,d)<-1e-9&&cross(c,d,a)*cross(c,d,b)<-1e-9;}
export function previewPolygonMesh(boundary,points,spacing){
    const triangles=[];
    if(points.length>=3){const index=Delaunator.from(points,p=>p.x,p=>p.y).triangles;for(let i=0;i<index.length;i+=3){const t=[points[index[i]],points[index[i+1]],points[index[i+2]]],center={x:(t[0].x+t[1].x+t[2].x)/3,y:(t[0].y+t[1].y+t[2].y)/3};if(inside(center,boundary)&&Math.max(distance(t[0],t[1]),distance(t[1],t[2]),distance(t[2],t[0]))<=spacing*3)triangles.push(t);}}
    return {points,measuredPoints:points,triangles,preview:true};
}
export function polygonMesh(boundary, samples, spacing, bedZ, recesses=[], threshold=-Infinity){
    if(!Array.isArray(boundary)||boundary.length<3||!Array.isArray(samples)||samples.length<3||!Number.isFinite(spacing)||spacing<=0)throw Error('A measured polygon, at least three surface readings, and valid sample spacing are required.');
    if([...boundary,...samples].some(p=>![p.x,p.y,p.z].every(Number.isFinite))||!Number.isFinite(bedZ))throw Error('The scan needs valid coordinates and a measured bed height.');
    const unique=[];const seen=new Set();for(const p of samples){const k=`${p.x.toFixed(5)},${p.y.toFixed(5)}`;if(!seen.has(k)){seen.add(k);unique.push(p);}}
    // The probe measured XY at the side, not the height of the top edge.
    // Estimate the latter from nearby top readings; never claim it measured Z.
    const estimate=(p,points)=>{
        const nearby=[...points].sort((a,b)=>distance(a,p)-distance(b,p)).slice(0,3);
        if(!nearby.length)throw Error('No nearby surface readings for a perimeter wall.');
        let sum=0,weight=0;for(const s of nearby){const w=1/Math.max(.01,distance(s,p));sum+=s.z*w;weight+=w;}
        return sum/weight;
    };
    const contours=recesses.map(r=>r.contour.filter((p,i,a)=>!i||distance(p,a[i-1])>.02));
    const topSamples=unique.filter(p=>p.z>=threshold&&!contours.some(loop=>inside(p,loop)));
    const edgeTop=boundary.filter((p,i)=>i===0||distance(p,boundary[i-1])>0.001).map(p=>({x:p.x,y:p.y,z:estimate(p,topSamples),estimated:true}));
    if(edgeTop.length>1&&distance(edgeTop[0],edgeTop.at(-1))<0.001)edgeTop.pop();
    const onBoundary=(p,loop)=>loop.some((a,i)=>{const b=loop[(i+1)%loop.length],dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<1e-5;});
    const within=(p,loop)=>inside(p,loop)||onBoundary(p,loop);
    const surfaceTriangles=[],wallTriangles=[],bottomTriangles=[],triangles=[],all=[...topSamples,...edgeTop],holeEdges=[];
    for(let i=0;i<contours.length;i++){
        const loop=contours[i],readings=recesses[i].floor,parentIndex=recesses[i].parentIndex??null;
        if(loop.length<3||!Array.isArray(readings)||!readings.length)throw Error('Recess outline and floor readings are required for the mesh.');
        if(parentIndex!==null&&(!Number.isInteger(parentIndex)||parentIndex<0||parentIndex>=i||!inside(loop[0],contours[parentIndex])))throw Error('Invalid nested recess hierarchy; raw readings retained.');
        const childLoops=contours.filter((_loop,index)=>(recesses[index].parentIndex??null)===i);
        const floor=readings.filter(p=>!childLoops.some(child=>inside(p,child)));
        if(!floor.length)throw Error('No floor readings remain outside the nested recess; raw readings retained.');
        const through=floor.every(p=>p.z<=bedZ+.02);
        if(!through&&floor.some(p=>p.z<=bedZ+.02))throw Error('A recess partly reaches the bed; a closed mesh cannot be inferred from these readings.');
        const surrounding=parentIndex===null?topSamples:recesses[parentIndex].floor.filter(p=>!inside(p,loop));
        const top=loop.map(p=>({x:p.x,y:p.y,z:estimate(p,surrounding),estimated:true}));
        const bottom=loop.map(p=>({x:p.x,y:p.y,z:through?bedZ:recesses[i].raised?estimate(p,floor):Number.isFinite(recesses[i].floorZ)?recesses[i].floorZ:estimate(p,floor),estimated:true}));
        all.push(...top,...bottom);holeEdges.push({loop,top,bottom,floor,through,parentIndex});
    }
    const addSurface=(points,outer,holes=[])=>{
        const vertices=[],edges=[],map=new Map(),pointMap=new Map(points.map(p=>[`${p.x.toFixed(7)},${p.y.toFixed(7)}`,p]));
        const add=p=>{const k=`${p.x.toFixed(7)},${p.y.toFixed(7)}`;if(map.has(k))return map.get(k);const index=vertices.length;vertices.push(p);map.set(k,index);return index;};
        for(const loop of [outer,...holes]){
            const ids=loop.map(p=>{const found=pointMap.get(`${p.x.toFixed(7)},${p.y.toFixed(7)}`);if(!found)throw Error('Missing measured boundary vertex for triangulation.');return add(found);});
            for(let i=0;i<ids.length;i++){if(ids[i]===ids[(i+1)%ids.length])throw Error('Duplicate boundary vertex prevents closed triangulation.');edges.push([ids[i],ids[(i+1)%ids.length]]);}
        }
        for(const p of points){
            if(!within(p,outer)||holes.some(h=>inside(p,h)&&!onBoundary(p,h)))continue;
            const k=`${p.x.toFixed(7)},${p.y.toFixed(7)}`;if(map.has(k))continue;
            if([outer,...holes].some(loop=>onBoundary(p,loop)))continue;
            add(p);
        }
        const cells=cdt2d(vertices.map(p=>[p.x,p.y]),edges,{exterior:false});
        for(const cell of cells){let [a,b,c]=cell.map(i=>vertices[i]);if(Math.abs(cross(a,b,c))<1e-9)continue;
            const center={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3};if(!within(center,outer)||holes.some(h=>inside(center,h)))continue;
            if(cross(a,b,c)<0)[b,c]=[c,b];surfaceTriangles.push([a,b,c]);
        }
    };
    const outerHoles=holeEdges.filter(h=>h.parentIndex===null);
    addSurface([...topSamples,...edgeTop,...outerHoles.flatMap(h=>h.top)],boundary,outerHoles.map(h=>h.loop));
    for(const [index,h] of holeEdges.entries()){
        const children=holeEdges.filter(child=>child.parentIndex===index);
        if(h.through&&children.length)throw Error('A through opening cannot contain another recess.');
        if(!h.through)addSurface([...h.floor,...h.bottom,...children.flatMap(child=>child.top)],h.loop,children.map(child=>child.loop));
        const ccw=h.loop.reduce((sum,p,i)=>sum+p.x*h.loop[(i+1)%h.loop.length].y-h.loop[(i+1)%h.loop.length].x*p.y,0)>0;
        for(let i=0;i<h.top.length;i++){const j=(i+1)%h.top.length;const faces=[[h.top[i],h.bottom[j],h.bottom[i]],[h.top[i],h.top[j],h.bottom[j]]];wallTriangles.push(...(ccw?faces:faces.map(([a,b,c])=>[a,c,b])));}
    }
    if(!triangles.length)throw Error('The measured samples cannot form a surface within the candidate outline.');
    const bed=edgeTop.map(p=>({x:p.x,y:p.y,z:bedZ,bed:true}));
    const outerCcw=edgeTop.reduce((sum,p,i)=>sum+p.x*edgeTop[(i+1)%edgeTop.length].y-edgeTop[(i+1)%edgeTop.length].x*p.y,0)>0;
    for(let i=0;i<edgeTop.length;i++){const j=(i+1)%edgeTop.length;const faces=[[edgeTop[i],bed[i],bed[j]],[edgeTop[i],bed[j],edgeTop[j]]];wallTriangles.push(...(outerCcw?faces:faces.map(([a,b,c])=>[a,c,b])));}
    const bottomVertices=bed.slice(),bottomEdges=bed.map((_p,i)=>[i,(i+1)%bed.length]);
    for(const h of holeEdges.filter(h=>h.through)){const offset=bottomVertices.length;bottomVertices.push(...h.bottom);for(let i=0;i<h.bottom.length;i++)bottomEdges.push([offset+i,offset+(i+1)%h.bottom.length]);}
    for(const cell of cdt2d(bottomVertices.map(p=>[p.x,p.y]),bottomEdges,{exterior:false})){let [a,b,c]=cell.map(j=>bottomVertices[j]);const center={x:(a.x+b.x+c.x)/3,y:(a.y+b.y+c.y)/3};if(!within(center,bed)||holeEdges.some(h=>h.through&&inside(center,h.loop))||Math.abs(cross(a,b,c))<1e-9)continue;if(cross(a,b,c)>0)[b,c]=[c,b];bottomTriangles.push([a,b,c]);}
    triangles.push(...surfaceTriangles,...wallTriangles,...bottomTriangles);
    const edges=new Map(),pointKey=p=>`${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
    for(const tri of triangles)for(let i=0;i<3;i++){const a=pointKey(tri[i]),b=pointKey(tri[(i+1)%3]),key=a<b?`${a}|${b}`:`${b}|${a}`,entry=edges.get(key)??{count:0,direction:0};entry.count++;entry.direction+=a<b?1:-1;edges.set(key,entry);}
    const invalid=[...edges.values()].filter(e=>e.count!==2||e.direction!==0).length;
    if(invalid){const sample=[...edges.entries()].filter(([,e])=>e.count!==2||e.direction!==0).slice(0,3);throw Error(`Surface could not form a closed STL (${invalid} unmatched or overlapping edges; ${JSON.stringify(sample)}). Raw readings were retained.`);}
    return {points:[...all,...bed,...holeEdges.flatMap(h=>h.floor)],measuredPoints:unique,bedZ,triangles,surfaceTriangles,wallTriangles,bottomTriangles,closed:true};
}
export function polygonSurfaceOnlyMesh(mesh){
    if(!mesh?.surfaceTriangles?.length)throw Error('A completed surface mesh is required for the surface-only view.');
    const triangles=mesh.surfaceTriangles,points=[...new Map(triangles.flat().map(point=>[`${point.x.toFixed(7)},${point.y.toFixed(7)},${point.z.toFixed(7)}`,point])).values()];
    return {...mesh,points,triangles,closed:false};
}
export function polygonPerimeterMesh(boundary,topZ,bedZ){
    if(!Array.isArray(boundary)||boundary.length<3||![topZ,bedZ].every(Number.isFinite)||topZ<=bedZ)throw Error('A measured perimeter and a valid first surface height are required for the perimeter-only model.');
    const loop=boundary.filter((point,index,array)=>index===0||distance(point,array[index-1])>.001);
    if(loop.length>1&&distance(loop[0],loop.at(-1))<.001)loop.pop();
    if(loop.length<3)throw Error('The measured perimeter has too few unique contacts to build the perimeter-only model.');
    const edges=loop.map((_point,index)=>[index,(index+1)%loop.length]);
    const cells=cdt2d(loop.map(point=>[point.x,point.y]),edges,{exterior:false});
    const top=loop.map(point=>({x:point.x,y:point.y,z:topZ})),bottom=loop.map(point=>({x:point.x,y:point.y,z:bedZ}));
    const surfaceTriangles=[],bottomTriangles=[],wallTriangles=[];
    for(const cell of cells){let [a,b,c]=cell.map(index=>top[index]);if(Math.abs(cross(a,b,c))<1e-9)continue;if(cross(a,b,c)<0)[b,c]=[c,b];surfaceTriangles.push([a,b,c]);}
    for(const cell of cells){let [a,b,c]=cell.map(index=>bottom[index]);if(Math.abs(cross(a,b,c))<1e-9)continue;if(cross(a,b,c)>0)[b,c]=[c,b];bottomTriangles.push([a,b,c]);}
    const ccw=loop.reduce((sum,p,index)=>sum+p.x*loop[(index+1)%loop.length].y-loop[(index+1)%loop.length].x*p.y,0)>0;
    for(let index=0;index<loop.length;index++){
        const next=(index+1)%loop.length;
        const faces=[[top[index],bottom[next],bottom[index]],[top[index],top[next],bottom[next]]];
        wallTriangles.push(...(ccw?faces:faces.map(([a,b,c])=>[a,c,b])));
    }
    const triangles=[...surfaceTriangles,...wallTriangles,...bottomTriangles];
    if(!surfaceTriangles.length)throw Error('The measured perimeter could not be triangulated.');
    return {points:[...top,...bottom],measuredPoints:loop,bedZ,triangles,surfaceTriangles,wallTriangles,bottomTriangles,closed:true};
}
export function polygonMeshStl(mesh){
    const reference=mesh.bedZ,fmt=n=>Number(n.toFixed(6)).toString();
    const lines=['solid polygon_measured_surface_mm_z_relative_to_bed'];
    for(const tri of mesh.triangles){const [a,b,c]=tri.map(p=>[p.x,p.y,p.z-reference]);const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n);if(!len)continue;lines.push(`  facet normal ${n.map(x=>fmt(x/len)).join(' ')}`,'    outer loop',...([a,b,c].map(p=>`      vertex ${p.map(fmt).join(' ')}`)),'    endloop','  endfacet');}
    lines.push('endsolid polygon_measured_surface_mm_z_relative_to_bed');return lines.join('\n')+'\n';
}
