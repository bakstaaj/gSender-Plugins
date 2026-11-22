import { storage } from '@sienci/gsender-plugin-sdk';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { analyzeNc } from './nc.js';
import './style.css';

const PLUGIN_ID = 'com.bakstaaj.stock-fixture-visualizer';
const STORAGE_KEY = 'workspace';
const DB_NAME = `${PLUGIN_ID}-models`;
const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const $ = (id) => document.getElementById(id);
const state = { library: [], instances: [], projects: [], activeProjectId: null, selectedProjectId: null, libraryCategory: 'stock', pendingDeleteProjectId: null, pendingDeleteAssetId: null, renamingProjectId: null, renamingAssetId: null, projectDirty: false, checkConfig: { toolDiameter: 6.35, toolLength: 40, clearance: 3, includeRapid: true }, clearance: null, isChecking: false, job: null, selectedId: null, selectedAssetId: null, db: null, renderer: null, scene: null, camera: null, controls: null, transform: null, transformMode: 'translate', showTransformInputs: false, rotationGizmo: null, rotationDrag: null, pathGroup: null, objectGroup: null, checkGroup: null, meshById: new Map(), geometryCache: new Map(), triangleGridCache: new Map(), occt: null, saveTimer: null, showGrid: true, libraryViewer: null, projectViewer: null };

document.querySelector('#app').innerHTML = `
  <header class="app-header">
    <div><div class="eyebrow">SETUP REVIEW · STOCK + WORKHOLDING</div><h1>Stock &amp; Clamp Visualizer</h1><p>Build a stock and clamp library, place the models around an NC toolpath, and inspect the setup in 3D.</p></div>
    <span class="local-badge">Setup files stay on this device</span>
  </header>
  <nav class="workspace-tabs" aria-label="Plugin workspace"><button class="workspace-tab active" type="button" data-tab="setup">Setup workspace</button><button class="workspace-tab" type="button" data-tab="library">Model library</button><button class="workspace-tab" type="button" data-tab="projects">Saved projects</button></nav>
  <div id="setupWorkspace" class="workspace-page">
  <div class="app-layout">
    <aside class="sidebar">
      <section class="panel project-panel">
        <div class="section-title"><span>00</span><div><h2>Save setup project</h2><p>Save this setup and continue it later from the Saved Projects tab.</p></div></div>
        <label class="project-name-label">Project name<input id="projectName" type="text" maxlength="80" placeholder="e.g. Walnut tray setup"></label>
        <div class="project-buttons"><button id="saveProject" class="primary-button" type="button">Save project</button><button id="saveProjectAs" class="quiet" type="button">Save as new</button></div>
        <div id="projectStatus" class="status" role="status" aria-live="polite">Projects are saved locally in this gSender profile.</div>
      </section>

      <section class="panel job-panel">
        <div class="section-title"><span>01</span><div><h2>NC toolpath</h2><p>Load an NC or G-code file to display rapid and cutting moves.</p></div></div>
        <label class="file-picker">Import NC file<input id="jobFile" type="file" accept=".nc,.gcode,.tap,.ngc,.txt,.cnc"></label>
        <div id="jobStatus" class="status" role="status" aria-live="polite">No NC file loaded.</div>
        <div id="jobInfo" class="job-info" hidden></div>
        <div class="row"><button id="clearJob" class="quiet" type="button" disabled>Clear toolpath</button><button id="alignStock" class="quiet" type="button" disabled>Align stock to job</button></div>
        <div class="clearance-settings">
          <div class="subheading">Tool envelope and clearance</div>
          <div class="clearance-grid"><label>Tool diameter (mm)<input id="checkToolDiameter" type="number" min="0.1" step="0.1" value="6.35"></label><label>Tool length above tip (mm)<input id="checkToolLength" type="number" min="0" step="1" value="40"></label><label>Required clearance (mm)<input id="checkClearance" type="number" min="0" step="0.5" value="3"></label></div>
          <label class="visibility-control"><input id="includeRapids" type="checkbox" checked> Check rapid moves too</label>
          <button id="checkClearanceButton" class="check-button" type="button" disabled>Check clamp clearance</button>
          <div class="clearance-disclaimer">Conservative bounds screening for setup review; candidates may be false positives. Not a machine safety interlock.</div>
          <div id="clearanceResults" class="clearance-results" role="status" aria-live="polite">Load an NC file and add at least one clamp to check clearance.</div>
        </div>
      </section>

      <section class="panel scene-panel">
        <div class="section-title"><span>03</span><div><h2>Scene</h2><p>Select a model to position or rotate it.</p></div></div>
        <div id="sceneList" class="scene-list"><div class="empty-state">Add stock or clamps from the library.</div></div>
        <div id="transformPanel" class="transform-panel" hidden>
          <div class="selected-heading"><strong id="selectedName"></strong><button id="removeInstance" class="danger-link" type="button">Remove</button></div>
          <div class="transform-modes"><button id="moveMode" class="active" type="button">Move</button><button id="rotateMode" type="button">Rotate</button></div>
          <div class="transform-grid">
            <label>X (mm)<input id="posX" type="number" step="1"></label><label>Y (mm)<input id="posY" type="number" step="1"></label><label>Z (mm)<input id="posZ" type="number" step="1"></label>
            <label>Rotate X°<input id="rotX" type="number" step="5"></label><label>Rotate Y°<input id="rotY" type="number" step="5"></label><label>Rotate Z°<input id="rotZ" type="number" step="5"></label>
            <label>Scale<input id="scale" type="number" step="0.05" min="0.01"></label><label>Color<input id="color" type="color"></label>
          </div>
          <label class="opacity-control">Opacity <input id="opacity" type="range" min="0.12" max="1" step="0.02"><span id="opacityValue"></span></label>
          <label class="visibility-control"><input id="visible" type="checkbox"> Visible in scene</label>
          <p class="transform-hint">Drag the arrows to move and the colored rotation rings to turn the part. Choose Rotate for full-size rotation rings, or enter exact coordinates.</p>
        </div>
      </section>
      <div id="appStatus" class="app-status" role="status" aria-live="polite">Loading setup library…</div>
    </aside>

    <section class="viewer-panel" aria-label="3D setup viewer">
      <div class="viewer-toolbar"><div class="legend"><span><i class="cut-key"></i> Feed move</span><span><i class="rapid-key"></i> Rapid</span><span><i class="stock-key"></i> Stock</span><span><i class="clamp-key"></i> Clamps</span></div><div class="viewer-actions"><button id="fitView" type="button">Fit setup</button><button id="toggleGrid" type="button" aria-pressed="true">Grid on</button></div></div>
      <div id="viewer" class="viewer"><div id="viewerHint" class="viewer-hint">Import an NC file or add models from the library.</div><section id="quickTransform" class="quick-transform" hidden aria-label="Exact move and rotation values"><div class="quick-transform-heading"><div><strong id="quickTransformTitle">Exact transform</strong><span>Millimeters · degrees</span></div><button id="closeQuickTransform" type="button" aria-label="Hide exact transform controls" title="Hide controls">×</button></div><div class="quick-transform-group"><b>Move</b><label>X<input id="quickX" type="number" step="0.1"></label><label>Y<input id="quickY" type="number" step="0.1"></label><label>Z<input id="quickZ" type="number" step="0.1"></label></div><div class="quick-transform-group"><b>Rotate</b><label>X°<input id="quickRX" type="number" step="0.1"></label><label>Y°<input id="quickRY" type="number" step="0.1"></label><label>Z°<input id="quickRZ" type="number" step="0.1"></label></div><button id="applyQuickTransform" class="action-button action-primary" type="button">Apply values</button></section></div>
      <footer class="viewer-footer"><span>Drag to orbit · Shift + drag to pan · Scroll to zoom</span><span id="viewerReadout">Units: mm</span></footer>
    </section>
  </div>
  </div>
  <section id="libraryWorkspace" class="library-workspace" hidden>
    <div class="library-heading"><div><div class="eyebrow">MODEL LIBRARY</div><h2>Stock and clamps</h2><p>Click a part row to preview it. Change its type, add it to a setup, or delete it with the row actions.</p></div><div class="library-import-actions"><div class="import-controls"><label>Import as<select id="modelKind"><option value="stock">Stock</option><option value="clamp">Clamp</option></select></label><label class="file-picker">Import model<input id="modelFile" type="file" accept=".stl,.step,.stp,model/stl,application/step"></label></div><button id="showShapeForm" class="primary-button" type="button">+ Create basic shape</button></div></div>
    <section id="shapeForm" class="panel shape-form" hidden><div class="section-title"><span>NEW</span><div><h2>Create a basic shape</h2><p>Build a box or cylinder directly in millimeters.</p></div></div><div class="shape-fields"><label>Name<input id="shapeName" type="text" maxlength="80" placeholder="e.g. Rear vise jaw"></label><label>Type<select id="shapeKind"><option value="box">Box</option><option value="cylinder">Cylinder</option></select></label><label id="shapeWidthLabel"><span>Width (mm)</span><input id="shapeWidth" type="number" min="0.1" step="1" value="100"></label><label id="shapeDepthLabel"><span>Depth (mm)</span><input id="shapeDepth" type="number" min="0.1" step="1" value="60"></label><label>Height (mm)<input id="shapeHeight" type="number" min="0.1" step="1" value="20"></label><button id="createShape" class="primary-button" type="button">Add to library</button><button id="cancelShape" class="quiet" type="button">Cancel</button></div></section>
    <div class="library-workspace-grid">
      <section class="panel library-manager"><div class="library-category-tabs" role="tablist" aria-label="Model category"><button class="library-category-tab active" type="button" role="tab" aria-selected="true" data-library-category="stock">Stock <span id="stockCount">0</span></button><button class="library-category-tab" type="button" role="tab" aria-selected="false" data-library-category="clamp">Clamps <span id="clampCount">0</span></button></div><div id="libraryList" class="library-list"><div class="empty-state">No stock models yet.</div></div><p class="storage-note">Click a model row to preview it. Model files stay in this gSender browser profile.</p><div id="libraryStatus" class="status" role="status" aria-live="polite">Choose a model to preview it.</div></section>
      <section class="panel asset-preview-panel"><div class="asset-preview-toolbar"><div><strong id="assetPreviewTitle">Model preview</strong><span id="assetPreviewMeta">Select a library item</span></div><button id="fitAssetView" type="button">Fit model</button></div><div id="assetViewer" class="asset-viewer"><div id="assetViewerHint" class="viewer-hint">Select a model to preview it here.</div></div><footer class="viewer-footer"><span>Drag to orbit · Shift + drag to pan · Scroll to zoom</span><span>Independent library view</span></footer></section>
    </div>
  </section>
  <section id="projectsWorkspace" class="library-workspace" hidden>
    <div class="library-heading"><div><div class="eyebrow">SAVED PROJECTS</div><h2>Setup projects</h2><p>Click a project row to preview its NC path, stock, and clamps. Load it into Setup workspace to continue editing.</p></div></div>
    <div class="library-workspace-grid"><section class="panel library-manager"><div id="projectList" class="library-list"><div class="empty-state">No saved projects yet. Save a setup from the Setup workspace.</div></div><p class="storage-note">Projects are stored locally in this gSender browser profile.</p><div id="savedProjectStatus" class="status" role="status" aria-live="polite">Select a project to preview it.</div></section>
      <section class="panel asset-preview-panel"><div class="asset-preview-toolbar"><div><strong id="projectPreviewTitle">Project preview</strong><span id="projectPreviewMeta">Select a saved project</span></div><button id="fitProjectView" type="button">Fit project</button></div><div id="projectViewer" class="asset-viewer"><div id="projectViewerHint" class="viewer-hint">Select a saved project to preview its setup.</div></div><footer class="viewer-footer"><span>Drag to orbit · Shift + drag to pan · Scroll to zoom</span><span>Saved project view</span></footer></section>
    </div>
  </section>
`;

