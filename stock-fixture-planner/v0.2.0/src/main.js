import { gcode, storage } from '@sienci/gsender-plugin-sdk';
import { analyzeNc, chooseStock, DEFAULT_TOOLS, generatePlan, methodXYMargins, mountingLayoutForStock, recommendTool, toolDiameterMm } from './planner.js';
import recoveredSettings from './recovered-settings.json';
import './style.css';
import clampReference from './clamp-reference.png';

const $ = (id) => document.getElementById(id);
const defaults = {
  collet: '6.35', feature: 3, margin: 5, countersinkDiameter: 10, roughingOffset: 1, roughingOffsetUsesPassDepth: true, safeZ: 5, passDepth: 1, feed: 500, plunge: 150,
  tools: DEFAULT_TOOLS,
  billets: [{ name: '3 x 3 x 1/2 in', length: 76.2, width: 76.2, thickness: 12.7, material: 'Unspecified' }, { name: '4 x 4 x 3/4 in', length: 101.6, width: 101.6, thickness: 19.05, material: 'Unspecified' }, { name: '6 x 6 x 1 in', length: 152.4, width: 152.4, thickness: 25.4, material: 'Unspecified' }],
  fixture: { clamps: [{ name: 'Low profile clamp', maxHeight: 12, reach: 20 }], vise: { name: 'Configured vise', jawWidth: 75, maxOpening: 80, jawHeight: 20, centerX: '', centerY: '' }, holes: [], alignmentHoles: [] },
  plateFiles: {}
};
const FALLBACK_STORAGE_KEY = 'com.bakstaaj.stock-fixture-planner.settings.v1';
let cachedSettings = null;
try { cachedSettings = JSON.parse(localStorage.getItem(FALLBACK_STORAGE_KEY) || 'null'); } catch {}
const hasCachedSettings = Boolean(cachedSettings);
const initialSettings = { ...defaults, ...recoveredSettings, ...(cachedSettings || {}), fixture: { ...defaults.fixture, ...recoveredSettings.fixture, ...(cachedSettings?.fixture || {}) }, plateFiles: cachedSettings?.plateFiles || recoveredSettings.plateFiles || {} };
if (!Object.hasOwn(cachedSettings || {}, 'roughingOffset') && !Object.hasOwn(recoveredSettings, 'roughingOffset')) initialSettings.roughingOffset = Number(initialSettings.passDepth) || Number(defaults.passDepth);
delete initialSettings.thickness;
const state = { settings: structuredClone(initialSettings), savedFixture: structuredClone(initialSettings.fixture), savedBillets: (initialSettings.billets || defaults.billets).map(normalizeBillet), savedTools: (initialSettings.tools || DEFAULT_TOOLS).map(normalizeTool), plateFiles: structuredClone(initialSettings.plateFiles), savedPlateFiles: structuredClone(initialSettings.plateFiles), roughingOffsetAuto: initialSettings.roughingOffsetUsesPassDepth !== false, settingsReady: true, storageSynced: false, userEdited: false, saveSection: '', plateDirty: false, fixtureDirty: false, billetDirty: false, toolsDirty: false, part: null, fileName: '', gcode: '' };

document.querySelector('#app').innerHTML = `
<header><div class="eyebrow">STOCK PREPARATION · 2D NC ENVELOPE</div><h1>Stock &amp; Fixture Planner</h1><p>Read a part program’s motion envelope, choose a billet and workholding plan, then review stock-preparation G-code in Carve.</p></header>
<nav class="tabs" role="tablist" aria-label="Planner setup steps"><button type="button" role="tab" id="tab-dashboard-button" aria-selected="true" aria-controls="tab-dashboard" data-tab="dashboard">Overview</button><button type="button" role="tab" id="tab-stock-button" aria-selected="false" aria-controls="tab-stock" data-tab="stock" tabindex="-1">1 · Billet Stock</button><button type="button" role="tab" id="tab-tools-button" aria-selected="false" aria-controls="tab-tools" data-tab="tools" tabindex="-1">2 · Cutting Tools</button><button type="button" role="tab" id="tab-bedplate-button" aria-selected="false" aria-controls="tab-bedplate" data-tab="bedplate" tabindex="-1">3 · Bed Plate</button><button type="button" role="tab" id="tab-tracks-button" aria-selected="false" aria-controls="tab-tracks" data-tab="tracks" tabindex="-1">4 · T-Tracks</button><button type="button" role="tab" id="tab-clamps-button" aria-selected="false" aria-controls="tab-clamps" data-tab="clamps" tabindex="-1">5 · Surface Clamps</button><button type="button" role="tab" id="tab-vise-button" aria-selected="false" aria-controls="tab-vise" data-tab="vise" tabindex="-1">6 · Vise</button><button type="button" role="tab" id="tab-fixtures-button" aria-selected="false" aria-controls="tab-fixtures" data-tab="fixtures" tabindex="-1">7 · Other Fixtures</button><button type="button" role="tab" id="tab-plan-button" aria-selected="false" aria-controls="tab-plan" data-tab="plan" tabindex="-1">Plan a Part</button></nav>
<section class="tab-page panel overview-page" id="tab-dashboard" role="tabpanel" aria-labelledby="tab-dashboard-button" data-tab-page="dashboard"><div class="step">SETUP STATUS</div><h2>Workholding setup overview</h2><p>Configure reusable machine resources first. The part planner can then use these inventories when preparing a job.</p><div id="setupDashboard" class="dashboard-grid"></div><div class="actions"><button type="button" data-go-tab="stock">Start with billet stock</button><button type="button" data-go-tab="plan">Plan a part</button></div></section>
<div class="tab-page" id="tab-plan" role="tabpanel" aria-labelledby="tab-plan-button" data-tab-page="plan" hidden>
<section class="panel"><div class="step">01 · SOURCE PART</div><h2>Upload the part NC file</h2><label class="file">Part NC file<input id="file" type="file" accept=".nc,.tap,.gcode,.g,.ngc,.txt"></label><div id="partStatus" class="status">No source file loaded.</div><div id="envelope" class="envelope" hidden></div><div id="boundingCube" class="bounding-cube" hidden><svg id="isoView" viewBox="0 0 560 300" role="img" aria-labelledby="isoTitle isoDesc"><title id="isoTitle">Isometric part bounding box</title><desc id="isoDesc">Proportional isometric drawing of the loaded NC motion envelope</desc><g id="isoEdges"></g><g id="isoLabels"></g></svg><div id="isoDimensions" class="iso-dimensions"></div></div><p class="hint">Envelope scanning reads G0–G3 XYZ motion, G20/G21, G90/G91, and I/J arcs. Dimensions use the file's final G20/G21 unit mode. It ignores canned cycles, subprograms, macros, tool length offsets, and machine-coordinate moves. Check the bounds against a trusted CAM preview.</p></section>
<section class="panel"><div class="step">02 · WORKHOLDING</div><h2>Choose the hold-down method</h2><div class="strategy workholding-methods" role="radiogroup" aria-label="Hold-down method"><label class="method-option"><input type="radio" name="strategy" value="bottomSurface"><span><strong>Bottom Surface</strong><small>Vacuum, double-sided tape, CA glue</small></span></label><label class="method-option"><input type="radio" name="strategy" value="perimeterSurface" checked><span><strong>Perimeter Surface</strong><small>Toe and edge clamps</small></span></label><label class="method-option"><input type="radio" name="strategy" value="topSurface"><span><strong>Top Surface</strong><small>Strap and top clamps</small></span></label><label class="method-option"><input type="radio" name="strategy" value="fastening"><span><strong>Fastening</strong><small>Bolts, screws, T-track hardware</small></span></label><label class="method-option"><input type="radio" name="strategy" value="fixture"><span><strong>Fixture</strong><small>Vise or dedicated hard fixture</small></span></label></div><div class="grid compact" id="mountingOptions"><label id="boltHeadOption">Bolt head pocket diameter (mm)<input id="countersinkDiameter" type="number" min="5.1" step="0.1"></label><label>Part-area Z roughing offset (mm)<input id="roughingOffset" type="number" min="0" step="0.1"></label><p class="hint" id="roughingHelp">The planner pockets the planned part area to part depth plus this offset, then cuts the outside profile while leaving two holding tabs. In Fastening mode, it also drills through and counterbores the mounting holes.</p></div><p id="mountingPlanStatus" class="hint">Mounting-hole mode uses two symmetric bed-plate bolt holes. Alignment-pin holes are reserved for alignment in clamp setups and are not hold-down points.</p>
<div class="grid compact"><label>Pass depth (mm)<input id="passDepth" type="number" min="0.1" step="0.1"></label><label>Safe Z (mm)<input id="safeZ" type="number" min="0.1" step="0.1"></label><label>Feed (mm/min)<input id="feed" type="number" min="1"></label><label>Plunge (mm/min)<input id="plunge" type="number" min="1"></label></div></section>\n<section class="panel"><div class="step">03 · STOCK AND TOOL</div><h2>Choose the starting billet and cutter</h2><div class="grid">
<label>Installed collet<select id="collet"><option value="3">3 mm</option><option value="3.175">1/8 in</option><option value="4">4 mm</option><option value="6">6 mm</option><option value="6.35">1/4 in</option></select></label>
<label>Smallest feature / clearance (mm)<input id="feature" type="number" min="0.1" step="0.1"></label><label>XY stock edge margin (mm)<input id="margin" type="number" min="0" step="0.1"></label>
<label>Recommended cutter<select id="tool" disabled></select></label><label>Raw billet<select id="billet"></select></label>
</div><p id="stockStatus" class="hint"></p></section>
<div class="actions"><button id="generate" class="primary">Generate preparation file</button><button id="load" disabled>Load into Carve</button><button id="download" disabled>Download G-code</button></div><div id="notice" role="status"></div>
<section class="panel" id="result" hidden><div class="step">04 · REVIEW</div><h2>Preparation G-code</h2><p id="summary"></p><pre id="preview"></pre><p class="caution">This draft uses envelope-derived coordinates and fixture data you provide. Verify actual screw head fit, tool changes, work zero, controller dialect, and stock retention. Inspect the full toolpath in Carve and simulate it before machining. Loading replaces the currently loaded visualizer file; it does not start a job.</p></section>
</div>
<section class="tab-page panel" id="tab-stock" role="tabpanel" aria-labelledby="tab-stock-button" data-tab-page="stock" hidden><div class="step">CONFIGURATION · RAW STOCK</div><h2>Available raw stock</h2><p>Maintain the billets available for stock selection. Dimensions are in millimeters; material is descriptive inventory information.</p><div class="csv-controls"><label>Import stock CSV<input id="stockCsvImport" type="file" accept=".csv,text/csv"></label><button type="button" data-copy-csv="stock">Copy stock CSV</button></div><div id="stockInventoryEditor"></div><div class="plate-save-row"><button type="button" id="saveBillets" class="primary" disabled>Save Raw Stock Inventory</button><span id="stockInventoryStatus" class="file-status" role="status" aria-live="polite">Loading saved configuration…</span></div><p class="hint">The planner checks length, width, and thickness when matching a billet to a part. Unsaved edits can be used for the current plan, but click Save Raw Stock Inventory to preserve them.</p></section>
<section class="tab-page panel" id="tab-tools" role="tabpanel" aria-labelledby="tab-tools-button" data-tab-page="tools" hidden><div class="step">CONFIGURATION · CUTTING TOOLS</div><h2>Available tools</h2><p>Maintain the end mills and drills available on your machine. Enter each diameter in millimeters or inches. Inch diameters are converted to millimeters for collet and feature-fit checks.</p><div class="csv-controls"><label>Import tools CSV<input id="toolsCsvImport" type="file" accept=".csv,text/csv"></label><button type="button" data-copy-csv="tools">Copy tools CSV</button></div><div id="toolInventoryEditor"></div><div class="plate-save-row"><button type="button" id="saveTools" class="primary" disabled>Save Tool Inventory</button><span id="toolInventoryStatus" class="file-status" role="status" aria-live="polite">Loading saved configuration…</span></div><p class="hint">The part planner recommends from configured end mills that fit the installed collet, feature clearance, and (when selected) mounting-hole diameter. Drills are saved in the inventory; generated mounting holes and bolt-head pockets are currently milled with the selected end mill.</p></section>
<section class="tab-page panel" id="tab-bedplate" role="tabpanel" aria-labelledby="tab-bedplate-button" data-tab-page="bedplate" hidden><div class="step">CONFIGURATION · WORKHOLDING</div><h2>Bed plate and fixture setup</h2><div id="asset-bedplate" class="asset-manager"></div><p>Upload one complete bed-plate DXF. Use a closed outline on a PERIMETER/OUTLINE layer, mounting circles on a BOLTS/MOUNTING layer, and alignment circles on a PINS/ALIGNMENT layer. If layers are absent, the largest closed polyline supplies the perimeter; circles default to mounting holes unless their layer identifies pins. Review the editable hole tables before saving.</p><div id="bedplateEditor" class="fixture-editor"></div><div class="plate-file-grid legacy-plate-import" hidden>
<label class="plate-file">Bed plate perimeter NC<input id="platePerimeterFile" type="file" accept=".nc,.ngc,.tap,.gcode,.g,.txt"><span id="platePerimeterStatus" class="file-status">No perimeter file loaded.</span></label>
<label class="plate-file">Bed plate bolt-hole NC<input id="plateBoltsFile" type="file" accept=".nc,.ngc,.tap,.gcode,.g,.txt"><span id="plateBoltsStatus" class="file-status">No bolt-hole file loaded.</span></label>
<label class="plate-file">Bed plate alignment-pin NC<input id="platePinsFile" type="file" accept=".nc,.ngc,.tap,.gcode,.g,.txt"><span id="platePinsStatus" class="file-status">No alignment-pin file loaded.</span></label></div>
<div id="plateIsoPanel" class="plate-iso-panel" hidden><h3>Combined bed plate layout</h3><svg id="plateIso" viewBox="0 0 700 370" role="img" aria-label="Combined isometric bed plate NC geometry"><g id="plateIsoBox"></g><g id="plateIsoPaths"></g></svg><div class="plate-legend"><span class="legend-perimeter">Perimeter</span><span class="legend-bolts">Bolt holes</span><span class="legend-pins">Alignment pins</span></div><div id="plateIsoDimensions" class="iso-dimensions"></div></div>
<div class="plate-save-row legacy-plate-import" hidden><button type="button" id="savePlateFiles" class="primary" disabled>Save Bed Plate Configuration</button><span id="plateSaveStatus" class="file-status" role="status" aria-live="polite">Upload all three NC files, then save to preserve the combined layout.</span></div>
<p class="hint">Perimeter is blue, bolt holes orange, and alignment pins green. Saved data contains the perimeter XY bounds and each hole's XY center, diameter, and type; Z depth and the source toolpaths are not saved. Verify the coordinates against your actual bed before using the layout.</p>
<h2>Bed plate hole table</h2><p class="hint">Review mounting bolt and alignment-pin locations in millimeters, measured from the bed-plate datum. Bolt holes are used for mounting-hole plans; alignment pins locate stock.</p><div id="fixtureEditor" class="fixture-editor" hidden aria-hidden="true"></div><div class="plate-save-row"><button type="button" id="saveFixture" class="primary" disabled>Save Fixture Configuration</button><span id="fixtureSaveStatus" class="file-status" role="status" aria-live="polite">Loading saved configuration…</span></div><p class="hint">The part's required thickness comes from its NC Z envelope; the selected billet supplies stock thickness. Mounting-bolt through-holes are cut through that billet thickness.</p></section>
<section class="tab-page panel" id="tab-tracks" role="tabpanel" aria-labelledby="tab-tracks-button" data-tab-page="tracks" hidden><div class="step">CONFIGURATION · T-TRACKS</div><h2>T-track inventory</h2><p>Upload a DXF for each track layout. Extracted extents and geometry are shown as editable setup data.</p><div id="asset-tracks" class="asset-manager"></div></section><section class="tab-page panel" id="tab-clamps" role="tabpanel" aria-labelledby="tab-clamps-button" data-tab-page="clamps" hidden><div class="step">CONFIGURATION · SURFACE CLAMPS</div><h2>Surface clamp inventory</h2><p>Record the clamp’s working height, contact width, and reach range from the mounting bolt center.</p><div class="clamp-diagram" role="group" aria-label="Surface clamp measurement guide">
<img class="clamp-reference-image" src="${clampReference}" alt="Isometric surface clamp with callouts for width, height, overlap, and reach">
<div class="clamp-diagram-note">Width, height, and overlap describe the clamp envelope to keep clear around the part. Reach is the distance from the clamp contact edge to its mounting point; record the minimum and maximum positions that can reach a bed-plate bolt hole or T-slot track.</div>
</div><div id="clampEditor" class="fixture-editor"></div><div class="plate-save-row"><button type="button" class="primary" data-save-workholding>Save Workholding Configuration</button><span class="file-status" data-workholding-status>Changes are saved with the workholding configuration.</span></div></section><section class="tab-page panel" id="tab-vise" role="tabpanel" aria-labelledby="tab-vise-button" data-tab-page="vise" hidden><div class="step">CONFIGURATION · VISE</div><h2>Vise configuration</h2><p>Enter vise jaw and opening dimensions, and locate the center of the open jaws from the bed-plate XY datum.</p><div id="viseEditor" class="fixture-editor"></div><div class="plate-save-row"><button type="button" class="primary" data-save-workholding>Save Workholding Configuration</button><span class="file-status" data-workholding-status>Changes are saved with the workholding configuration.</span></div></section><section class="tab-page panel" id="tab-fixtures" role="tabpanel" aria-labelledby="tab-fixtures-button" data-tab-page="fixtures" hidden><div class="step">CONFIGURATION · OTHER FIXTURES</div><h2>Hard fixture inventory</h2><p>Upload dedicated fixture DXFs. Review extracted dimensions and configure clamp seats or vise alignment marks below.</p><div id="asset-fixtures" class="asset-manager"></div><div id="otherFixtureEditor" class="fixture-editor"></div><div class="plate-save-row"><button type="button" class="primary" data-save-workholding>Save Workholding Configuration</button><span class="file-status" data-workholding-status>Changes are saved with the workholding configuration.</span></div></section>
<footer>Stock &amp; Fixture Planner · generated files load for review only</footer>`;
$('saveBillets').disabled = false;
$('saveTools').disabled = false;
$('saveFixture').disabled = false;
$('stockInventoryStatus').textContent = 'Recovered configuration is loaded on this device; saves will also sync to gSender when available.';
$('fixtureSaveStatus').textContent = 'Recovered fixture and tooling data is loaded on this device; saves will also sync to gSender when available.';
$('toolInventoryStatus').textContent = 'Standard metric and inch tool sizes are loaded; click Save Tool Inventory to preserve edits.';

