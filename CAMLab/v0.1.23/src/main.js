import { gcode } from '@sienci/gsender-plugin-sdk';
import { bounds, generateGcode, makeCutPath, parseStl, planContourSweeps, planRoughingPaths } from './geometry.js';
import { analyzeModel, ensureMillAccessible, isContourAccessibleFrom, offsetContours, sliceContours } from './mesh-slices.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const state = {
  modelName: '', geometry: null, triangles: [], modelSize: null, gcode: '', bottomGcode: '', frontGcode: '', backGcode: '', prepared: null,
  colletDiameters: { '1/4 in': 6.35, '6 mm': 6, '4 mm': 4, '1/8 in': 3.175, '3 mm': 3 },
  standardToolDiameters: [6.35, 6, 4, 3.175, 3],
};
let occtModule;

async function getOcct() {
  if (!occtModule) {
    occtModule = (async () => {
      if (typeof window.occtimportjs !== 'function') {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = new URL(/* @vite-ignore */ '../occt/occt-import-js.js', import.meta.url).href;
          script.onload = resolve;
          script.onerror = () => reject(new Error('Could not load the local STEP importer.'));
          document.head.append(script);
        });
      }
      return window.occtimportjs();
    })().catch((error) => { occtModule = null; throw error; });
  }
  return occtModule;
}