function setStatus(message, type = '') { $('appStatus').textContent = message; $('appStatus').className = `app-status ${type}`; }
function setJobStatus(message, type = '') { $('jobStatus').textContent = message; $('jobStatus').className = `status ${type}`; }
function escapeHtml(text) { return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
function uid() { return globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function openModelDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the local model library.'));
  });
}
function dbRequest(mode, action, key, value, storeName = 'files') {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = action === 'put' ? store.put(value, key) : action === 'delete' ? store.delete(key) : store.get(key);
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Local model storage failed.'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Local model storage transaction failed.'));
    tx.onabort = () => reject(tx.error || new Error('Local model storage transaction was aborted.'));
  });
}
function dbKeys(storeName) { return new Promise((resolve,reject)=>{const tx=state.db.transaction(storeName,'readonly'),request=tx.objectStore(storeName).getAllKeys();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error||new Error('Could not read local library index.'));}); }
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    try { await persistWorkspaceNow(); }
    catch (error) { setStatus(`Could not save the library settings: ${error.message || error}`, 'error'); }
  }, 250);
}
async function persistWorkspaceNow() {
  clearTimeout(state.saveTimer);
  const snapshot={library:state.library,instances:state.instances,projects:state.projects,activeProjectId:state.activeProjectId,checkConfig:state.checkConfig};
  await dbRequest('readwrite','put','__catalog__',snapshot,'projects');
  await storage.set(STORAGE_KEY,snapshot);
}
function markProjectDirty(message = 'Unsaved changes in this project.') {
  state.projectDirty = true;
  $('projectStatus').textContent = message;
  $('projectStatus').className = 'status';
}

function renderProjects() {
  const list=$('projectList'); if(!list)return;
  if(!state.projects.length){list.innerHTML='<div class="empty-state">No saved projects yet. Save a setup from the Setup workspace.</div>';return;}
  list.innerHTML=state.projects.map(p=>`<article class="library-item ${p.id===state.selectedProjectId?'active':''}" data-preview-project="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(p.name)}"><div class="item-meta">${state.renamingProjectId===p.id?`<input class="inline-rename-input" data-project-name-input="${escapeHtml(p.id)}" value="${escapeHtml(p.name)}" maxlength="80" aria-label="New project name">`:`<strong>${escapeHtml(p.name)}</strong>`}<span class="tag ${p.id===state.activeProjectId?'stock':''}">${p.id===state.activeProjectId?'active setup':'saved project'}</span><small>Saved ${p.updatedAt?new Date(p.updatedAt).toLocaleString():'locally'}</small></div><div class="item-actions">${state.renamingProjectId===p.id?`<button class="action-button action-primary" type="button" data-save-project-name="${escapeHtml(p.id)}">Save name</button><button class="action-button action-secondary" type="button" data-cancel-project-rename>Cancel</button>`:state.pendingDeleteProjectId===p.id?`<span class="delete-confirm-label">Delete this project?</span><button class="action-button action-danger" type="button" data-project-confirm-delete="${escapeHtml(p.id)}">Confirm delete</button><button class="action-button action-secondary" type="button" data-project-cancel-delete>Cancel</button>`:`<button class="action-button action-primary" type="button" data-project-load="${escapeHtml(p.id)}">Load to Setup</button><button class="action-button action-secondary" type="button" data-rename-project="${escapeHtml(p.id)}">Rename</button><button class="icon-button project-delete-button action-danger" type="button" data-project-delete="${escapeHtml(p.id)}" aria-label="Delete project ${escapeHtml(p.name)}" title="Delete project">×</button>`}</div></article>`).join('');
}
async function saveProjectName(id){const input=document.querySelector(`[data-project-name-input="${CSS.escape(id)}"]`),name=input?.value.trim(),meta=state.projects.find(p=>p.id===id);if(!meta)return;if(!name){$('savedProjectStatus').textContent='Project name cannot be empty.';input?.focus();return;}const project=await dbRequest('readonly','get',id,undefined,'projects');if(project){project.name=name;project.savedAt=new Date().toISOString();await dbRequest('readwrite','put',id,project,'projects');}meta.name=name;meta.updatedAt=project?.savedAt||new Date().toISOString();if(state.activeProjectId===id)$('projectName').value=name;if(state.selectedProjectId===id)$('projectPreviewTitle').textContent=name;state.renamingProjectId=null;renderProjects();scheduleSave();$('savedProjectStatus').textContent=`Renamed project to “${name}”.`;}
function saveAssetName(id){const input=document.querySelector(`[data-asset-name-input="${CSS.escape(id)}"]`),name=input?.value.trim(),asset=state.library.find(a=>a.id===id);if(!asset)return;if(!name){$('libraryStatus').textContent='Part name cannot be empty.';input?.focus();return;}asset.name=name;for(const instance of state.instances.filter(i=>i.modelId===id))instance.name=name;if(state.selectedAssetId===id)$('assetPreviewTitle').textContent=name;state.renamingAssetId=null;scheduleSave();markProjectDirty();renderLibrary();renderSceneList();$('libraryStatus').textContent=`Renamed part to “${name}”.`;}
function cameraSnapshot() { return { position: state.camera.position.toArray(), up: state.camera.up.toArray(), target: state.controls.target.toArray() }; }
async function saveProject(asNew = false) {
  const name = $('projectName').value.trim();
  if (!name) { $('projectStatus').textContent = 'Enter a project name before saving.'; return; }
  const id = asNew || !state.activeProjectId ? uid() : state.activeProjectId;
  const assets = [];
  for (const modelId of new Set(state.instances.map((i) => i.modelId))) {
    const metadata = state.library.find((a) => a.id === modelId);
    const buffer = metadata?.format === 'shape' ? null : await dbRequest('readonly', 'get', modelId);
    if (!metadata || (metadata.format !== 'shape' && !buffer)) throw new Error(`A model used by this project is missing (${modelId}).`);
    assets.push({ metadata: normalizeForStorage(metadata), ...(buffer ? { buffer } : {}) });
  }
  const project = { id, name, assets, instances: structuredClone(state.instances), job: state.job ? { name: state.job.name, text: state.job.rawText } : null, checkConfig: structuredClone(state.checkConfig), camera: cameraSnapshot(), savedAt: new Date().toISOString() };
  await dbRequest('readwrite', 'put', id, project, 'projects');
  state.projects = [{ id, name, updatedAt: project.savedAt }, ...state.projects.filter((p) => p.id !== id)];
  state.activeProjectId = id; state.projectDirty = false; $('projectStatus').textContent = `Saved “${name}” locally.`; $('projectStatus').className = 'status success'; renderProjects(); scheduleSave();
}
async function openProject(id) {
  const project = await dbRequest('readonly', 'get', id, undefined, 'projects'); if (!project) throw new Error('Could not find that saved project.');
  for (const bundled of project.assets || []) { if (!state.library.some((a) => a.id === bundled.metadata.id)) state.library.push(bundled.metadata); if (bundled.buffer) await dbRequest('readwrite', 'put', bundled.metadata.id, bundled.buffer); state.geometryCache.get(bundled.metadata.id)?.dispose(); state.geometryCache.delete(bundled.metadata.id); }
  state.instances = structuredClone(project.instances || []); state.activeProjectId = project.id; state.projectDirty = false; state.checkConfig = { ...state.checkConfig, ...(project.checkConfig || {}) };
  $('projectName').value = project.name; $('checkToolDiameter').value = state.checkConfig.toolDiameter; $('checkToolLength').value = state.checkConfig.toolLength; $('checkClearance').value = state.checkConfig.clearance; $('includeRapids').checked = state.checkConfig.includeRapid;
  state.job = project.job?.text ? { ...analyzeNc(project.job.text), name: project.job.name, rawText: project.job.text } : null; state.selectedId = state.instances.at(-1)?.id ?? null;
  renderLibrary(); renderSceneList(); renderSelection(); renderToolpath(state.job || { points: [] });
  $('jobInfo').hidden = !state.job; $('clearJob').disabled = !state.job; $('alignStock').disabled = !state.job || !state.instances.some((i) => i.kind === 'stock');
  if (state.job) { $('jobInfo').textContent = `${state.job.points.length.toLocaleString()} path points · X ${state.job.bounds.minX.toFixed(2)} to ${state.job.bounds.maxX.toFixed(2)} · Y ${state.job.bounds.minY.toFixed(2)} to ${state.job.bounds.maxY.toFixed(2)} mm`; $('viewerReadout').textContent = `NC file: ${state.job.name} · mm`; setJobStatus(`Loaded ${state.job.name}.`, 'success'); } else { $('viewerReadout').textContent = 'Units: mm'; setJobStatus('No NC file loaded.'); }
  await renderObjects();
  if (project.camera) { state.camera.position.fromArray(project.camera.position); state.camera.up.fromArray(project.camera.up); state.controls.target.fromArray(project.camera.target); state.controls.update(); } else fitView();
  state.clearance = null; clearClearanceMarkers(); renderClearance(); renderProjects(); scheduleSave(); $('projectStatus').textContent = `Opened “${project.name}”.`; $('projectStatus').className = 'status success';
  setWorkspace('setup');
}
async function deleteProject(id) { const p = state.projects.find((x) => x.id === id); if (!p) return; await dbRequest('readwrite', 'delete', id, undefined, 'projects'); state.projects = state.projects.filter((x) => x.id !== id); if (state.activeProjectId === id) { state.activeProjectId = null; $('projectName').value = ''; } if(state.selectedProjectId===id){state.selectedProjectId=null;clearProjectPreview();}state.pendingDeleteProjectId=null;renderProjects();await persistWorkspaceNow();$('savedProjectStatus').textContent=`Deleted “${p.name}”.`; }
async function deleteAsset(id){const asset=state.library.find(a=>a.id===id);if(!asset)return;state.instances=state.instances.filter(i=>i.modelId!==id);state.selectedId=state.instances.at(-1)?.id??null;state.library=state.library.filter(a=>a.id!==id);state.geometryCache.get(id)?.dispose();state.geometryCache.delete(id);await dbRequest('readwrite','delete',id);if(state.selectedAssetId===id){state.selectedAssetId=null;if(state.libraryViewer.object){state.libraryViewer.scene.remove(state.libraryViewer.object);state.libraryViewer.object.geometry.dispose();state.libraryViewer.object.material.dispose();state.libraryViewer.object=null;}$('assetViewerHint').hidden=false;$('assetPreviewTitle').textContent='Model preview';$('assetPreviewMeta').textContent='Select a library item';}state.pendingDeleteAssetId=null;await persistWorkspaceNow();markProjectDirty();renderLibrary();renderSceneList();renderSelection();void renderObjects();setStatus(`Deleted ${asset.name} from the library.`,'success');$('libraryStatus').textContent=`Deleted “${asset.name}” and its setup instances.`;}

