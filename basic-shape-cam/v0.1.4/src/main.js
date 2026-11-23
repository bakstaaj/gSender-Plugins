import { file, gcode, storage } from '@sienci/gsender-plugin-sdk';
import { generateGcode, makeToolpath } from './geometry.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  shape: 'rectangle', compensation: 'outside', width: 50, height: 30, sides: 6,
  originX: 0, originY: 0, depth: 3, stepDown: 1, safeZ: 5, materialIndex: 0, toolIndex: 0,
  materials: [
    { name: 'Softwood', rpm: 12000, feed: 1200, plunge: 300 },
    { name: 'Hardwood', rpm: 16000, feed: 900, plunge: 220 },
    { name: 'MDF', rpm: 16000, feed: 1100, plunge: 250 },
  ],
  tools: [
    { name: '1/4 in end mill', number: 1, diameter: 6.35 },
    { name: '1/8 in end mill', number: 2, diameter: 3.175 },
  ],
};
const state = { settings: structuredClone(DEFAULTS), generated: '', points: [] };

document.querySelector('#app').innerHTML = `
  <header class="page-header"><div class="eyebrow">Quick 2D profile toolpaths</div><h1>Basic Shape CAM</h1><p>Choose a shape, set dimensions and cutting parameters, then load or save a G-code profile to review in gSender.</p></header>
  <section class="panel"><div class="section-heading"><div><div class="step">01 · SHAPE</div><h2>Choose geometry and size</h2></div><span class="status">Millimeters</span></div>
    <div class="form-grid">
      <label>Shape<select id="shape"><option value="rectangle">Rectangle</option><option value="square">Square</option><option value="circle">Circle</option><option value="oval">Oval / ellipse</option><option value="slot">Slot</option><option value="triangle">Triangle</option><option value="polygon">Regular polygon</option></select></label>
      <label id="widthLabel">Width (mm)<input id="width" type="number" min="1" step="0.1"></label>
      <label id="heightLabel">Height (mm)<input id="height" type="number" min="1" step="0.1"></label>
      <label id="sidesLabel" hidden>Sides<input id="sides" type="number" min="3" max="32" step="1"></label>
      <label>Center X (mm)<input id="originX" type="number" step="0.1"></label>
      <label>Center Y (mm)<input id="originY" type="number" step="0.1"></label>
      <label>Toolpath location<select id="compensation"><option value="outside">Outside shape</option><option value="inside">Inside shape</option><option value="on">On the line</option></select></label>
    </div>
    <p id="shapeHint" class="hint"></p>
  </section>
  <section class="panel"><div class="section-heading"><div><div class="step">02 · CUT SETTINGS</div><h2>Choose material, tool, and depth</h2></div></div>
    <div class="form-grid">
      <label>Material preset<select id="materialSelect"></select></label>
      <label>Tool preset<select id="toolSelect"></select></label>
      <label>Total depth (mm)<input id="depth" type="number" min="0.1" step="0.1"></label>
      <label>Depth per pass (mm)<input id="stepDown" type="number" min="0.1" step="0.1"></label>
      <label>Safe Z (mm)<input id="safeZ" type="number" min="0.1" step="0.1"></label>
    </div>
    <div class="preset-managers">
      <details><summary>Manage materials</summary><div class="preset-grid">
        <label>Material name<input id="materialName" placeholder="e.g. Baltic birch"></label><label>Spindle speed (RPM)<input id="materialRpm" type="number" min="1"></label><label>Feed rate (mm/min)<input id="materialFeed" type="number" min="1"></label><label>Plunge rate (mm/min)<input id="materialPlunge" type="number" min="1"></label>
        <div class="preset-actions"><button id="saveMaterial">Save as new material</button><button id="deleteMaterial" class="secondary">Delete selected material</button></div>
      </div></details>
      <details><summary>Manage tools</summary><div class="preset-grid">
        <label>Tool name<input id="toolName" placeholder="e.g. 1/8 in end mill"></label><label>Tool number<input id="toolNumber" type="number" min="1" step="1"></label><label>Diameter (mm)<input id="toolDiameter" type="number" min="0.1" step="0.01"></label>
        <div class="preset-actions"><button id="saveTool">Save as new tool</button><button id="deleteTool" class="secondary">Delete selected tool</button></div>
      </div></details>
    </div>
    <p class="hint">Material and tool presets are saved locally in gSender. Starting feed and speed values are examples; verify them for your machine, cutter, and material.</p>
  </section>
  <div class="actions"><button id="previewButton" class="primary large">Preview toolpath</button><button id="loadButton" class="large">Load into Carve</button><button id="downloadButton" class="secondary large" disabled>Save G-code</button><span id="saveStatus" class="hint">Settings save on this device.</span></div>
  <p id="loadStatus" class="load-status" role="status" aria-live="polite">Load generates the current settings and replaces the file in gSender's visualizer. It does not start a job. Open Carve to review it.</p>
  <div id="notice" class="notice" role="status" aria-live="polite">Set up the profile and preview the generated path.</div>
  <section id="previewPanel" class="panel preview-panel" hidden><div class="section-heading"><div><div class="step">03 · PREVIEW</div><h2 id="previewTitle">Profile preview</h2></div></div><div class="preview-wrap"><svg id="preview" viewBox="0 0 600 380" role="img" aria-label="Generated profile preview"><g id="previewPath"></g></svg></div><pre id="gcodePreview"></pre><p class="caution">Profile cutting only. No pocket clearing, ramps, tabs, lead-ins, stock/clamp collision checking, or automatic job start. Review the G-code and simulate it in gSender before cutting.</p></section>
  <footer>Generated G-code can be loaded into Carve for review or saved to a file · no CNC job is started</footer>
`;