function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : 'success'; }
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
function fixtureInput(label, key, value, numeric = false, object = '') {
  const type = numeric ? 'number' : 'text';
  const step = numeric ? ' step="any"' : '';
  return `<label>${label}<input type="${type}"${step} data-fixture-key="${key}"${object ? ` data-fixture-object="${object}"` : ''} value="${escapeHtml(value)}"></label>`;
}
function fixtureCell(label, key, value, numeric = false) {
  return `<input type="${numeric ? 'number' : 'text'}"${numeric ? ' step="any"' : ''} aria-label="${label}" data-fixture-key="${key}" value="${escapeHtml(value)}">`;
}
function normalizeBillet(billet) {
  return { name: billet.name || 'Unnamed billet', length: Number(billet.length ?? billet.x ?? 0), width: Number(billet.width ?? billet.y ?? 0), thickness: Number(billet.thickness ?? billet.z ?? 0), material: billet.material || 'Unspecified' };
}
function normalizeTool(tool) {
  const unit = tool.unit === 'in' ? 'in' : 'mm';
  const rawDiameter = tool.diameter ?? (unit === 'in' ? Number(tool.diameterMm) / 25.4 : tool.diameterMm);
  const diameter = rawDiameter === '' || rawDiameter == null ? '' : Number(rawDiameter);
  return { name: String(tool.name || 'Unnamed tool'), type: tool.type === 'drill' ? 'drill' : 'endMill', diameter, unit };
}
function readToolInventory() {
  return [...$('toolInventoryEditor').querySelectorAll('[data-tool-row]')].map(row => normalizeTool({
    name: row.querySelector('[data-tool-key="name"]').value.trim(),
    type: row.querySelector('[data-tool-key="type"]').value,
    diameter: row.querySelector('[data-tool-key="diameter"]').value === '' ? '' : Number(row.querySelector('[data-tool-key="diameter"]').value),
    unit: row.querySelector('[data-tool-key="unit"]').value
  }));
}
function renderToolInventory(items) {
  const rows = items.map((raw,index) => { const item = normalizeTool(raw); return `<tr data-tool-row><td><input data-tool-key="name" aria-label="Tool name, row ${index+1}" value="${escapeHtml(item.name)}"></td><td><select data-tool-key="type" aria-label="Tool type, row ${index+1}"><option value="endMill"${item.type==='endMill'?' selected':''}>End mill</option><option value="drill"${item.type==='drill'?' selected':''}>Drill</option></select></td><td><input type="number" min="0.01" step="any" data-tool-key="diameter" aria-label="Diameter, row ${index+1}" value="${Number.isFinite(item.diameter)?item.diameter:''}"></td><td><select data-tool-key="unit" aria-label="Diameter units, row ${index+1}"><option value="mm"${item.unit==='mm'?' selected':''}>mm</option><option value="in"${item.unit==='in'?' selected':''}>in</option></select></td><td><button type="button" class="subtle" data-tool-remove="${index}">Remove</button></td></tr>`; }).join('');
  $('toolInventoryEditor').innerHTML = `<div class="fixture-group"><div class="fixture-group-heading"><h3>Tool inventory</h3><button type="button" id="addTool">Add tool</button></div>${items.length ? `<div class="fixture-table-scroll"><table class="fixture-table tool-table"><thead><tr><th>Name</th><th>Type</th><th>Diameter</th><th>Units</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No tools configured. Add an end mill to enable cutter recommendations.</p>'}</div>`;
  $('addTool').addEventListener('click', event => { event.preventDefault(); const next=readToolInventory(); next.push({name:'New end mill',type:'endMill',diameter:'',unit:'mm'}); renderToolInventory(next); state.userEdited=true; state.toolsDirty=true; updateToolStatus(); renderOptions(); $('toolInventoryEditor').querySelector('[data-tool-row]:last-child [data-tool-key="name"]')?.focus(); });
  $('toolInventoryEditor').querySelectorAll('[data-tool-remove]').forEach(button=>button.addEventListener('click',event=>{event.preventDefault();const next=readToolInventory();next.splice(Number(button.dataset.toolRemove),1);renderToolInventory(next);state.userEdited=true;state.toolsDirty=true;updateToolStatus();renderOptions();}));
}
function updateToolStatus() { $('toolInventoryStatus').textContent = state.toolsDirty ? 'Unsaved changes. Click Save Tool Inventory to preserve them.' : state.storageSynced ? 'Tool inventory is saved locally in gSender.' : 'Standard tool inventory is loaded on this device; gSender sync is pending.'; }
function readBilletInventory() {
  return [...$('stockInventoryEditor').querySelectorAll('[data-stock-row]')].map(row => ({
    name: row.querySelector('[data-stock-key="name"]').value.trim(),
    length: row.querySelector('[data-stock-key="length"]').value === '' ? '' : Number(row.querySelector('[data-stock-key="length"]').value),
    width: row.querySelector('[data-stock-key="width"]').value === '' ? '' : Number(row.querySelector('[data-stock-key="width"]').value),
    thickness: row.querySelector('[data-stock-key="thickness"]').value === '' ? '' : Number(row.querySelector('[data-stock-key="thickness"]').value),
    material: row.querySelector('[data-stock-key="material"]').value.trim()
  }));
}
function renderBilletInventory(items) {
  const headers = ['Name','Length (mm)','Width (mm)','Thickness (mm)','Material'];
  const fields = ['name','length','width','thickness','material'];
  const rows = items.map((raw,index) => {
    const item = { name:raw.name ?? '', length:raw.length ?? raw.x ?? '', width:raw.width ?? raw.y ?? '', thickness:raw.thickness ?? raw.z ?? '', material:raw.material ?? '' };
    return `<tr data-stock-row>${fields.map((field,column) => `<td>${fixtureCell(`${headers[column]}, row ${index+1}`,field,item[field],column>0&&column<4).replace('data-fixture-key=', 'data-stock-key=')}</td>`).join('')}<td><button type="button" class="subtle" data-stock-remove="${index}">Remove</button></td></tr>`;
  }).join('');
  $('stockInventoryEditor').innerHTML = `<div class="fixture-group"><div class="fixture-group-heading"><h3>Billet inventory</h3><button type="button" id="addBillet">Add raw stock</button></div>${items.length ? `<div class="fixture-table-scroll"><table class="fixture-table stock-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}<th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No raw stock is configured. Add a billet to use stock selection.</p>'}</div>`;
  $('addBillet').addEventListener('click', event => {
    event.preventDefault();
    const next = readBilletInventory();
    next.push({ name:'New raw stock',length:'',width:'',thickness:'',material:'' });
    renderBilletInventory(next);
    state.userEdited = true; state.billetDirty = true; updateBilletStatus(); renderOptions();
    $('stockInventoryEditor').querySelector('[data-stock-row]:last-child [data-stock-key="name"]')?.focus();
  });
  $('stockInventoryEditor').querySelectorAll('[data-stock-remove]').forEach(button => button.addEventListener('click', event => {
    event.preventDefault();
    const next = readBilletInventory();
    next.splice(Number(button.dataset.stockRemove), 1);
    renderBilletInventory(next);
    state.userEdited = true; state.billetDirty = true; updateBilletStatus(); renderOptions();
  }));
}
function updateBilletStatus() {
  $('stockInventoryStatus').textContent = state.billetDirty ? 'Unsaved changes. Click Save Raw Stock Inventory to preserve them.' : state.storageSynced ? 'Inventory is saved locally in gSender.' : 'Inventory is saved on this device; gSender sync is pending.';
}
renderBilletInventory(state.savedBillets);
renderToolInventory(state.savedTools);
const toolInventoryEditor = $('toolInventoryEditor');
toolInventoryEditor.addEventListener('input', () => { state.settings.tools=readToolInventory(); state.userEdited=true; state.toolsDirty=true; updateToolStatus(); renderOptions(); });
toolInventoryEditor.addEventListener('change', () => { state.settings.tools=readToolInventory(); state.userEdited=true; state.toolsDirty=true; updateToolStatus(); renderOptions(); });
function validateToolInventory(items) {
  const incomplete=items.find(item=>!item.name || !['endMill','drill'].includes(item.type) || !['mm','in'].includes(item.unit) || !Number.isFinite(Number(item.diameter)) || Number(item.diameter)<=0);
  if (incomplete) throw new Error('Complete each tool name, type, and positive diameter with mm or in units.');
  return items.map(normalizeTool);
}
$('saveTools').addEventListener('click', async () => {
  if (!state.settingsReady) return;
  state.saveSection='tools';
  try {
    const tools=validateToolInventory(readToolInventory());
    const nextSettings=await persistSettingsPatch({tools});
    state.savedTools=structuredClone(nextSettings.tools); state.settings.tools=structuredClone(nextSettings.tools); state.toolsDirty=false;
    renderToolInventory(state.savedTools); updateToolStatus(); renderOptions();
  } catch(error) { $('toolInventoryStatus').textContent=`Save failed: ${error.message}. Your current tool list remains on screen.`; }
});
const stockInventoryEditor = $('stockInventoryEditor');
stockInventoryEditor.addEventListener('input', () => { state.userEdited = true; state.billetDirty = true; updateBilletStatus(); renderOptions(); });
stockInventoryEditor.addEventListener('change', () => { state.userEdited = true; state.billetDirty = true; updateBilletStatus(); renderOptions(); });
$('saveBillets').addEventListener('click', async () => {
  if (!state.settingsReady) return;
  state.saveSection = 'stock';
  const rawItems = readBilletInventory();
  const incomplete = rawItems.find(item => !item.name || !item.material || ![item.length,item.width,item.thickness].every(value => Number.isFinite(Number(value)) && Number(value) > 0));
  if (incomplete) { $('stockInventoryStatus').textContent = 'Complete each billet name, positive length/width/thickness, and material before saving.'; return; }
  const items = rawItems.map(normalizeBillet);
  try {
    const nextSettings = await persistSettingsPatch({ billets: items });
    state.savedBillets = structuredClone(nextSettings.billets); state.billetDirty = false;
    renderBilletInventory(state.savedBillets); updateBilletStatus(); renderOptions();
  } catch (error) { $('stockInventoryStatus').textContent = `Save failed: ${error.message}. Your current inventory remains on screen.`; }
});
function fixtureList(title, key, items, fields, emptyText, addLabel) {
  if (key === 'holes' || key === 'alignmentHoles') {
    const rows = items.map((item,index) => `<tr>${fields.map(([field,label,numeric=false]) => `<td>${fixtureCell(`${label}, row ${index+1}`,`${key}.${index}.${field}`,item[field] ?? '',numeric)}</td>`).join('')}<td><button type="button" class="subtle" data-fixture-remove="${key}" data-fixture-index="${index}">Remove</button></td></tr>`).join('');
    return `<section class="fixture-group"><div class="fixture-group-heading"><h3>${title}</h3><button type="button" data-fixture-add="${key}">${addLabel}</button></div>${items.length ? `<div class="fixture-table-scroll"><table class="fixture-table"><thead><tr>${fields.map(([,label])=>`<th>${label}</th>`).join('')}<th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="hint">${emptyText}</p>`}</section>`;
  }
  return `<section class="fixture-group"><div class="fixture-group-heading"><h3>${title}</h3><button type="button" data-fixture-add="${key}">${addLabel}</button></div>${items.length ? items.map((item, index) => `<div class="fixture-item"><div class="fixture-item-heading"><strong>${escapeHtml(item.name || `${title.slice(0,-1)} ${index + 1}`)}</strong><button type="button" class="subtle" data-fixture-remove="${key}" data-fixture-index="${index}">Remove</button></div><div class="grid compact">${fields.map(([field, label, numeric = false]) => fixtureInput(label, `${key}.${index}.${field}`, item[field] ?? '', numeric)).join('')}</div></div>`).join('') : `<p class="hint">${emptyText}</p>`}</section>`;
}
function renderFixtureEditor() {
  const fixture = state.settings.fixture || (state.settings.fixture = structuredClone(defaults.fixture));
  fixture.clamps ||= []; fixture.holes ||= []; fixture.alignmentHoles ||= []; fixture.clampSeats ||= []; fixture.viseMarks ||= [];
  fixture.clamps = fixture.clamps.map(clamp => ({...clamp, width: clamp.width ?? clamp.contactWidth ?? '', height: clamp.height ?? clamp.maxHeight ?? '', overlap: clamp.overlap ?? '', minReach: clamp.minReach ?? '', maxReach: clamp.maxReach ?? clamp.reach ?? ''}));
  for (const hole of fixture.holes) {
    if (!hole.pin) continue;
    fixture.alignmentHoles.push({ name: `Alignment pin at X${hole.pinX} Y${hole.pinY}`, x: hole.pinX, y: hole.pinY, diameter: hole.pinDiameter, depth: hole.pinDepth });
    delete hole.pin; delete hole.pinX; delete hole.pinY; delete hole.pinDiameter; delete hole.pinDepth;
  }
  fixture.vise = { name:'', jawWidth:'', maxOpening:'', jawHeight:'', centerX:'', centerY:'', ...(fixture.vise || {}) };
  $('fixtureEditor').innerHTML = `
    ${fixtureList('Clamp inventory','clamps',fixture.clamps,[['name','Clamp name'],['width','Width (mm)',true],['height','Height above support surface (mm)',true],['overlap','Overlap over part (mm)',true],['minReach','Minimum reach to mounting point (mm)',true],['maxReach','Maximum reach to mounting point (mm)',true]],'No clamps configured. Add the clamps available for this machine.','Add clamp')}
    <section class="fixture-group"><h3>Vise dimensions</h3><div class="grid compact">${fixtureInput('Vise name','name',fixture.vise.name,false,'vise')}${fixtureInput('Jaw width (mm)','jawWidth',fixture.vise.jawWidth,true,'vise')}${fixtureInput('Maximum opening (mm)','maxOpening',fixture.vise.maxOpening,true,'vise')}${fixtureInput('Jaw height (mm)','jawHeight',fixture.vise.jawHeight,true,'vise')}${fixtureInput('Open jaw center X (mm)','centerX',fixture.vise.centerX,true,'vise')}${fixtureInput('Open jaw center Y (mm)','centerY',fixture.vise.centerY,true,'vise')}</div><p class="hint">Enter the center of the open jaws from the same XY datum used for the bed plate.</p></section>
    ${fixtureList('Mounting bolt holes','holes',fixture.holes,[['name','Hole name'],['x','X center (mm)',true],['y','Y center (mm)',true],['diameter','Diameter (mm)',true]],'No mounting holes configured. Import a bed-plate DXF above or add coordinates manually.','Add mounting hole')}
    ${fixtureList('Clamp seat pockets','clampSeats',fixture.clampSeats,[['name','Seat name'],['x','Lower-left X (mm)',true],['y','Lower-left Y (mm)',true],['width','Width (mm)',true],['height','Length (mm)',true],['depth','Pocket depth (mm)',true]],'No clamp seats configured. Add shallow pockets if your clamps need recessed seating.','Add clamp seat')}
    ${fixtureList('Vise alignment marks','viseMarks',fixture.viseMarks,[['name','Mark name'],['x1','Start X (mm)',true],['y1','Start Y (mm)',true],['x2','End X (mm)',true],['y2','End Y (mm)',true],['depth','Mark depth (mm)',true]],'No marks configured. Add a line to mark the vise jaw alignment on the billet.','Add vise mark')}
    ${fixtureList('Alignment pin holes','alignmentHoles',fixture.alignmentHoles,[['name','Pin hole name'],['x','X center (mm)',true],['y','Y center (mm)',true],['diameter','Diameter (mm)',true]],'No alignment holes configured. Import a bed-plate DXF above or add coordinates manually.','Add alignment pin hole')}`;
  arrangeFixtureEditor();
}
function arrangeFixtureEditor(){const root=$('fixtureEditor');const targets={bedplate:$('bedplateEditor'),clamps:$('clampEditor'),vise:$('viseEditor'),extras:$('otherFixtureEditor')};for(const target of Object.values(targets))target.replaceChildren();for(const section of [...root.querySelectorAll(':scope > .fixture-group')]){const title=section.querySelector('h3')?.textContent||'';const target=/Clamp inventory/i.test(title)?targets.clamps:/Vise dimensions/i.test(title)?targets.vise:/Mounting bolt holes|Alignment pin holes/i.test(title)?targets.bedplate:targets.extras;target.appendChild(section);}}

