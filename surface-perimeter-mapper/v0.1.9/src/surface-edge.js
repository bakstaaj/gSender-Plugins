// Find the first point on the center-to-boundary ray whose probe center is
// at least one tip radius inside the measured polygon, including at corners.
export function insetPolygonBoundary(boundary, polygon, clearance, center = { x: 0, y: 0 }) {
    if (!Array.isArray(polygon) || polygon.length < 3 || !Number.isFinite(clearance) || clearance <= 0) {
        throw new Error('A measured boundary and positive probe radius are required for the first surface pass.');
    }
    function safeAt(t) {
        const x = boundary.x + (center.x - boundary.x) * t;
        const y = boundary.y + (center.y - boundary.y) * t;
        let inside = false;
        let minDistanceSquared = Infinity;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const a = polygon[j], b = polygon[i];
            if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
            const dx = b.x - a.x, dy = b.y - a.y;
            const lengthSquared = dx * dx + dy * dy;
            const u = lengthSquared ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared)) : 0;
            minDistanceSquared = Math.min(minDistanceSquared, (x - a.x - u * dx) ** 2 + (y - a.y - u * dy) ** 2);
        }
        return inside && minDistanceSquared >= clearance * clearance;
    }
    if (!safeAt(1)) throw new Error('The part center does not provide 0.5D clearance inside the measured perimeter.');
    let lo = 0, hi = 1;
    for (let i = 0; i < 35; i += 1) {
        const mid = (lo + hi) / 2;
        if (safeAt(mid)) hi = mid;
        else lo = mid;
    }
    return { x: boundary.x + (center.x - boundary.x) * hi, y: boundary.y + (center.y - boundary.y) * hi };
}

// A right triangle's bounding-box center can lie on its hypotenuse. Use the
// measured polygon's area centroid as the radial origin for surface planning.
export function polygonAreaCentroid(polygon) {
    let crossSum = 0, xSum = 0, ySum = 0;
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const cross = a.x * b.y - b.x * a.y;
        crossSum += cross;
        xSum += (a.x + b.x) * cross;
        ySum += (a.y + b.y) * cross;
    }
    if (Math.abs(crossSum) < 1e-8) throw new Error('The measured perimeter does not enclose enough area for a surface scan.');
    return { x: xSum / (3 * crossSum), y: ySum / (3 * crossSum) };
}