function showNotice(message, kind = '') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function formSettings() {
  return {
    ...state.settings,
    shape: $('shape').value, compensation: $('compensation').value,
    width: Number($('width').value), height: Number($('height').value), sides: Number($('sides').value),
    originX: Number($('originX').value), originY: Number($('originY').value),
    depth: Number($('depth').value), stepDown: Number($('stepDown').value), safeZ: Number($('safeZ').value),
    materialIndex: Number($('materialSelect').value), toolIndex: Number($('toolSelect').value),
  };
}
function fillFields() {
  for (const key of ['shape', 'compensation', 'width', 'height', 'sides', 'originX', 'originY', 'depth', 'stepDown', 'safeZ']) $(key).value = state.settings[key];
  renderShapeFields(); renderPresetLists();
}
function renderShapeFields() {
  const shape = $('shape').value;
  $('widthLabel').hidden = false; $('heightLabel').hidden = !['rectangle', 'oval', 'triangle', 'slot'].includes(shape); $('sidesLabel').hidden = shape !== 'polygon';
  $('widthLabel').firstChild.textContent = ({ circle: 'Diameter (mm)', polygon: 'Across-corners diameter (mm)', slot: 'Overall length (mm)' }[shape] || 'Width (mm)');
  if (shape === 'slot') $('heightLabel').firstChild.textContent = 'Slot width (mm)';
  else $('heightLabel').firstChild.textContent = 'Height (mm)';
  $('shapeHint').textContent = ({
    rectangle: 'Rectangle profile, centered on the entered X/Y position.',
    square: 'Square profile, centered on the entered X/Y position.',
    circle: 'Circle profile. Diameter is measured to the nominal shape; tool compensation is applied separately.',
    oval: 'Oval/ellipse profile approximated by short straight G1 segments.',
    slot: 'Capsule slot centered on X/Y. Enter overall length and slot width; each end is a semicircle with radius equal to half the slot width.',
    triangle: 'Isosceles triangle profile with a horizontal base, centered on the entered X/Y position.',
    polygon: 'Regular polygon with the requested number of sides. Size is specified across opposite corners.',
  })[shape];
}
function renderPresetLists() {
  $('materialSelect').innerHTML = state.settings.materials.map((item, i) => `<option value="${i}">${escapeHtml(item.name)}</option>`).join('');
  $('toolSelect').innerHTML = state.settings.tools.map((item, i) => `<option value="${i}">${escapeHtml(item.name)} · ${Number(item.diameter).toFixed(3)} mm</option>`).join('');
  $('materialSelect').value = Math.min(state.settings.materialIndex || 0, state.settings.materials.length - 1);
  $('toolSelect').value = Math.min(state.settings.toolIndex || 0, state.settings.tools.length - 1);
  syncPresetEditors();
}
function syncPresetEditors() {
  const material = state.settings.materials[Number($('materialSelect').value)];
  const tool = state.settings.tools[Number($('toolSelect').value)];
  if (material) { $('materialName').value = material.name; $('materialRpm').value = material.rpm; $('materialFeed').value = material.feed; $('materialPlunge').value = material.plunge; }
  if (tool) { $('toolName').value = tool.name; $('toolNumber').value = tool.number; $('toolDiameter').value = tool.diameter; }
}
async function saveSettings() {
  state.settings = formSettings();
  try { await storage.set('basicShapeCamSettings', state.settings); $('saveStatus').textContent = 'Saved on this device'; }
  catch (error) { $('saveStatus').textContent = `Could not save: ${error.message}`; }
}
function makePreview(points) {
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1); const scale = 300 / span;
  const centerX = (minX + maxX) / 2; const centerY = (minY + maxY) / 2;
  const coordinates = points.map((p) => `${300 + (p.x - centerX) * scale},${190 - (p.y - centerY) * scale}`).join(' ');
  $('previewPath').innerHTML = `<polyline points="${coordinates} ${coordinates.split(' ')[0]}" />`;
  $('previewTitle').textContent = `${$('shape').selectedOptions[0].text} · ${$('compensation').selectedOptions[0].text}`;
  $('previewPanel').hidden = false;
}
function validate(settings, material, tool) {
  if (!material || !tool) throw new Error('Add at least one material and one tool preset.');
  const positive = [['shape width/diameter', settings.width], ['shape height', settings.height], ['cut depth', settings.depth], ['depth per pass', settings.stepDown], ['safe Z', settings.safeZ], ['tool diameter', Number(tool.diameter)], ['feed', Number(material.feed)], ['plunge rate', Number(material.plunge)], ['spindle speed', Number(material.rpm)]];
  for (const [label, value] of positive) if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero.`);
  if (settings.shape === 'polygon' && (!Number.isInteger(settings.sides) || settings.sides < 3 || settings.sides > 32)) throw new Error('Regular polygon sides must be an integer from 3 to 32.');
  if (settings.shape === 'rectangle' && (!Number.isFinite(settings.height) || settings.height <= 0)) throw new Error('Rectangle height must be greater than zero.');
  if (settings.shape === 'oval' && (!Number.isFinite(settings.height) || settings.height <= 0)) throw new Error('Oval height must be greater than zero.');
  if (settings.shape === 'slot' && (!Number.isFinite(settings.height) || settings.height <= 0)) throw new Error('Slot width must be greater than zero.');
  if (settings.shape === 'slot' && settings.width < settings.height) throw new Error('Slot overall length must be at least as large as its width.');
  if (settings.shape === 'triangle' && (!Number.isFinite(settings.height) || settings.height <= 0)) throw new Error('Triangle height must be greater than zero.');
  if (!Number.isFinite(settings.originX) || !Number.isFinite(settings.originY)) throw new Error('Shape center X/Y must be valid numbers.');
  const toolRadius = Number(tool.diameter) / 2;
  let insideLimit = Math.min(settings.width, settings.height || settings.width) / 2;
  if (settings.shape === 'triangle') {
    const area = settings.width * settings.height / 2;
    const semiperimeter = (settings.width + 2 * Math.hypot(settings.width / 2, settings.height)) / 2;
    insideLimit = area / semiperimeter;
  } else if (settings.shape === 'polygon') {
    insideLimit = settings.width / 2 * Math.cos(Math.PI / settings.sides);
  } else if (settings.shape === 'circle') insideLimit = settings.width / 2;
  if (settings.compensation === 'inside' && toolRadius >= insideLimit) throw new Error('The selected tool is too large for an inside profile of this shape.');
  if (Math.ceil(settings.depth / settings.stepDown) > 500) throw new Error('Depth per pass would create more than 500 passes. Increase the step-down or reduce total depth.');
  if (settings.safeZ <= 0) throw new Error('Safe Z must be a positive clearance height.');
}
function generate(announce = true) {
  const settings = formSettings(); const material = state.settings.materials[settings.materialIndex]; const tool = state.settings.tools[settings.toolIndex];
  validate(settings, material, tool);
  state.points = makeToolpath(settings.shape, settings, settings.compensation, Number(tool.diameter), { x: settings.originX, y: settings.originY });
  state.generated = generateGcode({ shape: settings.shape, shapeName: $('shape').selectedOptions[0].text, path: state.points, values: settings, material, tool, settings });
  makePreview(state.points);
  $('gcodePreview').textContent = state.generated.split('\n').slice(0, 55).join('\n') + (state.generated.split('\n').length > 55 ? '\n...\n' : '');
  $('downloadButton').disabled = false;
  $('loadButton').disabled = false;
  if (announce) showNotice(`Preview ready: ${Math.ceil(settings.depth / settings.stepDown)} depth pass(es), ${state.points.length} outline points. No job has been sent to the CNC.`, 'success');
}
async function loadIntoCarve() {
  const button = $('loadButton');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  $('loadStatus').textContent = 'Generating the current toolpath…';
  $('loadStatus').className = 'load-status';
  try {
    await saveSettings();
    generate(false);
    const shapeLabel = $('shape').value.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const fileName = `${shapeLabel}-profile.nc`;
    button.textContent = 'Loading…';
    $('loadStatus').textContent = `Sending ${fileName} to gSender's visualizer…`;
    await gcode.loadToVisualizer(state.generated, fileName);
    $('loadStatus').textContent = `Loaded ${fileName} into gSender's visualizer. Open Carve to review it. No job was started.`;
    $('loadStatus').className = 'load-status success';
  } catch (error) {
    const message = error?.message || String(error);
    $('loadStatus').textContent = `Load failed: ${message}. Check the plugin's Visualizer Load permission and CNC connection.`;
    $('loadStatus').className = 'load-status error';
  } finally {
    button.textContent = originalLabel;
    button.disabled = false;
  }
}
async function initialize() {
  try {
    const saved = await storage.get('basicShapeCamSettings');
    if (saved && typeof saved === 'object') {
      state.settings = { ...DEFAULTS, ...saved, materials: Array.isArray(saved.materials) ? saved.materials : DEFAULTS.materials, tools: Array.isArray(saved.tools) ? saved.tools : DEFAULTS.tools };
    }
  } catch (error) { $('saveStatus').textContent = `Using defaults: ${error.message}`; }
  fillFields();
}

