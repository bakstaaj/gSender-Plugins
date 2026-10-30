const NUMBER = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const AXIS_WORD = new RegExp(`([XYZ])\\s*(${NUMBER})`, 'gi');
const ARC_IJ = new RegExp(`([IJ])\\s*(${NUMBER})`, 'gi');

export function analyzeNc(text) {
  let x = 0, y = 0, z = 0;
  let absolute = true, arcCenterAbsolute = false, units = 1, motion = null, cycle = null, cycleR = 0, cycleZ = 0;
  let knownX = false, knownY = false;
  const points = [];
  const cuttingZ = [];
  const holeFeatures = new Map();
  let commandedHoleDiameter = null, toolDiameter = null;
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const add = (px, py, pz, draw = false) => {
    if (!knownX || !knownY) return;
    points.push({ x: px, y: py, z: pz, draw });
    bounds.minX = Math.min(bounds.minX, px); bounds.maxX = Math.max(bounds.maxX, px);
    bounds.minY = Math.min(bounds.minY, py); bounds.maxY = Math.max(bounds.maxY, py);
    bounds.minZ = Math.min(bounds.minZ, pz); bounds.maxZ = Math.max(bounds.maxZ, pz);
  };
  const word = (line, letter) => {
    const match = line.match(new RegExp(`\\b${letter}\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:E[-+]?\\d+)?)`, 'i'));
    return match ? Number(match[1]) * units : null;
  };
  const lineMove = (nx, ny, nz, draw) => {
    if (draw && points.length === 0) add(x, y, z, false);
    // Record only descending feed moves and feed moves across the part. G0
    // retracts and feed retracts must not enlarge the planned cut envelope.
    if (draw && nz < z - 1e-9) add(x, y, z, true);
    if (draw && nz < z - 1e-9) cuttingZ.push(nz);
    else if (draw && Math.abs(nz-z) <= 1e-9 && (nx !== x || ny !== y)) cuttingZ.push(nz);
    add(nx, ny, nz, draw);
    x = nx; y = ny; z = nz;
  };
  for (const raw of text.split(/\r?\n/)) {
    const holeComment = raw.match(/\(\s*HOLE\s+DRILL\s+([-+]?(?:\d+\.?\d*|\.\d+))\s*MM\s*\)/i);
    const toolComment = raw.match(/\(\s*T\d+\s*:\s*([-+]?(?:\d+\.?\d*|\.\d+))\s*\)/i);
    if (holeComment) commandedHoleDiameter = Number(holeComment[1]) * units;
    if (toolComment) toolDiameter = Number(toolComment[1]) * units;
    const line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').toUpperCase();
    const gCodes = [...line.matchAll(/\bG\s*(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
    for (const g of gCodes) {
      if (g === 20) units = 25.4;
      else if (g === 21) units = 1;
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 90.1) arcCenterAbsolute = true;
      else if (g === 91.1) arcCenterAbsolute = false;
      else if ([0,1,2,3].includes(g)) motion = g;
      else if ([73,81,82,83].includes(g)) cycle = g;
      else if (g === 80) cycle = null;
    }
    if (/\bG\s*(?:28|30|53)\b/.test(line)) continue;
    const words = new Map([...line.matchAll(AXIS_WORD)].map(m => [m[1], Number(m[2]) * units]));
    if (!words.size) continue;
    if (words.has('X')) knownX = true;
    if (words.has('Y')) knownY = true;
    const nx = words.has('X') ? absolute ? words.get('X') : x + words.get('X') : x;
    const ny = words.has('Y') ? absolute ? words.get('Y') : y + words.get('Y') : y;
    const nz = words.has('Z') ? absolute ? words.get('Z') : z + words.get('Z') : z;
    if (cycle !== null) {
      const rv = word(line, 'R'), zv = word(line, 'Z');
      if (rv !== null) cycleR = absolute ? rv : z + rv;
      if (zv !== null) cycleZ = absolute ? zv : z + zv;
      if (words.has('X') || words.has('Y')) {
        lineMove(nx, ny, cycleR, false);
        lineMove(nx, ny, cycleZ, true);
        lineMove(nx, ny, cycleR, false);
      }
      continue;
    }
    if (motion === null) continue;
    if (motion === 2 || motion === 3) {
      const ij = new Map([...line.matchAll(ARC_IJ)].map(m => [m[1], Number(m[2]) * units]));
      if (ij.has('I') && ij.has('J')) {
        const cx = arcCenterAbsolute ? ij.get('I') : x + ij.get('I'), cy = arcCenterAbsolute ? ij.get('J') : y + ij.get('J');
        const start = Math.atan2(y - cy, x - cx), end = Math.atan2(ny - cy, nx - cx);
        const cw = motion === 2;
        let sweep = end - start;
        if (cw && sweep >= 0) sweep -= 2 * Math.PI;
        if (!cw && sweep <= 0) sweep += 2 * Math.PI;
        const radius = Math.hypot(x - cx, y - cy);
        if (radius > 0.05) {
          const diameter = commandedHoleDiameter || (toolDiameter ? 2 * radius + toolDiameter : 2 * radius);
          const feature = { x: cx, y: cy, diameter };
          const key = `${Math.round(cx * 100)}:${Math.round(cy * 100)}:${Math.round(diameter * 100)}`;
          holeFeatures.set(key, feature);
        }
        const segments = Math.max(8, Math.ceil(Math.abs(sweep) * radius / 1));
        if (points.length === 0) add(x, y, z, false);
        for (let i = 1; i <= segments; i++) {
          const t = i / segments, a = start + sweep * t;
          add(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z + (nz - z) * t, true);
          if (nz <= z + 1e-9) cuttingZ.push(z + (nz - z) * t);
        }
        x = nx; y = ny; z = nz;
        continue;
      }
    }
    lineMove(nx, ny, nz, motion !== 0);
  }
  if (!points.length || !Number.isFinite(bounds.minX)) throw new Error('No absolute or incremental X/Y/Z motion was found in the selected NC file.');
  const cutMinZ = cuttingZ.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const cutMaxZ = cuttingZ.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const hasCutZ = Number.isFinite(cutMinZ) && Number.isFinite(cutMaxZ);
  // For a conventional top-at-Z0 file, the stock surface is the top of the
  // cutting envelope even if no feed move ends exactly at Z0. For CAMLab's
  // positive-down output, report the span of positive cutting coordinates.
  const zEnvelope = !hasCutZ ? 0 : cutMinZ < -1e-6 ? Math.abs(cutMinZ) : cutMaxZ - cutMinZ;
  return { bounds, points, holes: [...holeFeatures.values()], width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY, depth: zEnvelope, depthBasis: 'cut-moves-only', motionDepth: bounds.maxZ - bounds.minZ, centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2, displayUnits: units === 25.4 ? 'in' : 'mm' };
}

const fractionalTools = [
  ['1/32',1/32],['3/64',3/64],['1/16',1/16],['5/64',5/64],['3/32',3/32],['7/64',7/64],
  ['1/8',1/8],['9/64',9/64],['5/32',5/32],['11/64',11/64],['3/16',3/16],['13/64',13/64],
  ['7/32',7/32],['1/4',1/4],['5/16',5/16],['3/8',3/8]
];
export const DEFAULT_TOOLS = [
  ...[0.8,1,1.5,2,2.5,3,4,5,6,8].map(diameter=>({name:`${diameter} mm end mill`,type:'endMill',diameter,unit:'mm'})),
  ...[['1/32',1/32],['1/16',1/16],['3/32',3/32],['1/8',1/8],['5/32',5/32],['3/16',3/16],['1/4',1/4],['5/16',5/16],['3/8',3/8]].map(([size,diameter])=>({name:`${size} in end mill`,type:'endMill',diameter,unit:'in'})),
  ...[0.5,0.8,1,1.5,2,2.5,3,3.2,3.5,4,4.5,5,5.5,6,6.5,8,10].map(diameter=>({name:`${diameter} mm drill`,type:'drill',diameter,unit:'mm'})),
  ...fractionalTools.map(([size,diameter])=>({name:`${size} in drill`,type:'drill',diameter,unit:'in'}))
];

export function toolDiameterMm(tool) {
  if (tool?.diameterMm != null) return Number(tool.diameterMm);
  const diameter=Number(tool?.diameter);
  return tool?.unit==='in' ? diameter*25.4 : diameter;
}

export function recommendTool(colletMm, featureMm, tools = DEFAULT_TOOLS) {
  const max=Math.min(Number(colletMm),Number(featureMm));
  return tools.map(tool=>({...tool,diameterMm:toolDiameterMm(tool)}))
    .filter(tool=>tool.type==='endMill' && Number.isFinite(tool.diameterMm) && tool.diameterMm>0 && tool.diameterMm<=max+1e-6)
    .sort((a,b)=>b.diameterMm-a.diameterMm)[0] || null;
}

export const M5_BOLT_HEAD_POCKET = { diameter: 10, depth: 2.25 };

export function methodXYMargins(strategy, fixture, edgeMargin, toolDiameter) {
  const edge = Number(edgeMargin), tool = Number(toolDiameter);
  const edgeClearance = Number.isFinite(edge) ? edge : 0;
  const cutterClearance = Number.isFinite(tool) ? tool : 0;
  const kind = ({bottomSurface:'bottomSurface',perimeterSurface:'perimeterSurface',topSurface:'topSurface',fastening:'fastening',fixture:'fixture',clamps:'perimeterSurface',holes:'fastening',vise:'fixture'})[strategy] || strategy;
  if (kind === 'bottomSurface') return { x: 0, y: 0 };
  if (kind === 'topSurface') {
    const overlap = Math.max(0, ...(fixture?.clamps || []).map(clamp => Number(clamp.overlap)).filter(Number.isFinite));
    const clearance = cutterClearance + overlap + edgeClearance;
    return { x: clearance, y: clearance };
  }
  if (kind === 'fastening') return { x: cutterClearance + edgeClearance, y: 0 };
  return { x: cutterClearance + edgeClearance, y: cutterClearance + edgeClearance };
}

function marginAxes(margin) {
  if (margin && typeof margin === 'object') return { x: Number(margin.x) || 0, y: Number(margin.y) || 0 };
  const value = Number(margin) || 0;
  return { x: value, y: value };
}

export function symmetricMountingLayouts(part, mountingHoles, margin, countersinkDiameter = M5_BOLT_HEAD_POCKET.diameter) {
  const margins = marginAxes(margin);
  const boltSideClearance = Math.max(margins.x, margins.y);
  const holes = (mountingHoles || []).map(h => ({ x:Number(h.x), y:Number(h.y), diameter:Number(h.diameter), name:h.name || '' }))
    .filter(h => Number.isFinite(h.x) && Number.isFinite(h.y) && Number.isFinite(h.diameter) && h.diameter > 0);
  const layouts = [];
  for (let i=0; i<holes.length; i++) for (let j=i+1; j<holes.length; j++) {
    const a=holes[i], b=holes[j];
    if (Math.abs(a.diameter-b.diameter) > 0.01 || (Math.abs(a.x-b.x) > 0.05 && Math.abs(a.y-b.y) > 0.05)) continue;
    const orientation = Math.abs(a.y-b.y) <= 0.05 ? 'x' : 'y';
    const ordered = orientation === 'x'
      ? (a.x < b.x ? [a,b] : [b,a])
      : (a.y < b.y ? [a,b] : [b,a]);
    const [firstHole,secondHole] = ordered;
    // The hole pair defines the axis with bolt-side tabs and clearance.
    // Keep the part centered locally; absolute plate XY only selects spacing.
    const spacing = orientation === 'x' ? secondHole.x-firstHole.x : secondHole.y-firstHole.y;
    const marginX = orientation === 'x' ? boltSideClearance : 0;
    const marginY = orientation === 'y' ? boltSideClearance : 0;
    const width = orientation === 'x'
      ? spacing+countersinkDiameter+2*marginX
      : Math.max(part.width,countersinkDiameter)+2*marginX;
    const height = orientation === 'y'
      ? spacing+countersinkDiameter+2*marginY
      : Math.max(part.height,countersinkDiameter)+2*marginY;
    if (orientation === 'x' && spacing < part.width+countersinkDiameter+2*marginX) continue;
    if (orientation === 'y' && spacing < part.height+countersinkDiameter+2*marginY) continue;
    const centerX=width/2, centerY=height/2;
    const localFirst = orientation === 'x'
      ? {...firstHole,x:marginX+countersinkDiameter/2,y:centerY}
      : {...firstHole,x:centerX,y:marginY+countersinkDiameter/2};
    const localSecond = orientation === 'x'
      ? {...secondHole,x:localFirst.x+spacing,y:centerY}
      : {...secondHole,x:centerX,y:localFirst.y+spacing};
    const bounds={minX:0,maxX:width,minY:0,maxY:height};
    layouts.push({ holes:[firstHole,secondHole], localHoles:[localFirst,localSecond], centerX, centerY, spacing, bounds,
      width, height, orientation,
      partOffsetX:centerX-part.centerX, partOffsetY:centerY-part.centerY,
      throughDiameter:firstHole.diameter, countersinkDiameter });
  }
  // Prefer a compact local layout. Absolute plate XY values never translate
  // the cutout on the billet.
  return layouts.sort((a,b)=>a.width*a.height-b.width*b.height || a.spacing-b.spacing);
}

function mountingLayoutsForStock(part, fixture, margin, toolDiameter, stock, countersinkDiameter = M5_BOLT_HEAD_POCKET.diameter, roughingOffset = 0) {
  const stockLength=Number(stock?.length ?? stock?.x), stockWidth=Number(stock?.width ?? stock?.y);
  const stockThickness=Number(stock?.thickness ?? stock?.z);
  return symmetricMountingLayouts(part, fixture?.holes, margin, countersinkDiameter)
    .sort((a,b)=>(a.width+toolDiameter)*(a.height+toolDiameter)-(b.width+toolDiameter)*(b.height+toolDiameter))
    .filter(layout =>
    layout.width+toolDiameter <= stockLength && layout.height+toolDiameter <= stockWidth &&
    layout.throughDiameter >= toolDiameter && countersinkDiameter > layout.throughDiameter &&
    stockThickness >= part.depth+Number(roughingOffset) && part.depth+Number(roughingOffset) > M5_BOLT_HEAD_POCKET.depth
  );
}

export function mountingLayoutForStock(part, fixture, margin, toolDiameter, stock, countersinkDiameter = M5_BOLT_HEAD_POCKET.diameter, roughingOffset = 0) {
  return mountingLayoutsForStock(part,fixture,margin,toolDiameter,stock,countersinkDiameter,roughingOffset)[0] || null;
}

function normalizePlanStrategy(strategy) {
  return ({bottomSurface:'bottomSurface',perimeterSurface:'clamps',topSurface:'clamps',fastening:'holes',fixture:'vise',clamps:'clamps',holes:'holes',vise:'vise'})[strategy] || strategy;
}

export function chooseStock(part, billets, margin, partThickness, toolDiameter = 0, strategy = 'clamps', fixture = {}, countersinkDiameter = M5_BOLT_HEAD_POCKET.diameter, roughingOffset = 0) {
  const planKind=normalizePlanStrategy(strategy), xyMargins=methodXYMargins(strategy,fixture,margin,toolDiameter);
  const length = b => Number(b.length ?? b.x), width = b => Number(b.width ?? b.y), thick = b => Number(b.thickness ?? b.z);
  if (planKind === 'holes') {
    const candidates = billets.flatMap(billet => mountingLayoutsForStock(part,fixture,xyMargins,toolDiameter,billet,countersinkDiameter,roughingOffset)
      .map(layout => ({ billet, layout, blankVolume:(layout.width+toolDiameter)*(layout.height+toolDiameter)*thick(billet), billetVolume:length(billet)*width(billet)*thick(billet) })));
    return candidates.sort((a,b)=>a.blankVolume-b.blankVolume || a.billetVolume-b.billetVolume)[0]?.billet || null;
  }
  const fits = billets.filter(b => {
    if (thick(b) < partThickness) return false;
    return length(b) >= part.width + 2 * xyMargins.x + toolDiameter && width(b) >= part.height + 2 * xyMargins.y + toolDiameter;
  });
  return fits
    .sort((a, b) => length(a) * width(a) * thick(a) - length(b) * width(b) * thick(b))[0] || null;
}

export function generatePlan({ part, strategy, stock, margin, tool, safeZ, passDepth, feed, plunge, fixture, countersinkDiameter = M5_BOLT_HEAD_POCKET.diameter, roughingOffset = passDepth }) {
  if (!part || !stock || !tool) throw new Error('Load an NC part and choose compatible stock and a cutter first.');
  const planKind=normalizePlanStrategy(strategy), xyMargins=methodXYMargins(strategy,fixture,margin,tool);
  const partThickness=Number(part.depth), stockThickness=Number(stock.thickness ?? stock.z);
  if (![margin, partThickness, stockThickness, tool, safeZ, passDepth, feed, plunge, roughingOffset].every(Number.isFinite) || margin < 0 || partThickness < 0 || stockThickness <= 0 || tool <= 0 || passDepth <= 0 || feed <= 0 || plunge <= 0 || roughingOffset < 0) throw new Error('The NC part envelope, billet, and cutting values must be valid.');
  if (partThickness > stockThickness) throw new Error(`The NC part Z envelope is ${partThickness.toFixed(3)} mm, greater than the selected billet thickness of ${stockThickness.toFixed(3)} mm.`);
  if (planKind === 'clamps' && (!fixture.clamps || !fixture.clamps.length)) throw new Error('Add a clamp inventory item before using clamp workholding.');
  if (planKind === 'vise' && !fixture.vise) throw new Error('Configure vise dimensions before using vise workholding.');
  const mountingLayout = planKind === 'holes' ? mountingLayoutForStock(part,fixture,xyMargins,tool,stock,countersinkDiameter,roughingOffset) : null;
  if (planKind === 'holes' && !mountingLayout) throw new Error('Fastening mode needs a symmetric same-row or same-column pair of bed-plate bolt holes with matching diameters. The selected billet must fit the centered part, two bolt-head pockets, and the selected cutter. Alignment pins are not hold-down points.');
  const radius=Number(tool)/2;
  const partOffsetX = mountingLayout ? radius + mountingLayout.partOffsetX : radius + xyMargins.x - part.bounds.minX;
  const partOffsetY = mountingLayout ? radius + mountingLayout.partOffsetY : radius + xyMargins.y - part.bounds.minY;
  const minX = radius;
  const minY = radius;
  const maxX = mountingLayout ? minX + mountingLayout.width : minX + part.width + 2*xyMargins.x;
  const maxY = mountingLayout ? minY + mountingLayout.height : minY + part.height + 2*xyMargins.y;
  const stockLength = Number(stock.length ?? stock.x), stockWidth = Number(stock.width ?? stock.y);
  const roughStockThickness=partThickness+Number(roughingOffset);
  const cutoutWidth=mountingLayout?mountingLayout.width+Number(tool):part.width+2*xyMargins.x+Number(tool);
  const cutoutHeight=mountingLayout?mountingLayout.height+Number(tool):part.height+2*xyMargins.y+Number(tool);
  const facePocketDepth=Math.max(0,stockThickness-roughStockThickness);
  if (maxX - minX + tool > stockLength || maxY - minY + tool > stockWidth || partThickness > stockThickness) throw new Error('The selected stock does not contain the part envelope, margins, hold-down holes, and cutter-clearance allowance.');
  const lines = [
    '(Stock & Fixture Planner - generated stock preparation)',
    `(Part envelope ${part.width.toFixed(3)} x ${part.height.toFixed(3)} x ${part.depth.toFixed(3)} mm from cutting moves; full NC Z motion ${part.bounds.minZ.toFixed(3)} to ${part.bounds.maxZ.toFixed(3)} mm)`,
    `(Part thickness requirement from NC Z envelope ${partThickness.toFixed(3)} mm; billet thickness ${stockThickness.toFixed(3)} mm)`,
    `(Selected billet ${stock.name}: ${stockLength} x ${stockWidth} x ${stockThickness} mm; material ${stock.material || 'unspecified'})`,
    `(Applied XY clearance per side X${xyMargins.x.toFixed(3)} Y${xyMargins.y.toFixed(3)} mm; estimated outside blank size ${cutoutWidth.toFixed(3)} x ${cutoutHeight.toFixed(3)} mm including cutter diameter.)`,
    `(Workholding method: ${({bottomSurface:'Bottom Surface',perimeterSurface:'Perimeter Surface',topSurface:'Top Surface',fastening:'Fastening',fixture:'Fixture'})[strategy] || strategy}; ${({bottomSurface:'vacuum plate or adhesive/tape hold-down',perimeterSurface:'toe or edge clamp hold-down',topSurface:'strap clamp hold-down',fastening:'bolt, screw, nail, or T-track fastening',fixture:'vise or dedicated hard fixture'})[strategy] || 'verify the fixture setup'})`,
    `(Suggested cutter diameter ${tool.toFixed(3)} mm; verify actual tool and collet compatibility)`,
    '(Planner draft only: coordinates are based on the source file envelope and configured fixture data.)',
    'G21', 'G90', 'G17', 'G94', 'G54', 'M5', `G0 Z${Number(safeZ).toFixed(3)}`
  ];
  if (planKind === 'clamps') lines.push(`(Clamp inventory: ${(fixture.clamps || []).map(c => `${c.name}: width ${c.width ?? c.contactWidth ?? 'unset'} mm, height ${c.height ?? c.maxHeight ?? 'unset'} mm, overlap ${c.overlap ?? 'unset'} mm, reach ${c.minReach ?? 'unset'}-${c.maxReach ?? c.reach ?? 'unset'} mm`).join('; ')})`);
  if (planKind === 'vise') lines.push(`(Vise: ${fixture.vise.name || 'configured vise'} jaw width ${fixture.vise.jawWidth} mm max opening ${fixture.vise.maxOpening} mm jaw height ${fixture.vise.jawHeight} mm)`);
  if (planKind === 'holes') lines.push(`(Set G54 XY zero at the raw billet lower-left corner and Z0 at its top surface; clamp the billet to the table for this cutout.)`, `(Bed plate hole pattern is used only for spacing: ${mountingLayout.spacing.toFixed(3)} mm between symmetric hold-down holes. Billet-local hole centers X${(mountingLayout.localHoles[0].x+radius).toFixed(3)} Y${(mountingLayout.localHoles[0].y+radius).toFixed(3)} and X${(mountingLayout.localHoles[1].x+radius).toFixed(3)} Y${(mountingLayout.localHoles[1].y+radius).toFixed(3)} mm.)`, `(Apply this XY translation to the original part program: X${partOffsetX.toFixed(3)} Y${partOffsetY.toFixed(3)} mm; the cutout layout starts at the billet lower-left.)`);
  else lines.push('(Set G54 XY zero at the raw billet lower-left corner; Z0 at its top surface.)', `(Place the planned blank near the lower-left with the original part-program XY translation X${partOffsetX.toFixed(3)} Y${partOffsetY.toFixed(3)} mm.)`);
  const step = Number(passDepth), safe = Number(safeZ);
  const addHole = (x, y, label, dia, depth, startDepth = 0) => {
    dia = Number(dia); depth = Number(depth); startDepth=Number(startDepth);
    if (![x, y, dia, depth, startDepth].every(Number.isFinite) || dia <= 0 || depth <= 0 || startDepth<0 || dia < Number(tool)) throw new Error(`${label}: hole values must be positive and the selected cutter must fit the hole.`);
    const outerRadius = (dia - Number(tool)) / 2;
    lines.push(`(${label} at center X${x.toFixed(3)} Y${y.toFixed(3)}; target diameter ${dia} mm; depth ${depth} mm below Z-${startDepth.toFixed(3)}; end-mill circular pocket path)`);
    let previous = Math.min(step, depth);
    for (let z = previous; z <= depth + 1e-8; z = Math.min(depth, z + step)) {
      lines.push(`G0 Z${safe}`, `G0 X${x.toFixed(3)} Y${y.toFixed(3)}`, `G1 Z-${(startDepth+z).toFixed(3)} F${plunge}`);
      for (let r = Math.min(Number(tool) / 4, outerRadius); r > 0; r = Math.min(outerRadius, r + Number(tool) / 2)) {
        lines.push(`G1 X${(x+r).toFixed(3)} Y${y.toFixed(3)} F${feed}`, `G2 X${(x+r).toFixed(3)} Y${y.toFixed(3)} I-${r.toFixed(3)} J0`);
        if (r >= outerRadius) break;
      }
      lines.push(`G0 Z${safe}`);
      if (z >= depth) break;
    }
  };
  const addRectangularPocket = (xMin,yMin,xMax,yMax,depth,label) => {
    const left=xMin+radius, right=xMax-radius, bottom=yMin+radius, top=yMax-radius;
    if (depth<=0) return;
    if (right<=left || top<=bottom) throw new Error(`${label}: pocket area must be wider than the selected end mill.`);
    const stepover=Math.max(Number(tool)*0.6,0.1), rows=Math.max(1,Math.ceil((top-bottom)/stepover)), rowStep=(top-bottom)/rows;
    let pass=0;
    for (let z=Math.min(step,depth);z<=depth+1e-8;z=Math.min(depth,z+step)) {
      pass++;
      lines.push(`(${label}; rectangular pocket X${xMin.toFixed(3)} to ${xMax.toFixed(3)} Y${yMin.toFixed(3)} to ${yMax.toFixed(3)}; Z-${z.toFixed(3)} from original billet top)`, `G0 Z${safe}`, `G0 X${left.toFixed(3)} Y${bottom.toFixed(3)}`, `G1 Z-${z.toFixed(3)} F${plunge}`);
      for (let row=0;row<=rows;row++) {
        const yy=bottom+rowStep*row, startX=row%2?right:left, endX=row%2?left:right;
        if (row>0) lines.push(`G1 Y${yy.toFixed(3)} F${feed}`);
        lines.push(`G1 X${endX.toFixed(3)} Y${yy.toFixed(3)} F${feed}`);
      }
      lines.push(`G0 Z${safe}`);
      if (z>=depth) break;
    }
  };
  if (planKind === 'holes') lines.push(`(Use selected ${Number(tool).toFixed(3)} mm end mill for rectangular roughing pocket, mounting holes, counterbores, and blank profile)`, '(Install selected end mill)', 'M0 (Install selected end mill)');
  lines.push(`(Part-area roughing target: ${roughStockThickness.toFixed(3)} mm remaining; part depth ${partThickness.toFixed(3)} mm plus ${Number(roughingOffset).toFixed(3)} mm offset.)`);
  if(facePocketDepth>0) {
    lines.push(`(Rough the planned part area to ${roughStockThickness.toFixed(3)} mm remaining. Pocket depth ${facePocketDepth.toFixed(3)} mm from the original billet top; set the part program Z0 on this prepared surface.)`);
    addRectangularPocket(minX,minY,maxX,maxY,facePocketDepth,'Part-area thickness roughing pocket');
  } else lines.push(`(Billet is already at or below the rough thickness target ${roughStockThickness.toFixed(3)} mm; no part-area pocket is required.)`);
  const addTabbedPerimeter = (outline,depth,tabWidth=6,tabThickness=2,boltOrientation=null) => {
    const [leftBottom,rightBottom,rightTop,leftTop]=outline;
    const [left,bottom]=leftBottom, [right]=rightBottom, [,top]=rightTop;
    const horizontal=boltOrientation ? boltOrientation === 'y' : right-left>=top-bottom;
    const tabCenter=horizontal?(left+right)/2:(bottom+top)/2;
    const tabStart=tabCenter-tabWidth/2, tabEnd=tabCenter+tabWidth/2;
    if ((horizontal?right-left:top-bottom)<=tabWidth+2*radius || tabThickness<=0 || tabThickness>=depth) throw new Error('The blank perimeter is too small for two safe holding tabs on the selected sides.');
    const maxTabCut=depth-tabThickness;
    let pass=0;
    for (let z=Math.min(step,depth);z<=depth+1e-8;z=Math.min(depth,z+step)) {
      pass++;
      const leaveTabs=z>maxTabCut+1e-8;
      lines.push(`(Outside profile pass ${pass}; cut to Z-${z.toFixed(3)}${leaveTabs?'; preserve two tabs':''})`);
      if (!leaveTabs) {
        lines.push(`G0 Z${safe}`,`G0 X${left.toFixed(3)} Y${bottom.toFixed(3)}`,`G1 Z-${z.toFixed(3)} F${plunge}`);
        for (const [x,y] of [rightBottom,rightTop,leftTop,leftBottom]) lines.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${feed}`);
        lines.push(`G0 Z${safe}`);
      } else {
        let segments;
        if (horizontal) segments=[[[left,bottom],[tabStart,bottom]],[[tabEnd,bottom],[right,bottom]],[rightBottom,rightTop],[[right,top],[tabEnd,top]],[[tabStart,top],[left,top]],[leftTop,leftBottom]];
        else segments=[[[left,bottom],[right,bottom]],[[right,bottom],[right,tabStart]],[[right,tabEnd],[right,top]],[[right,top],[left,top]],[[left,top],[left,tabEnd]],[[left,tabStart],[left,bottom]]];
        for (const [start,end] of segments) lines.push(`G0 Z${safe}`,`G0 X${start[0].toFixed(3)} Y${start[1].toFixed(3)}`,`G1 Z-${z.toFixed(3)} F${plunge}`,`G1 X${end[0].toFixed(3)} Y${end[1].toFixed(3)} F${feed}`,`G0 Z${safe}`);
      }
      if (z>=depth) break;
    }
  };
  if (planKind === 'holes') {
    const throughDiameter=mountingLayout.throughDiameter;
    const headPocketDepth=M5_BOLT_HEAD_POCKET.depth;
    if (countersinkDiameter <= throughDiameter || countersinkDiameter < Number(tool) || headPocketDepth >= roughStockThickness) throw new Error('The bolt-head counterbore must fit below the rough-pocket floor and within the remaining blank thickness.');
    for (const h of mountingLayout.localHoles) addHole(h.x+radius,h.y+radius,'M5 mounting bolt through-hole matching the bed-plate hole',throughDiameter,roughStockThickness,facePocketDepth);
    lines.push(`(Flat-bottom bolt-head counterbores: ${countersinkDiameter.toFixed(3)} mm diameter; ${headPocketDepth.toFixed(3)} mm deep below the rough-pocket floor.)`);
    for (const h of mountingLayout.localHoles) addHole(h.x+radius,h.y+radius,'M5 bolt-head flat-bottom counterbore',countersinkDiameter,headPocketDepth,facePocketDepth);
  } else if (planKind === 'vise') {
    lines.push(`(Vise billet thickness roughing target: ${roughStockThickness.toFixed(3)} mm remaining; pocket depth ${facePocketDepth.toFixed(3)} mm from original billet top.)`);
    const marks = fixture.viseMarks || [];
    for (const mark of marks) {
      const [x1,y1,x2,y2,d] = [mark.x1,mark.y1,mark.x2,mark.y2,mark.depth].map(Number);
      if (![x1,y1,x2,y2,d].every(Number.isFinite) || d <= 0 || d >= stockThickness || Math.hypot(x2-x1,y2-y1) < 0.1) throw new Error('Vise marks require valid XY endpoints and a shallow positive depth.');
      lines.push(`(Vise alignment mark ${mark.name || ''}; verify against the configured jaw datum)`, `G0 Z${safe}`, `G0 X${x1.toFixed(3)} Y${y1.toFixed(3)}`, `G1 Z-${d.toFixed(3)} F${plunge}`, `G1 X${x2.toFixed(3)} Y${y2.toFixed(3)} F${feed}`, `G0 Z${safe}`);
    }
    if (!marks.length) lines.push('(No vise alignment marks configured; define mark line endpoints from the measured vise jaw datum.)');
  } else if (planKind === 'clamps') {
    lines.push('(Perimeter clamps hold the stock at its outside edges during area roughing and profile cutting; clamp-seat pockets are not part of this method.)');
  } else {
    const marks = fixture.viseMarks || [];
    for (const mark of marks) {
      const [x1,y1,x2,y2,d] = [mark.x1,mark.y1,mark.x2,mark.y2,mark.depth].map(Number);
      if (![x1,y1,x2,y2,d].every(Number.isFinite) || d <= 0 || d >= stockThickness || Math.hypot(x2-x1,y2-y1) < 0.1) throw new Error('Vise marks require valid XY endpoints and a shallow positive depth.');
      lines.push(`(Vise alignment mark ${mark.name || ''}; verify against the configured jaw datum)`, `G0 Z${safe}`, `G0 X${x1.toFixed(3)} Y${y1.toFixed(3)}`, `G1 Z-${d.toFixed(3)} F${plunge}`, `G1 X${x2.toFixed(3)} Y${y2.toFixed(3)} F${feed}`, `G0 Z${safe}`);
    }
    if (!marks.length) lines.push('(No vise alignment marks configured; define mark line endpoints from the measured vise jaw datum.)');
  }
  const left = minX - radius, right = maxX + radius, bottom = minY - radius, top = maxY + radius;
  const outline = [[left,bottom],[right,bottom],[right,top],[left,top],[left,bottom]];
  const tabNote = mountingLayout ? `preserve two tabs on the ${mountingLayout.orientation==='x'?'east/west':'north/south'} bolt sides` : 'preserve two holding tabs on opposite sides';
  lines.push(`(Blank perimeter ${(maxX-minX+Number(tool)).toFixed(3)} x ${(maxY-minY+Number(tool)).toFixed(3)} mm; cut through the stock and ${tabNote}, 6.000 mm wide by 2.000 mm thick.)`);
  addTabbedPerimeter(outline,stockThickness,6,2,mountingLayout?.orientation || null);
  lines.push('M5', `G0 Z${safeZ}`, 'M30', '');
  return lines.join('\n');
}
