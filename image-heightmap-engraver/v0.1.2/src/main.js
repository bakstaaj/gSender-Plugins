import { gcode } from '@sienci/gsender-plugin-sdk';
import { generateHeightmapGcode, toGrayscale } from './heightmap.js';
import './style.css';

const $ = (id) => document.getElementById(id), state = { image: null, gray: null, gcode: '' };
document.querySelector('#app').innerHTML = `
<header><div class="eyebrow">GRAYSCALE RASTER ENGRAVING</div><h1>Image Heightmap Engraver</h1><p>Convert an image into a heightmap engraving file for review in gSender Carve.</p></header>
<section class="panel"><div class="heading"><div><small>01 · IMAGE</small><h2>Choose an image</h2></div><span>0 = Z0 · 255 = max depth</span></div><label>Image file<input id="file" type="file" accept="image/*"></label><div class="imageRow"><div class="preview"><img id="preview" hidden alt="Grayscale heightmap preview"><span id="empty">Preview appears here</span></div><div><b id="dimensions">No image loaded</b><label class="check"><input id="invert" type="checkbox"> Invert grayscale</label><p class="hint">Dark pixels map near Z0. Bright pixels cut deeper. Invert swaps the light and dark areas.</p><p id="pixelInfo" class="hint"></p></div></div></section>
<section class="panel"><div class="heading"><div><small>02 · ENGRAVING AREA</small><h2>Set size and depth</h2></div><span>Millimeters</span></div><div class="grid">
<label>X size<input id="x" type="number" min="0.1" step="0.1" value="100"></label><label>Y size<input id="y" type="number" min="0.1" step="0.1" value="75"></label><label class="check ratio"><input id="ratio" type="checkbox" checked> Maintain image aspect ratio</label>
<label class="check frame"><input id="frame" type="checkbox"> Add 5 mm Z0 frame</label>
<label>Maximum Z depth<input id="depth" type="number" min="0.01" step="0.1" value="1"></label><label>Engraving feed (mm/min)<input id="feed" type="number" min="1" value="800"></label><label>Plunge rate (mm/min)<input id="plunge" type="number" min="1" value="200"></label><label>Safe Z<input id="safe" type="number" min="0.1" step="0.1" value="3"></label><label>Origin X<input id="ox" type="number" step="0.1" value="0"></label><label>Origin Y<input id="oy" type="number" step="0.1" value="0"></label></div><p class="hint">Without a frame, the image lower-left is the X/Y origin. With a frame, the outer lower-left corner is the origin and the image starts 5 mm in from each frame edge. The image top is at maximum Y. Maximum depth is entered positive and written as negative Z. The optional frame adds 5 mm beyond every image edge and has 1.5 mm rounded inside corners.</p></section>
<div class="actions"><button id="make">Generate G-code</button><button id="load" disabled>Load into Carve</button><button id="export" class="secondary" disabled>Export .nc</button><button id="copy" class="secondary" disabled>Copy G-code</button></div><div id="notice" role="status">Load an image to begin. Generation does not start a CNC job.</div>
<section id="output" class="panel" hidden><div class="heading"><div><small>03 · OUTPUT</small><h2>Generated raster path</h2></div><span id="stats"></span></div><pre id="code"></pre><p class="caution">This emits one raster sample per source pixel. Large images produce large files. Tool diameter, feeds and speeds, stock, fixtures, and machine travel are not checked. Simulate and inspect before machining.</p></section><footer>Image conversion and G-code generation run locally.</footer>`;

