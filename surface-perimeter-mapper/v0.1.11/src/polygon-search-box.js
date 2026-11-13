// Box is centered on WPOS zero; the entered offset is WPOS zero relative
// to the approximate model center. Leave room for a side probe and tip.
export function simulatedOriginOffset(originMpos, limits) {
    if (!originMpos?.slice(0,2).every(Number.isFinite) || ![limits?.x?.min,limits?.x?.max,limits?.y?.min,limits?.y?.max].every(Number.isFinite)) throw new Error('Cannot determine the simulated part center.');
    return {x:originMpos[0]-(limits.x.min+limits.x.max)/2,y:originMpos[1]-(limits.y.min+limits.y.max)/2};
}
export function polygonSearchBox({ width, height, offsetX, offsetY, step, clearance, radius, releaseLimit, approachMargin }) {
    const values=[width,height,offsetX,offsetY,step,clearance,radius,releaseLimit,approachMargin];
    if (!values.every(Number.isFinite) || width<=0 || height<=0 || step<=0 || clearance<=0 || radius<=0 || releaseLimit<=0 || approachMargin<0) return null;
    const margin=Math.max(radius+approachMargin,step+clearance+radius,releaseLimit+radius);
    // Round up, never inward; the box is displayed at 0.1 mm precision.
    const up=value=>Math.ceil((value-1e-9)*10)/10;
    return {width:up(width+2*(Math.abs(offsetX)+margin)),height:up(height+2*(Math.abs(offsetY)+margin)),margin};
}
