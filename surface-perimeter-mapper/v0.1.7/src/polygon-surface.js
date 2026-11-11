import ClipperLib from 'clipper-lib';

// Simulator-only conservative interior sampling of a simple, candidate
// polygon formed by raw probe-center contacts. This is not a validated
// radius-compensated perimeter or a physical-machine motion planner.
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
function edgeDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);}
function inside(p,poly){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++) {const a=poly[j],b=poly[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)result=!result;}return result;}
function cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
function intersects(a,b,c,d){const e=1e-8,ab1=cross(a,b,c),ab2=cross(a,b,d),cd1=cross(c,d,a),cd2=cross(c,d,b);if(ab1*ab2 < -e && cd1*cd2 < -e)return true;
    const on=(p,q,v)=>Math.abs(cross(p,q,v))<e&&v.x>=Math.min(p.x,q.x)-e&&v.x<=Math.max(p.x,q.x)+e&&v.y>=Math.min(p.y,q.y)-e&&v.y<=Math.max(p.y,q.y)+e;
    return on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
export function planPolygonSurface(raw,{diameter,spacing,maxSamples=12000}){
    if(!Array.isArray(raw)||!Number.isFinite(diameter)||diameter<=0||!Number.isFinite(spacing)||spacing<=0)throw new Error('Valid polygon contacts, probe diameter and sampling spacing are required.');
    const polygon=[];for(const p of raw){if(!Number.isFinite(p.x)||!Number.isFinite(p.y))throw new Error('Polygon contains an invalid contact.');if(!polygon.length||distance(p,polygon[polygon.length-1])>.02)polygon.push({x:p.x,y:p.y});}
    if(polygon.length>1&&distance(polygon[0],polygon[polygon.length-1])<=.02)polygon.pop();
    if(polygon.length<3)throw new Error('Not enough distinct polygon contacts for a surface scan.');
    for(let i=0;i<polygon.length;i++)for(let j=i+2;j<polygon.length;j++){
        if(i===0&&j===polygon.length-1)continue;
        if(intersects(polygon[i],polygon[(i+1)%polygon.length],polygon[j],polygon[(j+1)%polygon.length]))throw new Error('The candidate polygon crosses or retraces itself; no surface scan was started.');
    }
    const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y);
    const span=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    if(span/spacing>maxSamples)throw new Error('Polygon surface passes are too large; increase spacing.');
    const samples=[],rings=[];
    // Raw probe centers sit about 0.5D outside the part edge. Start the probe
    // path about 0.25D inside the real edge, so inset the raw trace by 0.75D.
    // Discrete contacts can still approximate curves.
    const clearance=diameter*0.75,scale=100000;
    const path=polygon.map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)}));
    if(!ClipperLib.Clipper.Orientation(path))path.reverse();
    const offsetter=new ClipperLib.ClipperOffset(2,0.01*scale);
    offsetter.AddPath(path,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
    // Compute each inset from the original outline, so narrow necks can split
    // into separate loops rather than creating a shortcut across open space.
    for(let pass=0;pass<=Math.ceil(span/spacing);pass++){
        const inset=clearance+pass*spacing+0.005,paths=new ClipperLib.Paths();
        offsetter.Execute(paths,-inset*scale);
        if(!paths.length)break;
        for(const loop of paths){
            const vertices=loop.map(p=>({x:p.X/scale,y:p.Y/scale}));
            const lengths=vertices.map((p,i)=>distance(p,vertices[(i+1)%vertices.length]));
            const perimeter=lengths.reduce((a,b)=>a+b,0);
            if(perimeter<0.01)continue;
            const count=Math.max(1,Math.ceil(perimeter/spacing));
            if(samples.length+count>maxSamples)throw new Error('Polygon surface scan exceeds the sample limit. Increase spacing.');
            const ring=[];let edgeIndex=0,edgeStart=0;
            for(let i=0;i<count;i++){
                const along=perimeter*i/count;
                while(edgeIndex<lengths.length-1&&edgeStart+lengths[edgeIndex]<along){edgeStart+=lengths[edgeIndex];edgeIndex++;}
                const a=vertices[edgeIndex],b=vertices[(edgeIndex+1)%vertices.length],t=lengths[edgeIndex]?(along-edgeStart)/lengths[edgeIndex]:0;
                const p={x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};
                const edge=Math.min(...polygon.map((a,j)=>edgeDistance(p,a,polygon[(j+1)%polygon.length])));
                if(!inside(p,polygon)||edge<clearance-0.02)throw new Error('An inset surface pass could not be kept inside the candidate outline.');
                ring.push({...p,edgeDistance:edge,pass});
            }
            // Start each loop at its closest point to the preceding one.
            if(samples.length){const last=samples[samples.length-1];let nearest=0;for(let i=1;i<ring.length;i++)if(distance(last,ring[i])<distance(last,ring[nearest]))nearest=i;ring.push(...ring.splice(0,nearest));}
            rings.push(ring);samples.push(...ring);
        }
    }
    if(!samples.length)throw new Error('No polygon surface points fit inside the candidate outline with probe clearance.');
    if(samples.length>maxSamples)throw new Error('Polygon surface scan exceeds the sample limit. Increase spacing.');
    return {polygon,samples,clearance,rings};
}