function readFixtureEditor() {
  const fixture = structuredClone(state.settings.fixture || defaults.fixture);
  document.querySelectorAll('#bedplateEditor [data-fixture-key], #clampEditor [data-fixture-key], #viseEditor [data-fixture-key], #otherFixtureEditor [data-fixture-key]').forEach(input => {
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value;
    const object = input.dataset.fixtureObject;
    if (object) fixture[object][input.dataset.fixtureKey] = value;
    else {
      const [group, index, key] = input.dataset.fixtureKey.split('.');
      fixture[group][index][key] = value;
    }
  });
  return fixture;
}
renderFixtureEditor();
const fixtureEditor = $('fixtureEditor');
document.addEventListener('change', event => {
  if (!event.target.closest('[data-fixture-key]')) return;
  state.settings.fixture = readFixtureEditor(); state.userEdited = true; state.fixtureDirty = true;
  $('fixtureSaveStatus').textContent = 'Unsaved changes. Click Save Fixture Configuration to preserve them.';
});
document.addEventListener('click', event => {
  const add = event.target.closest('[data-fixture-add]');
  const remove = event.target.closest('[data-fixture-remove]');
  if (!add && !remove) return;
  state.userEdited = true;
  state.settings.fixture = readFixtureEditor();
  const fixture = state.settings.fixture;
  if (add) {
    const templates = { clamps:{name:'New clamp',width:'',height:12,overlap:'',minReach:'',maxReach:''}, holes:{name:'Mounting hole',x:0,y:0,diameter:5}, alignmentHoles:{name:'Alignment pin hole',x:0,y:0,diameter:3}, clampSeats:{name:'Clamp seat',x:0,y:0,width:20,height:12,depth:1}, viseMarks:{name:'Jaw line',x1:0,y1:0,x2:20,y2:0,depth:0.3} };
    fixture[add.dataset.fixtureAdd].push(templates[add.dataset.fixtureAdd]);
  } else fixture[remove.dataset.fixtureRemove].splice(Number(remove.dataset.fixtureIndex),1);
  renderFixtureEditor(); state.fixtureDirty = true;
  $('fixtureSaveStatus').textContent = 'Unsaved changes. Click Save Fixture Configuration to preserve them.';
});
function markImportedHoles(kind, sourceHoles) {
  state.settings.fixture = readFixtureEditor();
  const isPins = kind === 'alignmentPins';
  const group = isPins ? 'alignmentHoles' : 'holes';
  const list = importRows(sourceHoles, isPins, state.settings.fixture[group]);
  if (isPins) state.settings.fixture.alignmentHoles = list;
  else state.settings.fixture.holes = list;
  state.fixtureDirty = true;
  renderFixtureEditor();
  $('fixtureSaveStatus').textContent = `Imported ${list.length} ${isPins ? 'alignment pin' : 'bolt'} locations. Save the fixture configuration to preserve them.`;
  renderOptions();
}
function importRows(sourceHoles, isPins, previous = []) {
  return sourceHoles.map((hole, index) => {
    const old = previous.find(item => Math.abs(Number(item.x)-hole.x)<0.01 && Math.abs(Number(item.y)-hole.y)<0.01 && Math.abs(Number(item.diameter)-hole.diameter)<0.01);
    return { name: old?.name || `${isPins ? 'Alignment pin' : 'Bolt'} ${index + 1}`, x: hole.x, y: hole.y, diameter: hole.diameter };
  });
}
$('saveFixture').addEventListener('click', async () => {
  if (!state.settingsReady) return;
  state.saveSection = 'fixture';
  state.settings.fixture = readFixtureEditor();
  try {
    const nextSettings = await persistSettingsPatch({ fixture: state.settings.fixture });
    state.settings = nextSettings; state.savedFixture = structuredClone(state.settings.fixture); state.fixtureDirty = false;
    $('fixtureSaveStatus').textContent = 'Fixture configuration is saved on this device; syncing to gSender.';
  } catch (error) { $('fixtureSaveStatus').textContent = `Save failed: ${error.message}. Your current entries remain on screen.`; }
});
function selectTab(tab) {
  document.querySelectorAll('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('[data-tab-page]').forEach(page => { page.hidden = page.dataset.tabPage !== tab; });
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.tab)));
document.querySelector('.tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  const tabs = [...document.querySelectorAll('[data-tab]')], current = tabs.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  event.preventDefault(); tabs[next].focus(); selectTab(tabs[next].dataset.tab);
});
const plateFileKinds = [
  { input: 'platePerimeterFile', kind: 'perimeter', status: 'platePerimeterStatus', label: 'Perimeter' },
  { input: 'plateBoltsFile', kind: 'boltHoles', status: 'plateBoltsStatus', label: 'Bolt holes' },
  { input: 'platePinsFile', kind: 'alignmentPins', status: 'platePinsStatus', label: 'Alignment pins' }
];
function plateReferenceText(reference) {
  if (reference.kind === 'perimeter') return `${reference.fileName} · X ${(reference.width / (reference.displayUnits === 'in' ? 25.4 : 1)).toFixed(3)} × Y ${(reference.height / (reference.displayUnits === 'in' ? 25.4 : 1)).toFixed(3)} ${reference.displayUnits}`;
  const type = reference.kind === 'boltHoles' ? 'bolt holes' : 'alignment pins';
  return `${reference.fileName} · ${reference.holes.length} ${type} · XY and diameter captured`;
}
function updatePlateSaveButton() {
  const perimeter = state.plateFiles.perimeter;
  const bolts = state.plateFiles.boltHoles;
  const pins = state.plateFiles.alignmentPins;
  const complete = perimeter?.pathFormat === 3 && bolts?.pathFormat === 3 && pins?.pathFormat === 3 && bolts.holes?.length && pins.holes?.length;
  $('savePlateFiles').disabled = !state.settingsReady || !complete || !state.plateDirty;
  if (!complete) $('plateSaveStatus').textContent = 'Upload the perimeter file and NC files with detectable bolt-hole and alignment-pin circles.';
  else if (state.plateDirty) $('plateSaveStatus').textContent = 'Changes are not saved yet.';
  else $('plateSaveStatus').textContent = 'Bed plate configuration is saved locally.';
}
for (const entry of plateFileKinds) {
  $(entry.input).addEventListener('change', async () => {
    const file = $(entry.input).files[0]; if (!file) return;
    delete state.plateFiles[entry.kind];
    state.plateDirty = true;
    renderPlateIso(); updatePlateSaveButton();
    try {
      const parsed = analyzeNc(await file.text());
      const holes = entry.kind === 'perimeter' ? [] : parsed.holes.map(hole => ({ x: hole.x, y: hole.y, diameter: hole.diameter, type: entry.kind === 'boltHoles' ? 'bolt' : 'alignmentPin' }));
      if (entry.kind !== 'perimeter' && !holes.length) throw new Error('No circular hole paths were detected in this file.');
      const bounds = entry.kind === 'perimeter' ? { minX: parsed.bounds.minX, maxX: parsed.bounds.maxX, minY: parsed.bounds.minY, maxY: parsed.bounds.maxY } : undefined;
      const reference = entry.kind === 'perimeter'
        ? { pathFormat: 3, kind: entry.kind, fileName: file.name, width: parsed.width, height: parsed.height, bounds, displayUnits: parsed.displayUnits }
        : { pathFormat: 3, kind: entry.kind, fileName: file.name, holes };
      state.plateFiles[entry.kind] = reference;
      state.userEdited = true;
      state.plateDirty = true;
      if (entry.kind === 'boltHoles' || entry.kind === 'alignmentPins') markImportedHoles(entry.kind, holes);
      $(entry.status).textContent = `Unsaved · ${plateReferenceText(reference)}`;
      $(entry.status).classList.remove('error');
      renderPlateIso(); updatePlateSaveButton();
    } catch (error) {
      $(entry.status).textContent = `${file.name} · ${error.message}`;
      $(entry.status).classList.add('error');
      updatePlateSaveButton();
    }
  });
}
function renderPlateIso() {
  const files = plateFileKinds.map(entry => ({ ...entry, reference: state.plateFiles[entry.kind] }));
  if (files.some(file => file.reference?.pathFormat !== 3)) { $('plateIsoPanel').hidden = true; return; }
  const { minX, maxX, minY, maxY } = state.plateFiles.perimeter.bounds;
  const dx=maxX-minX, dy=maxY-minY, visualThickness=Math.max(0.5,Math.min(dx,dy)*0.01), zTop=visualThickness;
  const project=(x,y,z)=>[Math.sqrt(3)/2*(x-y),0.5*(x+y)-z];
  const box=[[0,0,0],[dx,0,0],[dx,dy,0],[0,dy,0],[0,0,zTop],[dx,0,zTop],[dx,dy,zTop],[0,dy,zTop]].map(v=>project(...v));
  const px=box.map(p=>p[0]), py=box.map(p=>p[1]), sx=Math.max(...px)-Math.min(...px), sy=Math.max(...py)-Math.min(...py);
  const scale=Math.min(570/Math.max(sx,1e-6),260/Math.max(sy,1e-6)), ox=350-(Math.min(...px)+Math.max(...px))*scale/2, oy=184-(Math.min(...py)+Math.max(...py))*scale/2;
  const xy=(x,y,z=zTop)=>[ox+project(x-minX,y-minY,z)[0]*scale,oy+project(x-minX,y-minY,z)[1]*scale];
  const edgePairs=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const topCorners=[4,5,6,7].map(i=>`${ox+box[i][0]*scale},${oy+box[i][1]*scale}`).join(' ');
  $('plateIsoBox').innerHTML=`<polygon class="plate-face" points="${topCorners}"/>`+edgePairs.map(([a,b])=>`<line class="plate-box-edge" x1="${ox+box[a][0]*scale}" y1="${oy+box[a][1]*scale}" x2="${ox+box[b][0]*scale}" y2="${oy+box[b][1]*scale}"/>`).join('');
  const holes=[...state.plateFiles.boltHoles.holes,...state.plateFiles.alignmentPins.holes];
  $('plateIsoPaths').innerHTML=holes.map(hole=>{const p=xy(hole.x,hole.y),r=hole.diameter/2*scale;return `<ellipse class="plate-hole ${hole.type}" cx="${p[0]}" cy="${p[1]}" rx="${(r*1.225).toFixed(2)}" ry="${(r*0.707).toFixed(2)}"><title>${hole.type}: Ø${hole.diameter.toFixed(3)} mm at X${hole.x.toFixed(3)} Y${hole.y.toFixed(3)}</title></ellipse>`;}).join('');
  const unit=state.plateFiles.perimeter.displayUnits==='in'?'in':'mm', factor=unit==='in'?1/25.4:1;
  const bolts=state.plateFiles.boltHoles.holes.length, pins=state.plateFiles.alignmentPins.holes.length;
  $('plateIsoDimensions').textContent=`Perimeter · X ${(dx*factor).toFixed(3)} × Y ${(dy*factor).toFixed(3)} ${unit} · ${bolts} bolt holes · ${pins} alignment pins · plate thickness not inferred`;
  for (const file of files) $(file.status).textContent=`${state.plateDirty?'Unsaved · ':''}${plateReferenceText(file.reference)}`;
  $('plateIsoPanel').hidden=false;
}
for (const entry of plateFileKinds) {
  const reference = state.savedPlateFiles[entry.kind];
  if (reference?.pathFormat === 3) $(entry.status).textContent = plateReferenceText(reference);
}
renderPlateIso();
updatePlateSaveButton();
$('savePlateFiles').addEventListener('click', async () => {
  if (!state.settingsReady) return;
  if (plateFileKinds.some(entry => state.plateFiles[entry.kind]?.pathFormat !== 3)) return;
  const previous = state.settings.plateFiles;
  try {
    const nextSettings = await persistSettingsPatch({ plateFiles: state.plateFiles });
    state.savedPlateFiles = structuredClone(state.plateFiles);
    state.plateDirty = false;
    $('plateSaveStatus').textContent='Saved locally in gSender: perimeter bounds and hole XY, diameter, and type will be restored next time.';
    updatePlateSaveButton(); renderPlateIso();
  } catch (error) {
    state.settings.plateFiles = previous || state.savedPlateFiles;
    $('plateSaveStatus').textContent=`Save failed: ${error.message}. The compact bed plate layout is still shown but is not preserved yet.`;
  }
});
function renderIso(part) {
  const factor = part.displayUnits === 'in' ? 1 / 25.4 : 1;
  const fmt = (v) => (v * factor).toFixed(3);
  const unit = part.displayUnits;
  const dx = part.width, dy = part.height, dz = part.depth;
  const drawZ = dz || Math.max(dx, dy, 1) * 0.06;
  const vertices = [[0,0,0],[dx,0,0],[dx,dy,0],[0,dy,0],[0,0,drawZ],[dx,0,drawZ],[dx,dy,drawZ],[0,dy,drawZ]];
  const project = ([x,y,z]) => [Math.sqrt(3)/2*(x-y), 0.5*(x+y)-z];
  const projected = vertices.map(project);
  const xs = projected.map(p=>p[0]), ys = projected.map(p=>p[1]);
  const spanX = Math.max(...xs)-Math.min(...xs), spanY = Math.max(...ys)-Math.min(...ys);
  const scale = Math.min(470/Math.max(spanX,1e-6), 220/Math.max(spanY,1e-6));
  const ox = 280-(Math.min(...xs)+Math.max(...xs))*scale/2;
  const oy = 158-(Math.min(...ys)+Math.max(...ys))*scale/2;
  const xy = (i) => [ox+projected[i][0]*scale, oy+projected[i][1]*scale];
  const edges = [[0,1,'x'],[1,2,'y'],[2,3,'x'],[3,0,'y'],[4,5,'x'],[5,6,'y'],[6,7,'x'],[7,4,'y'],[0,4,'z'],[1,5,'z'],[2,6,'z'],[3,7,'z']];
  $('isoEdges').innerHTML = edges.map(([a,b,axis])=>{const p=xy(a),q=xy(b);return `<line class="edge ${axis}" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"/>`;}).join('');
  const label = (a,b,text,axis,ox=0,oy=0) => {const p=xy(a),q=xy(b),x=(p[0]+q[0])/2+ox,y=(p[1]+q[1])/2+oy;return `<text class="dim-label ${axis}" x="${x}" y="${y}">${text}</text>`;};
  $('isoLabels').innerHTML = label(0,1,`X ${fmt(dx)} ${unit}`,'x',0,18)+label(0,3,`Y ${fmt(dy)} ${unit}`,'y',-18,14)+label(0,4,`Z ${fmt(dz)} ${unit}`,'z',-34,0);
  $('isoDimensions').textContent = `X ${fmt(dx)} ${unit}   ·   Y ${fmt(dy)} ${unit}   ·   Z ${fmt(dz)} ${unit}`;
}
function values() { for (const key of ['collet','feature','margin','countersinkDiameter','roughingOffset','passDepth','safeZ','feed','plunge']) state.settings[key] = $(key).value; state.settings.roughingOffsetUsesPassDepth=state.roughingOffsetAuto; }
let settingsWriteQueue = Promise.resolve();
function persistSettingsPatch(patch) {
  if (!state.settingsReady) return Promise.reject(new Error('Saved settings are still loading.'));
  const write = settingsWriteQueue.then(() => {
    const next = { ...state.settings, ...patch };
    try { localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(next)); }
    catch (error) { throw new Error(`Could not save on this device: ${error.message}`); }
    state.settings = next;
    state.userEdited = true;
    state.storageSynced = false;
    const section = state.saveSection;
    const statusId = section === 'stock' ? 'stockInventoryStatus' : section === 'tools' ? 'toolInventoryStatus' : section === 'fixture' ? 'fixtureSaveStatus' : section === 'plate' ? 'plateSaveStatus' : null;
    if (statusId) $(statusId).textContent = 'Saved on this device; syncing to gSender…';
    Promise.resolve().then(async () => {
      const previous = await storage.get('stockFixturePlannerSettings');
      if (previous && Object.keys(previous).length) await storage.set('stockFixturePlannerSettingsBackup', previous);
      await storage.set('stockFixturePlannerSettings', next);
    }).then(() => {
      state.storageSynced = true;
      if (statusId && state.saveSection === section) $(statusId).textContent = 'Saved on this device and in gSender.';
    }).catch(() => {
      if (statusId && state.saveSection === section) $(statusId).textContent = 'Saved on this device; gSender sync is unavailable.';
    });
    return next;
  });
  settingsWriteQueue = write.catch(() => {});
  return write;
}
function save() {
  values();
  if (!state.settingsReady) return;
  const keys = ['collet','feature','margin','countersinkDiameter','roughingOffset','roughingOffsetUsesPassDepth','passDepth','safeZ','feed','plunge'];
  persistSettingsPatch(Object.fromEntries(keys.map(key => [key, state.settings[key]]))).catch(() => {});
}
const methodPlanKinds={bottomSurface:'bottomSurface',perimeterSurface:'clamps',topSurface:'clamps',fastening:'holes',fixture:'vise',clamps:'clamps',holes:'holes',vise:'vise'};
const methodLabels={bottomSurface:'Bottom Surface',perimeterSurface:'Perimeter Surface',topSurface:'Top Surface',fastening:'Fastening',fixture:'Fixture',clamps:'Perimeter Surface',holes:'Fastening',vise:'Fixture'};
const methodHelp={
  bottomSurface:'Bottom Surface: no XY stock edge clearance is added. Vacuum or adhesive holds the underside; the Z roughing offset still controls pocket depth.',
  perimeterSurface:'Perimeter Surface: each side gets cutter diameter plus XY stock edge margin for the edge-clamp clearance band. Two holding tabs keep the blank attached through the final outline cut.',
  topSurface:'Top Surface: each side gets cutter diameter, the largest configured clamp overhang, and XY stock edge margin so clamps can sit anywhere around the blank clear of the cutter.',
  fastening:'Fastening: bolt sides get cutter diameter plus XY stock edge margin to clear the bolt heads; sides without bolts use no XY edge clearance, like Bottom Surface.',
  fixture:'Fixture: each side gets cutter diameter plus XY stock edge margin for vise or hard-fixture clearance; two tabs retain the blank through the final outline cut.'
};
function planKindForMethod(method){return methodPlanKinds[method]||method;}
function renderOptions() {
  const strategy = document.querySelector('input[name="strategy"]:checked')?.value || 'perimeterSurface';
  const planKind = planKindForMethod(strategy);
  $('boltHeadOption').hidden = planKind !== 'holes';
  const countersinkDiameter = Number($('countersinkDiameter').value);
  const roughingOffset = Number($('roughingOffset').value);
  const edgeMargin = Number($('margin').value);
  const fixture = readFixtureEditor();
  const maxHole = planKind === 'holes' && fixture.holes.length ? Math.max(...fixture.holes.map(h => Number(h.diameter) || 0)) : Infinity;
  const maxTool=Math.min(Number($('collet').value),Number($('feature').value),maxHole);
  const available=(state.settings.tools||state.savedTools||DEFAULT_TOOLS).map(normalizeTool).map(item=>({...item,diameterMm:toolDiameterMm(item)}))
    .filter(item=>item.type==='endMill' && Number.isFinite(item.diameterMm) && item.diameterMm>0 && item.diameterMm<=maxTool+1e-6)
    .sort((a,b)=>b.diameterMm-a.diameterMm);
  const recommended=recommendTool(Number($('collet').value),Math.min(Number($('feature').value),maxHole),available);
  const previous=Number($('tool').value);
  $('tool').innerHTML=available.length?available.map(item=>`<option value="${item.diameterMm}">${escapeHtml(item.name)} · Ø${item.diameterMm.toFixed(3)} mm</option>`).join(''):'<option value="">No compatible configured end mill</option>';
  $('tool').disabled=!available.length;
  if(available.some(item=>Math.abs(item.diameterMm-previous)<1e-6)) $('tool').value=String(previous);
  else if(recommended) $('tool').value=String(recommended.diameterMm);
  const billets = readBilletInventory().map(normalizeBillet);
  $('billet').innerHTML = billets.map((b,i) => `<option value="${i}">${escapeHtml(b.name)} · ${b.length} × ${b.width} × ${b.thickness} mm · ${escapeHtml(b.material)}</option>`).join('') || '<option value="">No billets configured</option>';
  if (state.part && billets.length) {
    const xyMargins = methodXYMargins(strategy, fixture, edgeMargin, Number($('tool').value) || 0);
    const best = chooseStock(state.part, billets, Number($('margin').value), state.part.depth, Number($('tool').value) || 0, strategy, fixture, countersinkDiameter, roughingOffset);
    $('stockStatus').textContent = !available.length ? 'No configured end mill fits the collet and feature limits. Add compatible end mills in the Tools tab.' : best ? `${planKind === 'holes' ? 'Lowest planned blank volume fits' : 'Smallest configured billet that fits'}: ${best.name}. Part Z envelope ${state.part.depth.toFixed(3)} mm; billet thickness ${best.thickness} mm.` : planKind === 'holes' ? 'No billet fits the part and hold-down layout. Configure two symmetric bed-plate bolt holes with matching diameters, or choose a larger billet.' : 'No configured billet fits this XY envelope and required part thickness.';
    if (best) $('billet').value = String(billets.indexOf(best));
    const selected = billets[Number($('billet').value)];
    const layout = planKind === 'holes' && selected ? mountingLayoutForStock(state.part,fixture,xyMargins,Number($('tool').value)||0,selected,countersinkDiameter,roughingOffset) : null;
    $('mountingPlanStatus').textContent = planKind === 'holes'
      ? layout ? `Selected ${layout.orientation.toUpperCase()}-axis bolt pair: ${layout.spacing.toFixed(3)} mm spacing (Ø${layout.throughDiameter.toFixed(3)} mm). The planner compares planned blank volumes across compatible billets and X/Y bolt pairs. Absolute plate coordinates are ignored for this cutout; the part is centered between billet-local hold-down holes. Blank envelope ${layout.width.toFixed(3)} × ${layout.height.toFixed(3)} mm; part translation X${(Number($('tool').value)/2+layout.partOffsetX).toFixed(3)} Y${(Number($('tool').value)/2+layout.partOffsetY).toFixed(3)} mm. The rectangular pocket includes both bolt locations; rough thickness ${(state.part.depth+roughingOffset).toFixed(3)} mm. Then Ø${countersinkDiameter.toFixed(3)} mm flat-bottom counterbores are cut 2.250 mm below the pocket floor, followed by the outside profile with two tabs on the bolt-bearing sides.`
        : fixture.holes.length < 2 ? 'Upload or enter at least two bed-plate bolt holes. Alignment pins do not count as hold-down points.' : 'No symmetric bolt-hole pair fits this part and billet. Increase stock or adjust the bed-plate hole set.'
      : planKind === 'vise' ? `The rectangular face pocket targets ${(state.part.depth+roughingOffset).toFixed(3)} mm remaining thickness. The outside profile will leave two 6 mm wide × 2 mm thick holding tabs.` : methodHelp[strategy] || methodHelp.perimeterSurface;
    const blankWidth=layout?layout.width+Number($('tool').value):state.part.width+2*xyMargins.x+Number($('tool').value);
    const blankHeight=layout?layout.height+Number($('tool').value):state.part.height+2*xyMargins.y+Number($('tool').value);
    const marginNote=`Applied XY clearance per side: X${xyMargins.x.toFixed(3)} mm, Y${xyMargins.y.toFixed(3)} mm.`;
    $('mountingPlanStatus').textContent += ` ${marginNote} Estimated outside blank size ${blankWidth.toFixed(3)} × ${blankHeight.toFixed(3)} mm, including cutter diameter.${planKind === 'holes' && selected ? ` Planned blank envelope volume ${((blankWidth*blankHeight*Number(selected.thickness))).toFixed(0)} mm³ using billet thickness ${Number(selected.thickness).toFixed(3)} mm.` : ''}`;
  } else {
    $('stockStatus').textContent = state.part ? 'Add a raw stock billet to check fit.' : 'Load an NC file to calculate part dimensions and required thickness.';
    $('mountingPlanStatus').textContent = planKind === 'holes' ? fixture.holes.length < 2 ? 'Upload or enter at least two bed-plate bolt holes. Alignment pins do not count as hold-down points.' : 'Load an NC part and configure stock to select a symmetric bolt pair.' : planKind === 'vise' ? 'Load a part and choose stock to calculate the thickness pocket and holding-tab profile.' : methodHelp[strategy] || methodHelp.perimeterSurface;
  }
}
for (const id of ['collet','feature','margin','countersinkDiameter','roughingOffset','passDepth','safeZ','feed','plunge']) $(id).addEventListener('change', () => { if(id==='passDepth'&&state.roughingOffsetAuto) $('roughingOffset').value=$('passDepth').value; renderOptions(); save(); });
$('roughingOffset').addEventListener('change', () => { state.roughingOffsetAuto=false; save(); });
document.querySelectorAll('input[name="strategy"]').forEach(input => input.addEventListener('change', renderOptions));
$('file').addEventListener('change', async () => {
  const file = $('file').files[0]; if (!file) return;
  try { state.part = analyzeNc(await file.text()); state.fileName = file.name.replace(/\.[^.]+$/, '') + '-stock-prep.nc';
    $('partStatus').textContent = `Read ${file.name} · ${state.part.points.length.toLocaleString()} sampled motion points`;
    const unitFactor = state.part.displayUnits === 'in' ? 1 / 25.4 : 1, unit = state.part.displayUnits;
    $('envelope').hidden = false; $('envelope').textContent = `X ${ (state.part.bounds.minX*unitFactor).toFixed(3)} to ${(state.part.bounds.maxX*unitFactor).toFixed(3)} ${unit} · Y ${(state.part.bounds.minY*unitFactor).toFixed(3)} to ${(state.part.bounds.maxY*unitFactor).toFixed(3)} ${unit} · Z motion ${ (state.part.bounds.minZ*unitFactor).toFixed(3)} to ${(state.part.bounds.maxZ*unitFactor).toFixed(3)} ${unit} · cutting Z size ${ (state.part.depth*unitFactor).toFixed(3)} ${unit} (rapids/retracts excluded)`;
    $('boundingCube').hidden = false; renderIso(state.part);
    renderOptions(); notice('Part envelope loaded. Confirm it matches the source program preview.');
  } catch (e) { state.part = null; $('partStatus').textContent = e.message; $('envelope').hidden = true; $('boundingCube').hidden = true; renderOptions(); notice(e.message, true); }
});
$('generate').addEventListener('click', () => {
  save();
  try {
    const billets = readBilletInventory().map(normalizeBillet), stock = billets[Number($('billet').value)];
    const strategy = document.querySelector('input[name="strategy"]:checked').value;
    const planKind = planKindForMethod(strategy);
    state.gcode = generatePlan({ part: state.part, strategy, stock, margin: Number($('margin').value), tool: Number($('tool').value), safeZ: Number($('safeZ').value), passDepth: Number($('passDepth').value), feed: Number($('feed').value), plunge: Number($('plunge').value), fixture: readFixtureEditor(), countersinkDiameter: Number($('countersinkDiameter').value), roughingOffset: Number($('roughingOffset').value) });
    const fixture = readFixtureEditor();
    const xyMargins = methodXYMargins(strategy, fixture, Number($('margin').value), Number($('tool').value));
    const layout = planKind === 'holes' ? mountingLayoutForStock(state.part,fixture,xyMargins,Number($('tool').value),stock,Number($('countersinkDiameter').value),Number($('roughingOffset').value)) : null;
    const offsetX = layout?.partOffsetX ?? (Number($('tool').value)/2 + xyMargins.x - state.part.bounds.minX);
    const offsetY = layout?.partOffsetY ?? (Number($('tool').value)/2 + xyMargins.y - state.part.bounds.minY);
    $('preview').textContent = state.gcode; $('summary').textContent = `${state.fileName} · ${stock.name} · ${$('tool').value} mm cutter · ${methodLabels[strategy] || strategy} workholding · original part XY offset X${offsetX.toFixed(3)} Y${offsetY.toFixed(3)} mm`;
    $('result').hidden = false; $('load').disabled = false; $('download').disabled = false; notice('Draft generated. Review every operation and its setup before use.');
  } catch (e) { notice(e.message, true); }
});
$('load').addEventListener('click', async () => { try { await gcode.loadToVisualizer(state.gcode, state.fileName); notice('Loaded into gSender visualizer for Carve review. No job was started.'); } catch (e) { notice(`Could not load into Carve: ${e.message}`, true); } });
$('download').addEventListener('click', () => { const blob = new Blob([state.gcode], { type: 'text/plain' }), url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = state.fileName; a.click(); URL.revokeObjectURL(url); });

