import { gcode } from '@sienci/gsender-plugin-sdk';
import { rotateToolpathCW } from './transform.js';
import './style.css';

const $ = (id) => document.getElementById(id);
let sourceName = '';
let currentGcode = '';
let rotations = 0;

function setStatus(message, kind = '') {
  $('status').textContent = message;
  $('status').className = kind;
}

$('file').addEventListener('change', async () => {
  const file = $('file').files?.[0];
  if (!file) return;
  try {
    currentGcode = await file.text();
    if (!currentGcode.trim()) throw new Error('The selected file is empty.');
    sourceName = file.name;
    rotations = 0;
    $('fileName').textContent = sourceName;
    $('rotate').disabled = false;
    setStatus('Source ready. Press the button to rotate and load it.');
  } catch (error) {
    currentGcode = '';
    $('rotate').disabled = true;
    setStatus(error.message || String(error), 'error');
  }
});

$('rotate').addEventListener('click', async () => {
  if (!currentGcode) return;
  $('rotate').disabled = true;
  try {
    const angle = Number($('angle').value);
    const transformed = rotateToolpathCW(currentGcode, angle);
    rotations += angle;
    const normalizedRotation = rotations % 360;
    const outputName = `${sourceName.replace(/\.[^.]+$/, '')}-rotated-${normalizedRotation || 360}cw.nc`;
    await gcode.loadToVisualizer(transformed.text, outputName);
    currentGcode = transformed.text;
    setStatus(`Rotated ${angle}° clockwise. New bounds: X ${transformed.bounds.minX}–${transformed.bounds.maxX}, Y ${transformed.bounds.minY}–${transformed.bounds.maxY}. Lower-left is now WPOS 0,0.`, 'success');
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    $('rotate').disabled = !currentGcode;
  }
});
