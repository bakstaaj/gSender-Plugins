import { gcode } from '@sienci/gsender-plugin-sdk';
import { detectOvalBounds, generateHeightmapGcode, maskOutsideOval, toGrayscale } from './heightmap.js';
import './style.css';

const $ = (id) => document.getElementById(id), state = { image: null, gray: null, gcode: '' };
document.querySelector('#app').innerHTML = `
<header><div class="eyebrow">GRAYSCALE RASTER ENGRAVING</div><h1>Image Heightmap Engraver</h1><p>Convert an image into a heightmap engraving file for review in gSender Carve.</p></header>
<section class="panel"><div class="heading"><div><small>01 · IMAGE</small><h2>Choose an image</h2></div><span>Image minimum = Z0 · maximum = max depth</span></div><label>Image file<input id="file" type="file" accept="image/*"></label><div class="imageRow"><div class="preview"><img id="preview" hidden alt="Grayscale heightmap preview"><span id="empty">Preview appears here</span></div><div><b id="dimensions">No image loaded</b><label class="check"><input id="invert" type="checkbox"> Invert grayscale</label><p class="hint">The lowest grayscale value in the loaded image maps to Z0. Its highest grayscale value maps to the selected maximum depth. Invert swaps light and dark before the image range is measured.</p><p id="pixelInfo" class="hint"></p></div></div></section>
<section class="panel"><div class="heading"><div><small>02 · ENGRAVING AREA</small><h2>Set size and depth</h2></div><span>Millimeters</span></div><div class="grid">
<label>X size<input id="x" type="number" min="0.1" step="0.1" value="100"></label><label>Y size<input id="y" type="number" min="0.1" step="0.1" value="75"></label><label class="check ratio"><input id="ratio" type="checkbox" checked> Maintain image aspect ratio</label>
<label class="check frame"><input id="frame" type="checkbox"> Add 5 mm Z0 frame</label>
<label class="check"><input id="twoPass" type="checkbox" checked> Two-tool roughing + finishing</label><label>Roughing allowance (mm)<input id="roughAllowance" type="number" min="0" step="0.1" value="0.3"></label>
<label class="check"><input id="crossHatch" type="checkbox"> Add perpendicular V-bit finish pass (optional third pass)</label>
<p class="hint">Two-tool mode uses a 1/8 inch flat endmill for a conservative roughing raster, then pauses (M0) for the 60° V-bit with 0.1 mm tip. Re-zero work Z0 to the stock surface before resuming. The same feed, plunge, and spindle settings apply to both tools.</p>
<label class="spindle">Spindle speed · <output id="rpmValue">10,000 RPM</output><input id="rpm" type="range" min="0" max="20000" step="100" value="10000"><span class="rangeScale"><span>0 RPM · spindle off</span><span>20,000 RPM</span></span></label>
<label>Maximum Z depth<input id="depth" type="number" min="0.01" step="0.1" value="1"></label><label>Engraving feed (mm/min)<input id="feed" type="number" min="1" value="800"></label><label>Plunge rate (mm/min)<input id="plunge" type="number" min="1" value="200"></label><label>Safe Z<input id="safe" type="number" min="0.1" step="0.1" value="3"></label><label>Origin X<input id="ox" type="number" step="0.1" value="0"></label><label>Origin Y<input id="oy" type="number" step="0.1" value="0"></label></div><p class="hint">Without a frame, the image lower-left is the X/Y origin. With a frame, the outer lower-left corner is the origin and the image starts 5 mm in from each frame edge. The image top is at maximum Y. Maximum depth is entered positive and written as negative Z. The optional frame adds 5 mm beyond every image edge and has 1.5 mm rounded inside corners. Spindle speed 0 leaves the spindle off; nonzero speed outputs M3 S value. Confirm your controller is configured for RPM.</p></section>
<div class="actions"><button id="make">Generate G-code</button><button id="load" disabled>Load into Carve</button><button id="export" class="secondary" disabled>Export .nc</button><button id="copy" class="secondary" disabled>Copy G-code</button></div><div id="notice" role="status">Load an image to begin. Generation does not start a CNC job.</div>
<section id="output" class="panel" hidden><div class="heading"><div><small>03 · OUTPUT</small><h2>Generated raster path</h2></div><span id="stats"></span></div><pre id="code"></pre><p class="caution">Two-tool output pauses with M0 for a manual tool change. Set work Z0 to the stock surface before resuming. Confirm your controller supports M0 and verify the complete file in simulation. Tool geometry, feeds and speeds, stock, fixtures, and machine travel are not checked.</p></section><footer>Settings are saved locally in this browser. Image conversion and G-code generation run locally.</footer>`;

