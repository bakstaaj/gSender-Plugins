// Detect likely recessed readings only after nearby surface measurements exist.
export function recessCandidates(points,{bedZ,spacing,diameter}){
    if(!Number.isFinite(bedZ)||!(spacing>0)||!(diameter>0))throw Error('Valid bed and sampling settings are required.');
    const range=Math.max(spacing*4,diameter*5),bins=new Map(),key=(x,y)=>`${x},${y}`;
    for(const p of points){const x=Math.floor(p.x/range),y=Math.floor(p.y/range),k=key(x,y);if(!bins.has(k))bins.set(k,[]);bins.get(k).push(p);}
    const result=[];
    for(const p of points){
        const x=Math.floor(p.x/range),y=Math.floor(p.y/range),neighbors=[];
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)for(const q of bins.get(key(x+dx,y+dy))??[]){if(q!==p&&Math.hypot(q.x-p.x,q.y-p.y)<=range&&Number.isFinite(q.z))neighbors.push(q.z);}
        if(neighbors.length<3)continue;neighbors.sort((a,b)=>a-b);
        const reference=neighbors[Math.floor((neighbors.length-1)*.8)];
        if(reference>bedZ+.1&&p.z-bedZ < (reference-bedZ)*.9-.02)result.push({point:p,reference});
    }
    return result.sort((a,b)=>a.point.z-b.point.z);
}
