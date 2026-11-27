import {selectCutPreviewJobs, simulateCut} from './cut-simulation.js';

const rgb = (r, g, b) => (255 << 24) | (b << 16) | (g << 8) | r;
const orbitGridCache = new WeakMap();

function drawStock(canvas, grid, angled, orbit) {
  const {width, height, thickness, columns, rows, depths} = grid;
  const {width: viewWidth, height: viewHeight} = canvas.getBoundingClientRect();
  if (!viewWidth || !viewHeight) return;
  // Keep the preview lightweight: it is a visual guide, not a render-quality export.
  const ratio = Math.min(1.25, window.devicePixelRatio || 1, 1100 / viewWidth);
  const w = Math.round(viewWidth * ratio), h = Math.round(viewHeight * ratio);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!angled) {
    const image = ctx.createImageData(w, h);
    const pixels = new Uint32Array(image.data.buffer);
    const scale = Math.min(w * .88 / width, h * .83 / height);
    const cellPixelsX = width / columns * scale, cellPixelsY = height / rows * scale;
    const offsetX = (w - width * scale) / 2, offsetY = (h - height * scale) / 2;
    for (let row=0; row<rows; row++) for (let col=0; col<columns; col++) {
      const depth = depths[row * columns + col];
      const shade = Math.max(.48, 1 - .35 * depth / thickness);
      const color = rgb(231 * shade, 194 * shade, 145 * shade);
      const left = Math.floor(offsetX + col * cellPixelsX), right = Math.ceil(offsetX + (col + 1) * cellPixelsX);
      const top = Math.floor(offsetY + row * cellPixelsY), bottom = Math.ceil(offsetY + (row + 1) * cellPixelsY);
      for (let y=top; y<bottom; y++) pixels.fill(color, y * w + left, y * w + right);
    }
    ctx.putImageData(image,0,0);
    return;
  }

  const yaw = orbit * Math.PI / 180, elevation = Math.PI / 5;
  const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
  const cosElevation = Math.cos(elevation), sinElevation = Math.sin(elevation);
  const projectedCorners = [0,width].flatMap(x=>[0,height].flatMap(y=>[0,thickness].map(z=>({
    x:x*cosYaw+y*sinYaw,
    y:(x*sinYaw-y*cosYaw)*sinElevation+z*cosElevation,
  }))));
  const minX=Math.min(...projectedCorners.map(point=>point.x)), maxX=Math.max(...projectedCorners.map(point=>point.x));
  const minY=Math.min(...projectedCorners.map(point=>point.y)), maxY=Math.max(...projectedCorners.map(point=>point.y));
  const scale = Math.min(w * .88 / (maxX-minX), h * .83 / (maxY-minY));
  const centerX = w / 2, centerY = h / 2;
  const project = (x,y,z) => ({
    x: centerX + (x * cosYaw + y * sinYaw - (minX+maxX)/2) * scale,
    y: centerY + ((x * sinYaw - y * cosYaw) * sinElevation + z * cosElevation - (minY+maxY)/2) * scale,
  });
  let orbitGrid=orbitGridCache.get(grid);
  if (!orbitGrid) {
    const renderStep = Math.max(1,Math.ceil(Math.max(columns,rows)/84));
    const renderColumns = Math.ceil(columns/renderStep), renderRows = Math.ceil(rows/renderStep);
    const renderDepths = new Float32Array(renderColumns*renderRows);
    for (let row=0;row<renderRows;row++) for (let col=0;col<renderColumns;col++) {
      let deepest=0;
      for (let y=row*renderStep;y<Math.min(rows,(row+1)*renderStep);y++) {
        for (let x=col*renderStep;x<Math.min(columns,(col+1)*renderStep);x++) {
          deepest=Math.max(deepest,depths[y*columns+x]);
        }
      }
      renderDepths[row*renderColumns+col]=deepest;
    }
    orbitGrid={columns:renderColumns,rows:renderRows,depths:renderDepths};
    orbitGridCache.set(grid,orbitGrid);
  }
  const {columns:renderColumns,rows:renderRows,depths:renderDepths}=orbitGrid;
  const cellWidth=width/renderColumns,cellHeight=height/renderRows;
  const depthAt = (col, row) => renderDepths[row * renderColumns + col];
  const fillFace = (points,color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0].x,points[0].y);
    for (const point of points.slice(1)) ctx.lineTo(point.x,point.y);
    ctx.closePath();
    ctx.fill();
  };
  const cells = Array.from({length:renderRows*renderColumns},(_,index)=>{
    const col=index%renderColumns,row=Math.floor(index/renderColumns),x=col*cellWidth,y=row*cellHeight;
    return {col,row,x,y,depth:depthAt(col,row),cameraDepth:-x*sinYaw+y*cosYaw};
  }).sort((a,b)=>b.cameraDepth-a.cameraDepth);
  for (const {col,row,x,y,depth} of cells) {
    const p00=project(x,y,depth),p10=project(x+cellWidth,y,depth);
    const p11=project(x+cellWidth,y+cellHeight,depth),p01=project(x,y+cellHeight,depth);
    const grain=3*Math.sin(y*.64+.8*Math.sin(x*.027))+1.7*Math.sin(y*2.2+x*.019);
    const base=Math.max(.42,.96-.28*depth/thickness);
    fillFace([p00,p10,p11,p01],`rgb(${231*base+grain}, ${194*base+grain}, ${145*base+grain})`);

    const rightDepth=col+1<renderColumns?depthAt(col+1,row):thickness;
    if (rightDepth>depth+.04) fillFace([p10,project(x+cellWidth,y,rightDepth),project(x+cellWidth,y+cellHeight,rightDepth),p11],'#956b45');
    const lowerDepth=row+1<renderRows?depthAt(col,row+1):thickness;
    if (lowerDepth>depth+.04) fillFace([p01,p11,project(x+cellWidth,y+cellHeight,lowerDepth),project(x,y+cellHeight,lowerDepth)],'#815c3b');
  }
}