function initViewer() {
  const host = $('viewer');
  state.scene = new THREE.Scene();
  state.scene.background = new THREE.Color('#151a21');
  state.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000000);
  state.camera.up.set(0, 0, 1);
  state.camera.position.set(180, -240, 190);
  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.prepend(state.renderer.domElement);
  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.08;
  state.controls.minDistance = 1;
  state.controls.maxDistance = 100000;
  state.controls.minPolarAngle = 0;
  state.controls.maxPolarAngle = Math.PI;
  state.scene.add(new THREE.HemisphereLight(0xeaf2ff, 0x28323d, 2.0));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.6); keyLight.position.set(-1, -2, 4); state.scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8ab7ff, 1.0); fillLight.position.set(2, 3, 2); state.scene.add(fillLight);
  const grid = new THREE.GridHelper(2000, 80, 0x526171, 0x303b47); grid.rotation.x = Math.PI / 2; grid.position.z = -0.05; grid.name = 'work-grid'; state.scene.add(grid);
  const axes = new THREE.AxesHelper(70); axes.name = 'work-axes'; state.scene.add(axes);
  state.pathGroup = new THREE.Group(); state.pathGroup.name = 'NC toolpath'; state.scene.add(state.pathGroup);
  state.objectGroup = new THREE.Group(); state.objectGroup.name = 'Stock and clamps'; state.scene.add(state.objectGroup);
  state.checkGroup = new THREE.Group(); state.checkGroup.name = 'Clearance markers'; state.scene.add(state.checkGroup);
  state.transform = new TransformControls(state.camera, state.renderer.domElement);
  state.transform.setSize(0.44);
  state.transform.setSpace('world');
  softenMoveGizmo(state.transform);
  state.transform.addEventListener('dragging-changed', (event) => { state.controls.enabled = !event.value; if(event.value){state.showTransformInputs=true;syncQuickTransform();}updateQuickTransformVisibility();if (!event.value) commitSelectedTransform(); });
  state.transform.addEventListener('objectChange', () => { readTransformFromMesh(); });
  state.scene.add(state.transform);
  state.rotationGizmo = new THREE.Group(); state.rotationGizmo.name='Combined rotation rings'; state.rotationGizmo.visible=false; state.scene.add(state.rotationGizmo);
  state.renderer.domElement.addEventListener('pointerdown', beginRingRotation, true);
  state.renderer.domElement.addEventListener('pointerdown', selectObjectAtPointer, true);
  state.renderer.domElement.addEventListener('pointermove', updateRingRotation, true);
  state.renderer.domElement.addEventListener('pointerup', endRingRotation, true);
  state.renderer.domElement.addEventListener('pointercancel', endRingRotation, true);
  const resize = () => {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height; state.camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host); resize();
  const tick = () => { requestAnimationFrame(tick); state.controls.update(); updateRotationGizmoScale(); state.renderer.render(state.scene, state.camera); };
  tick();
}

function softenMoveGizmo(transform){
  const gizmo=transform?._gizmo;if(!gizmo?.gizmo?.translate)return;
  const update=gizmo.updateMatrixWorld.bind(gizmo),axisColors={X:0xe88989,Y:0x83c99b,Z:0x83a9df};
  gizmo.updateMatrixWorld=function(force){
    update(force);
    this.gizmo.translate.traverse((handle)=>{const hex=axisColors[handle.name];if(!hex||!handle.material)return;for(const material of Array.isArray(handle.material)?handle.material:[handle.material]){material.color.setHex(hex);material._color?.setHex(hex);material.opacity=this.axis===handle.name?.58:.42;material._opacity=material.opacity;}});
  };
}

