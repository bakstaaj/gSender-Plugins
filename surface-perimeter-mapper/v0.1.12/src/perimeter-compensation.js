import ClipperLib from 'clipper-lib';
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function crossing(a,b,c,d){return cross(a,b,c)*cross(a,b,d)<-1e-9&&cross(c,d,a)*cross(c,d,b)<-1e-9;}
// The probe-center contour is outside an outer wall and inside a recess wall.
// Estimate the local wall normal from adjacent measured contacts; this also
// avoids assuming that the command's approach vector was surface-normal.
export function compensateContour(points,radius,{recess=false}={}){
    if(!Array.isArray(points)||!Number.isFinite(radius)||radius<=0)throw Error('A positive probe radius and perimeter contacts are required.');
    const p=[];for(const item of points){if(!Number.isFinite(item.x)||!Number.isFinite(item.y))throw Error('Invalid perimeter contact.');if(!p.length||dist(item,p.at(-1))>.02)p.push(item);}
    if(p.length>1&&dist(p[0],p.at(-1))<=.02)p.pop();
    if(p.length<3)throw Error('Not enough distinct contacts for probe-radius compensation.');
    const area=p.reduce((s,a,i)=>{const b=p[(i+1)%p.length];return s+a.x*b.y-b.x*a.y;},0);
    if(Math.abs(area)<1e-6)throw Error('Perimeter has no usable enclosed area.');
    const scale=100000,path=p.map(q=>({X:Math.round(q.x*scale),Y:Math.round(q.y*scale)}));
    if(!ClipperLib.Clipper.Orientation(path))path.reverse();
    const offsetter=new ClipperLib.ClipperOffset(2,.005*scale),paths=new ClipperLib.Paths();
    offsetter.AddPath(path,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);
    offsetter.Execute(paths,(recess?radius:-radius)*scale);
    if(paths.length!==1||paths[0].length<3)throw Error('Probe-radius compensation split or erased the outline; raw readings were retained.');
    const result=[];for(const v of paths[0]){const x=v.X/scale,y=v.Y/scale,q=p.reduce((best,candidate)=>Math.hypot(candidate.x-x,candidate.y-y)<Math.hypot(best.x-x,best.y-y)?candidate:best,p[0]);const dx=x-q.x,dy=y-q.y,n=Math.hypot(dx,dy),normal=n?[dx/n,dy/n]:[0,0],approach=q.approach,alen=Array.isArray(approach)?Math.hypot(...approach):0,angle=alen&&n?Math.acos(Math.min(1,Math.abs((approach[0]*normal[0]+approach[1]*normal[1])/alen)))*180/Math.PI:null,point={...q,rawX:q.x,rawY:q.y,x,y,estimatedNormal:normal,approachAngle:angle,compensated:true};if(!result.length||dist(point,result.at(-1))>.002)result.push(point);}
    if(result.length>1&&dist(result[0],result.at(-1))<=.002)result.pop();
    for(let i=0;i<result.length;i++)for(let j=i+2;j<result.length;j++){if(i===0&&j===result.length-1)continue;if(crossing(result[i],result[(i+1)%result.length],result[j],result[(j+1)%result.length]))throw Error('Compensated perimeter crosses itself; no corrected mesh was exported.');}
    return result.map((q,i)=>({...q,index:i+1}));
}