$('shape').onchange = () => { renderShapeFields(); saveSettings(); };
$('materialSelect').onchange = () => { state.settings.materialIndex = Number($('materialSelect').value); syncPresetEditors(); saveSettings(); };
$('toolSelect').onchange = () => { state.settings.toolIndex = Number($('toolSelect').value); syncPresetEditors(); saveSettings(); };
document.querySelectorAll('input,select').forEach((control) => control.addEventListener('change', () => saveSettings()));
$('previewButton').onclick = async () => { await saveSettings(); try { generate(); } catch (error) { showNotice(error.message, 'error'); } };
$('loadButton').onclick = loadIntoCarve;
$('downloadButton').onclick = async () => {
  if (!state.generated) return;
  const safeName = $('shape').value.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const fileName = `${safeName}-profile.nc`;
  const button = $('downloadButton');
  button.disabled = true;
  try {
    const result = await file.openSaveDialog({
      content: state.generated,
      options: {
        defaultFileName: fileName,
        title: 'Save G-code profile',
        filters: [{ name: 'G-code files', extensions: ['nc', 'gcode', 'tap'] }],
      },
    });
    if (result.success) showNotice(`Saved ${fileName} to the selected location.`, 'success');
    else showNotice('G-code save canceled.', '');
  } catch (error) {
    showNotice(`Could not save G-code: ${error?.message || error}`, 'error');
  } finally {
    button.disabled = false;
  }
};
$('saveMaterial').onclick = async () => {
  const item = { name: $('materialName').value.trim(), rpm: Number($('materialRpm').value), feed: Number($('materialFeed').value), plunge: Number($('materialPlunge').value) };
  if (!item.name || Object.values(item).slice(1).some((v) => !Number.isFinite(v) || v <= 0)) return showNotice('Enter a material name and positive spindle, feed, and plunge rates.', 'error');
  state.settings.materials.push(item); state.settings.materialIndex = state.settings.materials.length - 1; renderPresetLists(); await saveSettings(); showNotice(`Saved material preset: ${item.name}.`, 'success');
};
$('deleteMaterial').onclick = async () => {
  if (state.settings.materials.length <= 1) return showNotice('Keep at least one material preset.', 'error');
  state.settings.materials.splice(Number($('materialSelect').value), 1); state.settings.materialIndex = 0; renderPresetLists(); await saveSettings(); showNotice('Selected material preset deleted.', 'success');
};
$('saveTool').onclick = async () => {
  const item = { name: $('toolName').value.trim(), number: Number($('toolNumber').value), diameter: Number($('toolDiameter').value) };
  if (!item.name || !Number.isInteger(item.number) || item.number < 1 || !Number.isFinite(item.diameter) || item.diameter <= 0) return showNotice('Enter a tool name, positive tool number, and positive diameter.', 'error');
  state.settings.tools.push(item); state.settings.toolIndex = state.settings.tools.length - 1; renderPresetLists(); await saveSettings(); showNotice(`Saved tool preset: ${item.name}.`, 'success');
};
$('deleteTool').onclick = async () => {
  if (state.settings.tools.length <= 1) return showNotice('Keep at least one tool preset.', 'error');
  state.settings.tools.splice(Number($('toolSelect').value), 1); state.settings.toolIndex = 0; renderPresetLists(); await saveSettings(); showNotice('Selected tool preset deleted.', 'success');
};
initialize();