function initLibraryViewer() {
  const host = $('assetViewer'); const scene = new THREE.Scene(); scene.background = new THREE.Color('#151a21');
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 1e7); camera.up.set(0,0,1); camera.position.set(180,-240,190);
  const renderer = new THREE.WebGLRenderer({antialias:true,alpha:false}); renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2)); renderer.outputColorSpace=THREE.SRGBColorSpace; host.prepend(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xeaf2ff,0x28323d,2)); const key=new THREE.DirectionalLight(0xffffff,2.6);key.position.set(-1,-2,4);scene.add(key); const fill=new THREE.DirectionalLight(0x8ab7ff,1);fill.position.set(2,3,2);scene.add(fill);
  const grid=new THREE.GridHelper(2000,80,0x526171,0x303b47);grid.rotation.x=Math.PI/2;grid.position.z=-.05;scene.add(grid);
  const controls=new OrbitControls(camera,renderer.domElement); controls.enableDamping=true; controls.dampingFactor=.08; controls.minDistance=1; controls.maxDistance=100000;
  const resize=()=>{const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}; new ResizeObserver(resize).observe(host); resize();
  const tick=()=>{requestAnimationFrame(tick);controls.update();renderer.render(scene,camera);};tick();
  state.libraryViewer={host,scene,camera,renderer,controls,object:null};
}
function initProjectViewer() {
  const host=$('projectViewer'),scene=new THREE.Scene();scene.background=new THREE.Color('#151a21');const camera=new THREE.PerspectiveCamera(45,1,.1,1e7);camera.up.set(0,0,1);camera.position.set(180,-240,190);
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.outputColorSpace=THREE.SRGBColorSpace;host.prepend(renderer.domElement);scene.add(new THREE.HemisphereLight(0xeaf2ff,0x28323d,2));const light=new THREE.DirectionalLight(0xffffff,2.6);light.position.set(-1,-2,4);scene.add(light);const fill=new THREE.DirectionalLight(0x8ab7ff,1);fill.position.set(2,3,2);scene.add(fill);const grid=new THREE.GridHelper(2000,80,0x526171,0x303b47);grid.rotation.x=Math.PI/2;grid.position.z=-.05;scene.add(grid);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.08;controls.minDistance=1;controls.maxDistance=100000;const content=new THREE.Group();scene.add(content);
  const resize=()=>{const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(host);resize();const tick=()=>{requestAnimationFrame(tick);controls.update();renderer.render(scene,camera);};tick();state.projectViewer={host,scene,camera,renderer,controls,content};
}
function clearProjectPreview(){const v=state.projectViewer;if(!v)return;for(const child of [...v.content.children]){v.content.remove(child);child.geometry?.dispose();child.material?.dispose();} $('projectViewerHint').hidden=false;$('projectPreviewTitle').textContent='Project preview';$('projectPreviewMeta').textContent='Select a saved project';}
function fitProjectView(){const v=state.projectViewer;if(!v)return;const box=new THREE.Box3().setFromObject(v.content);if(box.isEmpty())return;const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z,10),distance=radius*.55/Math.tan(THREE.MathUtils.degToRad(v.camera.fov/2));v.controls.target.copy(center);v.camera.position.set(center.x+distance*.72,center.y-distance,center.z+distance*.68);v.camera.near=Math.max(.01,distance/10000);v.camera.far=Math.max(10000,distance*20);v.camera.updateProjectionMatrix();v.controls.update();}
async function showProjectPreview(id){
  const project=await dbRequest('readonly','get',id,undefined,'projects');if(!project)throw new Error('Saved project data was not found.');state.selectedProjectId=id;clearProjectPreview();
  const v=state.projectViewer,assets=new Map((project.assets||[]).map(a=>[a.metadata.id,a]));
  for(const item of project.instances||[]){const saved=assets.get(item.modelId);if(!saved)continue;let geometry;if(saved.metadata.format==='shape')geometry=makeShapeGeometry(saved.metadata);else if(saved.buffer)geometry=(await readGeometry(saved.buffer,saved.metadata.format)).geometry;else continue;
    const mesh=new THREE.Mesh(geometry.clone(),new THREE.MeshStandardMaterial({color:item.color|| (item.kind==='stock'?0x9dbad8:0xff754d),roughness:.62,transparent:item.kind==='stock'||item.opacity<1,opacity:item.opacity??(item.kind==='stock'?.3:1),depthWrite:item.kind!=='stock',side:THREE.DoubleSide}));geometry.dispose();mesh.position.set(item.x,item.y,item.z);mesh.rotation.set(THREE.MathUtils.degToRad(item.rx),THREE.MathUtils.degToRad(item.ry),THREE.MathUtils.degToRad(item.rz));mesh.scale.setScalar(item.scale||1);mesh.visible=item.visible!==false;v.content.add(mesh);
  }
  if(project.job?.text){const job=analyzeNc(project.job.text),cut=[],rapid=[];for(let i=1;i<job.points.length;i++){const a=job.points[i-1],b=job.points[i];(b.draw?cut:rapid).push(a.x,a.y,a.z,b.x,b.y,b.z);}for(const [coords,color,opacity] of [[rapid,0x91a2b5,.45],[cut,0xffad64,1]])if(coords.length){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(coords,3));v.content.add(new THREE.LineSegments(g,new THREE.LineBasicMaterial({color,transparent:opacity<1,opacity})));}}
  $('projectViewerHint').hidden=true;$('projectPreviewTitle').textContent=project.name;$('projectPreviewMeta').textContent=`${(project.instances||[]).length} scene item(s) · ${project.job?.name||'No NC file'}`;fitProjectView();
}
async function showAssetPreview(id) {
  const asset=state.library.find(a=>a.id===id); if(!asset)return; state.selectedAssetId=id;
  $('assetPreviewTitle').textContent=asset.name; $('assetPreviewMeta').textContent=`${asset.kind.toUpperCase()} · ${asset.format.toUpperCase()} · ${asset.size.x.toFixed(1)} × ${asset.size.y.toFixed(1)} × ${asset.size.z.toFixed(1)} mm`; $('assetViewerHint').hidden=true;
  const viewer=state.libraryViewer; if(viewer.object){viewer.scene.remove(viewer.object);viewer.object.geometry.dispose();viewer.object.material.dispose();viewer.object=null;}
  const geometry=(await geometryFor(asset)).clone(); const object=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:asset.kind==='stock'?0x8db3d8:0xff754d,roughness:.58,metalness:.06,transparent:asset.kind==='stock',opacity:asset.kind==='stock'?.48:1,side:THREE.DoubleSide})); viewer.scene.add(object);viewer.object=object;fitAssetView();
}
function fitAssetView(){const v=state.libraryViewer;if(!v?.object)return;const box=new THREE.Box3().setFromObject(v.object),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()),radius=Math.max(size.x,size.y,size.z,10),distance=radius*.55/Math.tan(THREE.MathUtils.degToRad(v.camera.fov/2));v.controls.target.copy(center);v.camera.position.set(center.x+distance*.72,center.y-distance,center.z+distance*.68);v.camera.near=Math.max(.01,distance/10000);v.camera.far=Math.max(10000,distance*20);v.camera.updateProjectionMatrix();v.controls.update();}

async function getOcct() {
  if (state.occt) return state.occt;
  if (typeof window.occtimportjs !== 'function') {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(/* @vite-ignore */ '../occt/occt-import-js.js', import.meta.url).href;
      script.onload = resolve; script.onerror = () => reject(new Error('Could not load the STEP model importer.'));
      document.head.append(script);
    });
  }
  state.occt = await window.occtimportjs();
  return state.occt;
}

function geometryFromStep(result) {
  if (!result?.success || !Array.isArray(result.meshes) || !result.meshes.length) throw new Error('STEP import did not contain a usable mesh.');
  const positions = [], indices = [];
  for (const mesh of result.meshes) {
    const p = mesh.attributes?.position?.array;
    if (!p?.length) continue;
    const base = positions.length / 3;
    for (let i = 0; i < p.length; i += 1) positions.push(Number(p[i]));
    const ix = mesh.index?.array;
    if (ix?.length) {
      const flat = Array.isArray(ix[0]) ? ix.flat() : ix;
      for (const n of flat) indices.push(base + Number(n));
    }
    else for (let n = 0; n < p.length / 3; n += 1) indices.push(base + n);
  }
  if (!positions.length || !indices.length) throw new Error('STEP import returned no triangles.');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingBox();
  return geometry;
}

async function readGeometry(buffer, format) {
  let geometry;
  if (format === 'stl') geometry = new STLLoader().parse(buffer);
  else {
    const occt = await getOcct();
    const imported = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.15, angularDeflection: 0.5 });
    geometry = geometryFromStep(imported);
  }
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds || !Number.isFinite(bounds.min.x) || bounds.isEmpty()) throw new Error('The model has no measurable geometry.');
  // Adopt a predictable datum: lower-left-bottom of the imported bounds.
  geometry.translate(-bounds.min.x, -bounds.min.y, -bounds.min.z);
  geometry.computeBoundingBox(); geometry.computeVertexNormals();
  return { geometry, size: geometry.boundingBox.getSize(new THREE.Vector3()) };
}

function normalizeForStorage(asset) {
  return { id: asset.id, name: asset.name, kind: asset.kind, format: asset.format, size: asset.size, shape: asset.shape, createdAt: asset.createdAt };
}

function makeShapeGeometry(asset) {
  const { x, y, z } = asset.size;
  let geometry;
  if (asset.shape.type === 'cylinder') { geometry = new THREE.CylinderGeometry(x / 2, x / 2, z, 48); geometry.rotateX(Math.PI / 2); }
  else geometry = new THREE.BoxGeometry(x, y, z);
  geometry.translate(x / 2, y / 2, z / 2); geometry.computeVertexNormals(); geometry.computeBoundingBox(); return geometry;
}
function createBasicShape() {
  const type=$('shapeKind').value, name=$('shapeName').value.trim() || `${type==='box'?'Box':'Cylinder'} ${state.library.filter(a=>a.format==='shape').length+1}`;
  const width=Number($('shapeWidth').value), depth=type==='cylinder'?width:Number($('shapeDepth').value), height=Number($('shapeHeight').value);
  if (![width,depth,height].every(v=>Number.isFinite(v)&&v>0)) { $('libraryStatus').textContent='Enter positive dimensions in millimeters.'; return; }
  const asset={id:uid(),name,kind:$('modelKind').value,format:'shape',shape:{type},size:{x:width,y:depth,z:height},createdAt:new Date().toISOString()};
  state.library.push(asset);state.libraryCategory=asset.kind;state.geometryCache.set(asset.id,makeShapeGeometry(asset));scheduleSave();renderLibrary();$('shapeForm').hidden=true;$('shapeName').value='';$('libraryStatus').textContent=`Created ${type} “${name}” (${width} × ${depth} × ${height} mm).`;void showAssetPreview(asset.id);
}

async function importModel(file) {
  if (!file) return;
  if (file.size > MAX_MODEL_BYTES) throw new Error(`This model is ${(file.size / 1024 / 1024).toFixed(1)} MiB. The current import limit is 100 MiB.`);
  const format = file.name.split('.').pop().toLowerCase();
  if (!['stl', 'step', 'stp'].includes(format)) throw new Error('Choose an STL, STP, or STEP model.');
  const resolvedFormat = format === 'stp' ? 'step' : format;
  setStatus(`Importing ${file.name}…`);
  const buffer = await file.arrayBuffer();
  const { geometry, size } = await readGeometry(buffer, resolvedFormat);
  const id = uid();
  const asset = { id, name: file.name.replace(/\.(stl|step|stp)$/i, ''), kind: $('modelKind').value, format: resolvedFormat, size: { x: size.x, y: size.y, z: size.z }, createdAt: new Date().toISOString() };
  await dbRequest('readwrite', 'put', id, buffer);
  state.library.push(asset); state.libraryCategory=asset.kind;
  state.geometryCache.set(id, geometry);
  await persistWorkspaceNow();
  renderLibrary();
  setStatus(`${asset.kind === 'stock' ? 'Stock' : 'Clamp'} model “${asset.name}” added to the library (${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm).`, 'success');
}

async function geometryFor(asset) {
  if (state.geometryCache.has(asset.id)) return state.geometryCache.get(asset.id);
  if (asset.format === 'shape') { const geometry=makeShapeGeometry(asset);state.geometryCache.set(asset.id,geometry);return geometry; }
  const buffer = await dbRequest('readonly', 'get', asset.id);
  if (!buffer) throw new Error(`The model file for “${asset.name}” is missing from this browser’s local storage. Reimport the model.`);
  const { geometry } = await readGeometry(buffer, asset.format);
  state.geometryCache.set(asset.id, geometry);
  return geometry;
}

