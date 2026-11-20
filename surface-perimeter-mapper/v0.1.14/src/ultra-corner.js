// Plan intermediate probes between the last two confirmed probe centers.
// Inputs must be in contour order; the two outward vectors point away from
// the material at the confirmed contacts.
export function sampleUltraCorner(b,c,t) {
    const v=[c.center[0]-b.center[0],c.center[1]-b.center[1]],lv=Math.hypot(...v);
    const opposed=b.outward[0]*c.outward[0]+b.outward[1]*c.outward[1]<-0.7;
    let bend=[v[1]/lv,-v[0]/lv];
    const middle=[(b.center[0]+c.center[0])/2,(b.center[1]+c.center[1])/2];
    if(bend[0]*middle[0]+bend[1]*middle[1]<0)bend=bend.map(x=>-x);
    const weight=opposed?4*t*(1-t)*1.5:0,n=[b.outward[0]*(1-t)+c.outward[0]*t+bend[0]*weight,b.outward[1]*(1-t)+c.outward[1]*t+bend[1]*weight],length=Math.hypot(...n);
    if(length<0.1)throw Error('Ultra precise cannot determine a safe approach around this corner.');
    return {t,center:[b.center[0]+v[0]*t,b.center[1]+v[1]*t],outward:[n[0]/length,n[1]/length]};
}
export function planUltraCorner(history, diameter) {
    if(!Number.isFinite(diameter)||diameter<=0)throw Error('Ultra precise requires a positive probe diameter.');
    if(history.length<3)return null;
    const [a,b,c]=history.slice(-3),u=[b.center[0]-a.center[0],b.center[1]-a.center[1]],v=[c.center[0]-b.center[0],c.center[1]-b.center[1]];
    const lu=Math.hypot(...u),lv=Math.hypot(...v);
    if(lu<diameter*.1||lv<diameter*.1)return null;
    const degrees=Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(lu*lv))))*180/Math.PI;
    if(degrees<=45+1e-7)return null;
    // Projected chords can expand on a sharp corner. Start at 0.25D, then
    // verify actual measured spacing and subdivide any remaining large gaps.
    const steps=Math.ceil(lv/(diameter*.25)),samples=[];
    if(steps>1000)throw Error('Ultra precise corner exceeds the 1,000-probe limit.');
    for(let i=1;i<steps;i++)samples.push(sampleUltraCorner(b,c,i/steps));
    return {degrees,previous:b,current:c,spacing:lv/steps,samples};
}