function note(text, type = '') { $('notice').textContent = text; $('notice').className = type; }
const preferenceIds = ['x', 'y', 'ratio', 'invert', 'frame', 'twoPass', 'crossHatch', 'roughAllowance', 'rpm', 'depth', 'feed', 'plunge', 'safe', 'ox', 'oy'];
const preferenceKey = 'image-heightmap-engraver-settings-v1';
function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    for (const id of preferenceIds) {
      const element = $(id), value = saved[id];
      if (element.type === 'checkbox') { if (typeof value === 'boolean') element.checked = value; }
      else if (value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value))) element.value = String(value);
    }
  } catch { /* Keep the built-in defaults when storage is unavailable or invalid. */ }
}
function savePreferences() {
  try {
    const saved = Object.fromEntries(preferenceIds.map((id) => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
    localStorage.setItem(preferenceKey, JSON.stringify(saved));
  } catch { /* The plugin remains usable if storage is unavailable. */ }
}
loadPreferences();
for (const id of preferenceIds) { $(id).addEventListener('input', savePreferences); $(id).addEventListener('change', savePreferences); }
function grayscaleMappingMessage(gray) { return gray.minGray === gray.maxGray ? `The image is flat at grayscale ${gray.minGray}; all pixels map to Z0.` : `Image minimum ${gray.minGray} maps to Z0; maximum ${gray.maxGray} maps to the selected maximum depth.`; }
function sizeFromX() { if (state.gray && $('ratio').checked) $('y').value = (Number($('x').value) * state.gray.height / state.gray.width).toFixed(2); }
function sizeFromY() { if (state.gray && $('ratio').checked) $('x').value = (Number($('y').value) * state.gray.width / state.gray.height).toFixed(2); }
function renderGray() {
  if (!state.image) return;
  const c = document.createElement('canvas');
  const sourceWidth = state.image.naturalWidth, sourceHeight = state.image.naturalHeight;
  const scale = Math.min(1, Math.sqrt(300000 / (sourceWidth * sourceHeight)));
  c.width = Math.max(1, Math.floor(sourceWidth * scale)); c.height = Math.max(1, Math.floor(sourceHeight * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(state.image, 0, 0, c.width, c.height);
  state.gray = toGrayscale(ctx.getImageData(0, 0, c.width, c.height), $('invert').checked);
  state.gray.radialBounds = detectOvalBounds(state.gray);
  if (state.gray.radialBounds) maskOutsideOval(state.gray, state.gray.radialBounds);
  const out = ctx.createImageData(c.width, c.height);
  for (let p = 0, i = 0; p < state.gray.pixels.length; p++, i += 4) { const v = state.gray.pixels[p]; out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255; }
  ctx.putImageData(out, 0, 0); $('preview').src = c.toDataURL('image/png'); $('preview').hidden = false; $('empty').hidden = true;
  $('dimensions').textContent = `${c.width} × ${c.height} pixels`;
  const resized = c.width !== sourceWidth || c.height !== sourceHeight;
  $('pixelInfo').textContent = `${(c.width * c.height).toLocaleString()} grayscale points${resized ? `; automatically resized from ${sourceWidth} × ${sourceHeight} to stay within the 300,000 point limit` : ''}${state.gray.radialBounds ? '; oval outline detected: background outside it maps to Z0 and finishing uses an elliptical spiral' : ''}; range ${state.gray.minGray}–${state.gray.maxGray}; ${state.gray.minGray === state.gray.maxGray ? 'flat image maps to Z0.' : 'range maps across selected maximum depth.'}`;
  state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
}
function makeGcode() {
  if (!state.gray) throw new Error('Choose an image first.');
  for (const id of ['x', 'y', 'depth', 'feed', 'plunge', 'safe']) if (!Number.isFinite(Number($(id).value)) || Number($(id).value) <= 0) throw new Error('All dimensions, depth, feed, plunge, and safe Z values must be greater than zero.');
  if (!Number.isFinite(Number($('ox').value)) || !Number.isFinite(Number($('oy').value))) throw new Error('Origin X/Y must be valid numbers.');
  state.gcode = generateHeightmapGcode({ ...state.gray, sizeX: +$('x').value, sizeY: +$('y').value, maxDepth: +$('depth').value, feed: +$('feed').value, plunge: +$('plunge').value, safeZ: +$('safe').value, spindleSpeed: +$('rpm').value, originX: +$('ox').value, originY: +$('oy').value, frame: $('frame').checked, twoPass: $('twoPass').checked, crossHatch: $('crossHatch').checked, roughAllowance: +$('roughAllowance').value });
  $('stats').textContent = `${state.gray.width} × ${state.gray.height} · ${Math.round(state.gcode.length / 1024)} KB`;
  const lines = state.gcode.split('\n'); $('code').textContent = lines.slice(0, 65).join('\n') + (lines.length > 65 ? '\n…\n' : '');
  $('output').hidden = false; $('load').disabled = $('export').disabled = $('copy').disabled = false;
  note(`G-code generated for ${state.gray.width} × ${state.gray.height} grayscale points. Review and simulate before machining.`, 'success');
}
$('file').onchange = () => { const file = $('file').files?.[0]; if (!file) return; const img = new Image(); img.onload = () => { state.image = img; renderGray(); sizeFromX(); savePreferences(); note(grayscaleMappingMessage(state.gray)); URL.revokeObjectURL(img.src); }; img.onerror = () => note('Could not read that image. Choose another supported image.', 'error'); img.src = URL.createObjectURL(file); };
$('invert').onchange = () => { renderGray(); note(grayscaleMappingMessage(state.gray)); }; $('x').onchange = () => { sizeFromX(); savePreferences(); }; $('y').onchange = () => { sizeFromY(); savePreferences(); }; $('ratio').onchange = () => { if ($('ratio').checked) sizeFromX(); savePreferences(); };
$('rpm').oninput = () => { $('rpmValue').value = `${Number($('rpm').value).toLocaleString()} RPM`; savePreferences(); };
$('make').onclick = () => { try { makeGcode(); } catch (e) { note(e.message, 'error'); } };
$('load').onclick = async () => { const b = $('load'); b.disabled = true; b.textContent = 'Loading…'; try { if (!state.gcode) makeGcode(); await gcode.loadToVisualizer(state.gcode, 'image-heightmap-engraving.nc'); note('Loaded into gSender visualizer for Carve review. No CNC job was started.', 'success'); } catch (e) { note(`Could not load into Carve: ${e?.message || e}. Check Visualizer Load permission.`, 'error'); } finally { b.disabled = !state.gcode; b.textContent = 'Load into Carve'; } };
$('export').onclick = () => { if (!state.gcode) return; const u = URL.createObjectURL(new Blob([state.gcode], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = u; a.download = 'image-heightmap-engraving.nc'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(state.gcode); note('G-code copied to clipboard.', 'success'); } catch { note('Clipboard access is unavailable in this gSender view. Use Export .nc instead.', 'error'); } };
$('rpmValue').value = `${Number($('rpm').value).toLocaleString()} RPM`;
savePreferences();
