// Geometry for the proposed front-bed work origin. Coordinates are WPOS,
// with the probe reference point on the exposed bed at X0 Y0 Z0.
export function createFrontBedFrame({width,height,diameter,maxThickness,margin,frontContactY}) {
    if (![width,height,diameter,maxThickness,margin,frontContactY].every(Number.isFinite)
        || width<=0 || height<=0 || diameter<=0 || maxThickness<=0 || margin<0)
        throw new Error('Valid part dimensions, probe diameter, clearance and measured front contact are required.');
    const radius=diameter/2;
    // A +Y side touch reports the ball center, one radius in front of the
    // face for an axis-normal contact. This is only a center estimate for an
    // irregular or angled face, not a confirmed geometric measurement.
    const frontEdgeY=frontContactY+radius;
    if (frontContactY < -0.001) throw new Error('The measured front contact is behind the bed origin.');
    return {
        origin:[0,0,0],
        frontContactY,
        frontEdgeY,
        approximateCenter:[0,frontEdgeY+height/2],
        bounds:{minX:-width/2-margin,maxX:width/2+margin,minY:-margin,maxY:frontEdgeY+height+margin},
        perimeterClearanceZ:maxThickness*1.1
    };
}