export function setupCutPreview(readStock, readJobs) {
  const dialog = document.getElementById('cut-preview-dialog');
  const canvas = document.getElementById('cut-preview-canvas');
  const status = document.getElementById('cut-preview-status');
  const stockLabel = document.getElementById('cut-preview-stock');
  const operation = document.getElementById('cut-preview-operation');
  const viewport = document.getElementById('cut-preview-viewport');
  const rotation = document.getElementById('cut-preview-rotation');
  const rotationValue = document.getElementById('cut-preview-rotation-value');
  const views = [...dialog.querySelectorAll('[data-cut-view]')];
  let angled = true, model, request = 0, dragX = null, dragAngle = 0;

  function setOrbit(value) {
    const degrees = ((Math.round(value) % 360) + 360) % 360;
    rotation.value = String(degrees);
    rotationValue.value = degrees + '°';
    rotationValue.textContent = degrees + '°';
    draw();
  }

  let drawFrame = 0;
  function draw() {
    if (drawFrame || !dialog.open || !model) return;
    drawFrame = requestAnimationFrame(() => {
      drawFrame = 0;
      if (dialog.open && model) drawStock(canvas, model, angled, Number(rotation.value));
    });
  }

  async function update() {
    const item = ++request;
    const stock = readStock();
    const {jobs, clearance, missingClearance} = selectCutPreviewJobs(readJobs(), operation.value);
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
      if (clearance) notes.push('Includes the matching end-mill clearance pass.');
      if (missingClearance) notes.push('Matching clearance pass is missing. Regenerate the flat-bottom groove.');
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
  rotation.addEventListener('input', () => setOrbit(Number(rotation.value)));
  viewport.addEventListener('pointerdown', event => {
    if (!angled || event.button !== 0) return;
    dragX = event.clientX;
    dragAngle = Number(rotation.value);
    viewport.classList.add('is-dragging');
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', event => {
    if (dragX === null) return;
    setOrbit(dragAngle + (event.clientX - dragX) * 360 / Math.max(240, viewport.clientWidth));
  });
  const stopRotation = event => {
    if (dragX === null) return;
    dragX = null;
    viewport.classList.remove('is-dragging');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener('pointerup', stopRotation);
  viewport.addEventListener('pointercancel', stopRotation);
  viewport.addEventListener('lostpointercapture', () => {dragX = null; viewport.classList.remove('is-dragging');});
  for (const button of views) {
    button.addEventListener('click', () => {
      const nextAngled = button.dataset.cutView === 'angled';
      if (angled === nextAngled) return;
      angled = nextAngled;
      for (const view of views) view.setAttribute('aria-pressed', String(view === button));
      rotation.disabled = !angled;
      draw();
    });
  }
  dialog.addEventListener('close', () => {
    request++;
    model = null;
    if (drawFrame) cancelAnimationFrame(drawFrame);
    drawFrame = 0;
  });
  new ResizeObserver(draw).observe(viewport);
  rotation.disabled = !angled;
  setOrbit(0);
}