document.querySelector('#app').innerHTML = `
  <header class="topbar"><div><div class="eyebrow">STL / STEP mesh machining</div><h1>CAMLab</h1><p>Import a model, set the stock and cut settings, then review or download four-sided toolpaths with tabs and roughing on the top, front, and back.</p></div><span class="local-badge">Files stay on this device</span></header>
  <div class="layout">
    <div class="controls">
      <section class="panel"><div class="section-title"><span>01</span><div><h2>Import model</h2><p>STL is interpreted in millimeters. STEP units are converted to millimeters.</p></div></div>
        <label class="file-drop" for="modelFile" title="Choose the 3D part model. STL is treated as millimeters; STEP units are converted to millimeters."><span class="file-icon">＋</span><strong id="fileName">Choose an STL or STEP file</strong><span>STL · STP · STEP</span><input id="modelFile" type="file" accept=".stl,.stp,.step,model/stl,application/step" title="Choose the 3D part model. STL is treated as millimeters; STEP units are converted to millimeters."></label>
        <div id="modelInfo" class="model-info">No model loaded.</div>
      </section>
      <section class="panel"><div class="section-title"><span>02</span><div><h2>Blank stock</h2><p>Model top aligns with stock top. Choose how its XY coordinates are placed.</p></div></div>
        <div class="fields three"><label>Length X (mm)<input id="stockLength" type="number" min="1" step="0.1" value="100" title="Blank stock dimension along the machine X axis. Used for stock-fit checks and the bottom-side flip transform."></label><label>Width Y (mm)<input id="stockWidth" type="number" min="1" step="0.1" value="80" title="Blank stock dimension along the machine Y axis. Used for stock-fit checks and preview bounds."></label><label>Thickness Z (mm)<input id="stockThickness" type="number" min="1" step="0.1" value="18" title="Blank stock thickness. Sets the through-cut depth and the bottom of the generated top-side toolpaths."></label><label>XY origin<select id="xyOrigin" title="Choose whether to center the model in the stock or preserve its imported XY coordinates. Both side files use the same stock XY datum."><option value="center">Center model in stock</option><option value="source">Keep imported model coordinates</option></select></label></div>
      </section>
      <section class="panel"><div class="section-title"><span>03</span><div><h2>Tool and cut settings</h2><p>Values are in millimeters and millimeters per minute.</p></div></div>
        <div class="fields"><label>Installed collet size<select id="colletSize" title="Select the installed collet. CAMLab uses the matching largest standard end mill first and changes to smaller cutters only when a feature needs one."><option value="1/4 in">1/4 in</option><option value="6 mm">6 mm</option><option value="4 mm">4 mm</option><option value="1/8 in">1/8 in</option><option value="3 mm">3 mm</option></select></label><label>Spindle speed (RPM)<input id="rpm" type="number" min="1" step="100" value="12000" title="Spindle speed written to the S command. Confirm it is suitable for your spindle, cutter, and material."></label><label>Step down (mm)<input id="stepDown" type="number" min="0.1" step="0.1" value="0.4" title="Maximum vertical depth between contour passes. Smaller values create more Z levels and shallower cuts."></label><label>Feed rate (mm/min)<input id="feed" type="number" min="1" step="1" value="150" title="XY cutting speed used while following each contour, in millimeters per minute."></label><label>Plunge rate (mm/min)<input id="plunge" type="number" min="1" step="1" value="30" title="Vertical Z speed used when entering each cut, in millimeters per minute."></label></div>
      </section>
      <section class="panel"><div class="section-title"><span>04</span><div><h2>Cutout tabs</h2><p>Two top-side tabs are placed on the left and right outline sides.</p></div></div>
        <div class="fields"><label>Tab width along edge (mm)<input id="tabWidth" type="number" min="1" step="0.1" value="6" title="Length of each uncut bridge along the outside edge. Top-side tabs are centered on the left and right outline sides; front/back passes preserve those tab support zones and add no side tabs."></label><label>Tab height from stock bottom (mm)<input id="tabHeight" type="number" min="0.1" step="0.1" value="2" title="Material thickness left under each top-side tab at the final through-cut. Larger values leave stronger tabs. This value is saved between sessions."></label><label>Safe Z (mm)<input id="safeZ" type="number" min="0.1" step="0.1" value="5" title="Clearance height above the stock for rapid XY moves and retracts. Ensure clamps and fixtures are below this height."></label></div>
      </section>
      <div class="actions"><button id="generate" class="primary" disabled>Generate preview</button><button id="load" disabled>Load top-side</button><button id="loadFront" disabled>Load front-side</button><button id="loadBack" disabled>Load back-side</button><button id="loadBottom" disabled>Load bottom-side</button><button id="download" class="secondary" disabled>Download top-side</button><button id="downloadFront" class="secondary" disabled>Download front-side</button><button id="downloadBack" class="secondary" disabled>Download back-side</button><button id="downloadBottom" class="secondary" disabled>Download bottom-side</button></div>
      <p id="status" class="status" role="status" aria-live="polite">Import a model to begin.</p>
    </div>
    <div class="right-column">
      <section class="panel preview-panel"><div class="section-title"><span>VIEW</span><div><h2>Stock and toolpath</h2><p id="previewCaption">Top view · model footprint in gray · contours in orange · tabs in green</p></div></div>
        <div class="preview-wrap"><svg id="preview" viewBox="0 0 640 450" role="img" aria-label="Stock and tabbed outline preview"><g id="drawing"></g></svg></div>
        <div class="legend"><span><i class="stock-key"></i>Stock</span><span><i class="cut-key"></i>Profile cut</span><span><i class="tab-key"></i>Tab spans</span></div>
      </section>
      <section class="panel code-panel"><div class="section-title"><span>G-CODE</span><div class="code-heading"><div><h2>Top-side output preview</h2><p>Full generated file. Scroll to review every line.</p></div><button id="copyTop" class="secondary" disabled>Copy all</button></div></div><pre id="gcodePreview">G-code will appear after preview generation.</pre></section>
      <section class="panel code-panel"><div class="section-title"><span>G-CODE</span><div class="code-heading"><div><h2>Front-side output preview</h2><p>Roughing, reachable features, and the perimeter for the Y− face; top tabs are preserved.</p></div><button id="copyFront" class="secondary" disabled>Copy all</button></div></div><pre id="frontGcodePreview">Front-side G-code will appear after preview generation.</pre></section>
      <section class="panel code-panel"><div class="section-title"><span>G-CODE</span><div class="code-heading"><div><h2>Back-side output preview</h2><p>Roughing, features missed from the front, and perimeter undercuts beneath the top tabs.</p></div><button id="copyBack" class="secondary" disabled>Copy all</button></div></div><pre id="backGcodePreview">Back-side G-code will appear after preview generation.</pre></section>
      <section class="panel code-panel"><div class="section-title"><span>G-CODE</span><div class="code-heading"><div><h2>Bottom-side output preview</h2><p>Internal undercuts for the flipped setup, generated last in the sequence.</p></div><button id="copyBottom" class="secondary" disabled>Copy all</button></div></div><pre id="bottomGcodePreview">Bottom-side G-code will appear after preview generation.</pre></section>
      <aside class="caution"><strong>Setup order and clamp rails</strong><p>Run the files in this order: top, front, back, bottom. The front is the Y− face rotated −90° about stock-centered X; the back is the Y+ face rotated +90°. Keep the selected X datum registered and reset Z0 at each exposed face. CAMLab carries the stock removed by prior roughing and hole/slot paths into later roughing plans, and groups roughing, circular hole contours, pockets/slots, and perimeter cuts after removing same-depth duplicates. Left and right stock rails outside the top perimeter path are reserved for clamping and are excluded from cutting paths on all four sides. Top uses left/right tabs; front/back avoid their support zones. Secure and support the stock for each setup, and simulate every file before cutting.</p></aside>
    </div>
  </div>
  <footer>CAMLab v0.1.23 · G-code generation only · no job is started<div id="copyright-footer">Copyright 2026 bakStaaJ Designs LLC.</div></footer>
`;

const SETTINGS_KEY = 'com.bakstaaj.camlab.settings.v1';
const LEGACY_TAB_SETTINGS_KEY = 'com.bakstaaj.camlab.tab-settings.v1';
const PERSISTENT_NUMBER_FIELDS = ['stockLength', 'stockWidth', 'stockThickness', 'rpm', 'stepDown', 'feed', 'plunge', 'tabWidth', 'tabHeight', 'safeZ'];
const PERSISTENT_SELECT_FIELDS = ['xyOrigin', 'colletSize'];

function restoreSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const legacyTabs = JSON.parse(localStorage.getItem(LEGACY_TAB_SETTINGS_KEY) || '{}');
    for (const id of PERSISTENT_NUMBER_FIELDS) {
      const value = saved[id] ?? (id === 'tabWidth' ? legacyTabs.width : id === 'tabHeight' ? legacyTabs.height : undefined);
      if (Number.isFinite(value) && value > 0) $(id).value = String(value);
    }
    for (const id of PERSISTENT_SELECT_FIELDS) {
      if (typeof saved[id] === 'string' && [...$(id).options].some((option) => option.value === saved[id])) $(id).value = saved[id];
    }
  } catch { /* Keep the built-in defaults when stored settings are unavailable or invalid. */ }
}