function addInstance(asset) {
  if (asset.kind === 'stock' && state.instances.some((item) => item.kind === 'stock')) {
    setStatus('There is already a stock model in the scene. Remove it before adding another stock model.'); return;
  }
  const bounds = state.job?.bounds;
  const stock = state.instances.find((item) => item.kind === 'stock');
  const stockAsset = stock && state.library.find((model) => model.id === stock.modelId);
  const shouldFit = !state.job && state.instances.length === 0;
  const instance = {
    id: uid(), modelId: asset.id, name: asset.name, kind: asset.kind,
    x: asset.kind === 'stock' && bounds ? bounds.minX : asset.kind === 'clamp' && stock && stockAsset ? stock.x + stockAsset.size.x * stock.scale + 20 : 0,
    y: asset.kind === 'stock' && bounds ? bounds.minY : stock?.y ?? 0,
    z: asset.kind === 'stock' && bounds ? -asset.size.z : 0, rx: 0, ry: 0, rz: 0, scale: 1,
    color: asset.kind === 'stock' ? '#9dbad8' : '#ff754d',
    opacity: asset.kind === 'stock' ? 0.28 : 1, visible: true,
  };
  state.instances.push(instance); state.selectedId = instance.id;
  markProjectDirty(); renderClearance();
  $('alignStock').disabled = !state.job || !state.instances.some((item) => item.kind === 'stock');
  scheduleSave(); renderSceneList(); renderSelection();
  void renderObjects().then(() => { if (shouldFit) fitView(); });
  setStatus(`${asset.kind === 'stock' ? 'Stock' : 'Clamp'} added to the scene.`,'success');
}

function disposeObject(object) {
  object.traverse((child) => { if (child.geometry && child.geometry !== state.geometryCache.get(child.userData.modelId)) child.geometry.dispose(); if (child.material) { for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose(); } });
}
async function renderObjects() {
  if (!state.objectGroup) return;
  state.transform.detach(); state.meshById.clear();
  for (const child of [...state.objectGroup.children]) { state.objectGroup.remove(child); disposeObject(child); }
  for (const item of state.instances) {
    try {
      const asset = state.library.find((model) => model.id === item.modelId);
      if (!asset) continue;
      const source = await geometryFor(asset);
      const mesh = new THREE.Mesh(source, new THREE.MeshStandardMaterial({ color: item.color, roughness: 0.62, metalness: 0.04, transparent: item.opacity < 1, opacity: item.opacity, depthWrite: item.opacity >= 0.98, side: THREE.DoubleSide }));
      mesh.name = item.name; mesh.userData.modelId = item.modelId; mesh.userData.instanceId = item.id;
      mesh.position.set(item.x, item.y, item.z); mesh.rotation.set(THREE.MathUtils.degToRad(item.rx), THREE.MathUtils.degToRad(item.ry), THREE.MathUtils.degToRad(item.rz)); mesh.scale.setScalar(item.scale); mesh.visible = item.visible;
      mesh.renderOrder = item.kind === 'stock' ? 1 : 3;
      state.objectGroup.add(mesh); state.meshById.set(item.id, mesh);
    } catch (error) { setStatus(error.message || String(error), 'error'); }
  }
  const selected = state.meshById.get(state.selectedId);
  if (selected) state.transform.attach(selected);
  rebuildRotationGizmo();
  $('viewerHint').hidden = Boolean(state.job || state.instances.length);
  fitIfEmpty();
}

function renderLibrary() {
  const list = $('libraryList');
  if (!state.library.length) { list.innerHTML = '<div class="empty-state">No saved models yet.</div>'; return; }
  $('stockCount').textContent=state.library.filter(a=>a.kind==='stock').length; $('clampCount').textContent=state.library.filter(a=>a.kind==='clamp').length;
  document.querySelectorAll('[data-library-category]').forEach(tab=>{const active=tab.dataset.libraryCategory===state.libraryCategory;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));});
  const visibleAssets=state.library.filter(asset=>asset.kind===state.libraryCategory);
  if (!visibleAssets.length) { list.innerHTML=`<div class="empty-state">No ${state.libraryCategory==='stock'?'stock':'clamp'} models yet. Import or create one to add it here.</div>`; return; }
  list.innerHTML = visibleAssets.map((asset) => `<article class="library-item ${asset.id===state.selectedAssetId?'active':''}" data-preview-model="${asset.id}" tabindex="0" role="button" aria-label="Preview ${escapeHtml(asset.name)}"><div class="item-meta">${state.renamingAssetId===asset.id?`<input class="inline-rename-input" data-asset-name-input="${asset.id}" value="${escapeHtml(asset.name)}" maxlength="100" aria-label="New part name">`:`<strong>${escapeHtml(asset.name)}</strong>`}<span class="tag ${asset.kind}">${asset.kind}</span><small>${asset.format.toUpperCase()} · ${asset.size.x.toFixed(1)} × ${asset.size.y.toFixed(1)} × ${asset.size.z.toFixed(1)} mm</small></div><div class="item-actions">${state.renamingAssetId===asset.id?`<button class="action-button action-primary" type="button" data-save-asset-name="${asset.id}">Save name</button><button class="action-button action-secondary" type="button" data-cancel-asset-rename>Cancel</button>`:state.pendingDeleteAssetId===asset.id?`<span class="delete-confirm-label">Delete this part and scene instances?</span><button class="action-button action-danger" type="button" data-confirm-model-delete="${asset.id}">Confirm delete</button><button class="action-button action-secondary" type="button" data-cancel-model-delete>Cancel</button>`:`<button class="action-button action-secondary" type="button" data-rename-asset="${asset.id}">Rename</button><button class="action-button action-secondary" type="button" data-toggle-kind="${asset.id}">Change to ${asset.kind==='stock'?'Clamp':'Stock'}</button><button class="action-button action-primary" type="button" data-add-model="${asset.id}">Load to Setup</button><button class="icon-button delete-icon-button action-danger" type="button" data-delete-model="${asset.id}" aria-label="Delete ${escapeHtml(asset.name)} from library" title="Delete from library">×</button>`}</div></article>`).join('');
}

function renderSceneList() {
  const list = $('sceneList');
  if (!state.instances.length) { list.innerHTML = '<div class="empty-state">Add stock or clamps from the library.</div>'; return; }
  list.innerHTML = state.instances.map((item) => `<article class="scene-item ${item.id === state.selectedId ? 'selected' : ''}" data-select-instance="${item.id}"><span class="scene-color" style="background:${item.color}"></span><button class="scene-select" type="button" data-select-instance="${item.id}">${escapeHtml(item.name)}</button><span class="tag ${item.kind}">${item.kind}</span><button class="icon-button" type="button" data-toggle-visible="${item.id}" aria-label="Toggle visibility" title="Toggle visibility">${item.visible ? '◉' : '○'}</button></article>`).join('');
}

function selectedInstance() { return state.instances.find((item) => item.id === state.selectedId); }
async function removeSceneInstance(id){const item=state.instances.find(i=>i.id===id);if(!item)return;state.transform.detach();state.instances=state.instances.filter(i=>i.id!==id);state.selectedId=state.instances.at(-1)?.id??null;state.clearance=null;clearClearanceMarkers();renderClearance();renderSceneList();renderSelection();void renderObjects();markProjectDirty();try{await persistWorkspaceNow();setStatus(`Removed ${item.name} from the setup.`, 'success');}catch(error){setStatus(`Removed from the current view, but could not save the setup: ${error.message||error}`,'error');}}
function renderSelection() {
  const item = selectedInstance(); const panel = $('transformPanel'); panel.hidden = !item;
  updateQuickTransformVisibility();
  if (!item) { if(state.rotationGizmo)state.rotationGizmo.visible=false; return; }
  $('selectedName').textContent = item.name;
  $('posX').value = item.x.toFixed(2); $('posY').value = item.y.toFixed(2); $('posZ').value = item.z.toFixed(2);
  $('rotX').value = item.rx.toFixed(1); $('rotY').value = item.ry.toFixed(1); $('rotZ').value = item.rz.toFixed(1);
  $('scale').value = item.scale; $('color').value = item.color; $('opacity').value = item.opacity;
  $('opacityValue').textContent = `${Math.round(item.opacity * 100)}%`; $('visible').checked = item.visible;
  syncQuickTransform();
  rebuildRotationGizmo();
}
function updateQuickTransformVisibility(){const panel=$('quickTransform');if(panel)panel.hidden=!selectedInstance()||!state.showTransformInputs;}
function syncQuickTransform(){const item=selectedInstance();if(!item)return;$('quickTransformTitle').textContent=item.name;for(const [id,value] of [['quickX',item.x],['quickY',item.y],['quickZ',item.z],['quickRX',item.rx],['quickRY',item.ry],['quickRZ',item.rz]])$(id).value=Number(value).toFixed(2);updateQuickTransformVisibility();}
function applyQuickTransform(){const item=selectedInstance();if(!item)return;for(const [quick,normal] of [['quickX','posX'],['quickY','posY'],['quickZ','posZ'],['quickRX','rotX'],['quickRY','rotY'],['quickRZ','rotZ']])$(normal).value=$(quick).value;updateSelectedFromInputs();}

