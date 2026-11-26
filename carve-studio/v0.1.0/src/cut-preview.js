import {simulateCut} from './cut-simulation.js';

const rgb = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;

function drawStock(canvas, grid, angled) {
  const {width, height, thickness, columns, rows, cellWidth, cellHeight, depths} = grid;
  const {width: viewWidth, height: viewHeight} = canvas.getBoundingClientRect();
  if (!viewWidth || !viewHeight) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1, 1440 / viewWidth);
  const w = Math.round(viewWidth * ratio), h = Math.round(viewHeight * ratio);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const pixels = new Uint32Array(image.data.buffer);

  const shear = angled ? .36 : 0, tilt = angled ? .60 : 1, vertical = angled ? .82 : 0;
  const spanX = width + shear * height, spanY = tilt * height + vertical * thickness;
  const scale = Math.min(w * .88 / spanX, h * .83 / spanY);
  const offsetX = (w - spanX * scale) / 2, offsetY = (h - spanY * scale) / 2;
  const depthAt = (col, row) => depths[row * columns + col];
  const brush = (left, right, top, bottom, color) => {
    for (let y = Math.max(0, top); y < Math.min(h, bottom); y++) {
      pixels.fill(color, y * w + left, y * w + right);
    }
  };

  // Draw columns from the far edge forward. Uncut foreground columns occlude deeper surfaces.
  for (let row = rows - 1; row >= 0; row--) {
    const y = (rows - row - 1) * cellHeight;
    const rowX = offsetX + y * shear * scale, rowY = offsetY + y * tilt * scale;
    const rowHeight = Math.max(1, tilt * cellHeight * scale);
    for (let col = columns - 1; col >= 0; col--) {
      const depth = depthAt(col, row);
      if (depth >= thickness - .0005) continue;
      const x = col * cellWidth;
      const left = Math.floor(rowX + x * scale);
      const right = Math.ceil(rowX + (x + cellWidth + shear * cellHeight) * scale);
      const top = rowY + depth * vertical * scale;
      const bottom = Math.ceil(rowY + thickness * vertical * scale + rowHeight);
      const grain = 3 * Math.sin(y * .64 + .8 * Math.sin(x * .027)) + 1.7 * Math.sin(y * 2.2 + x * .019);
      const dx = (depthAt(Math.min(col + 1, columns - 1), row) - depthAt(Math.max(col - 1, 0), row)) / (2 * cellWidth);
      const dy = (depthAt(col, Math.min(row + 1, rows - 1)) - depthAt(col, Math.max(row - 1, 0))) / (2 * cellHeight);
      const light = (dx * .37 - dy * .58 + .73) / Math.hypot(dx, dy, 1);
      const shadow = Math.max(0, Math.min(1, light / .73));
      const base = .55 + .45 * shadow - .28 * depth / thickness;
      if (angled) brush(left, right, Math.floor(top), bottom, rgb(138 + grain * 2, 99 + grain, 61 + grain));
      brush(left, right, Math.floor(top), Math.ceil(top + rowHeight), rgb(231 * base + grain, 194 * base + grain, 145 * base + grain));
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function setupCutPreview(readStock, readJobs) {
  const dialog = document.getElementById('cut-preview-dialog');
  const canvas = document.getElementById('cut-preview-canvas');
  const status = document.getElementById('cut-preview-status');
  const stockLabel = document.getElementById('cut-preview-stock');
  const operation = document.getElementById('cut-preview-operation');
  const views = [...dialog.querySelectorAll('[data-cut-view]')];
  let angled = true, model, request = 0;

  function draw() {
    if (dialog.open && model) drawStock(canvas, model, angled);
  }

  async function update() {
    const item = ++request;
    const stock = readStock();
    const jobs = readJobs().filter(job => !operation.value || String(job.id) === operation.value);
    model = null;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    status.textContent = 'Calculating cut preview…';
    canvas.setAttribute('aria-busy', 'true');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (item !== request) return;
    try {
      const result = await simulateCut(stock, jobs, () => item !== request);
      if (item !== request) return;
      model = result;
      draw();
      const count = model.count;
      const notes = [count + ' of ' + jobs.length + ' toolpaths shown'];
      if (model.skipped.length) notes.push('Cutter geometry missing for ' + model.skipped.join(', ') + '. Choose a tool preset and regenerate to preview.');
      if (model.estimatedDrills.length) notes.push('Drawn hole diameter used for ' + model.estimatedDrills.join(', ') + '.');
      status.textContent = notes.join(' · ');
    } catch (error) {
      if (item === request) status.textContent = error.message || String(error);
    } finally {
      if (item === request) canvas.removeAttribute('aria-busy');
    }
  }

  document.getElementById('open-cut-preview').addEventListener('click', () => {
    if (dialog.open) return;
    const stock = readStock();
    stockLabel.textContent = [stock.width, stock.height, stock.thickness].map(value =>
      Number(value.toFixed(2))).join(' × ') + ' mm stock';
    operation.replaceChildren(new Option('All generated toolpaths', ''),
      ...readJobs().map(job => new Option(job.name, String(job.id))));
    dialog.showModal();
    update();
  });
  operation.addEventListener('change', update);
  for (const button of views) {
    button.addEventListener('click', () => {
      const nextAngled = button.dataset.cutView === 'angled';
      if (angled === nextAngled) return;
      angled = nextAngled;
      for (const view of views) view.setAttribute('aria-pressed', String(view === button));
      draw();
    });
  }
  dialog.addEventListener('close', () => {request++; model = null;});
  new ResizeObserver(draw).observe(canvas);
}