function note(text, type = '') { $('notice').textContent = text; $('notice').className = type; }
function sizeFromX() { if (state.gray && $('ratio').checked) $('y').value = (Number($('x').value) * state.gray.height / state.gray.width).toFixed(2); }
function sizeFromY() { if (state.gray && $('ratio').checked) $('x').value = (Number($('y').value) * state.gray.width / state.gray.height).toFixed(2); }
function renderGray() {
  if (!state.image) return;
  const c = document.createElement('canvas'); c.width = state.image.naturalWidth; c.height = state.image.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(state.image, 0, 0);
  state.gray = toGrayscale(ctx.getImageData(0, 0, c.width, c.height), $('invert').checked);
  const out = ctx.createImageData(c.width, c.height);
  for (let p = 0, i = 0; p < state.gray.pixels.length; p++, i += 4) { const v = state.gray.pixels[p]; out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255; }
  ctx.putImageData(out, 0, 0); $('preview').src = c.toDataURL('image/png'); $('preview').hidden = false; $('empty').hidden = true;
  $('dimensions').textContent = `${c.width} × ${c.height} pixels`; $('pixelInfo').textContent = `${(c.width * c.height).toLocaleString()} grayscale points; large images make large G-code files.`;
  state.gcode = ''; $('load').disabled = $('export').disabled = $('copy').disabled = true; $('output').hidden = true;
}
function makeGcode() {
  if (!state.gray) throw new Error('Choose an image first.');
  for (const id of ['x', 'y', 'depth', 'feed', 'plunge', 'safe']) if (!Number.isFinite(Number($(id).value)) || Number($(id).value) <= 0) throw new Error('All dimensions, depth, feed, plunge, and safe Z values must be greater than zero.');
  if (!Number.isFinite(Number($('ox').value)) || !Number.isFinite(Number($('oy').value))) throw new Error('Origin X/Y must be valid numbers.');
  if (state.gray.pixels.length > 300000) throw new Error('This image has over 300,000 pixels. Resize it before generating to keep the G-code file manageable.');
  state.gcode = generateHeightmapGcode({ ...state.gray, sizeX: +$('x').value, sizeY: +$('y').value, maxDepth: +$('depth').value, feed: +$('feed').value, plunge: +$('plunge').value, safeZ: +$('safe').value, originX: +$('ox').value, originY: +$('oy').value, frame: $('frame').checked });
  $('stats').textContent = `${state.gray.width} × ${state.gray.height} · ${Math.round(state.gcode.length / 1024)} KB`;
  const lines = state.gcode.split('\n'); $('code').textContent = lines.slice(0, 65).join('\n') + (lines.length > 65 ? '\n…\n' : '');
  $('output').hidden = false; $('load').disabled = $('export').disabled = $('copy').disabled = false;
  note(`G-code generated for ${state.gray.width} × ${state.gray.height} grayscale points. Review and simulate before machining.`, 'success');
}
$('file').onchange = () => { const file = $('file').files?.[0]; if (!file) return; const img = new Image(); img.onload = () => { if (img.naturalWidth * img.naturalHeight > 300000) { note('This image has over 300,000 pixels. Resize it before loading to keep the G-code file manageable.', 'error'); URL.revokeObjectURL(img.src); return; } state.image = img; renderGray(); sizeFromX(); note('Converted to grayscale: 0 maps to Z0 and 255 maps to maximum depth.'); URL.revokeObjectURL(img.src); }; img.onerror = () => note('Could not read that image. Choose another supported image.', 'error'); img.src = URL.createObjectURL(file); };
$('invert').onchange = renderGray; $('x').onchange = sizeFromX; $('y').onchange = sizeFromY; $('ratio').onchange = () => { if ($('ratio').checked) sizeFromX(); };
$('make').onclick = () => { try { makeGcode(); } catch (e) { note(e.message, 'error'); } };
$('load').onclick = async () => { const b = $('load'); b.disabled = true; b.textContent = 'Loading…'; try { if (!state.gcode) makeGcode(); await gcode.loadToVisualizer(state.gcode, 'image-heightmap-engraving.nc'); note('Loaded into gSender visualizer for Carve review. No CNC job was started.', 'success'); } catch (e) { note(`Could not load into Carve: ${e?.message || e}. Check Visualizer Load permission.`, 'error'); } finally { b.disabled = !state.gcode; b.textContent = 'Load into Carve'; } };
$('export').onclick = () => { if (!state.gcode) return; const u = URL.createObjectURL(new Blob([state.gcode], { type: 'text/plain;charset=utf-8' })); const a = document.createElement('a'); a.href = u; a.download = 'image-heightmap-engraving.nc'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(state.gcode); note('G-code copied to clipboard.', 'success'); } catch { note('Clipboard access is unavailable in this gSender view. Use Export .nc instead.', 'error'); } };