function persistSettings() {
  try {
    const saved = {};
    for (const id of PERSISTENT_NUMBER_FIELDS) {
      const value = Number($(id).value);
      if (Number.isFinite(value) && value > 0) saved[id] = value;
    }
    for (const id of PERSISTENT_SELECT_FIELDS) saved[id] = $(id).value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
    localStorage.setItem(LEGACY_TAB_SETTINGS_KEY, JSON.stringify({ width: saved.tabWidth, height: saved.tabHeight }));
  } catch { /* CAMLab remains usable if browser storage is unavailable. */ }
}

restoreSettings();

function setStatus(message, type = '') { $('status').textContent = message; $('status').className = `status ${type}`; }

function stepTrianglesFromImport(result) {
  if (!result?.success || !Array.isArray(result.meshes) || !result.meshes.length) throw new Error('STEP import did not contain a usable mesh.');
  const triangles = [];
  for (const mesh of result.meshes) {
    const positions = mesh.attributes?.position?.array;
    if (!positions?.length) continue;
    const indices = mesh.index?.array;
    const flatIndices = indices?.length ? indices.flat?.() || indices : Array.from({ length: positions.length / 3 }, (_, i) => i);
    for (let i = 0; i + 2 < flatIndices.length; i += 3) {
      const tri = [];
      for (let j = 0; j < 3; j += 1) {
        const at = Number(flatIndices[i + j]) * 3;
        tri.push([Number(positions[at]), Number(positions[at + 1]), Number(positions[at + 2])]);
      }
      triangles.push(tri);
    }
  }
  if (!triangles.length) throw new Error('STEP import returned no triangles.');
  return triangles;
}

async function loadModel(file) {
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  $('generate').disabled = true;
  for (const id of ['load', 'loadBottom', 'loadFront', 'loadBack', 'download', 'downloadBottom', 'downloadFront', 'downloadBack', 'copyTop', 'copyBottom', 'copyFront', 'copyBack']) $(id).disabled = true;
  setStatus(`Reading ${file.name}…`, 'working');
  try {
    const buffer = await file.arrayBuffer();
    let triangles;
    if (ext === 'stl') triangles = parseStl(buffer);
    else if (ext === 'step' || ext === 'stp') {
      const occt = await getOcct();
      const result = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.12, angularDeflection: 0.45 });
      triangles = stepTrianglesFromImport(result);
    } else throw new Error('Choose an STL, STP, or STEP file.');
    const model = analyzeModel(triangles);
    state.geometry = model; state.triangles = triangles; state.modelSize = model.size; state.modelName = file.name; state.gcode = ''; state.bottomGcode = ''; state.frontGcode = ''; state.backGcode = ''; state.prepared = null;
    $('fileName').textContent = file.name;
    $('modelInfo').innerHTML = `<strong>${model.size.length.toFixed(2)} × ${model.size.width.toFixed(2)} × ${model.size.height.toFixed(2)} mm</strong><span>${triangles.length.toLocaleString()} mesh triangles · projected outline</span>`;
    $('gcodePreview').textContent = 'Generate a preview to build the mesh-slice contours.';
    $('bottomGcodePreview').textContent = 'Generate a preview to build the flipped-side undercut contours.';
    $('frontGcodePreview').textContent = 'Generate a preview to build front-side contours.';
    $('backGcodePreview').textContent = 'Generate a preview to build back-side contours.';
    $('stockLength').value = Math.max(Number($('stockLength').value), model.size.length + 10).toFixed(1);
    $('stockWidth').value = Math.max(Number($('stockWidth').value), model.size.width + 10).toFixed(1);
    persistSettings();
    $('generate').disabled = false;
    drawPreview();
    setStatus('Model imported. Check its dimensions and placement in the stock preview.', 'success');
  } catch (error) { setStatus(error.message || String(error), 'error'); }
}

function values() {
  return {
    stock: { length: Number($('stockLength').value), width: Number($('stockWidth').value), thickness: Number($('stockThickness').value), originMode: $('xyOrigin').value },
    settings: { rpm: Number($('rpm').value), stepDown: Number($('stepDown').value), feed: Number($('feed').value), plunge: Number($('plunge').value), tabWidth: Number($('tabWidth').value), tabHeight: Number($('tabHeight').value), safeZ: Number($('safeZ').value) },
    colletDiameter: state.colletDiameters[$('colletSize').value],
  };
}

function offsetModelContours(contours, diameter) {
  const result = offsetContours(contours, diameter, { allowMissingHoles: state.allowPartialContours });
  state.omittedFeatureSections += result.missingHoleCount || 0;
  return result;
}