for (const key of ['collet','feature','margin','countersinkDiameter','roughingOffset','passDepth','safeZ','feed','plunge']) $(key).value = state.settings[key] ?? defaults[key];
renderOptions();
async function loadSavedSettings() {
  const key = 'stockFixturePlannerSettings';
  const readKey = storage.get(key).then(value => {
    if (!value) throw Object.assign(new Error('No saved settings under the planner key.'), { notFound: true });
    return value;
  });
  const readAll = storage.getAll().then(values => {
    const value = values?.[key];
    if (!value) throw Object.assign(new Error('No saved planner settings in plugin storage.'), { notFound: true });
    return value;
  });
  try { return await Promise.any([readKey, readAll]); }
  catch (error) {
    const reasons = error.errors || [];
    if (reasons.length === 2 && reasons.every(reason => reason.notFound)) return null;
    throw new Error(`Could not read planner settings: ${reasons.map(reason => reason.message).join('; ') || error.message}`);
  }
}
Promise.race([loadSavedSettings(), new Promise(resolve => setTimeout(() => resolve(undefined), 2000))]).then(saved => {
  if (saved && !state.userEdited && !hasCachedSettings) {
    state.settings = { ...defaults, ...saved };
    state.roughingOffsetAuto = saved.roughingOffsetUsesPassDepth !== false;
    if (!Object.hasOwn(saved, 'roughingOffset')) state.settings.roughingOffset=Number(saved.passDepth)||Number(defaults.passDepth);
    delete state.settings.thickness;
    state.savedBillets = (saved.billets || defaults.billets).map(normalizeBillet);
    state.settings.billets = structuredClone(state.savedBillets);
    state.savedFixture = structuredClone(saved.fixture || defaults.fixture);
    state.savedPlateFiles = structuredClone(saved.plateFiles || {});
    state.plateFiles = structuredClone(state.savedPlateFiles);
    state.settings.tools ||= structuredClone(DEFAULT_TOOLS);
    state.savedTools=(state.settings.tools||DEFAULT_TOOLS).map(normalizeTool);
    state.settings.tools=structuredClone(state.savedTools);
    state.settings.fixture ||= structuredClone(defaults.fixture);
    state.settings.fixture.alignmentHoles ||= [];
    const savedBoltHoles = state.savedPlateFiles.boltHoles?.holes || [];
    const savedAlignmentHoles = state.savedPlateFiles.alignmentPins?.holes || [];
    let restoredImportedHoles = false;
    if (!state.settings.fixture.holes?.length && savedBoltHoles.length) { state.settings.fixture.holes = importRows(savedBoltHoles, false); restoredImportedHoles = true; }
    if (!state.settings.fixture.alignmentHoles.length && savedAlignmentHoles.length) { state.settings.fixture.alignmentHoles = importRows(savedAlignmentHoles, true); restoredImportedHoles = true; }
    for (const key of ['collet','feature','margin','countersinkDiameter','roughingOffset','passDepth','safeZ','feed','plunge']) $(key).value = state.settings[key] ?? defaults[key];
    if(state.roughingOffsetAuto) $('roughingOffset').value=$('passDepth').value;
    renderBilletInventory(state.savedBillets); updateBilletStatus();
    renderToolInventory(state.savedTools);
    renderFixtureEditor();
    $('fixtureSaveStatus').textContent = restoredImportedHoles ? 'Saved bed plate locations were added to the tables. Save the fixture configuration to preserve them.' : 'Fixture configuration is loaded from gSender.';
    renderOptions();
    state.storageSynced = true;
    updateToolStatus();
    try { localStorage.setItem(FALLBACK_STORAGE_KEY, JSON.stringify(state.settings)); } catch {}
  }
  state.settingsReady = true;
  $('saveBillets').disabled = false;
  $('saveTools').disabled = false;
  $('saveFixture').disabled = false;
  updateBilletStatus();
  if (!saved && !state.userEdited) {
    $('stockInventoryStatus').textContent = 'Recovered inventory is loaded on this device; gSender sync is pending.';
    $('fixtureSaveStatus').textContent = 'Recovered fixture and tooling data is loaded on this device; gSender sync is pending.';
    $('plateSaveStatus').textContent = 'Recovered bed plate layout is loaded on this device; gSender sync is pending.';
  }
  const configured = state.savedPlateFiles;
  for (const entry of plateFileKinds) {
    const reference = configured[entry.kind];
    if (reference?.pathFormat === 3) $(entry.status).textContent = plateReferenceText(reference);
    else if (reference) $(entry.status).textContent = `Older envelope data for ${reference.fileName}; reupload to create the compact bed plate layout.`;
  }
  renderPlateIso(); updatePlateSaveButton();
}).catch(error => {
  $('stockInventoryStatus').textContent = `Recovered inventory is loaded on this device. gSender read failed: ${error.message}`;
  $('fixtureSaveStatus').textContent = `Recovered fixture data is loaded on this device. gSender read failed: ${error.message}`;
  $('plateSaveStatus').textContent = `Recovered plate layout is loaded on this device. gSender read failed: ${error.message}`;
  renderPlateIso(); updatePlateSaveButton();
});


