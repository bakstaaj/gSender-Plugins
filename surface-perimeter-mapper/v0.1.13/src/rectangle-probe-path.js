// The first probe on a new face is half a tip diameter along that face from
// the most recent confirmed incoming-face probe center.
export function cornerApproachFromContact(approach, contactWpos, nextSide, radius) {
    const tangentBySide = { front: [1, 0], right: [0, 1], rear: [-1, 0], left: [0, -1] };
    const tangent = tangentBySide[nextSide];
    if (!tangent || !contactWpos?.slice(0, 2).every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0) {
        throw new Error('Cannot position the next rectangle face without a valid previous contact and probe diameter.');
    }
    const result = approach.slice();
    const axis = tangent[0] ? 0 : 1;
    result[axis] = contactWpos[axis] + tangent[axis] * radius;
    return result;
}