function prepareSideLayers(side, stock, settings, tool) {
  const sourceOrigin = stock.originMode === 'source';
  const front = side === 'front';
  const stockYMin = sourceOrigin ? 0 : -stock.width / 2;
  const stockYMax = sourceOrigin ? stock.width : stock.width / 2;
  const sign = front ? 1 : -1;
  const sideTriangles = state.triangles.map((triangle) => triangle.map(([x, y, z]) => {
    const stockY = y - state.geometry.center.y + (sourceOrigin ? state.geometry.center.y : 0);
    const stockZ = z - state.geometry.maxZ;
    const depth = front ? stockY - stockYMin : stockYMax - stockY;
    return [x - state.geometry.center.x, sign * (stockZ + stock.thickness / 2), -depth];
  }));
  const sideGeometry = analyzeModel(sideTriangles);
  const epsilon = Math.min(0.001, Math.min(sideGeometry.size.height, stock.width) / 1000);
  const nearDepth = -sideGeometry.maxZ;
  const farDepth = -sideGeometry.minZ;
  const positionContours = (contours) => contours.map((contour) => ({
    ...contour,
    points: contour.points.map(([x, y]) => [x + (sourceOrigin ? state.geometry.center.x : 0), y + sideGeometry.center.y]),
  }));
  const sampledLayers = [];
  let firstPositionedContours = null;
  let lastPositionedContours = null;
  let firstSectionError = null;
  const levelCount = Math.ceil(stock.width / settings.stepDown);
  for (let index = 1; index <= levelCount; index += 1) {
    const depth = Math.min(stock.width, index * settings.stepDown);
    if (depth + epsilon < nearDepth) {
      sampledLayers.push({ depth, contours: null });
      continue;
    }
    if (depth >= farDepth - epsilon) {
      sampledLayers.push({ depth, contours: lastPositionedContours });
      continue;
    }
    let rawContours;
    try {
      rawContours = sliceContours(sideTriangles, -depth, sideGeometry.center);
    } catch (error) {
      if (!firstPositionedContours) {
        firstSectionError ||= error;
        sampledLayers.push({ depth, contours: null });
        continue;
      }
      throw error;
    }
    if (!rawContours.length) {
      sampledLayers.push({ depth, contours: null });
      continue;
    }
    const contours = positionContours(offsetModelContours(rawContours, tool.diameter));
    firstPositionedContours ||= contours;
    lastPositionedContours = contours;
    sampledLayers.push({ depth, contours });
  }
  if (!firstPositionedContours) throw firstSectionError || new Error(`No closed ${side}-side contours intersect the stock depth. Check the model position and stock width.`);
  const copyContours = (contours) => contours.map((contour) => ({ ...contour, points: contour.points.map((point) => [...point]) }));
  let carriedRawContours = firstPositionedContours;
  const rawLayers = sampledLayers.map(({ depth, contours }) => {
    if (contours) carriedRawContours = contours;
    return { depth, contours: copyContours(carriedRawContours) };
  });
  let carriedContours = firstPositionedContours;
  const layers = rawLayers.map(({ depth, contours }) => {
    if (contours) carriedContours = contours;
    return { depth, contours: copyContours(carriedContours) };
  });
  const access = { depth: 0, contours: copyContours(firstPositionedContours) };
  const accessIssue = ensureMillAccessible(layers, access, Math.max(0.05, Math.min(0.15, settings.stepDown * 0.1)));
  if (accessIssue) {
    const issueIndex = accessIssue.layerIndex;
    const continuationDepth = issueIndex > 0 ? layers[issueIndex - 1].depth : access.depth;
    const profile = issueIndex > 0 ? layers[issueIndex - 1].contours : access.contours;
    for (let i = Math.max(0, issueIndex); i < layers.length; i += 1) {
      layers[i].contours = profile.map((contour) => ({ ...contour, points: contour.points.map((point) => [...point]) }));
    }
    layers.undercutFallback = { depth: accessIssue.depth, continuationDepth };
  }
  layers.rawLayers = rawLayers;
  layers.accessContours = copyContours(firstPositionedContours);
  return layers;
}

function prepareMissedBackUndercuts(frontLayers, backLayers, stock, settings) {
  const result = [];
  const tolerance = Math.max(0.05, Math.min(0.15, settings.stepDown * 0.1));
  const frontAccess = { depth: 0, contours: frontLayers.accessContours };
  const backAccess = { depth: 0, contours: backLayers.accessContours };
  for (const layer of backLayers.rawLayers) {
    if (layer.depth >= stock.width) continue;
    const correspondingFrontDepth = stock.width - layer.depth;
    const upperFront = [frontAccess, ...frontLayers.rawLayers.filter((upper) => upper.depth < correspondingFrontDepth + 1e-5)];
    const upperBack = [backAccess, ...backLayers.rawLayers.filter((upper) => upper.depth < layer.depth)];
    const missedUndercuts = layer.contours.filter((contour) => {
      if (!contour.hole) return false;
      const frontCoordinates = { ...contour, points: contour.points.map(([x, y]) => [x, -y]) };
      return isContourAccessibleFrom(contour, upperBack, tolerance)
        && !isContourAccessibleFrom(frontCoordinates, upperFront, tolerance);
    });
    if (missedUndercuts.length) result.push({ depth: layer.depth, contours: missedUndercuts });
  }
  return result;
}