// Setup overview, DXF fixture library, and CSV inventory exchange.
const setupGroups = { bedplate:'Bed plate / T-track layout', tracks:'T-track segments', clamps:'Surface clamps', vise:'Vises', fixtures:'Other fixtures' };
function parseDxfSummary(text) {
  const lines=text.replace(/\r/g,'').split('\n');const pairs=[];
  for(let i=0;i+1<lines.length;i+=2){const code=Number(lines[i].trim());if(Number.isFinite(code))pairs.push([code,lines[i+1].trim()]);}
  let unitsCode=0,inHeader=false;for(let i=0;i<pairs.length-1;i++){if(pairs[i][0]===9&&pairs[i][1]==='$INSUNITS'){inHeader=true;continue;}if(inHeader&&pairs[i][0]===70){unitsCode=Number(pairs[i][1]);break;}if(inHeader&&pairs[i][0]===9)inHeader=false;}
  const factor=unitsCode===1?25.4:unitsCode===2?304.8:unitsCode===4?1:unitsCode===5?10:unitsCode===6?1000:1;
  const units=unitsCode===1?'in':unitsCode===2?'ft':unitsCode===4?'mm':unitsCode===5?'cm':unitsCode===6?'m':'unitless';
  let inEntities=false,entity=null;const entities=[];for(const [code,value] of pairs){if(code===2&&value==='ENTITIES'){inEntities=true;continue;}if(code===0&&value==='ENDSEC'){if(entity)entities.push(entity);entity=null;inEntities=false;continue;}if(!inEntities)continue;if(code===0){if(entity)entities.push(entity);entity={type:value,layer:'0',values:[]};}else if(entity){if(code===8)entity.layer=value;entity.values.push([code,Number(value)]);}}if(entity)entities.push(entity);
  const allPoints=[],linePoints=[],closedPolylines=[],circles=[];let lineCount=0,polylineCount=0;
  for(const e of entities){const vals=c=>e.values.filter(x=>x[0]===c).map(x=>x[1]);const xs=vals(10),ys=vals(20);if(e.type==='LINE'){lineCount++;const points=[[xs[0],ys[0]],[vals(11)[0],vals(21)[0]]].filter(p=>p.every(Number.isFinite));linePoints.push(...points);allPoints.push(...points);}else if(e.type==='CIRCLE'){const x=xs[0],y=ys[0],r=vals(40)[0];if([x,y,r].every(Number.isFinite)){allPoints.push([x-r,y-r],[x+r,y+r]);circles.push({x:x*factor,y:y*factor,diameter:2*r*factor,layer:e.layer});}}else if(e.type==='ARC'){const x=xs[0],y=ys[0],r=vals(40)[0];if([x,y,r].every(Number.isFinite))allPoints.push([x-r,y-r],[x+r,y+r]);}else if(e.type==='LWPOLYLINE'||e.type==='POLYLINE'){polylineCount++;const points=[];for(let i=0;i<Math.min(xs.length,ys.length);i++)if(Number.isFinite(xs[i])&&Number.isFinite(ys[i]))points.push([xs[i],ys[i]]);allPoints.push(...points);const flags=vals(70)[0]||0;if(points.length>=3&&(flags&1))closedPolylines.push({layer:e.layer,points,area:Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0))/2});}}
  const valid=allPoints.filter(p=>p.every(Number.isFinite));if(!valid.length)throw Error('No supported LINE, CIRCLE, ARC, or polyline geometry found.');
  const perimeterLayer=/perimeter|outline|boundary|border|plate/i;const named=closedPolylines.filter(p=>perimeterLayer.test(p.layer));const perimeter=(named.length?named:closedPolylines).sort((x,y)=>y.area-x.area)[0];const sourcePoints=perimeter?.points?.length?perimeter.points:linePoints.length>=4?linePoints:valid;const xs=sourcePoints.map(p=>p[0]*factor),ys=sourcePoints.map(p=>p[1]*factor);const bounds={minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)};
  return {units,width:bounds.maxX-bounds.minX,height:bounds.maxY-bounds.minY,...bounds,circles,lineCount,polylineCount,entityCount:entities.length,perimeterSource:perimeter?(named.length?'named closed polyline':'largest closed polyline'):linePoints.length>=4?'line geometry':'drawing bounds'};
}
function csvParse(text){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell='';}else if(c!=='\r')cell+=c;}if(cell.length||row.length){row.push(cell);rows.push(row);}return rows;}
function csvText(name){const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';const stock=name==='stock';const headers=stock?['name','length_mm','width_mm','thickness_mm','material']:['name','type','diameter','unit'];const items=stock?readBilletInventory():readToolInventory();const fields=stock?['name','length','width','thickness','material']:['name','type','diameter','unit'];return [headers.map(q).join(','),...items.map(x=>fields.map(f=>q(x[f])).join(','))].join('\r\n');}
function wireCsv(inputId,mode){$(inputId).addEventListener('change',async()=>{const f=$(inputId).files[0];if(!f)return;try{const rows=csvParse(await f.text()).filter(r=>r.some(v=>v.trim())),header=rows.shift().map(x=>x.trim().toLowerCase()),col=(r,...names)=>{const i=names.map(n=>header.indexOf(n)).find(i=>i>=0);return i===undefined?'':r[i]??'';};if(mode==='stock'){const items=rows.map(r=>normalizeBillet({name:col(r,'name','billet'),length:col(r,'length_mm','length','x'),width:col(r,'width_mm','width','y'),thickness:col(r,'thickness_mm','thickness','z'),material:col(r,'material')}));renderBilletInventory(items);state.billetDirty=true;updateBilletStatus();}else{const items=rows.map(r=>normalizeTool({name:col(r,'name','tool'),type:/drill/i.test(col(r,'type','tool_type'))?'drill':'endMill',diameter:col(r,'diameter','size'),unit:/^(in|inch|inches)$/i.test(col(r,'unit','units'))?'in':'mm'}));renderToolInventory(items);state.toolsDirty=true;updateToolStatus();renderOptions();}refreshDashboard();}catch(e){alert('CSV import failed: '+e.message);}});}
wireCsv('stockCsvImport','stock');wireCsv('toolsCsvImport','tools');document.addEventListener('click',async event=>{const button=event.target.closest('[data-copy-csv]');if(!button)return;const mode=button.dataset.copyCsv;const status=$(mode==='stock'?'stockInventoryStatus':'toolInventoryStatus');try{await navigator.clipboard.writeText(csvText(mode));if(status)status.textContent='CSV copied to clipboard.';}catch{const panel=button.closest('.csv-controls');let area=panel.querySelector('textarea[data-csv-fallback]');if(!area){area=document.createElement('textarea');area.dataset.csvFallback='true';area.setAttribute('aria-label','CSV text fallback');panel.append(area);}area.value=csvText(mode);area.focus();area.select();if(status)status.textContent='Clipboard access is unavailable. CSV text is selected; copy it and paste it into a .csv file or spreadsheet.';}});
function ensureLibrary(){state.settings.fixtureLibrary ||= {bedplate:[],tracks:[],clamps:[],vise:[],fixtures:[]}; for(const k of Object.keys(setupGroups))state.settings.fixtureLibrary[k] ||= [];return state.settings.fixtureLibrary;}
const assetExtraLabels={bedplate:['Plate thickness (mm)','Datum offset (mm)'],tracks:['Track groove width (mm)','Track depth (mm)'],clamps:['Clamp height (mm)','Maximum reach (mm)'],vise:['Jaw height (mm)','Maximum opening (mm)'],fixtures:['Fixture thickness (mm)','Mounting depth (mm)']};
function renderAssetManager(group){const host=$('asset-'+group);if(!host)return;const lib=ensureLibrary(),items=lib[group]||[],extra=assetExtraLabels[group];host.innerHTML='<div class="csv-controls"><label>'+(group==='bedplate'?'Bed plate DXF':'Upload DXF')+'<input type="file" accept=".dxf,application/dxf" data-dxf-upload="'+group+'"'+(group==='bedplate'?'':' multiple')+'></label><button type="button" data-save-assets="'+group+'" class="primary">Save '+setupGroups[group]+'</button></div>'+ (items.length?'<div class="fixture-table-scroll"><table class="fixture-table asset-table"><thead><tr><th>Name</th><th>Source DXF</th><th>Envelope width (mm)</th><th>Envelope length (mm)</th><th>'+extra[0]+'</th><th>'+extra[1]+'</th><th>Circles</th><th>Lines</th><th>Polylines</th><th>Action</th></tr></thead><tbody>'+items.map((a,i)=>'<tr data-asset-row="'+group+'" data-index="'+i+'"><td><input data-asset-key="name" value="'+escapeHtml(a.name)+'" aria-label="Asset name"></td><td>'+escapeHtml(a.fileName)+'</td><td><input type="number" data-asset-key="width" value="'+Number(a.width||0).toFixed(3)+'"></td><td><input type="number" data-asset-key="height" value="'+Number(a.height||0).toFixed(3)+'"></td><td><input type="number" data-asset-key="propertyA" value="'+escapeHtml(a.propertyA??'')+'"></td><td><input type="number" data-asset-key="propertyB" value="'+escapeHtml(a.propertyB??'')+'"></td><td>'+a.circleCount+'</td><td>'+a.lineCount+'</td><td>'+a.polylineCount+'</td><td><button type="button" data-asset-remove="'+group+'" data-index="'+i+'">Remove</button></td></tr>').join('')+'</tbody></table></div>':'<p class="hint">No DXF files loaded for this step yet.</p>');}
for(const group of Object.keys(setupGroups))renderAssetManager(group);
const uploadChoiceMarkup = `
<div id="dxfUploadChoice" class="dxf-choice-backdrop" hidden>
  <section class="dxf-choice-dialog" role="dialog" aria-modal="true" aria-labelledby="dxfChoiceTitle" aria-describedby="dxfChoiceMessage">
    <h2 id="dxfChoiceTitle">DXF data already exists</h2>
    <p id="dxfChoiceMessage"></p>
    <div class="dxf-choice-actions">
      <button type="button" data-upload-mode="overwrite" class="primary">Overwrite existing data</button>
      <button type="button" data-upload-mode="add">Add to existing data</button>
      <button type="button" data-upload-mode="cancel">Cancel</button>
    </div>
  </section>
</div>`;
document.querySelector('#app').insertAdjacentHTML('beforeend', uploadChoiceMarkup);
function roundDxfValue(value){return Math.round((Number(value)+Number.EPSILON)*10)/10;}
function roundedDxfSummary(summary){
  return {...summary,minX:roundDxfValue(summary.minX),minY:roundDxfValue(summary.minY),maxX:roundDxfValue(summary.maxX),maxY:roundDxfValue(summary.maxY),width:roundDxfValue(summary.width),height:roundDxfValue(summary.height),circles:summary.circles.map(circle=>({...circle,x:roundDxfValue(circle.x),y:roundDxfValue(circle.y),diameter:roundDxfValue(circle.diameter)}))};
}
function askDxfUploadMode(group) {
  const modal=$('dxfUploadChoice'), message=$('dxfChoiceMessage');
  message.textContent=group==='bedplate'
    ? 'Overwrite replaces the current bed-plate DXF, perimeter, mounting holes, and alignment holes. Add keeps them and merges this DXF into the setup. Add assumes both files use the same XY datum.'
    : 'Overwrite replaces the current T-track DXF inventory. Add keeps the existing tracks and adds the selected DXF files.';
  modal.hidden=false;
  return new Promise(resolve=>{
    const finish=mode=>{modal.hidden=true;document.removeEventListener('click',onClick);document.removeEventListener('keydown',onKey);resolve(mode);};
    const onClick=e=>{const button=e.target.closest('[data-upload-mode]');if(button&&modal.contains(button))finish(button.dataset.uploadMode);};
    const onKey=e=>{if(e.key==='Escape')finish('cancel');};
    document.addEventListener('click',onClick);document.addEventListener('keydown',onKey);
    modal.querySelector('[data-upload-mode="overwrite"]').focus();
  });
}
const dxfPointKey=h=>[Number(h.x).toFixed(3),Number(h.y).toFixed(3),Number(h.diameter).toFixed(3)].join('|');
function mergeDxfHoles(existing,incoming) {
  const merged=[...existing],keys=new Set(existing.map(dxfPointKey));
  for(const hole of incoming)if(!keys.has(dxfPointKey(hole))){merged.push(hole);keys.add(dxfPointKey(hole));}
  return merged;
}
document.addEventListener('change',async event=>{
  const input=event.target.closest('[data-dxf-upload]');if(!input)return;
  const group=input.dataset.dxfUpload,files=[...input.files];if(!files.length)return;
  const lib=ensureLibrary();
  const existing=group==='bedplate'
    ? (lib.bedplate.length>0||state.savedPlateFiles?.perimeter?.pathFormat===3||state.plateFiles?.perimeter?.pathFormat===3||state.settings.fixture?.holes?.length>0||state.settings.fixture?.alignmentHoles?.length>0)
    : group==='tracks'&&lib.tracks.length>0;
  try{
    const mode=existing&&(group==='bedplate'||group==='tracks')?await askDxfUploadMode(group):'add';
    if(mode==='cancel')return;
    const priorAssets=[...lib[group]];
    if(mode==='overwrite'&&group==='bedplate'){
      const fixture=readFixtureEditor();
      state.settings.fixture={...fixture,holes:[],alignmentHoles:[]};
      state.plateFiles={};
      state.savedPlateFiles={};
      lib.bedplate=[];
      state.fixtureDirty=true;state.plateDirty=true;
      renderFixtureEditor();renderPlateIso();updatePlateSaveButton();renderAssetManager(group);refreshDashboard();
    }else if(mode==='overwrite'&&group==='tracks'){
      lib.tracks=[];
      renderAssetManager(group);refreshDashboard();
    }
    const parsed=[];
    for(const file of files){
      const g=roundedDxfSummary(parseDxfSummary(await file.text()));
      parsed.push({file,g,asset:{name:file.name.replace(/\\.dxf$/i,''),fileName:file.name,units:g.units,width:g.width,height:g.height,minX:g.minX,minY:g.minY,maxX:g.maxX,maxY:g.maxY,circleCount:g.circles.length,lineCount:g.lineCount,polylineCount:g.polylineCount,entityCount:g.entityCount,propertyA:'',propertyB:'',circles:g.circles}});
    }
    lib[group]=mode==='overwrite'?parsed.map(item=>item.asset):[...priorAssets,...parsed.map(item=>item.asset)];
    if(group==='bedplate'){
      const priorFixture=readFixtureEditor();
      const oldBolts=mode==='add'?(priorFixture.holes||[]):[],oldPins=mode==='add'?(priorFixture.alignmentHoles||[]):[];
      const newBolts=[],newPins=[];
      for(const {g} of parsed){
        newPins.push(...g.circles.filter(c=>/pin|align|dowel/i.test(c.layer)).map((h,i)=>({name:'Alignment pin '+(oldPins.length+newPins.length+i+1),x:h.x,y:h.y,diameter:h.diameter})));
        newBolts.push(...g.circles.filter(c=>!/pin|align|dowel/i.test(c.layer)).map((h,i)=>({name:'Bed plate hole '+(oldBolts.length+newBolts.length+i+1),x:h.x,y:h.y,diameter:h.diameter})));
      }
      const bolts=mode==='overwrite'?[...newBolts]:mergeDxfHoles(oldBolts,newBolts);
      const pins=mode==='overwrite'?[...newPins]:mergeDxfHoles(oldPins,newPins);
      state.settings.fixture={...priorFixture,holes:bolts,alignmentHoles:pins};
      state.fixtureDirty=true;renderFixtureEditor();
      const priorPerimeter=mode==='add'?state.plateFiles.perimeter:null;
      const boundsList=[...(priorPerimeter?.bounds?[priorPerimeter.bounds]:[]),...parsed.map(({g})=>({minX:g.minX,maxX:g.maxX,minY:g.minY,maxY:g.maxY}))];
      const bounds={minX:Math.min(...boundsList.map(b=>b.minX)),maxX:Math.max(...boundsList.map(b=>b.maxX)),minY:Math.min(...boundsList.map(b=>b.minY)),maxY:Math.max(...boundsList.map(b=>b.maxY))};
      const perimeterName=parsed.map(x=>x.file.name).join(', ');
      state.plateFiles.perimeter={pathFormat:3,kind:'perimeter',fileName:mode==='add'&&priorPerimeter?priorPerimeter.fileName+', '+perimeterName:perimeterName,width:roundDxfValue(bounds.maxX-bounds.minX),height:roundDxfValue(bounds.maxY-bounds.minY),bounds,displayUnits:'mm',perimeterSource:parsed.map(x=>x.g.perimeterSource).join('; ')};
      state.plateFiles.boltHoles={pathFormat:3,kind:'boltHoles',fileName:state.plateFiles.perimeter.fileName,holes:bolts.map(h=>({...h,type:'bolt'}))};
      state.plateFiles.alignmentPins={pathFormat:3,kind:'alignmentPins',fileName:state.plateFiles.perimeter.fileName,holes:pins.map(h=>({...h,type:'alignmentPin'}))};
      state.plateDirty=true;renderPlateIso();updatePlateSaveButton();
    }
    renderAssetManager(group);refreshDashboard();
  }catch(e){alert('DXF import failed: '+e.message);}
  finally{input.value='';}
});
document.addEventListener('input',e=>{const row=e.target.closest('[data-asset-row]');if(row){const item=ensureLibrary()[row.dataset.assetRow][Number(row.dataset.index)];item[e.target.dataset.assetKey]=e.target.dataset.assetKey==='name'?e.target.value:(e.target.value===''?'':Number(e.target.value));}});
document.addEventListener('click',async e=>{const rem=e.target.closest('[data-asset-remove]');if(rem){const group=rem.dataset.assetRemove;ensureLibrary()[group].splice(Number(rem.dataset.index),1);renderAssetManager(group);refreshDashboard();}const save=e.target.closest('[data-save-assets]');if(save){try{const patch={fixtureLibrary:ensureLibrary()};if(save.dataset.saveAssets==='bedplate'){patch.fixture=readFixtureEditor();patch.plateFiles=state.plateFiles;}await persistSettingsPatch(patch);if(patch.fixture){state.savedFixture=structuredClone(patch.fixture);state.fixtureDirty=false;state.savedPlateFiles=structuredClone(state.plateFiles);state.plateDirty=false;}save.textContent='Saved';refreshDashboard();}catch(err){alert('Save failed: '+err.message);}}});
document.addEventListener('click',async event=>{const button=event.target.closest('[data-save-workholding]');if(!button)return;button.disabled=true;try{const fixture=readFixtureEditor();await persistSettingsPatch({fixture,fixtureLibrary:ensureLibrary(),plateFiles:state.plateFiles});state.settings.fixture=fixture;state.savedFixture=structuredClone(fixture);state.savedPlateFiles=structuredClone(state.plateFiles);state.fixtureDirty=false;state.plateDirty=false;document.querySelectorAll('[data-workholding-status]').forEach(el=>el.textContent='Workholding configuration saved.');$('fixtureSaveStatus').textContent='Workholding configuration saved.';refreshDashboard();}catch(error){document.querySelectorAll('[data-workholding-status]').forEach(el=>el.textContent='Save failed: '+error.message);}finally{button.disabled=false;}});
function configuredBedplate(){return ensureLibrary().bedplate.length>0||Boolean(state.savedPlateFiles?.perimeter?.pathFormat===3&&state.savedPlateFiles?.boltHoles?.pathFormat===3);}
function refreshDashboard(){const billets=readBilletInventory?.()||state.settings.billets||[];const tools=readToolInventory?.()||state.settings.tools||[];const lib=ensureLibrary();const metric=tools.filter(t=>t.unit==='mm').length,imperial=tools.filter(t=>t.unit==='in').length;const clampCount=(state.settings.fixture?.clamps||[]).length;const viseCount=(state.settings.fixture?.vise?.name&&Number(state.settings.fixture.vise.maxOpening)>0)?1:0;const fixtureCount=lib.fixtures.length;const cards=[['Billets defined',billets.length,'Raw stock inventory'],['Metric tools',metric,'Millimeter diameters'],['Imperial tools',imperial,'Inch diameters'],['Bed plate configured',configuredBedplate()?'✓':'—','DXF or saved plate layout'],['Surface clamps loaded',clampCount,'Configured clamp types and DXFs'],['Vises / fixtures loaded',viseCount+' / '+fixtureCount,'Dedicated setup inventory']];$('setupDashboard').innerHTML=cards.map(c=>'<article class="dashboard-card"><span>'+c[0]+'</span><strong>'+c[1]+'</strong><small>'+c[2]+'</small></article>').join('');}
document.querySelectorAll('[data-go-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.goTab)));
document.querySelectorAll('[data-tab]').forEach(b=>{const prior=b.onclick;b.addEventListener('click',refreshDashboard);});
$('stockInventoryEditor').addEventListener('input',refreshDashboard);$('toolInventoryEditor').addEventListener('input',refreshDashboard);$('fixtureEditor').addEventListener('change',refreshDashboard);
refreshDashboard();