function rebuildRotationGizmo(){
  const group=state.rotationGizmo;if(!group)return;
  for(const child of [...group.children]){group.remove(child);child.geometry?.dispose();child.material?.dispose();}
  const item=selectedInstance(),mesh=item&&state.meshById.get(item.id);if(!item||!mesh){group.visible=false;return;}
  const radius=1;
  const axes=[['x',0xe88989,new THREE.Euler(0,Math.PI/2,0)],['y',0x83c99b,new THREE.Euler(Math.PI/2,0,0)],['z',0x83a9df,new THREE.Euler(0,0,0)]];
  for(const [axis,color,rotation] of axes){const ring=new THREE.Mesh(new THREE.TorusGeometry(radius,.012,8,96),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.42,depthTest:false,depthWrite:false}));ring.rotation.copy(rotation);ring.renderOrder=15;ring.userData.rotationAxis=axis;group.add(ring);}
  group.position.copy(mesh.position);group.visible=state.transformMode==='translate';
  updateRotationGizmoScale();
}
function updateRotationGizmoTransform(){const mesh=state.meshById.get(state.selectedId);if(mesh&&state.rotationGizmo)state.rotationGizmo.position.copy(mesh.position);}
function updateRotationGizmoScale(){const group=state.rotationGizmo;if(!group?.visible||!state.camera||!state.renderer)return;const distance=state.camera.position.distanceTo(group.position),worldRadius=distance*Math.tan(THREE.MathUtils.degToRad(state.camera.fov/2))*.26;group.scale.setScalar(Math.max(.01,worldRadius));}
function angleOnAxis(point,origin,axis){const p=point.clone().sub(origin);if(axis==='x')return Math.atan2(p.z,p.y);if(axis==='y')return Math.atan2(p.z,p.x);return Math.atan2(p.y,p.x);}
function pointerRay(event){const canvas=state.renderer.domElement,rect=canvas.getBoundingClientRect();state.raycaster ||= new THREE.Raycaster();state.pointer ||= new THREE.Vector2();state.pointer.set(((event.clientX-rect.left)/rect.width)*2-1,-((event.clientY-rect.top)/rect.height)*2+1);state.raycaster.setFromCamera(state.pointer,state.camera);return state.raycaster;}
function selectObjectAtPointer(event){if(event.button!==0||state.rotationDrag||!state.objectGroup)return;const ray=pointerRay(event),gizmo=state.transform?._gizmo,handles=gizmo?[...(gizmo.picker?.[state.transformMode]?.children||[]),...(gizmo.gizmo?.[state.transformMode]?.children||[])]:[];gizmo?.updateMatrixWorld(true);if(handles.length&&ray.intersectObjects(handles,false).length)return;const controlHits=state.rotationGizmo?.visible?ray.intersectObjects(state.rotationGizmo.children,false):[];if(controlHits.length)return;const hits=ray.intersectObjects(state.objectGroup.children,true),hit=hits.find((entry)=>entry.object.visible&&entry.object.userData.instanceId&&state.meshById.get(entry.object.userData.instanceId)?.visible);if(hit){const id=hit.object.userData.instanceId;if(id===state.selectedId)return;state.selectedId=id;renderSceneList();renderSelection();const mesh=state.meshById.get(id);if(mesh)state.transform.attach(mesh);else state.transform.detach();return;}if(!state.selectedId)return;state.selectedId=null;state.showTransformInputs=false;state.transform.detach();renderSceneList();renderSelection();}
function beginRingRotation(event){if(event.button!==0||!state.rotationGizmo?.visible||state.transformMode!=='translate')return;const ray=pointerRay(event),hits=ray.intersectObjects(state.rotationGizmo.children,false);if(!hits.length)return;const axisName=hits[0].object.userData.rotationAxis,item=selectedInstance(),mesh=item&&state.meshById.get(item.id);if(!mesh)return;const axis=new THREE.Vector3(axisName==='x'?1:0,axisName==='y'?1:0,axisName==='z'?1:0),origin=mesh.position.clone(),plane=new THREE.Plane().setFromNormalAndCoplanarPoint(axis,origin),point=ray.ray.intersectPlane(plane,new THREE.Vector3());if(!point)return;state.rotationDrag={pointerId:event.pointerId,axisName,axis,origin,plane,lastAngle:angleOnAxis(point,origin,axisName),mesh,item};state.showTransformInputs=true;syncQuickTransform();state.controls.enabled=false;state.transform.enabled=false;event.preventDefault();event.stopImmediatePropagation();state.renderer.domElement.setPointerCapture(event.pointerId);}
function updateRingRotation(event){const drag=state.rotationDrag;if(!drag||event.pointerId!==drag.pointerId)return;const ray=pointerRay(event),point=ray.ray.intersectPlane(drag.plane,new THREE.Vector3());if(!point)return;const angle=angleOnAxis(point,drag.origin,drag.axisName),delta=Math.atan2(Math.sin(angle-drag.lastAngle),Math.cos(angle-drag.lastAngle));if(Math.abs(delta)<1e-5)return;drag.mesh.rotateOnWorldAxis(drag.axis,delta);drag.lastAngle=angle;drag.item.rx=THREE.MathUtils.radToDeg(drag.mesh.rotation.x);drag.item.ry=THREE.MathUtils.radToDeg(drag.mesh.rotation.y);drag.item.rz=THREE.MathUtils.radToDeg(drag.mesh.rotation.z);$('rotX').value=drag.item.rx.toFixed(1);$('rotY').value=drag.item.ry.toFixed(1);$('rotZ').value=drag.item.rz.toFixed(1);syncQuickTransform();updateRotationGizmoTransform();}
function endRingRotation(event){const drag=state.rotationDrag;if(!drag||event.pointerId!==drag.pointerId)return;state.rotationDrag=null;state.controls.enabled=true;state.transform.enabled=true;commitSelectedTransform();}

function updateSelectedFromInputs() {
  const item = selectedInstance(); if (!item) return;
  item.x = Number($('posX').value) || 0; item.y = Number($('posY').value) || 0; item.z = Number($('posZ').value) || 0;
  item.rx = Number($('rotX').value) || 0; item.ry = Number($('rotY').value) || 0; item.rz = Number($('rotZ').value) || 0;
  item.scale = Math.max(0.01, Number($('scale').value) || 1); item.color = $('color').value;
  item.opacity = Number($('opacity').value); item.visible = $('visible').checked;
  const mesh = state.meshById.get(item.id);
  if (mesh) {
    mesh.position.set(item.x, item.y, item.z);
    mesh.rotation.set(THREE.MathUtils.degToRad(item.rx), THREE.MathUtils.degToRad(item.ry), THREE.MathUtils.degToRad(item.rz));
    mesh.scale.setScalar(item.scale); mesh.visible = item.visible;
    mesh.material.color.set(item.color); mesh.material.opacity = item.opacity; mesh.material.transparent = item.opacity < 1; mesh.material.depthWrite = item.opacity >= 0.98; mesh.material.needsUpdate = true;
  }
  $('opacityValue').textContent = `${Math.round(item.opacity * 100)}%`;
  updateRotationGizmoTransform(); renderSceneList(); scheduleSave(); markProjectDirty(); state.clearance = null; clearClearanceMarkers(); renderClearance();
}
function readTransformFromMesh() {
  const item = selectedInstance(), mesh = item && state.meshById.get(item.id); if (!item || !mesh) return;
  item.x = mesh.position.x; item.y = mesh.position.y; item.z = mesh.position.z;
  item.rx = THREE.MathUtils.radToDeg(mesh.rotation.x); item.ry = THREE.MathUtils.radToDeg(mesh.rotation.y); item.rz = THREE.MathUtils.radToDeg(mesh.rotation.z);
  $('posX').value = item.x.toFixed(2); $('posY').value = item.y.toFixed(2); $('posZ').value = item.z.toFixed(2);
  $('rotX').value = item.rx.toFixed(1); $('rotY').value = item.ry.toFixed(1); $('rotZ').value = item.rz.toFixed(1);
  syncQuickTransform(); updateRotationGizmoTransform();
}
function commitSelectedTransform() { renderSceneList(); scheduleSave(); markProjectDirty(); state.clearance = null; clearClearanceMarkers(); renderClearance(); }

function clearClearanceMarkers() { if (!state.checkGroup) return; for (const child of [...state.checkGroup.children]) { state.checkGroup.remove(child); child.geometry?.dispose(); child.material?.dispose(); } }
function renderClearance() {
  const button = $('checkClearanceButton'); if (button) button.disabled = state.isChecking || !state.job || !state.instances.some((i) => i.kind === 'clamp' && i.visible);
  const box = $('clearanceResults'); if (!box) return;
  if (!state.clearance) { box.textContent = 'Load an NC file and add at least one visible clamp to check clearance.'; return; }
  const r = state.clearance;
  box.innerHTML = `<strong class="clearance-${r.hazards.length ? 'bad' : 'good'}">${r.hazards.length ? `${r.hazards.length} potential clearance issue(s)` : 'No potential clamp interference found'}</strong><div>${escapeHtml(r.summary)}</div>${r.hazards.slice(0, 8).map((h) => `<div class="clearance-row clearance-bad">${escapeHtml(h.name)} · ${h.kind} move · X${h.point.x.toFixed(1)} Y${h.point.y.toFixed(1)} Z${h.point.z.toFixed(1)} · gap ${h.gap.toFixed(1)} mm</div>`).join('')}`;
}
async function runClearanceCheck() {
  if (!state.job) return;
  state.checkConfig = { toolDiameter: Math.max(.1, Number($('checkToolDiameter').value) || 6.35), toolLength: Math.max(0, Number($('checkToolLength').value) || 0), clearance: Math.max(0, Number($('checkClearance').value) || 0), includeRapid: $('includeRapids').checked };
  const clamps = state.instances.filter((i) => i.kind === 'clamp' && i.visible);
  const meshes = clamps.map((i) => ({ item: i, mesh: state.meshById.get(i.id) })).filter((x) => x.mesh);
  if (!meshes.length) return;
  state.isChecking = true; state.clearance = null; renderClearance(); $('clearanceResults').textContent = 'Checking NC segments against clamp geometry…';
  await new Promise(requestAnimationFrame);
  const radius = state.checkConfig.toolDiameter / 2, threshold = radius + state.checkConfig.clearance;
  const hazards = []; let checked = 0;
  const samples = state.job.points;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]; if (!b.draw && !state.checkConfig.includeRapid) continue;
    const length = Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z), count = Math.max(1, Math.ceil(length / Math.max(1, Math.min(3, threshold / 2 || 1))));
    for (let n=0;n<=count;n++) {
      const t=n/count, tip=new THREE.Vector3(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t), top=tip.clone().add(new THREE.Vector3(0,0,state.checkConfig.toolLength)); checked++;
      for (const {item,mesh} of meshes) {
        mesh.updateMatrixWorld(true);
        // Conservative broad-phase distance to the transformed clamp bounds. This intentionally flags near-boundary candidates for visual review.
        const clampBounds = new THREE.Box3().setFromObject(mesh);
        const bounds = clampBounds.clone().expandByScalar(threshold);
        const axisBox = new THREE.Box3().setFromPoints([tip,top]);
        if (!bounds.intersectsBox(axisBox)) continue;
        let gap = Infinity, marker = tip.clone();
        const axisSteps = Math.max(1, Math.ceil(state.checkConfig.toolLength / 2));
        for (let step=0;step<=axisSteps;step++) { const axisPoint=tip.clone().lerp(top,step/axisSteps); const surfacePoint=clampBounds.clampPoint(axisPoint,new THREE.Vector3()); const candidateGap=surfacePoint.distanceTo(axisPoint)-radius; if(candidateGap<gap){gap=candidateGap;marker=surfacePoint;} }
        hazards.push({ name:item.name, kind:b.draw?'feed':'rapid', point:tip.clone(), marker, gap });
        if (hazards.length > 2000) break;
      }
    }
    if (i % 120 === 0) await new Promise(requestAnimationFrame);
  }
  hazards.sort((a,b)=>a.gap-b.gap); state.clearance={hazards,summary:`${checked.toLocaleString()} tool positions sampled; tool envelope uses diameter ${state.checkConfig.toolDiameter} mm and ${state.checkConfig.toolLength} mm above the tip. Clamp bounds are used as a conservative screening check.`};
  clearClearanceMarkers();
  if (hazards.length) {
    const geo=new THREE.BufferGeometry().setFromPoints(hazards.slice(0,600).map(h=>h.marker));
    const hit=hazards.some(h=>h.gap<0);
    const marks=new THREE.Points(geo,new THREE.PointsMaterial({color:hit?0xff3028:0xffc247,size:12,sizeAttenuation:false,depthTest:false,transparent:true,opacity:.98}));
    marks.renderOrder=20; state.checkGroup.add(marks);
  }
  state.isChecking=false; renderClearance(); scheduleSave(); markProjectDirty('Clearance settings or results changed.');
}

