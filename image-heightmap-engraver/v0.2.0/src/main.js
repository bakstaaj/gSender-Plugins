import { file, gcode, navigation } from '@sienci/gsender-plugin-sdk';
import { detectOvalBounds, maskOutsideOval, toGrayscale } from './heightmap.js';
import { getModelBounds, MAX_MODEL_TRIANGLES, parseStl, sampleTopSurface, stepTrianglesFromImport } from './model.js';
import { generateHeightmapGcode } from './toolpaths.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const state = { image: null, gray: null, model: null, surface: null, gcode: '', flatOptions: null };
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
<header><div class="eyebrow">IMAGE RELIEF · TOP SURFACES</div><h1>Heightmap Engraver</h1><p>Generate a toolpath directly from an STL or STEP topography, engrave an image on a flat surface, or drape an image over a model. Review the generated toolpath in gSender Carve.</p></header>
<section class="panel"><div class="heading"><div><small>01 · RELIEF SOURCE</small><h2>Choose a heightmap source</h2></div><span>Image minimum = no added relief · maximum = max depth</span></div>
<label id="imageFileLabel"><span id="imageFileLabelText">Optional image overlay</span><input id="file" type="file" accept="image/*"></label>
<div class="model-picker"><label>Optional top-surface model<input id="modelFile" type="file" accept=".stl,.stp,.step,model/stl,application/step"></label><button id="clearModel" class="secondary" type="button" disabled>Remove model</button></div>
<p id="modelInfo" class="hint">No model loaded. The image will use a flat Z0 surface. STL units are millimeters; STEP units are converted to millimeters.</p>
<div class="imageRow"><div class="preview"><img id="preview" hidden alt="Grayscale relief preview"><span id="empty">Image preview appears here</span></div><div><b id="dimensions">No image loaded</b><label class="check"><input id="invert" type="checkbox"> Invert grayscale</label><label>Maximum sampling<select id="samplingLimit"><option value="300000">300K points · fastest</option><option value="500000">500K points</option><option value="750000">750K points</option><option value="1000000">1M points</option><option value="1500000">1.5M points</option><option value="2000000">2M points · slowest</option></select></label><p class="hint">Higher sampling can preserve finer image and model detail, with longer processing and larger G-code. The final detail also depends on your tool, stepover, and machine.</p><p class="hint">The darkest image value creates no added relief; the brightest value cuts to the selected maximum depth. Invert swaps light and dark. Image colors are converted to grayscale.</p><p id="pixelInfo" class="hint"></p></div></div></section>
<section class="panel"><div class="heading"><div><small>02 · ENGRAVING AREA</small><h2>Set size and depth</h2></div><span>Millimeters</span></div><div class="grid">
<label>X size<input id="x" type="number" min="0.1" step="0.1" value="100"></label><label>Y size<input id="y" type="number" min="0.1" step="0.1" value="75"></label><label class="check ratio"><input id="ratio" type="checkbox" checked> Maintain image aspect ratio</label>
<label>Finish path algorithm<select id="pattern"><option value="auto">Automatic (model spiral, oval spiral, otherwise raster)</option><option value="offset-inside">3D Relief Spiral (inside-out)</option><option value="offset-outside">3D Relief Spiral (outside-in)</option><option value="makera-parallel">3D Relief Parallel (reciprocating)</option><option value="raster">Raster with retracts</option><option value="crosshatch">Crosshatch (two directions)</option><option value="radial">Elliptical Spiral</option></select></label>
<label>Finish stepover (mm)<input id="stepover" type="number" min="0.05" step="0.05" value="0.5"></label>
<label id="slopeLabel">Maximum top-surface slope<input id="maxSlope" type="number" min="0" max="80" step="1" value="60"></label>
<label class="check frame"><input id="frame" type="checkbox"> Add 5 mm Z0 frame</label>
<label class="check"><input id="twoPass" type="checkbox" checked> Two-tool roughing + finishing</label><label>Roughing allowance (mm)<input id="roughAllowance" type="number" min="0" step="0.1" value="0.3"></label>
<p id="patternHint" class="hint pattern-hint"></p><p id="twoPassHint" class="hint">Two-tool mode roughs with T1 (1/8 inch flat endmill) in a reciprocating zigzag at 50% overlap, then selects T2 (60° V-bit with 0.1 mm tip) for the chosen finish path. Finish stepover applies to T2. Configure your controller's M6 tool-change behavior and re-zero work Z0 after changing tools if required.</p>
<label class="spindle">Spindle speed · <output id="rpmValue">10,000 RPM</output><input id="rpm" type="range" min="0" max="20000" step="100" value="10000"><span class="rangeScale"><span>0 RPM · spindle off</span><span>20,000 RPM</span></span></label>
<label id="depthLabel"><span id="depthLabelText">Maximum engraving depth</span><input id="depth" type="number" min="0.01" step="0.1" value="1"></label><label>Engraving feed (mm/min)<input id="feed" type="number" min="1" value="800"></label><label>Plunge rate (mm/min)<input id="plunge" type="number" min="1" value="200"></label><label>Safe Z<input id="safe" type="number" min="0.1" step="0.1" value="3"></label><label>Origin X<input id="ox" type="number" step="0.1" value="0"></label><label>Origin Y<input id="oy" type="number" step="0.1" value="0"></label></div>
<p class="hint">For model engraving, orient the face to machine from toward +Z. The model's XY bounds set the engraving size; Z0 is the model's highest point. Only upward-facing triangles within the slope limit are machined. Steep walls, underside faces, and uncovered areas are skipped. With no model, the existing flat image workflow remains available. The optional frame is only available in flat image mode.</p>
<p class="hint">STL is interpreted in millimeters. STEP geometry is tessellated locally in the browser and converted to millimeters. With a model loaded, Maximum Depth clips the combined model and image target to that depth below model Z0. Confirm the Z0 setup, fixtures, feeds, and clearances yourself; the plugin does not check tool collisions or machine travel.</p></section>
<div class="actions"><button id="make">Generate G-code</button><button id="load" disabled>Load into Carve</button><button id="export" class="secondary" disabled>Save G-code…</button><button id="copy" class="secondary" disabled>Copy G-code</button></div><div id="notice" role="status">Load an image or a top-surface STL/STEP model to begin. Generation does not start a CNC job.</div>
<section id="output" class="panel" hidden><div class="heading"><div><small>03 · OUTPUT</small><h2>Generated top-surface path</h2></div><span id="stats"></span></div><pre id="code"></pre><p class="caution">Tool selection uses T1 M6 for roughing and T2 M6 for finishing (T2 only in single-tool mode). Configure and verify your controller's M6 behavior before running. Set work Z0 to the model's highest point; re-zero after a tool change if required. Simulate the complete output. Tool geometry, workholding, stock, fixtures, machine travel, and collision safety are not checked.</p></section><footer>Settings are saved locally in this browser. Image conversion, model tessellation, surface sampling, and G-code generation run locally.</footer>`;

function note(text, type = '') { $('notice').textContent = text; $('notice').className = type; }
const preferenceIds = ['x', 'y', 'ratio', 'invert', 'samplingLimit', 'frame', 'twoPass', 'roughAllowance', 'rpm', 'depth', 'feed', 'plunge', 'safe', 'ox', 'oy', 'pattern', 'stepover', 'maxSlope'];
const preferenceKey = 'image-heightmap-engraver-settings-v2';
function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || localStorage.getItem('image-heightmap-engraver-settings-v1') || '{}');
    for (const id of preferenceIds) {
      const element = $(id), value = saved[id];
      if (element.type === 'checkbox') { if (typeof value === 'boolean') element.checked = value; }
      else if (element.tagName === 'SELECT') { if ([...element.options].some((option) => option.value === value)) element.value = value; }
      else if (value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value))) element.value = String(value);
    }
    if (!saved.pattern && saved.crossHatch) $('pattern').value = 'crosshatch';
  } catch { /* Keep defaults when local settings are invalid. */ }
}
function savePreferences() {
  try {
    const saved = Object.fromEntries(preferenceIds.map((id) => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
    localStorage.setItem(preferenceKey, JSON.stringify(saved));
  } catch { /* The plugin remains usable if storage is unavailable. */ }
}
loadPreferences();
for (const id of preferenceIds) { $(id).addEventListener('input', savePreferences); $(id).addEventListener('change', savePreferences); }

function grayscaleMappingMessage(gray) {
  return gray.minGray === gray.maxGray ? `The image is flat at grayscale ${gray.minGray}; it adds no relief.` : `Image minimum ${gray.minGray} adds no relief; maximum ${gray.maxGray} cuts to the selected maximum depth.`;
}
function sizeFromX() { if (state.gray && !state.model && $('ratio').checked) $('y').value = (Number($('x').value) * state.gray.height / state.gray.width).toFixed(2); }
function sizeFromY() { if (state.gray && !state.model && $('ratio').checked) $('x').value = (Number($('y').value) * state.gray.width / state.gray.height).toFixed(2); }
function updateModelControls() {
  const hasModel = Boolean(state.model);
  const modelOnly = hasModel && !state.gray;
  $('clearModel').disabled = !hasModel;
  $('x').readOnly = $('y').readOnly = hasModel;
  $('ratio').disabled = hasModel;
  $('frame').disabled = hasModel;
  if (hasModel) {
    $('frame').checked = false;
    $('ratio').checked = false;
    $('x').value = state.model.bounds.sizeX.toFixed(3);
    $('y').value = state.model.bounds.sizeY.toFixed(3);
  }
  $('slopeLabel').hidden = !hasModel;
  $('depthLabel').hidden = false;
  $('depthLabelText').textContent = modelOnly ? 'Maximum depth below model Z0' : hasModel ? 'Maximum total depth below model Z0' : 'Maximum engraving depth';
  $('imageFileLabelText').textContent = hasModel ? 'Optional image overlay' : 'Image file';
  if (!hasModel) { $('x').readOnly = $('y').readOnly = false; $('ratio').disabled = $('frame').disabled = false; }
}
function modelImageMask() {
  if (!state.surface || !state.gray) return null;
  const mask = state.surface.valid.slice();
  const oval = state.gray.radialBounds;
  const alpha = state.gray.alpha;
  for (let y = 0; y < state.gray.height; y += 1) for (let x = 0; x < state.gray.width; x += 1) {
    const i = y * state.gray.width + x;
    if (alpha?.[i] <= 16) { mask[i] = 0; continue; }
    if (oval) {
      const dx = (x - (oval.xMin + oval.xMax) / 2) / Math.max(1, (oval.xMax - oval.xMin) / 2);
      const dy = (y - (oval.yMin + oval.yMax) / 2) / Math.max(1, (oval.yMax - oval.yMin) / 2);
      if (dx * dx + dy * dy > 1.02) mask[i] = 0;
    }
  }
  return mask;
}
function refreshSurface() {
  if (!state.model) {
    state.surface = null;
    $('modelInfo').textContent = 'No model loaded. The image will use a flat Z0 surface. STL units are millimeters; STEP units are converted to millimeters.';
    return;
  }
  updateModelControls();
  const { bounds, triangles, name } = state.model;
  const maxSamples = Number($('samplingLimit').value) || 300000;
  let width = state.gray?.width, height = state.gray?.height;
  if (!width || !height) { width = Math.max(2, Math.floor(Math.sqrt(maxSamples * bounds.sizeX / bounds.sizeY))); height = Math.max(2, Math.floor(maxSamples / width)); }
  try {
    state.surface = sampleTopSurface(triangles, width, height, Number($('maxSlope').value));
  } catch (error) {
    state.surface = null;
    $('modelInfo').textContent = `${name} · Could not sample the requested top surface: ${error.message}`;
    return;
  }
  const mask = state.gray ? modelImageMask() : state.surface.valid.slice();
  const coverage = mask.reduce((sum, value) => sum + value, 0) / mask.length;
  state.surface.outputMask = mask;
  state.surface.outputCoverage = coverage;
  $('modelInfo').textContent = `${name} · ${bounds.sizeX.toFixed(2)} × ${bounds.sizeY.toFixed(2)} × ${(bounds.maxZ - bounds.minZ).toFixed(2)} mm · ${(triangles.length / 9).toLocaleString()} triangles · ${width} × ${height} sampling grid · ${Math.round(coverage * 100)}% top-surface coverage${state.gray ? ' of image' : ''}. ${state.gray ? 'Image relief overlays the model.' : 'Model topography is the heightmap.'}`;
}
function renderGray() {
  if (!state.image) return;
  const canvas = document.createElement('canvas');
  const sourceWidth = state.image.naturalWidth, sourceHeight = state.image.naturalHeight;
  const maxSamples = Number($('samplingLimit').value) || 300000;
  const scale = Math.min(1, Math.sqrt(maxSamples / (sourceWidth * sourceHeight)));
  canvas.width = Math.max(1, Math.floor(sourceWidth * scale)); canvas.height = Math.max(1, Math.floor(sourceHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(state.image, 0, 0, canvas.width, canvas.height);
  state.gray = toGrayscale(ctx.getImageData(0, 0, canvas.width, canvas.height), $('invert').checked);
  state.gray.radialBounds = detectOvalBounds(state.gray);
  if (state.gray.radialBounds) maskOutsideOval(state.gray, state.gray.radialBounds);
  const out = ctx.createImageData(canvas.width, canvas.height);
  for (let p = 0, i = 0; p < state.gray.pixels.length; p += 1, i += 4) { const v = state.gray.pixels[p]; out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255; }
  ctx.putImageData(out, 0, 0); $('preview').src = canvas.toDataURL('image/png'); $('preview').hidden = false; $('empty').hidden = true;
  $('dimensions').textContent = `${canvas.width} × ${canvas.height} pixels`;
  const resized = canvas.width !== sourceWidth || canvas.height !== sourceHeight;
  $('pixelInfo').textContent = `${(canvas.width * canvas.height).toLocaleString()} grayscale points${resized ? `; resized from ${sourceWidth} × ${sourceHeight} to stay within the ${maxSamples.toLocaleString()} point limit` : ''}${state.gray.radialBounds ? '; oval outline detected' : ''}; range ${state.gray.minGray}–${state.gray.maxGray}.`;
  updateModelControls();
  refreshSurface();
  state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
}
async function loadModel(file) {
  if (!file) return;
  note(`Reading ${file.name}…`);
  try {
    let buffer = await file.arrayBuffer();
    const extension = file.name.split('.').pop().toLowerCase();
    let triangles;
    if (extension === 'stl') triangles = parseStl(buffer);
    else if (extension === 'step' || extension === 'stp') {
      const occt = await getOcct();
      const result = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.15, angularDeflection: 0.45 });
      triangles = stepTrianglesFromImport(result);
    } else throw new Error('Choose an STL, STP, or STEP model.');
    buffer = null;
    if (triangles.length / 9 > MAX_MODEL_TRIANGLES) throw new Error(`This model exceeds the ${MAX_MODEL_TRIANGLES.toLocaleString()} triangle limit.`);
    const bounds = getModelBounds(triangles);
    if (!state.model) state.flatOptions = { ratio: $('ratio').checked, frame: $('frame').checked };
    state.model = { name: file.name, triangles, bounds };
    updateModelControls();
    refreshSurface();
    state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
    note(state.gray ? 'Model loaded. Image engraving is limited to sampled top-facing surfaces.' : 'Model loaded as a heightmap. You can generate a top-surface toolpath now or add an image overlay.', 'success');
  } catch (error) { note(`Could not load model: ${error?.message || error}`, 'error'); }
}
function makeGcode() {
  if (!state.gray && !state.model) throw new Error('Load an image or top-surface STL/STEP model first.');
  const surfaceOnly = Boolean(state.model && !state.gray);
  for (const id of ['x', 'y', 'depth', 'feed', 'plunge', 'safe', 'stepover']) if (!Number.isFinite(Number($(id).value)) || Number($(id).value) <= 0) throw new Error('Dimensions, depth, feed, plunge, safe Z, and stepover must be greater than zero.');
  if (!Number.isFinite(Number($('maxSlope').value)) || Number($('maxSlope').value) < 0 || Number($('maxSlope').value) > 80) throw new Error('Maximum top-surface slope must be from 0 to 80 degrees.');
  for (const id of ['ox', 'oy']) if (!Number.isFinite(Number($(id).value))) throw new Error('Origin X/Y must be valid numbers.');
  const validMask = state.model ? state.surface?.outputMask : null;
  if (state.model && (!validMask || !validMask.some(Boolean))) throw new Error('No top-facing model surface was sampled. Check model orientation and slope limit.');
  const source = state.gray || { width: state.surface.width, height: state.surface.height, pixels: null, minGray: 0, maxGray: 0, radialBounds: null };
  state.gcode = generateHeightmapGcode({
    ...source, sizeX: +$('x').value, sizeY: +$('y').value, maxDepth: +$('depth').value,
    feed: +$('feed').value, plunge: +$('plunge').value, safeZ: +$('safe').value,
    spindleSpeed: +$('rpm').value, originX: +$('ox').value, originY: +$('oy').value,
    frame: $('frame').checked && !state.model, twoPass: $('twoPass').checked,
    roughAllowance: +$('roughAllowance').value, baseHeights: state.surface?.heights || null,
    validMask, pattern: $('pattern').value, stepover: +$('stepover').value,
    modelName: state.model?.name || '', surfaceOnly,
  });
  const patternLabel = $('pattern').selectedOptions[0].textContent;
  $('stats').textContent = `${source.width} × ${source.height} · ${surfaceOnly ? 'STL/STEP topography' : state.gray ? 'image relief' : 'flat image'} · ${patternLabel} · ${Math.round(state.gcode.length / 1024)} KB`;
  const lines = state.gcode.split('\n'); $('code').textContent = lines.slice(0, 65).join('\n') + (lines.length > 65 ? '\n…\n' : '');
  $('output').hidden = false; $('load').disabled = $('export').disabled = $('copy').disabled = false;
  note(`G-code generated from ${surfaceOnly ? 'model topography' : 'image relief'} using ${patternLabel}${state.model ? ` over ${Math.round(state.surface.outputCoverage * 100)}% top-surface coverage` : ''}. Review and simulate before machining.`, 'success');
}

$('file').onchange = () => {
  const file = $('file').files?.[0]; if (!file) return;
  const image = new Image();
  image.onload = () => { state.image = image; renderGray(); if (!state.model) sizeFromX(); savePreferences(); note(grayscaleMappingMessage(state.gray), 'success'); URL.revokeObjectURL(image.src); };
  image.onerror = () => note('Could not read that image. Choose another supported image.', 'error');
  image.src = URL.createObjectURL(file);
};
$('modelFile').onchange = () => loadModel($('modelFile').files?.[0]);
$('clearModel').onclick = () => {
  state.model = null; state.surface = null;
  if (state.flatOptions) { $('ratio').checked = state.flatOptions.ratio; $('frame').checked = state.flatOptions.frame; state.flatOptions = null; }
  updateModelControls(); refreshSurface();
  if (state.gray) sizeFromX();
  state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
  note('Model removed. Image engraving will use a flat Z0 surface.');
};
$('invert').onchange = () => { renderGray(); note(grayscaleMappingMessage(state.gray)); };
$('samplingLimit').onchange = () => {
  savePreferences();
  if (state.image) { renderGray(); note(`${grayscaleMappingMessage(state.gray)} Sampling limit set to ${Number($('samplingLimit').value).toLocaleString()} points.`); }
  else if (state.model) {
    refreshSurface(); state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
    note(`Model topography sampled at up to ${Number($('samplingLimit').value).toLocaleString()} points. Generate G-code to review the result.`);
  }
};
$('maxSlope').onchange = () => { if (state.model && state.gray) { refreshSurface(); state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true; } savePreferences(); };
$('x').onchange = () => { sizeFromX(); savePreferences(); };
$('y').onchange = () => { sizeFromY(); savePreferences(); };
$('ratio').onchange = () => { if ($('ratio').checked) sizeFromX(); savePreferences(); };
$('pattern').onchange = () => {
  $('patternHint').textContent = ({
    auto: 'Automatic uses an inside-out 3D relief spiral for model-only work, an oval spiral for detected oval images, and raster for other images.',
    raster: 'Parallel rows retract and reposition between passes.',
    'makera-parallel': 'Makera-style 3D Relief parallel strategy: reciprocating rows stay engaged between adjacent passes when the top-surface mask is continuous.',
    crosshatch: 'Crosshatch adds a perpendicular finishing pass to reduce direction-dependent ridges; it takes about twice the finish time.',
    radial: 'Elliptical spiral moves from the center outward and may leave corners uncut.',
    'offset-inside': 'Makera-style relief spiral links nested elliptical passes from the center outward. It retracts only where a gap in the sampled top surface prevents a safe link.',
    'offset-outside': 'Makera-style relief spiral links nested elliptical passes from the outside inward. It retracts only where a gap in the sampled top surface prevents a safe link.',
  })[$('pattern').value];
  savePreferences();
};
$('twoPass').onchange = () => { $('twoPassHint').hidden = !$('twoPass').checked; savePreferences(); };
$('rpm').oninput = () => { $('rpmValue').value = `${Number($('rpm').value).toLocaleString()} RPM`; savePreferences(); };
$('make').onclick = () => { try { makeGcode(); } catch (error) { note(error.message, 'error'); } };
$('load').onclick = async () => {
  const button = $('load'); button.disabled = true; button.textContent = 'Loading…';
  try {
    if (!state.gcode) makeGcode();
    const fileName = 'image-heightmap-engraving.nc';
    await gcode.loadToVisualizer(state.gcode, fileName);
    try {
      await navigation.navigateToCarve();
      note(`Loaded ${fileName} and opened Carve for review. No CNC job was started.`, 'success');
    } catch (error) {
      note(`Loaded ${fileName}, but could not open Carve: ${error?.message || error}. No CNC job was started.`, 'error');
    }
  } catch (error) { note(`Could not load into Carve: ${error?.message || error}. Check Visualizer Load permission.`, 'error'); }
  finally { button.disabled = !state.gcode; button.textContent = 'Load into Carve'; }
};
$('export').onclick = async () => {
  if (!state.gcode) return;
  const button = $('export'); button.disabled = true;
  try {
    const result = await file.openSaveDialog({
      content: state.gcode,
      options: { defaultFileName: 'image-heightmap-engraving.nc', title: 'Save heightmap G-code', filters: [{ name: 'G-code files', extensions: ['nc', 'gcode', 'tap'] }] },
    });
    note(result.success ? 'G-code saved to the selected location.' : 'G-code save canceled.', result.success ? 'success' : '');
  } catch (error) { note(`Could not save G-code: ${error?.message || error}. Check File Save permission.`, 'error'); }
  finally { button.disabled = !state.gcode; }
};
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(state.gcode); note('G-code copied to clipboard.', 'success'); } catch { note('Clipboard access is unavailable in this gSender view. Use Save G-code instead.', 'error'); } };
$('rpmValue').value = `${Number($('rpm').value).toLocaleString()} RPM`;
$('pattern').onchange();
$('twoPassHint').hidden = !$('twoPass').checked;
updateModelControls();
savePreferences();