function prepareWithTool(tool) {
  if (!state.geometry) throw new Error('Import a model first.');
  const { stock, settings, colletDiameter } = values();
  for (const [name, value] of Object.entries({ 'stock length': stock.length, 'stock width': stock.width, 'stock thickness': stock.thickness, 'spindle speed': settings.rpm, 'step down': settings.stepDown, 'feed rate': settings.feed, 'plunge rate': settings.plunge, 'tab width': settings.tabWidth, 'tab height': settings.tabHeight, 'safe Z': settings.safeZ })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero.`);
  }
  if (settings.tabHeight >= stock.thickness) throw new Error('Tab height must be less than the stock thickness.');
  if (settings.tabWidth < tool.diameter * 1.5) throw new Error('Tab width should be at least 1.5 times the cutter diameter; CAMLab will try a smaller standard cutter.');
  if (state.modelSize.height <= 0.01) throw new Error('The model needs measurable Z thickness for mesh-slice finishing.');
  if (state.modelSize.height > stock.thickness) throw new Error('Model height is greater than the stock thickness. Align or scale the model, or use thicker stock.');
  const topBottomLevels = Math.ceil(stock.thickness / settings.stepDown);
  const sideLevels = Math.ceil(stock.width / settings.stepDown);
  if (Math.max(topBottomLevels, sideLevels) > 500) throw new Error('These settings create over 500 contour levels across the four sides. Increase step-down or reduce stock dimensions.');
  const originOffset = stock.originMode === 'source' ? state.geometry.center : { x: 0, y: 0 };
  const sliceEpsilon = Math.min(0.001, state.modelSize.height / 1000);
  const topContours = sliceContours(state.triangles, state.geometry.maxZ - sliceEpsilon, state.geometry.center);
  if (!topContours.length) throw new Error('Could not determine which model contours are open from the top. Check the STL/STEP mesh.');
  const topContoursWithOrigin = offsetModelContours(topContours, tool.diameter);
  for (const contour of topContoursWithOrigin) contour.points = contour.points.map(([x, y]) => [x + originOffset.x, y + originOffset.y]);
  const topAccess = { depth: 0, contours: topContoursWithOrigin };
  const bottomZ = state.geometry.minZ + sliceEpsilon;
  const bottomContours = sliceContours(state.triangles, bottomZ, state.geometry.center);
  if (!bottomContours.length) throw new Error('Could not form a closed contour near the model bottom. Check that the STL/STEP mesh is closed.');
  const layers = [];
  for (let index = 1; index <= topBottomLevels; index += 1) {
    const depth = Math.min(stock.thickness, index * settings.stepDown);
    const modelDepth = Math.min(depth, state.modelSize.height - 0.0001);
    const rawContours = depth >= state.modelSize.height ? bottomContours : sliceContours(state.triangles, state.geometry.maxZ - modelDepth, state.geometry.center);
    if (!rawContours.length) continue;
    const contours = offsetModelContours(rawContours, tool.diameter);
    for (const contour of contours) contour.points = contour.points.map(([x, y]) => [x + originOffset.x, y + originOffset.y]);
    layers.push({ depth, contours });
  }
  if (!layers.length) throw new Error('No closed contours were found at the selected step-down levels.');
  const topLayersForAccess = layers.map((layer) => ({ depth: layer.depth, contours: layer.contours.map((contour) => ({ ...contour, points: contour.points.map((point) => [...point]) })) }));
  const accessIssue = ensureMillAccessible(layers, topAccess, Math.max(0.05, Math.min(0.15, settings.stepDown * 0.1)));
  if (accessIssue) {
    const continuationDepth = accessIssue.layerIndex > 0 ? layers[accessIssue.layerIndex - 1].depth : 0;
    const profile = accessIssue.layerIndex > 0 ? layers[accessIssue.layerIndex - 1].contours : topAccess.contours;
    for (let i = accessIssue.layerIndex; i < layers.length; i += 1) {
      layers[i].contours = profile.map((contour) => ({ ...contour, points: contour.points.map((point) => [...point]) }));
    }
    layers.undercutFallback = { depth: accessIssue.depth, continuationDepth };
  }
  const bottomYOffset = stock.originMode === "center" ? 0 : stock.width - state.geometry.center.y;
  const bottomAccessContours = offsetModelContours(bottomContours, tool.diameter);
  for (const contour of bottomAccessContours) contour.points = contour.points.map(([x, y]) => [x + originOffset.x, -y + bottomYOffset]);
  const bottomAccess = { depth: 0, contours: bottomAccessContours };
  const rawBottomLayers = [];
  for (let index = 1; index <= topBottomLevels; index += 1) {
    const depth = Math.min(stock.thickness, index * settings.stepDown);
    const modelDepth = Math.min(depth, state.modelSize.height - 0.0001);
    const rawContours = depth >= state.modelSize.height ? topContours : sliceContours(state.triangles, state.geometry.minZ + modelDepth, state.geometry.center, -1);
    if (!rawContours.length) continue;
    const contours = offsetModelContours(rawContours, tool.diameter);
    for (const contour of contours) contour.points = contour.points.map(([x, y]) => [x + originOffset.x, -y + bottomYOffset]);
    rawBottomLayers.push({ depth, contours });
  }
  const bottomLayers = [];
  const tolerance = Math.max(0.05, Math.min(0.15, settings.stepDown * 0.1));
  for (const layer of rawBottomLayers) {
    if (layer.depth >= state.modelSize.height) continue;
    const correspondingTopDepth = state.modelSize.height - layer.depth;
    const upperTopLayers = [topAccess, ...topLayersForAccess.filter((upper) => upper.depth < correspondingTopDepth + 1e-5)];
    const exactTopContours = sliceContours(state.triangles, state.geometry.maxZ - correspondingTopDepth, state.geometry.center);
    if (exactTopContours.length) {
      const exact = offsetModelContours(exactTopContours, tool.diameter);
      for (const contour of exact) contour.points = contour.points.map(([x, y]) => [x + originOffset.x, y + originOffset.y]);
      upperTopLayers.push({ depth: correspondingTopDepth, contours: exact });
    }
    const upperBottomLayers = [bottomAccess, ...rawBottomLayers.filter((upper) => upper.depth < layer.depth)];
    const missedUndercuts = layer.contours.filter((contour) => {
      if (!contour.hole) return false;
      const topCoordinates = { ...contour, points: contour.points.map(([x, y]) => [x, bottomYOffset - y + originOffset.y]) };
      return isContourAccessibleFrom(contour, upperBottomLayers, tolerance)
        && !isContourAccessibleFrom(topCoordinates, upperTopLayers, tolerance);
    });
    if (missedUndercuts.length) bottomLayers.push({ depth: layer.depth, contours: missedUndercuts });
  }
  const frontLayers = prepareSideLayers('front', stock, settings, tool);
  const fullBackLayers = prepareSideLayers('back', stock, settings, tool);
  const backLayers = prepareMissedBackUndercuts(frontLayers, fullBackLayers, stock, settings);
  const allPoints = [...layers, ...bottomLayers].flatMap((layer) => layer.contours.flatMap((contour) => contour.points));
  const extents = bounds(allPoints);
  const stockBounds = stock.originMode === 'center'
    ? { minX: -stock.length / 2, maxX: stock.length / 2, minY: -stock.width / 2, maxY: stock.width / 2 }
    : { minX: 0, maxX: stock.length, minY: 0, maxY: stock.width };
  const fitsStock = extents.minX >= stockBounds.minX && extents.maxX <= stockBounds.maxX && extents.minY >= stockBounds.minY && extents.maxY <= stockBounds.maxY;
  if (!fitsStock && stock.originMode === 'center') throw new Error('Model plus cutter radius does not fit inside the entered stock dimensions.');
  return { layers, bottomLayers, frontLayers, backLayers, fullBackLayers, stock, settings, tool, roughingTool: tool, roughingExpansion: 0, colletDiameter, originOffset, stockBounds, fitsStock, undercutFallback: layers.undercutFallback || null, bottomUndercutFallback: null };
}

function prepare() {
  if (!state.geometry) throw new Error('Import a model first.');
  const colletDiameter = values().colletDiameter;
  if (!Number.isFinite(colletDiameter) || colletDiameter <= 0) throw new Error('Select an installed collet size.');
  const candidates = state.standardToolDiameters.filter((diameter) => diameter <= colletDiameter + 1e-6);
  let lastCandidateError = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const tool = { diameter: candidates[index], number: index === 0 ? 1 : 2 };
    state.omittedFeatureSections = 0;
    state.allowPartialContours = index === candidates.length - 1;
    try {
      const data = prepareWithTool(tool);
      data.roughingTool = { diameter: candidates[0], number: 1 };
      data.roughingExpansion = Math.max(0, (candidates[0] - tool.diameter) / 2);
      data.omittedFeatureSections = state.omittedFeatureSections;
      state.allowPartialContours = false;
      return data;
    } catch (error) {
      state.allowPartialContours = false;
      if (!/selected cutter is too large|selected tool removes the entire contour|tab width should be at least|model plus cutter radius does not fit/i.test(error.message || '')) throw error;
      lastCandidateError = error;
    }
  }
  throw lastCandidateError || new Error('No standard end mill fits the selected collet.');
}

function drawPreview(prepared = null) {
  const drawing = $('drawing'); drawing.replaceChildren();
  if (!state.geometry) return;
  const data = prepared || state.prepared;
  const stockLength = Number($('stockLength').value); const stockWidth = Number($('stockWidth').value);
  const stockBounds = data?.stockBounds || ($('xyOrigin').value === 'center'
    ? { minX: -stockLength / 2, maxX: stockLength / 2, minY: -stockWidth / 2, maxY: stockWidth / 2 }
    : { minX: 0, maxX: stockLength, minY: 0, maxY: stockWidth });
  const projectedLoops = state.geometry.polygons.flatMap((polygon) => polygon);
  const all = [[stockBounds.minX, stockBounds.minY], [stockBounds.maxX, stockBounds.maxY], ...projectedLoops.flat()];
  if (data) all.push(...data.layers.flatMap((layer) => layer.contours.flatMap((contour) => contour.points)));
  const ext = bounds(all); const w = Math.max(ext.maxX - ext.minX, 1); const h = Math.max(ext.maxY - ext.minY, 1);
  const scale = Math.min(560 / w, 370 / h); const ox = 320 - ((ext.minX + ext.maxX) / 2) * scale; const oy = 225 + ((ext.minY + ext.maxY) / 2) * scale;
  const xy = ([x, y]) => [ox + x * scale, oy - y * scale];
  const svg = (tag, attrs) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); drawing.append(node); return node; };
  svg('rect', { x: ox + stockBounds.minX * scale, y: oy - stockBounds.maxY * scale, width: stockLength * scale, height: stockWidth * scale, class: 'stock' });
  const originOffset = data?.originOffset || ($('xyOrigin').value === 'source' ? state.geometry.center : { x: 0, y: 0 });
  const modelPath = projectedLoops.map((ring) => `${ring.map((point, index) => `${index ? 'L' : 'M'}${xy([point[0] + originOffset.x, point[1] + originOffset.y]).join(',')}`).join(' ')} Z`).join(' ');
  svg('path', { d: modelPath, class: 'model', 'fill-rule': 'evenodd' });
  if (!data) return;
  const firstLayer = data.layers[0];
  for (const contour of firstLayer.contours) {
    const path = contour.points.map((point, index) => `${index ? 'L' : 'M'}${xy(point).join(',')}`).join(' ') + ' Z';
    svg('path', { d: path, class: 'cut-loop' });
  }
  const finalLayer = data.layers.at(-1); const mainOuter = [...finalLayer.contours].filter((c) => !c.hole).sort((a, b) => b.area - a.area)[0];
  if (mainOuter && finalLayer.depth > data.stock.thickness - data.settings.tabHeight) {
    const tabs = makeCutPath(mainOuter.points, data.settings.tabWidth, { placement: 'left-right' }).path;
    for (let i = 0; i < tabs.length; i += 1) {
      const current = tabs[i]; const next = tabs[(i + 1) % tabs.length]; const a = xy(current.point); const b = xy(next.point);
      svg('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: current.tab ? 'tab' : 'cut' });
    }
  }
  const originLabel = data.stock.originMode === 'center' ? 'center origin' : 'imported XY origin';
  $('previewCaption').textContent = `Model ${state.modelSize.length.toFixed(1)} × ${state.modelSize.width.toFixed(1)} × ${state.modelSize.height.toFixed(1)} mm · ${data.layers.length} contour levels · orange shows finishing contours; raster roughing is in top/front/back G-code · ${originLabel}`;
}

function generate() {
  const data = prepare();
  state.prepared = data;
  const topTabContours = data.layers.at(-1).contours;
  const outerPoints = topTabContours.filter((contour) => !contour.hole).flatMap((contour) => contour.points);
  const clampXBounds = outerPoints.length
    ? { minX: Math.min(...outerPoints.map((point) => point[0])), maxX: Math.max(...outerPoints.map((point) => point[0])) }
    : null;
  const topRoughing = planRoughingPaths({ layers: data.layers, stock: data.stock, settings: data.settings, tool: data.roughingTool, side: 'top', topTabContours, roughingExpansion: data.roughingExpansion, clampXBounds });
  const topHistory = [
    { side: 'top', layers: topRoughing, diameter: data.roughingTool.diameter },
    planContourSweeps({ layers: data.layers, stock: data.stock, settings: data.settings, side: 'top', toolDiameter: data.tool.diameter, clampXBounds }),
  ];
  state.gcode = generateGcode({ layers: data.layers, stock: data.stock, settings: data.settings, tool: data.tool, roughingTool: data.roughingTool, roughingExpansion: data.roughingExpansion, omittedFeatureSections: data.omittedFeatureSections, preplannedRoughing: topRoughing, clampXBounds, side: 'top' });

  const frontRoughing = planRoughingPaths({ layers: data.frontLayers, stock: data.stock, settings: data.settings, tool: data.roughingTool, side: 'front', topTabContours, roughingExpansion: data.roughingExpansion, previousRoughing: topHistory, clampXBounds });
  state.frontGcode = generateGcode({ layers: data.frontLayers, stock: data.stock, settings: data.settings, tool: data.tool, roughingTool: data.roughingTool, roughingExpansion: data.roughingExpansion, omittedFeatureSections: data.omittedFeatureSections, preplannedRoughing: frontRoughing, previousRoughing: topHistory, clampXBounds, side: 'front', cutExtent: data.stock.width, topTabContours });

  const frontFeatureHistory = planContourSweeps({ layers: data.frontLayers, stock: data.stock, settings: data.settings, side: 'front', toolDiameter: data.tool.diameter, cutExtent: data.stock.width, topTabContours, clampXBounds });
  const previousRoughing = [...topHistory, { side: 'front', layers: frontRoughing, diameter: data.roughingTool.diameter }, frontFeatureHistory];
  const backRoughing = planRoughingPaths({ layers: data.fullBackLayers, stock: data.stock, settings: data.settings, tool: data.roughingTool, side: 'back', topTabContours, roughingExpansion: data.roughingExpansion, previousRoughing, clampXBounds });
  state.backGcode = generateGcode({ layers: data.backLayers, roughingLayers: data.fullBackLayers, tabReleaseLayers: data.fullBackLayers, stock: data.stock, settings: data.settings, tool: data.tool, roughingTool: data.roughingTool, roughingExpansion: data.roughingExpansion, omittedFeatureSections: data.omittedFeatureSections, preplannedRoughing: backRoughing, previousRoughing, clampXBounds, side: 'back', cutExtent: data.stock.width, topTabContours });

  state.bottomGcode = generateGcode({ layers: data.bottomLayers, stock: data.stock, settings: data.settings, tool: data.tool, roughingTool: data.roughingTool, roughingExpansion: data.roughingExpansion, omittedFeatureSections: data.omittedFeatureSections, clampXBounds, side: 'bottom' });
  $('gcodePreview').textContent = state.gcode;
  $('bottomGcodePreview').textContent = state.bottomGcode;
  $('frontGcodePreview').textContent = state.frontGcode;
  $('backGcodePreview').textContent = state.backGcode;
  for (const id of ['load', 'loadBottom', 'loadFront', 'loadBack', 'download', 'downloadBottom', 'downloadFront', 'downloadBack', 'copyTop', 'copyBottom', 'copyFront', 'copyBack']) $(id).disabled = false;
  drawPreview(data);
  const extentNote = data.fitsStock ? '' : ' Toolpath extends beyond the entered stock rectangle; check placement.';
  const accessNote = ` Generated programs in machining order: top, front, back, bottom. Front assumes the Y− face is rotated −90° about stock-centered X; back assumes Y+ is rotated +90°. Re-zero Z at each exposed face and preserve the selected X datum. Later roughing paths exclude the swept areas removed by earlier roughing setups.`;
  const toolNote = data.tool.number === 2
    ? ` T1 ${data.roughingTool.diameter.toFixed(3)} mm roughing, then T2 ${data.tool.diameter.toFixed(3)} mm contouring.`
    : ` T1 ${data.tool.diameter.toFixed(3)} mm for all generated cuts.`;
  const featureNote = data.omittedFeatureSections
    ? ` Warning: ${data.omittedFeatureSections} narrow hole/slot contour sections do not fit the smallest available ${data.tool.diameter.toFixed(3)} mm cutter and were omitted; use a smaller cutter or another machining setup for those features.`
    : '';
  setStatus(`Preview ready ·${accessNote}${toolNote}${featureNote} No CNC motion started.${extentNote}`, data.omittedFeatureSections || !data.fitsStock || data.undercutFallback ? 'working' : 'success');
}

const sideControls = {
  top: { load: 'load', download: 'download', copy: 'copyTop' },
  bottom: { load: 'loadBottom', download: 'downloadBottom', copy: 'copyBottom' },
  front: { load: 'loadFront', download: 'downloadFront', copy: 'copyFront' },
  back: { load: 'loadBack', download: 'downloadBack', copy: 'copyBack' },
};

async function loadIntoGsender(side) {
  const content = side === 'top' ? state.gcode : state[`${side}Gcode`];
  const controls = sideControls[side];
  if (!content) return;
  $(controls.load).disabled = true;
  try {
    const name = `${state.modelName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-')}-${side}-side.nc`;
    await gcode.loadToVisualizer(content, name);
    setStatus(`Loaded ${name} into gSender for review. No job was started.`, 'success');
  } catch (error) { setStatus(`Could not load ${side}-side G-code: ${error?.message || error}`, 'error'); }
  finally { $(controls.load).disabled = false; }
}

function invalidatePreview() {
  state.gcode = ''; state.prepared = null;
  state.bottomGcode = ''; state.frontGcode = ''; state.backGcode = '';
  $('gcodePreview').textContent = 'Settings changed. Generate a new preview to update the G-code.';
  $('bottomGcodePreview').textContent = 'Settings changed. Generate a new preview to update the G-code.';
  $('frontGcodePreview').textContent = 'Settings changed. Generate a new preview to update the G-code.';
  $('backGcodePreview').textContent = 'Settings changed. Generate a new preview to update the G-code.';
  for (const id of ['load', 'loadBottom', 'loadFront', 'loadBack', 'download', 'downloadBottom', 'downloadFront', 'downloadBack', 'copyTop', 'copyBottom', 'copyFront', 'copyBack']) $(id).disabled = true;
  if (state.geometry) drawPreview();
}

$('modelFile').addEventListener('change', (event) => loadModel(event.target.files?.[0]));
$('colletSize').addEventListener('change', () => { persistSettings(); invalidatePreview(); });
$('xyOrigin').addEventListener('change', () => { persistSettings(); invalidatePreview(); });
document.querySelectorAll('input[type="number"]').forEach((input) => input.addEventListener('change', () => { persistSettings(); invalidatePreview(); }));
$('generate').addEventListener('click', () => { try { generate(); } catch (error) { setStatus(error.message, 'error'); } });
$('load').addEventListener('click', () => loadIntoGsender('top'));
$('loadBottom').addEventListener('click', () => loadIntoGsender('bottom'));
$('loadFront').addEventListener('click', () => loadIntoGsender('front'));
$('loadBack').addEventListener('click', () => loadIntoGsender('back'));
async function copyAllGcode(side) {
  const content = side === 'top' ? state.gcode : state[`${side}Gcode`];
  const button = $(sideControls[side].copy);
  if (!content) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = content; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
      document.body.append(textarea); textarea.select();
      const copied = document.execCommand('copy'); textarea.remove();
      if (!copied) throw new Error('Clipboard copy was blocked by the host.');
    }
    const oldLabel = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = oldLabel; }, 1600);
  } catch (error) {
    setStatus(`Could not copy ${side}-side G-code: ${error?.message || error}`, 'error');
  }
}
const downloadGcode = (side) => {
  const content = side === 'top' ? state.gcode : state[`${side}Gcode`];
  if (!content) return;
  const name = `${state.modelName.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-')}-${side}-side.nc`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' }); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
};
$('download').addEventListener('click', () => downloadGcode('top'));
$('downloadBottom').addEventListener('click', () => downloadGcode('bottom'));
$('downloadFront').addEventListener('click', () => downloadGcode('front'));
$('downloadBack').addEventListener('click', () => downloadGcode('back'));
$('copyTop').addEventListener('click', () => copyAllGcode('top'));
$('copyBottom').addEventListener('click', () => copyAllGcode('bottom'));
$('copyFront').addEventListener('click', () => copyAllGcode('front'));
$('copyBack').addEventListener('click', () => copyAllGcode('back'));