function renderToolpath(job) {
  for (const child of [...state.pathGroup.children]) { state.pathGroup.remove(child); child.geometry.dispose(); child.material.dispose(); }
  const cut = [], rapid = [];
  for (let i = 1; i < job.points.length; i += 1) {
    const a = job.points[i - 1], b = job.points[i];
    (b.draw ? cut : rapid).push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  if (rapid.length) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(rapid, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x91a2b5, transparent: true, opacity: 0.48 });
    const lines = new THREE.LineSegments(geometry, material); lines.name = 'Rapid moves'; lines.renderOrder = 2; state.pathGroup.add(lines);
  }
  if (cut.length) {
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(cut, 3));
    const material = new THREE.LineBasicMaterial({ color: 0xffad64 });
    const lines = new THREE.LineSegments(geometry, material); lines.name = 'Cutting moves'; lines.renderOrder = 4; state.pathGroup.add(lines);
  }
  $('viewerHint').hidden = Boolean(state.job || state.instances.length);
}

function fitView() {
  const box = new THREE.Box3();
  const pathBox = new THREE.Box3().setFromObject(state.pathGroup); if (!pathBox.isEmpty()) box.union(pathBox);
  const objectBox = new THREE.Box3().setFromObject(state.objectGroup); if (!objectBox.isEmpty()) box.union(objectBox);
  if (box.isEmpty()) { state.controls.target.set(0, 0, 0); state.camera.position.set(180, -240, 190); state.camera.lookAt(0, 0, 0); state.controls.update(); return; }
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 20); const distance = radius * 0.55 / Math.tan(THREE.MathUtils.degToRad(state.camera.fov / 2));
  state.controls.target.copy(center); state.camera.position.set(center.x + distance * 0.72, center.y - distance, center.z + distance * 0.68);
  state.camera.near = Math.max(0.01, distance / 10000); state.camera.far = Math.max(10000, distance * 20); state.camera.updateProjectionMatrix(); state.controls.update();
}
function fitIfEmpty() { if (!state.job && !state.instances.length) fitView(); }

