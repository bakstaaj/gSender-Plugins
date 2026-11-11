// Decision helpers only. The bed reference and motion adapter must be
// independently verified before these values are used to move a machine.
export function originTouchAssessment({bedZ,contactZ,minThickness,homeDirection}) {
    if (![bedZ,contactZ,minThickness,homeDirection].every(Number.isFinite) || minThickness<=0 || Math.abs(homeDirection)!==1)
        throw new Error('A valid bed reference, minimum thickness, contact and Z direction are required.');
    const height=(contactZ-bedZ)*homeDirection,threshold=minThickness*0.9;
    return {height,threshold,accepted:height>=threshold};
}
export function originSearchClearance({bedZ,maxThickness,diameter,homeDirection}) {
    if (![bedZ,maxThickness,diameter,homeDirection].every(Number.isFinite) || maxThickness<=0 || diameter<=0 || Math.abs(homeDirection)!==1)
        throw new Error('Valid bed height, maximum thickness, probe diameter and Z direction are required.');
    return bedZ+homeDirection*(maxThickness+0.75*diameter);
}
export function nextOriginSearchY(currentY,frontLimitY) {
    if (![currentY,frontLimitY].every(Number.isFinite)) throw new Error('A valid Y position and search boundary are required.');
    const next=currentY-5;
    if(next<frontLimitY-1e-6)throw new Error('Origin search reached its allowed front boundary.');
    return next;
}