async function loadJob(file) {
  if (!file) return;
  setJobStatus(`Reading ${file.name}…`);
  try {
    const rawText = await file.text(); const result = analyzeNc(rawText);
    state.job = { ...result, name: file.name, rawText };
    const guessed = [...rawText.matchAll(/\(\s*T\d+\s*:\s*(\d+(?:\.\d+)?)\s*\)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
    if (guessed.length) { state.checkConfig.toolDiameter = Math.max(...guessed); $('checkToolDiameter').value = state.checkConfig.toolDiameter; }
    renderToolpath(state.job); $('clearJob').disabled = false; $('alignStock').disabled = !state.instances.some((item) => item.kind === 'stock');
    $('jobInfo').hidden = false;
    $('jobInfo').textContent = `${result.points.length.toLocaleString()} path points · X ${result.bounds.minX.toFixed(2)} to ${result.bounds.maxX.toFixed(2)} · Y ${result.bounds.minY.toFixed(2)} to ${result.bounds.maxY.toFixed(2)} mm`;
    $('viewerReadout').textContent = `NC file: ${file.name} · mm`;
    setJobStatus(`Loaded ${file.name}.`, 'success'); state.clearance = null; renderClearance(); markProjectDirty(); scheduleSave(); void dbRequest('readwrite','put','__current_job__',{name:file.name,text:rawText},'projects'); fitView();
  } catch (error) { setJobStatus(error.message || String(error), 'error'); }
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>setWorkspace(button.dataset.tab)));
  $('modelFile').addEventListener('change', async (event) => { const [file] = event.target.files || []; try { await importModel(file); } catch (error) { setStatus(error.message || String(error), 'error'); } finally { event.target.value = ''; } });
  $('jobFile').addEventListener('change', async (event) => { const [file] = event.target.files || []; await loadJob(file); event.target.value = ''; });
  $('fitAssetView').addEventListener('click',fitAssetView);
  document.querySelectorAll('[data-library-category]').forEach(tab=>tab.addEventListener('click',()=>{state.libraryCategory=tab.dataset.libraryCategory;state.renamingAssetId=null;state.pendingDeleteAssetId=null;renderLibrary();}));
  $('showShapeForm').addEventListener('click',()=>{$('shapeForm').hidden=!$('shapeForm').hidden;});$('cancelShape').addEventListener('click',()=>$('shapeForm').hidden=true);$('createShape').addEventListener('click',createBasicShape);
  $('shapeKind').addEventListener('change',()=>{const cylinder=$('shapeKind').value==='cylinder';$('shapeDepth').disabled=cylinder;$('shapeDepthLabel').classList.toggle('disabled-field',cylinder);$('shapeWidthLabel').querySelector('span').textContent=cylinder?'Diameter (mm)':'Width (mm)';});
  $('saveProject').addEventListener('click', () => saveProject(false).catch((e) => { $('projectStatus').textContent = e.message || String(e); }));
  $('saveProjectAs').addEventListener('click', () => saveProject(true).catch((e) => { $('projectStatus').textContent = e.message || String(e); }));
  $('fitProjectView').addEventListener('click',fitProjectView);
  $('projectList').addEventListener('click',async(event)=>{const saveName=event.target.closest('[data-save-project-name]');if(saveName){await saveProjectName(saveName.dataset.saveProjectName);return;}if(event.target.closest('[data-cancel-project-rename]')){state.renamingProjectId=null;renderProjects();return;}const rename=event.target.closest('[data-rename-project]');if(rename){state.renamingProjectId=rename.dataset.renameProject;state.pendingDeleteProjectId=null;renderProjects();document.querySelector(`[data-project-name-input="${CSS.escape(state.renamingProjectId)}"]`)?.focus();return;}const confirm=event.target.closest('[data-project-confirm-delete]');if(confirm){try{await deleteProject(confirm.dataset.projectConfirmDelete);}catch(e){$('savedProjectStatus').textContent=`Project delete failed: ${e.message||e}`;}return;}if(event.target.closest('[data-project-cancel-delete]')){state.pendingDeleteProjectId=null;renderProjects();return;}const load=event.target.closest('[data-project-load]');if(load){try{await openProject(load.dataset.projectLoad);}catch(e){$('savedProjectStatus').textContent=e.message||String(e);}return;}const del=event.target.closest('[data-project-delete]');if(del){state.pendingDeleteProjectId=del.dataset.projectDelete;renderProjects();$('savedProjectStatus').textContent='Confirm deletion or cancel. This removes the saved project from this browser profile.';return;}const row=event.target.closest('[data-preview-project]');if(row&&!event.target.closest('button,input')){try{await showProjectPreview(row.dataset.previewProject);renderProjects();$('savedProjectStatus').textContent=`Previewing “${state.projects.find(p=>p.id===row.dataset.previewProject)?.name||'project'}”.`;}catch(e){$('savedProjectStatus').textContent=e.message||String(e);}}});
  $('projectList').addEventListener('keydown',async(event)=>{const input=event.target.closest('[data-project-name-input]');if(input&&event.key==='Enter'){event.preventDefault();await saveProjectName(input.dataset.projectNameInput);return;}if(input&&event.key==='Escape'){state.renamingProjectId=null;renderProjects();return;}if((event.key==='Enter'||event.key===' ')&&!event.target.closest('button,input')){const row=event.target.closest('[data-preview-project]');if(row){event.preventDefault();try{await showProjectPreview(row.dataset.previewProject);renderProjects();}catch(e){$('savedProjectStatus').textContent=e.message||String(e);}}}});
  $('checkClearanceButton').addEventListener('click', () => runClearanceCheck().catch((e) => { state.isChecking=false; $('clearanceResults').textContent=`Clearance check failed: ${e.message || e}`; renderClearance(); }));
  for (const id of ['checkToolDiameter','checkToolLength','checkClearance','includeRapids']) $(id).addEventListener('input', () => { state.clearance=null; clearClearanceMarkers(); renderClearance(); markProjectDirty(); });
  $('libraryList').addEventListener('click', async (event) => {
    const confirmDelete=event.target.closest('[data-confirm-model-delete]');if(confirmDelete){try{await deleteAsset(confirmDelete.dataset.confirmModelDelete);}catch(error){$('libraryStatus').textContent=`Delete failed: ${error.message||error}`;}return;}if(event.target.closest('[data-cancel-model-delete]')){state.pendingDeleteAssetId=null;renderLibrary();return;}
    const saveName=event.target.closest('[data-save-asset-name]');if(saveName){saveAssetName(saveName.dataset.saveAssetName);return;}if(event.target.closest('[data-cancel-asset-rename]')){state.renamingAssetId=null;renderLibrary();return;}const rename=event.target.closest('[data-rename-asset]');if(rename){state.renamingAssetId=rename.dataset.renameAsset;renderLibrary();document.querySelector(`[data-asset-name-input="${CSS.escape(state.renamingAssetId)}"]`)?.focus();return;}
    const toggleKind=event.target.closest('[data-toggle-kind]');
    if(toggleKind){const asset=state.library.find(a=>a.id===toggleKind.dataset.toggleKind);if(!asset)return;asset.kind=asset.kind==='stock'?'clamp':'stock';state.libraryCategory=asset.kind;for(const item of state.instances.filter(i=>i.modelId===asset.id)){item.kind=asset.kind;item.color=asset.kind==='stock'?'#9dbad8':'#ff754d';item.opacity=asset.kind==='stock'?.28:1;}scheduleSave();markProjectDirty();renderLibrary();renderSceneList();void renderObjects();if(state.selectedAssetId===asset.id)void showAssetPreview(asset.id);$('libraryStatus').textContent=`Changed “${asset.name}” to ${asset.kind}.`;return;}
    const preview = event.target.closest('[data-preview-model]');
    if (preview && !event.target.closest('button,input')) { try { await showAssetPreview(preview.dataset.previewModel); renderLibrary(); } catch (error) { $('libraryStatus').textContent = error.message || String(error); } return; }
    const add = event.target.closest('[data-add-model]');
    if (add) { const asset = state.library.find((item) => item.id === add.dataset.addModel); if (asset) addInstance(asset); return; }
    const remove = event.target.closest('[data-delete-model]');
    if (remove) {
      const id = remove.dataset.deleteModel;
      const asset = state.library.find((item) => item.id === id);
      if (!asset) return;state.pendingDeleteAssetId=id;state.renamingAssetId=null;renderLibrary();$('libraryStatus').textContent=`Confirm deletion of “${asset.name}”. Its scene instances will be removed too.`;
    }
  });
  $('libraryList').addEventListener('keydown', async (event)=>{const input=event.target.closest('[data-asset-name-input]');if(input&&event.key==='Enter'){event.preventDefault();saveAssetName(input.dataset.assetNameInput);return;}if(input&&event.key==='Escape'){state.renamingAssetId=null;renderLibrary();return;}if((event.key==='Enter'||event.key===' ')&&!event.target.closest('button,input')){const row=event.target.closest('[data-preview-model]');if(row){event.preventDefault();try{await showAssetPreview(row.dataset.previewModel);renderLibrary();}catch(error){$('libraryStatus').textContent=error.message||String(error);}}}});
  $('sceneList').addEventListener('click', (event) => {
    const visible = event.target.closest('[data-toggle-visible]');
    if (visible) { const item = state.instances.find((entry) => entry.id === visible.dataset.toggleVisible); if (item) { item.visible = !item.visible; scheduleSave(); markProjectDirty(); state.clearance=null; clearClearanceMarkers(); renderClearance(); renderSceneList(); const mesh = state.meshById.get(item.id); if (mesh) mesh.visible = item.visible; } return; }
    const select = event.target.closest('[data-select-instance]'); if (!select) return;
    state.selectedId = select.dataset.selectInstance; renderSceneList(); renderSelection();
    const mesh = state.meshById.get(state.selectedId); if (mesh) state.transform.attach(mesh); else state.transform.detach();
  });
  for (const id of ['posX','posY','posZ','rotX','rotY','rotZ','scale','color','opacity','visible']) $(id).addEventListener('input', updateSelectedFromInputs);
  $('moveMode').addEventListener('click', () => { state.showTransformInputs=true;state.transformMode='translate';state.transform.setMode('translate');$('moveMode').classList.add('active');$('rotateMode').classList.remove('active');syncQuickTransform();rebuildRotationGizmo(); });
  $('rotateMode').addEventListener('click', () => { state.showTransformInputs=true;state.transformMode='rotate';state.transform.setMode('rotate');$('rotateMode').classList.add('active');$('moveMode').classList.remove('active');syncQuickTransform();rebuildRotationGizmo(); });
  $('applyQuickTransform').addEventListener('click',applyQuickTransform);$('closeQuickTransform').addEventListener('click',()=>{state.showTransformInputs=false;updateQuickTransformVisibility();});
  $('quickTransform').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();applyQuickTransform();}});
  $('removeInstance').addEventListener('click', () => { const item = selectedInstance(); if (item) removeSceneInstance(item.id); });
  $('clearJob').addEventListener('click', () => { state.job = null; state.clearance=null; clearClearanceMarkers(); renderClearance(); void dbRequest('readwrite','delete','__current_job__',undefined,'projects'); renderToolpath({ points: [] }); $('jobInfo').hidden = true; $('clearJob').disabled = true; $('alignStock').disabled = !state.instances.some((item) => item.kind === 'stock'); $('viewerReadout').textContent = 'Units: mm'; setJobStatus('Toolpath cleared.'); markProjectDirty(); fitView(); });
  $('alignStock').addEventListener('click', () => { markProjectDirty(); state.clearance=null; });
  $('alignStock').addEventListener('click', () => { const stock = state.instances.find((item) => item.kind === 'stock'); const asset = stock && state.library.find((model) => model.id === stock.modelId); if (!stock || !asset || !state.job) return; stock.x = state.job.bounds.minX; stock.y = state.job.bounds.minY; stock.z = -asset.size.z * stock.scale; state.selectedId = stock.id; renderSelection(); renderSceneList(); void renderObjects(); scheduleSave(); setStatus('Stock lower-left corner aligned to the NC file’s XY minimum and its top face set to Z0.', 'success'); });
  $('fitView').addEventListener('click', fitView);
  $('toggleGrid').addEventListener('click', () => { state.showGrid = !state.showGrid; state.scene.getObjectByName('work-grid').visible = state.showGrid; $('toggleGrid').textContent = state.showGrid ? 'Grid on' : 'Grid off'; $('toggleGrid').setAttribute('aria-pressed', String(state.showGrid)); });
}

function setWorkspace(name){$('setupWorkspace').hidden=name!=='setup';$('libraryWorkspace').hidden=name!=='library';$('projectsWorkspace').hidden=name!=='projects';document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));if(name==='library'){const v=state.libraryViewer,w=Math.max(1,$('assetViewer').clientWidth),h=Math.max(1,$('assetViewer').clientHeight);v.renderer.setSize(w,h,false);v.camera.aspect=w/h;v.camera.updateProjectionMatrix();}if(name==='projects'){const v=state.projectViewer,w=Math.max(1,$('projectViewer').clientWidth),h=Math.max(1,$('projectViewer').clientHeight);v.renderer.setSize(w,h,false);v.camera.aspect=w/h;v.camera.updateProjectionMatrix();}}

async function start() {
  initViewer(); initLibraryViewer(); initProjectViewer(); bindEvents(); state.db = await openModelDb();
  const saved = await storage.get(STORAGE_KEY, { library: [], instances: [] });
  const catalog=await dbRequest('readonly','get','__catalog__',undefined,'projects');
  const workspace=catalog || saved || {};
  if(!catalog){
    const [modelKeys,projectKeys]=await Promise.all([dbKeys('files'),dbKeys('projects')]);
    const modelSet=new Set(modelKeys),projectSet=new Set(projectKeys);
    workspace.library=(Array.isArray(workspace.library)?workspace.library:[]).filter(a=>a.format==='shape'||modelSet.has(a.id));
    workspace.projects=(Array.isArray(workspace.projects)?workspace.projects:[]).filter(p=>projectSet.has(p.id));
  }
  state.library = Array.isArray(workspace?.library) ? workspace.library : [];
  state.instances = Array.isArray(workspace?.instances) ? workspace.instances : [];
  state.projects = Array.isArray(workspace?.projects) ? workspace.projects : []; state.activeProjectId = workspace?.activeProjectId || null; state.checkConfig = { ...state.checkConfig, ...(workspace?.checkConfig || {}) };
  $('checkToolDiameter').value = state.checkConfig.toolDiameter; $('checkToolLength').value = state.checkConfig.toolLength; $('checkClearance').value = state.checkConfig.clearance; $('includeRapids').checked = state.checkConfig.includeRapid;
  renderProjects();
  const priorJob = await dbRequest('readonly','get','__current_job__',undefined,'projects');
  if (priorJob?.text) { try { state.job = { ...analyzeNc(priorJob.text), name: priorJob.name, rawText: priorJob.text }; renderToolpath(state.job); $('jobInfo').hidden=false; $('jobInfo').textContent=`${state.job.points.length.toLocaleString()} path points · X ${state.job.bounds.minX.toFixed(2)} to ${state.job.bounds.maxX.toFixed(2)} · Y ${state.job.bounds.minY.toFixed(2)} to ${state.job.bounds.maxY.toFixed(2)} mm`; $('clearJob').disabled=false; $('alignStock').disabled=!state.instances.some(i=>i.kind==='stock'); $('viewerReadout').textContent=`NC file: ${state.job.name} · mm`; setJobStatus(`Restored ${state.job.name}.`, 'success'); } catch { state.job=null; } }
  if(!catalog) await persistWorkspaceNow();
  state.selectedId = state.instances.at(-1)?.id ?? null;
  renderLibrary(); renderSceneList(); renderSelection(); await renderObjects(); fitView();
  setStatus(`Library ready · ${state.library.length} saved model${state.library.length === 1 ? '' : 's'} · ${state.instances.length} scene object${state.instances.length === 1 ? '' : 's'}.`, 'success');
}

start().catch((error) => setStatus(`Could not open the setup library: ${error.message || error}`, 'error'));
