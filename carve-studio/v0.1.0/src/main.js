import { file, gcode, navigation } from '@sienci/gsender-plugin-sdk';
import { deriveGrooveCenterlines, flattenTextOutline, grooveCutPaths } from './groove-centerline.js';
import { parseDxf } from './dxf-import.js';
import { planFlatBottomGroove, writeFlatGrooveGcode } from './flat-bottom-groove.js';
import { compensateProfile } from './profile-compensation.js';
import { setupCutPreview } from './cut-preview.js';
import { rectangularArray, circularArray, cornerOutline, cornerTargets, shapeCorners, arcThroughThreePoints } from './drawing-tools.js';
import { setupNodeEditor } from './node-editor-ui.js';
import { closeVectors, isOpenVectorCandidate, joinVectors } from './vector-joining.js';
import { combineVectorRegions, offsetVectorRegion, vectorPathContours, vectorRings } from './closed-vector-geometry.js';
import { buildSnapGeometry, intersectSegments, nearestSnap } from './object-snapping.js';
import { operationDefaults, restoreToolpathSettings } from './toolpath-settings.js';
import { initToolLibrary, OPERATION_TOOL_TYPES, readTool, sameCutter, toolLabel } from './tool-library.js';
import { initRegistration } from './registration-ui.js';
import pluginManifest from '../gsender-plugin.json';
import ClipperLib from 'clipper-lib';
import { parse as parseOpenType } from 'opentype.js';
import antonFontUrl from '../fonts/Anton-Regular.ttf?url';
import oswaldFontUrl from '../fonts/Oswald-Variable.ttf?url';
import bebasFontUrl from '../fonts/BebasNeue-Regular.ttf?url';
import reliefSvgFontUrl from '../fonts/ReliefSingleLineSVG-Regular.svg?url';
import barlowFontUrl from '../fonts/BarlowCondensed-Black.ttf?url';
import alfaFontUrl from '../fonts/AlfaSlabOne-Regular.ttf?url';
import shortStackFontUrl from '../fonts/ShortStack-Regular.ttf?url';

const svgNS='http://www.w3.org/2000/svg';
const canvas=document.querySelector('#canvas'),root=document.querySelector('#view-root'),drawing=document.querySelector('#drawing');
const stock={width:300,height:200,thickness:18},gridSettings={enabled:false,resolution:5};let stockManuallySet=false;
const SESSION_STORAGE_KEY='carve-studio-session-v1';let sessionSaveTimer=null,currentProjectName='Untitled project';
const profileDefaults={scope:'selected',profileSide:'on',profileToolDiameter:0,tools:{},drillScope:'all',depth:3,stepdown:1,safeZ:5,feed:800,plunge:250,rpm:12000,optimizeMoves:true,profileThroughStock:true,profileTabCount:4,profileTabWidth:6,profileTabHeight:2,vgrooveAngle:90,vgrooveMaxDepth:3,vgrooveSingleLine:false,vgrooveClearanceTool:null,pocketToolDiameter:3.175,pocketStepover:1.27,pocketOverlap:50,operations:operationDefaults(18)};let profileSettings={...profileDefaults},generatedGcode='',profileContours=[],generatedOperation='',activeToolpathOperation='profile',toolpathJobs=[],nextToolpathId=1,finalGcode='';
let view={scale:1,tx:0,ty:0},activeTool='select',activePanel='selection',selectedIds=new Set(),selectedRegion=null,drag=null,drawStart=null,drawGesture=null,objects=[],nextId=1,customLayers=['Default'],activeLayer='Default',hiddenLayers=new Set(),undoStack=[],redoStack=[],transformEdit=null;
const $=s=>document.querySelector(s);
const registration = initRegistration(pluginManifest.version);
const toolLibrary = initToolLibrary(renderToolSelectors);
const textFontUrls={anton:antonFontUrl,oswald:oswaldFontUrl,bebas:bebasFontUrl,barlow:barlowFontUrl,alfa:alfaFontUrl,shortstack:shortStackFontUrl},textFontCache=new Map(),importedFontRecords=new Map();let pendingTextFontValue='',reliefSvgFontCache=null;

const drawingToolFields = ['array-layout','array-columns','array-rows','array-pitch-x','array-pitch-y',
  'array-count','array-sweep','array-center-x','array-center-y','array-radius','corner-mode','corner-size','join-gap'];

function drawingToolValues() {
  return Object.fromEntries(drawingToolFields.map(id=>[id,$('#'+id).value]));
}

function restoreDrawingToolValues(values) {
  for (const id of drawingToolFields) {
    const field = $('#'+id);
    const saved = values?.[id];
    field.value = typeof saved === 'string' ? saved : field.defaultValue ?? field.options[0].value;
  }
}

function arrayCenter() {
  return ['x','y'].map((axis,index)=>{
    const field = $('#array-center-'+axis);
    return field.value === '' ? (index ? stock.height : stock.width) / 2 : field.valueAsNumber;
  });
}

function setPickingArrayCenter(picking) {
  if (!picking) showSnapMarker(null);
  $('#pick-array-center').setAttribute('aria-pressed', String(picking));
  canvas.classList.toggle('picking-array-center', picking);
}

function getArrayPlan(items, circular) {
  const bounds = boundsOf(items);
  if (!bounds) throw Error('Select objects to duplicate.');
  const input = id=>$('#array-'+id).valueAsNumber;
  let plan;
  if (circular) {
    const radiusField = $('#array-radius'), center = arrayCenter(), seed = centerOfBounds(bounds);
    radiusField.placeholder = Number(Math.hypot(seed[0]-center[0], seed[1]-center[1]).toFixed(3)).toString();
    const radius = radiusField.value === '' && !radiusField.validity.badInput ? undefined : input('radius');
    plan = circularArray(input('count'),input('sweep'),center,seed,radius);
  } else {
    plan = {seedOffset:[0,0],offsets:rectangularArray(input('columns'),input('rows'),input('pitch-x'),input('pitch-y'))};
  }
  if (!plan.offsets.length) throw Error('Enter at least two array positions.');
  if (plan.offsets.length * items.length > 1000) throw Error('An array can create up to 1,000 objects at once.');
  return plan;
}

const centerOfBounds = b=>[(b.minX+b.maxX)/2,(b.minY+b.maxY)/2];

function arrayCopy(object, [dx,dy]) {
  const copy = structuredClone(object);
  shift(copy, dx, dy);
  return copy;
}

function addGeometryMarker(point) {
  const marker = document.createElementNS(svgNS,'circle');
  marker.classList.add('corner-target');
  marker.setAttribute('cx',point[0]);
  marker.setAttribute('cy',stock.height-point[1]);
  marker.setAttribute('r',6/Math.max(view.scale,.01));
  $('#geometry-preview').append(marker);
}

function drawGeometryGhost(object) {
  const ghost = elemFor(object);
  if (!ghost) return;
  ghost.removeAttribute('data-id');
  $('#geometry-preview').append(ghost);
}

function refreshDrawingTools(items=objects.filter(o=>selectedIds.has(o.id))) {
  $('#geometry-preview').replaceChildren();
  $('#array-tool').disabled = !items.length;
  const openVectors = items.filter(object=>!hiddenLayers.has(object.layer) && isOpenVectorCandidate(object));
  $('#apply-join').disabled = openVectors.length < 2;
  $('#close-vectors').disabled = !openVectors.some(object=>object.kind!=='line');
  refreshBooleanTools();
  if (activePanel === 'corner') {
    const mode = $('#corner-mode').value;
    $('#corner-size-label').textContent = mode==='chamfer'?'Setback (mm)':'Radius (mm)';
    $('#apply-corners').disabled = !items.some(o=>{
      const outline = cornerOutline(o);
      return outline && cornerTargets(outline,mode).length;
    });
  }
  if (activePanel !== 'array') return;
  const circular = $('#array-layout').value==='circular';
  $('#rectangular-array-fields').hidden = circular;
  $('#circular-array-fields').hidden = !circular;
  const button = $('#apply-array'), status = $('#array-status');
  try {
    const {seedOffset,offsets} = getArrayPlan(items,circular);
    const preview = document.createDocumentFragment();
    const placements = seedOffset.some(Boolean) ? [seedOffset,...offsets] : offsets;
    for (const offset of placements) for (const object of items) {
      const ghost = elemFor(arrayCopy(object,offset));
      if (ghost) {
        ghost.removeAttribute('data-id');
        ghost.classList.add('array-copy');
        preview.append(ghost);
      }
    }
    $('#geometry-preview').append(preview);
    if (circular) addGeometryMarker(arrayCenter());
    button.disabled = false;
    status.textContent = `${offsets.length} new ${offsets.length===1?'position':'positions'}`;
  } catch (error) {
    button.disabled = true;
    status.textContent = error.message;
  }
}

function applyDrawingArray() {
  const items = objects.filter(o=>selectedIds.has(o.id));
  const {seedOffset,offsets} = getArrayPlan(items,$('#array-layout').value==='circular');
  remember();
  for (const offset of offsets) {
    const group = 'array-copy-'+nextId+'-';
    for (const item of items) {
      const copy = arrayCopy(item,offset);
      copy.id = nextId++;
      if (copy.textGroupId) copy.textGroupId = group + copy.textGroupId;
      if (copy.outlineGroupId) copy.outlineGroupId = group + copy.outlineGroupId;
      selectedIds.add(copy.id);
      objects.push(copy);
    }
  }
  if (seedOffset.some(Boolean)) for (const item of items) shift(item,...seedOffset);
  setTool('select');
  redraw();
}

function nearestDrawingCorner(point, mode) {
  let best = null, tolerance = 20/Math.max(view.scale,.01);
  for (const object of objects) {
    if (hiddenLayers.has(object.layer)) continue;
    const outline = cornerOutline(object);
    if (!outline) continue;
    for (const target of cornerTargets(outline,mode)) {
      const distance = Math.hypot(target.point[0]-point.x,target.point[1]-point.y);
      if (distance < tolerance) {
        tolerance = distance;
        best = {object,outline,...target};
      }
    }
  }
  return best;
}

function cornerReplacement(object, outline, index) {
  const geometry = shapeCorners(outline,$('#corner-mode').value,$('#corner-size').valueAsNumber,index);
  return {id:object.id,layer:object.layer,...geometry};
}

function previewDrawingCorner(point) {
  $('#geometry-preview').replaceChildren();
  const target = nearestDrawingCorner(point,$('#corner-mode').value);
  canvas.style.cursor = target ? 'pointer' : '';
  if (!target) return;
  addGeometryMarker(target.point);
  try {
    drawGeometryGhost(cornerReplacement(target.object,target.outline,target.index));
  } catch {
    // Keep the marker visible so clicking can explain why the size does not fit.
  }
}

function applyDrawingCorners(target) {
  const status = $('#corner-status'), mode = $('#corner-mode').value;
  try {
    const replacements = new Map();
    if (target) {
      replacements.set(target.object.id,cornerReplacement(target.object,target.outline,target.index));
    } else {
      for (const object of objects) {
        if (!selectedIds.has(object.id)) continue;
        const outline = cornerOutline(object);
        if (outline && cornerTargets(outline,mode).length) replacements.set(object.id,cornerReplacement(object,outline));
      }
    }
    if (!replacements.size) return;
    remember();
    objects = objects.map(object=>replacements.get(object.id) || object);
    if (target) selectedIds = new Set([target.object.id]);
    redraw();
    status.textContent = target?'Corner updated.':'Selected corners updated.';
  } catch (error) {
    status.textContent = error.message;
    showWorkspaceError(error.message);
  }
}

function applyVectorJoining(close) {
  const selected = objects.filter(object=>selectedIds.has(object.id) && !hiddenLayers.has(object.layer));
  const status = $('#join-status');
  status.textContent = '';
  try {
    const results = close ? closeVectors(selected,stock.height)
      : joinVectors(selected,stock.height,$('#join-gap').valueAsNumber);
    if (!results.length) {
      throw Error(close ? 'Select an open outline with enough geometry to enclose an area.'
        : 'No selected open endpoints are within the maximum gap on the same layer.');
    }
    const used = new Set(results.flatMap(result=>result.ids));
    const replacements = new Map(results.map(({object})=>[object.id,object]));
    remember();
    objects = objects.flatMap(object=>used.has(object.id) ? (replacements.get(object.id) || []) : object);
    selectedIds = new Set(replacements.keys());
    dismissWorkspaceError();
    if (close) setTool('select');
    redraw();
    if (!close) {
      status.textContent = `Joined ${used.size} vectors into ${results.length} ${results.length===1?'outline':'outlines'}.`;
      const skipped = selected.length-used.size;
      if (skipped) status.textContent += ` ${skipped} selected ${skipped===1?'vector was':'vectors were'} left unchanged.`;
    }
  } catch (error) {
    status.textContent = error.message;
    showWorkspaceError(error.message);
  }
}

function outlineGroup(object) {
  return object.outlineGroupId || object.textGroupId;
}

function closedPolygonCopies(components,layer) {
  return components.flatMap(rings=>{
    const groupId = rings.length>1 ? 'outline-'+nextId : null;
    return rings.map(points=>{
      const object = {id:nextId++,kind:'polygon',points,layer};
      if (groupId) object.outlineGroupId = groupId;
      return object;
    });
  });
}

function booleanSelection() {
  const ids = new Set(selectedIds);
  // Shift-click exclusions are explicitly chosen shapes even when area selection
  // represents them as cutouts in the highlight.
  for (const part of selectedAreaParts()) {
    for (const area of part.exclusions || []) for (const id of area.ids) ids.add(id);
  }
  const order = new Map([...ids].map((id,index)=>[id,index]));
  const selected = objects.filter(object=>ids.has(object.id) && !hiddenLayers.has(object.layer))
    .sort((a,b)=>order.get(a.id)-order.get(b.id));
  const groups = new Map();
  for (const object of selected) {
    if (object.centerlineFont || !hasClosedGeometry(object)) return [];
    const key = outlineGroup(object) || object.id;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(object);
  }
  return [...groups.values()];
}

function refreshBooleanTools() {
  const operands = selectedIds.size ? booleanSelection() : [];
  const available = operands.length >= 2;
  for (const id of ['weld-vectors','subtract-vectors','intersect-vectors','apply-subtract']) {
    $('#'+id).disabled = !available;
  }
  if (activePanel !== 'subtract') return;
  const select = $('#subtract-target'), previous = select.value;
  select.replaceChildren(...operands.map(group=>{
    const object = group[0], bounds = boundsOf(group);
    const kind = ({rect:'Rectangle',circle:'Circle',ellipse:'Ellipse',polygon:'Polygon',polyline:'Polyline',path:'Path'})[object.kind];
    const label = group.length > 1 ? 'Outline' : kind;
    const position = bounds ? ` · X ${bounds.minX.toFixed(1)}, Y ${bounds.minY.toFixed(1)}` : '';
    return new Option(label+position,object.id);
  }));
  if (operands.some(group=>String(group[0].id)===previous)) select.value = previous;
  select.disabled = !available;
  const target = operands.find(group=>String(group[0].id)===select.value);
  for (const object of target || []) {
    const outline = elemFor(object);
    outline.classList.add('subtract-target');
    outline.removeAttribute('data-id');
    $('#geometry-preview').append(outline);
  }
}

function applyVectorBoolean(operation) {
  try {
    const operands = booleanSelection();
    if (operands.length < 2) throw Error('Select at least two closed shapes for this operation.');
    if (operation==='subtract') {
      const index = operands.findIndex(group=>String(group[0].id)===$('#subtract-target').value);
      if (index < 0) throw Error('Choose a shape to cut from.');
      operands.unshift(operands.splice(index,1)[0]);
    }
    const regions = operands.map(group=>group.flatMap(object=>vectorRings(object,stock.height,geometryPoints)));
    const components = combineVectorRegions(operation,regions);
    if (!components.length) {
      throw Error(operation==='intersect' ? 'The selected shapes share no area.'
        : 'The cutters cover the entire target. There is no outline to keep.');
    }
    const consumed = new Set(operands.flat().map(object=>object.id));
    const layer = operands[0][0].layer || activeLayer;
    remember();
    const replacements = closedPolygonCopies(components,layer);
    objects = [...objects.filter(object=>!consumed.has(object.id)),...replacements];
    selectedIds = new Set(replacements.map(object=>object.id));
    dismissWorkspaceError();
    setTool('select');
    redraw();
  } catch (error) {
    showWorkspaceError(error.message);
  }
}

function setupDrawingToolControls() {
  $('#array-tool').onclick = ()=>{setTool('select');setPanel('array')};
  $('#pick-array-center').onclick = ()=>{
    const picking = !canvas.classList.contains('picking-array-center');
    setPickingArrayCenter(picking);
    if (picking) $('#array-status').textContent = 'Click the center point on the canvas.';
    else refreshDrawingTools();
  };
  $('#apply-array').onclick = applyDrawingArray;
  $('#apply-corners').onclick = ()=>applyDrawingCorners();
  $('#join-vectors').onclick = ()=>{
    setTool('select');
    $('#join-status').textContent = '';
    setPanel('join');
  };
  $('#apply-join').onclick = ()=>applyVectorJoining(false);
  $('#close-vectors').onclick = ()=>applyVectorJoining(true);
  $('#weld-vectors').onclick = ()=>applyVectorBoolean('weld');
  $('#intersect-vectors').onclick = ()=>applyVectorBoolean('intersect');
  $('#subtract-vectors').onclick = ()=>{
    setTool('select');
    $('#subtract-target').replaceChildren();
    setPanel('subtract');
  };
  $('#subtract-target').onchange = ()=>refreshDrawingTools();
  $('#apply-subtract').onclick = ()=>applyVectorBoolean('subtract');
  for (const id of drawingToolFields) {
    $('#'+id).addEventListener('input',()=>{
      if (id==='array-layout') setPickingArrayCenter(false);
      if (id==='join-gap') $('#join-status').textContent = '';
      $('#corner-status').textContent = '';
      refreshDrawingTools();
      queueSessionSave();
    });
  }
}

function resizeBoard(){
  snapScene=null;
  stock.width=Math.max(1,Number($('#stock-width').value)||300);stock.height=Math.max(1,Number($('#stock-height').value)||200);
  $('#board').setAttribute('x',0);$('#board').setAttribute('y',0);$('#board').setAttribute('width',stock.width);$('#board').setAttribute('height',stock.height);
  $('#board-shadow').setAttribute('x',3);$('#board-shadow').setAttribute('y',3);$('#board-shadow').setAttribute('width',stock.width);$('#board-shadow').setAttribute('height',stock.height);
  $('#grid-overlay').setAttribute('width',stock.width);$('#grid-overlay').setAttribute('height',stock.height);updateGrid();
  if(!view.scale)fitView();else renderView();
}
function renderView(){showSnapMarker(null);root.setAttribute('transform',`translate(${view.tx} ${view.ty}) scale(${view.scale})`);$('#zoom-label').textContent=`${Math.round(view.scale*100)}%`;syncSelectionCenter();if(activeTool==='nodes')nodeEditor.render();updateGrid();}
function fitView(){const r=$('#canvas-wrap').getBoundingClientRect(),pad=70;if(!r.width||!r.height)return;view.scale=Math.min((r.width-pad*2)/stock.width,(r.height-pad*2)/stock.height);view.tx=(r.width-stock.width*view.scale)/2;view.ty=(r.height-stock.height*view.scale)/2;renderView();}
function point(evt){const p=canvas.createSVGPoint();p.x=evt.clientX;p.y=evt.clientY;const q=p.matrixTransform(root.getScreenCTM().inverse());return{x:q.x,y:stock.height-q.y};}
let snapScene = null;
const snapTools = new Set(['line','rect','circle','text']);

function svgSnapContours(object) {
  if (typeof object.d!=='string') return [];
  const probe=document.createElementNS(svgNS,'path');
  const scaleX=object.sx||1, scaleY=object.sy||1;
  const offsetX=(object.dx||0)+(object.ox||0), offsetY=(object.dy||0)+(object.oy||0);
  let previous={x:0,y:0};
  return (object.d.match(/[Mm][^Mm]*/g)||[]).flatMap(raw=>{
    let d=raw;
    if (d.startsWith('m')) {
      const start=d.match(/^m\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*,?\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)[\s,]*/i);
      if (!start) return [];
      const rest=d.slice(start[0].length);
      d='M'+(previous.x+Number(start[1]))+' '+(previous.y+Number(start[2]))+' '+(/^[0-9.+-]/.test(rest)?'l':'')+rest;
    }
    try {
      probe.setAttribute('d',d);
      const length=probe.getTotalLength();
      previous=probe.getPointAtLength(length);
      if (!length) return [];
      const closed=/[Zz]\s*$/.test(d);
      let points;
      const commands=d.replace(/(?:\d)e[-+]?\d+/gi,'0').match(/[A-Za-z]/g)||[];
      if (commands.every(command=>'MLQCZ'.includes(command))) {
        points=flattenTextOutline(d,scaleX,scaleY).map(p=>({x:p.x+offsetX,y:stock.height-p.y-offsetY}));
      }
      if (!points?.length) {
        const count=Math.max(2,Math.min(4000,Math.ceil(length*Math.max(Math.abs(scaleX),Math.abs(scaleY))/.4)));
        points=Array.from({length:count+1},(_,i)=>{
          const p=probe.getPointAtLength(length*i/count);
          return {x:p.x*scaleX+offsetX,y:stock.height-p.y*scaleY-offsetY};
        });
      }
      return [{points,closed}];
    } catch {
      return [];
    }
  });
}

function visibleSnapScene() {
  snapScene ??= objects.filter(object=>!hiddenLayers.has(object.layer)).flatMap(object=>{
    const bounds=boundsOf([object]);
    return bounds ? [{object,bounds}] : [];
  });
  return snapScene;
}

function objectSnap(point, scene=visibleSnapScene()) {
  const tolerance=10/Math.max(view.scale,.01);
  const geometry=[];
  for (const record of scene) {
    const {object,bounds:{minX,minY,maxX,maxY}}=record;
    if (point.x+tolerance<minX || point.x-tolerance>maxX ||
        point.y+tolerance<minY || point.y-tolerance>maxY) continue;
    if (!record.geometry) {
      const contours=object.kind==='path'?svgSnapContours(object):
        object.kind==='circle'?[]:[{points:geometryPoints(object),closed:['rect','polygon','ellipse'].includes(object.kind)}];
      record.geometry=buildSnapGeometry(object,contours);
    }
    geometry.push(record.geometry);
  }
  return nearestSnap(point,tolerance,geometry);
}

function showSnapMarker(target) {
  const marker=$('#object-snap-marker');
  marker.setAttribute('visibility',target?'visible':'hidden');
  if (!target) return;
  marker.dataset.kind=target.kind;
  marker.setAttribute('transform','translate('+target.x+' '+(stock.height-target.y)+') scale('+(1/Math.max(view.scale,.01))+')');
}

function snapPoint(point, scene) {
  const target=gridSettings.enabled ? objectSnap(point,scene) : null;
  showSnapMarker(target);
  if (target) return {x:target.x,y:target.y};
  if (!gridSettings.enabled) return point;
  const step=gridSettings.resolution;
  return {x:Math.round(point.x/step)*step,y:Math.round(point.y/step)*step};
}

function startSelectionMove(items, point, event, centerHandle=false) {
  const scene=gridSettings.enabled?visibleSnapScene():[];
  const ids=new Set(items.map(item=>item.id));
  let anchor=point;
  if (centerHandle) {
    const [x,y]=centerOfBounds(boundsOf(items));
    anchor={x,y};
  } else if (gridSettings.enabled) {
    anchor=objectSnap(point,scene.filter(record=>ids.has(record.object.id)))||point;
  }
  drag={mode:'move',items,origin:point,anchor,snapTargets:scene.filter(record=>!ids.has(record.object.id)),
    applied:{x:0,y:0},startClientX:event.clientX,startClientY:event.clientY,undoRecorded:false};
}

function moveSelectionTo(point, event) {
  if (Math.hypot(event.clientX-drag.startClientX,event.clientY-drag.startClientY)<=3) return;
  const {anchor,origin,applied}=drag;
  const destination=snapPoint({x:anchor.x+point.x-origin.x,y:anchor.y+point.y-origin.y},drag.snapTargets);
  const x=destination.x-anchor.x, y=destination.y-anchor.y;
  const dx=x-applied.x, dy=y-applied.y;
  if (!dx && !dy) return;
  if (!drag.undoRecorded) {
    remember();
    drag.undoRecorded=true;
  }
  drag.items.forEach(object=>shift(object,dx,dy));
  drag.applied={x,y};
  redraw();
}
function updateGrid(){if(!gridSettings.enabled)showSnapMarker(null);const step=gridSettings.resolution||5;$('#grid-pattern').setAttribute('width',step);$('#grid-pattern').setAttribute('height',step);$('#grid-pattern').setAttribute('x',-step/2);$('#grid-pattern').setAttribute('y',stock.height%step-step/2);$('#grid-dot').setAttribute('cx',step/2);$('#grid-dot').setAttribute('cy',step/2);$('#grid-dot').setAttribute('r',Math.min(step*.3,.9/Math.max(view.scale,.01)));$('#grid-overlay').setAttribute('visibility',gridSettings.enabled?'visible':'hidden');$('#grid-toggle').classList.toggle('active',gridSettings.enabled);$('#grid-toggle').setAttribute('aria-pressed',String(gridSettings.enabled));$('#grid-resolution').value=String(step)}
function setPanel(name){if(name!=='array')setPickingArrayCenter(false);activePanel=name;for(const [panel,id] of Object.entries({stock:'stock-panel',layers:'layers-panel',selection:'selection-panel',offset:'offset-panel',text:'text-settings',array:'array-panel',corner:'corner-panel',path:'path-panel',nodes:'node-panel',join:'join-panel',subtract:'subtract-panel'}))$('#'+id).hidden=panel!==name;document.querySelectorAll('[data-panel]').forEach(button=>button.classList.toggle('panel-active',button.dataset.panel===name));refreshDrawingTools()}
function elemFor(o){const el=document.createElementNS(svgNS,o.kind);el.classList.add('vector');el.dataset.id=o.id;const h=stock.height;
  if(o.kind==='line'){el.setAttribute('x1',o.x1);el.setAttribute('y1',h-o.y1);el.setAttribute('x2',o.x2);el.setAttribute('y2',h-o.y2)}
  else if(o.kind==='rect'){el.setAttribute('x',Math.min(o.x1,o.x2));el.setAttribute('y',h-Math.max(o.y1,o.y2));el.setAttribute('width',Math.abs(o.x2-o.x1));el.setAttribute('height',Math.abs(o.y2-o.y1))}
  else if(o.kind==='circle'){el.setAttribute('cx',o.cx);el.setAttribute('cy',h-o.cy);el.setAttribute('r',o.r)}
  else if(o.kind==='polyline'||o.kind==='polygon'){el.setAttribute('points',o.points.map(p=>`${p[0]},${h-p[1]}`).join(' '))}
  else if(o.kind==='path'){el.setAttribute('d',o.d);el.setAttribute('transform',`translate(${o.dx||0} ${o.dy||0}) translate(${o.ox||0} ${o.oy||0}) scale(${o.sx||1} ${o.sy||1})`)}
  else if(o.kind==='ellipse'){el.setAttribute('cx',o.cx);el.setAttribute('cy',h-o.cy);el.setAttribute('rx',o.rx);el.setAttribute('ry',o.ry)}
  else return null;
  return el;
}
function syncSelectionCenter(){const handle=$('#selection-center');if(!handle)return;if(activeTool==='nodes'){handle.setAttribute('visibility','hidden');return}const items=objects.filter(o=>selectedIds.has(o.id)&&!hiddenLayers.has(o.layer)),b=boundsOf(items);if(!b){handle.setAttribute('visibility','hidden');return}handle.setAttribute('cx',(b.minX+b.maxX)/2);handle.setAttribute('cy',stock.height-(b.minY+b.maxY)/2);handle.setAttribute('r',5/Math.max(view.scale,.01));handle.setAttribute('visibility','visible')}
function updateRegionCutouts(){$('#region-cutouts').replaceChildren()}
function redraw(){snapScene=null;drawing.replaceChildren();for(const o of objects){const el=elemFor(o);if(el){el.classList.toggle('selected',selectedIds.has(o.id));el.style.display=hiddenLayers.has(o.layer)?'none':'';drawing.append(el)}}const regionPath=$('#region-highlight');if(selectedRegion&&selectedRegion.ids.every(id=>selectedIds.has(id))){regionPath.setAttribute('d',selectedRegion.contours.map(points=>`M ${points.map(p=>`${p.x} ${stock.height-p.y}`).join(' L ')} Z`).join(' '));regionPath.setAttribute('visibility','visible')}else regionPath.setAttribute('visibility','hidden');updateRegionCutouts();
  const layerNames=[...new Set(['Default',...customLayers,...objects.map(o=>o.layer||'Default')])];if(!layerNames.includes(activeLayer))activeLayer='Default';const counts={};for(const o of objects)counts[o.layer]=(counts[o.layer]||0)+1;
  $('#layers').innerHTML=layerNames.map(n=>`<div class="layer-row ${n===activeLayer?'active':''} ${hiddenLayers.has(n)?'hidden-layer':''}" data-layer="${escapeHtml(n)}"><button class="layer-eye" type="button" title="${hiddenLayers.has(n)?'Show':'Hide'} layer">${hiddenLayers.has(n)?'◌':'◉'}</button><span class="layer-swatch"></span><span class="layer-name">${escapeHtml(n)}</span><span class="layer-count">${counts[n]||0}</span></div>`).join('');
  $('#layers').querySelectorAll('.layer-row').forEach(row=>row.onclick=e=>{const name=row.dataset.layer;if(e.target.closest('.layer-eye')){remember();if(hiddenLayers.has(name))hiddenLayers.delete(name);else{hiddenLayers.add(name);selectedIds=new Set([...selectedIds].filter(id=>objects.find(o=>o.id===id)?.layer!==name));if(activeLayer===name){const next=layerNames.find(layer=>!hiddenLayers.has(layer));if(next)activeLayer=next;else{hiddenLayers.delete('Default');activeLayer='Default'}}}}else{activeLayer=name;hiddenLayers.delete(name)}redraw()});
  $('#object-count').textContent=`${objects.length} object${objects.length===1?'':'s'}`;
  const picked=objects.filter(o=>selectedIds.has(o.id)),one=picked.length===1?picked[0]:null,b=boundsOf(picked);$('#selection-info').textContent=picked.length===0?'Nothing selected':selectedRegion?`Enclosed area · ${picked.length} vector${picked.length===1?'':'s'}`:picked.length===1?`${one.kind} · ${one.layer}`:`${picked.length} objects selected`;
  $('#delete-selected').disabled=!picked.length;$('#duplicate-selected').disabled=!picked.length;$('#mirror-x').disabled=!picked.length;$('#mirror-y').disabled=!picked.length;$('#duplicate-mirror-x').disabled=!picked.length;$('#duplicate-mirror-y').disabled=!picked.length;$('#center-on-stock').disabled=!b;$('#offset-tool').disabled=!picked.length;$('#apply-offset').disabled=!picked.length;$('#preview-drill').disabled=profileSettings.drillScope==='selected'?!picked.some(o=>o.kind==='circle'):!objects.some(o=>o.kind==='circle');$('#preview-vgroove').disabled=!picked.some(o=>isClosedVector(o)||o.centerlineFont);$('#preview-vgroove-flat').disabled=!picked.some(o=>isClosedVector(o)&&!o.centerlineFont);$('#preview-pocket').disabled=!picked.some(isClosedVector)&&!selectedRegion;
  for(const id of ['edit-x','edit-y','edit-width','edit-height'])$( '#'+id ).disabled=!b;
  if(b){const editX=one?.kind==='circle'?one.cx:b.minX,editY=one?.kind==='circle'?one.cy:b.minY;if(document.activeElement!==$('#edit-x'))$('#edit-x').value=editX.toFixed(1);if(document.activeElement!==$('#edit-y'))$('#edit-y').value=editY.toFixed(1);if(document.activeElement!==$('#edit-width'))$('#edit-width').value=b.width.toFixed(1);if(document.activeElement!==$('#edit-height'))$('#edit-height').value=b.height.toFixed(1)}
  syncSelectionCenter();
  if(activeTool==='nodes')nodeEditor.refresh();
  refreshDrawingTools(picked);
  syncHistoryButtons();queueSessionSave();
}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function projectState(){return{stock:{...stock,manual:stockManuallySet},grid:{...gridSettings},objects:JSON.parse(JSON.stringify(objects)),selected:[...selectedIds],selectedRegion:selectedRegion?JSON.parse(JSON.stringify(selectedRegion)):null,nextId,layers:[...customLayers],activeLayer,hiddenLayers:[...hiddenLayers],profileSettings:JSON.parse(JSON.stringify(profileSettings)),toolpaths:JSON.parse(JSON.stringify(toolpathJobs)),nextToolpathId,uiValues:{textContent:$('#text-content').value,textFont:pendingTextFontValue||$('#text-font').value,textFontLabel:$('#text-font').selectedOptions[0]?.textContent||'',textSize:$('#text-size').value,offsetDistance:$('#offset-distance').value,drawingTools:drawingToolValues()}}}
function saveSessionNow(){try{localStorage.setItem(SESSION_STORAGE_KEY,JSON.stringify({projectName:currentProjectName,state:projectState()}))}catch(error){console.warn('Carve Studio session autosave failed:',error)}}
function queueSessionSave(){clearTimeout(sessionSaveTimer);sessionSaveTimer=setTimeout(saveSessionNow,300)}
function restoreLastSession(){try{const saved=JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)||'null');if(!saved?.state?.stock||!Array.isArray(saved.state.objects))return false;restoreState(saved.state);setProjectName(saved.projectName||'Untitled project');return true}catch(error){console.warn('Carve Studio session restore failed:',error);return false}}
function clearProfilePreview(message=''){generatedGcode='';finalGcode='';profileContours=[];generatedOperation='';$('#toolpath-preview').replaceChildren();$('#gcode-preview').hidden=true;$('#gcode-preview').value='';$('#save-gcode').disabled=true;$('#load-visualizer').disabled=true;if(message)profileStatus(message)}
function showWorkspaceError(message) {
  $('#workspace-error').hidden = false;
  $('#workspace-error-message').textContent = message;
}
function dismissWorkspaceError() {
  $('#workspace-error').hidden = true;
  $('#workspace-error-message').textContent = '';
}
$('#dismiss-workspace-error').addEventListener('click', dismissWorkspaceError);
function profileStatus(message, error = false) {
  $('#profile-status').textContent = error ? '' : message;
  if (error) showWorkspaceError(message);
  else dismissWorkspaceError();
}
function toolpathLabel(operation){return({profile:'Profile',drill:'Drilling',vgroove:'V Groove','vgroove-flat':'Flat-bottom V Groove','vgroove-clearance':'V Groove Clearance',pocket:'Pocket'})[operation]||'Toolpath'}
function renderToolpathList(){const list=$('#toolpath-list');if(!list)return;list.innerHTML=toolpathJobs.length?toolpathJobs.map((job,index)=>{const previousIsProfile=toolpathJobs[index-1]?.operation==='profile',nextIsProfile=toolpathJobs[index+1]?.operation==='profile',canMoveUp=index>0&&(job.operation!=='profile'||previousIsProfile),canMoveDown=index<toolpathJobs.length-1&&(job.operation==='profile'?nextIsProfile:!nextIsProfile);return`<div class="toolpath-row"><span class="toolpath-number">${index+1}</span><div class="toolpath-name-wrap"><input data-job-name="${job.id}" aria-label="Toolpath name" value="${escapeHtml(job.name)}"><small>${toolpathLabel(job.operation)}${job.tool?' · '+escapeHtml(job.tool.name):''} · ${job.gcode.split(/\r?\n/).filter(Boolean).length} lines</small></div><label class="toolpath-tool-number" title="Tool number">T<input type="number" min="1" step="1" data-job-tool="${job.id}" value="${Number(job.toolNumber)||1}" aria-label="Tool number"></label><button type="button" data-job-action="up" data-job-id="${job.id}" title="Move toolpath up" ${canMoveUp?'':'disabled'}>↑</button><button type="button" data-job-action="down" data-job-id="${job.id}" title="Move toolpath down" ${canMoveDown?'':'disabled'}>↓</button><button type="button" data-job-action="remove" data-job-id="${job.id}" title="Remove toolpath">×</button></div>`}).join(''):'<div class="toolpath-empty">Generate an operation preview to add it here.</div>';$('#build-combined-nc').disabled=$('#open-cut-preview').disabled=toolpathJobs.length===0;$('#toolpath-count').textContent=`${toolpathJobs.length} path${toolpathJobs.length===1?'':'s'}`;queueSessionSave()}
function rememberToolpathChange(){undoStack.push(projectState());if(undoStack.length>100)undoStack.shift();redoStack=[];syncHistoryButtons()}
function invalidateFinalNc(message='Toolpath list changed. Build the combined NC file again.'){finalGcode='';if(generatedOperation==='combined')clearProfilePreview(message)}
function addToolpathJob(operation,gcode) {
  addToolpathStages([{operation,gcode,tool:selectedOperationTool(operation)}]);
}

function addToolpathStages(stages) {
  rememberToolpathChange();
  let previousId;
  for (const {operation,gcode,tool,toolChangeZ,requiresPrevious} of stages) {
    const ordinal = toolpathJobs.filter(job=>job.operation===operation).length+1;
    const job = {id:nextToolpathId++,name:`${toolpathLabel(operation)} ${ordinal}`,
      operation,gcode,toolNumber:tool?.number||1,tool};
    if (toolChangeZ) job.toolChangeZ = toolChangeZ;
    if (requiresPrevious) job.requiresJobId = previousId;
    const profileIndex = toolpathJobs.findIndex(item=>item.operation==='profile');
    if (operation==='profile' || profileIndex<0) toolpathJobs.push(job);
    else toolpathJobs.splice(profileIndex,0,job);
    previousId = job.id;
  }
  invalidateFinalNc();
  renderToolpathList();
  $('#generated-toolpaths').open = true;
}

function composeToolpaths(jobs,heading) {
  const lines = [heading,'G21 G90 G17 G94'];
  const cutters = new Map(), emitted = new Set();
  for (const [index,job] of jobs.entries()) {
    if (job.requiresJobId && !emitted.has(job.requiresJobId)) {
      throw Error(`Place the matching clearance toolpath before ${job.name}. Regenerate the groove if the clearance toolpath was removed.`);
    }
    const tool = Number(job.toolNumber);
    if (!Number.isInteger(tool) || tool<1) throw Error(`Enter a valid tool number for ${job.name}.`);
    const cutter = readTool(job.tool), previous = cutters.get(tool);
    if (cutter && previous && !sameCutter(cutter,previous)) {
      throw Error('Tool number T'+tool+' is assigned to different cutters. Review the generated toolpath tool numbers.');
    }
    if (cutter) cutters.set(tool,cutter);
    const name = String(job.name).replace(/[()\r\n]/g,' ').trim();
    lines.push('',`(Toolpath ${index+1}: ${name} · ${toolpathLabel(job.operation)})`);
    if (Number.isFinite(job.toolChangeZ) && job.toolChangeZ>0) lines.push(`G0 Z${job.toolChangeZ.toFixed(3)}`);
    lines.push(`M6 T${tool}`);
    const body = job.gcode.split(/\r?\n/).filter(line=>!/^\s*(?:M30|M2)\s*$/i.test(line)).join('\n').trim();
    if (body) lines.push(body);
    emitted.add(job.id);
  }
  return [...lines,'','M30'].join('\n')+'\n';
}

function buildCombinedNc() {
  if (!toolpathJobs.length) throw Error('Generate at least one toolpath before building the final NC file.');
  const ordered = [...toolpathJobs.filter(job=>job.operation!=='profile'),...toolpathJobs.filter(job=>job.operation==='profile')];
  finalGcode = composeToolpaths(ordered,'(Carve Studio combined NC file)\n(Toolpaths are emitted in list order; profile paths run last.)');
  generatedGcode = finalGcode;
  generatedOperation = 'combined';
  $('#gcode-preview').value = generatedGcode;
  $('#gcode-preview').hidden = false;
  $('#save-gcode').disabled = false;
  $('#load-visualizer').disabled = false;
  profileStatus(`Combined NC ready · ${ordered.length} toolpaths · profile runs last · M6 tool calls included. Verify tool assignments before machining.`);
}
function remember(){undoStack.push(projectState());if(undoStack.length>100)undoStack.shift();redoStack=[];selectedRegion=null;clearProfilePreview(objects.length?'Drawing changed. Generate the profile preview again.':'');syncHistoryButtons()}
function syncHistoryButtons(){$('#undo').disabled=undoStack.length===0;$('#redo').disabled=redoStack.length===0}
function restoreState(s){clearPathDraft();stock.width=s.stock.width;stock.height=s.stock.height;stock.thickness=Math.max(.1,Number(s.stock.thickness)||18);stockManuallySet=typeof s.stock.manual==='boolean'?s.stock.manual:true;gridSettings.enabled=!!s.grid?.enabled;gridSettings.resolution=[.5,1,2,5,10,20].includes(Number(s.grid?.resolution))?Number(s.grid.resolution):5;objects=s.objects;selectedIds=new Set(Array.isArray(s.selected)?s.selected:Number.isFinite(s.selected)?[s.selected]:[]);selectedRegion=s.selectedRegion||null;nextId=s.nextId;customLayers=Array.isArray(s.layers)?s.layers:['Default'];activeLayer=s.activeLayer||'Default';hiddenLayers=new Set(Array.isArray(s.hiddenLayers)?s.hiddenLayers:[]);selectedIds=new Set([...selectedIds].filter(id=>{const o=objects.find(x=>x.id===id);return o&&!hiddenLayers.has(o.layer)}));profileSettings={...profileDefaults,...restoreToolpathSettings(s.profileSettings||{},stock.thickness)};const savedToolpaths=Array.isArray(s.toolpaths)?s.toolpaths:[];toolpathJobs=[...savedToolpaths.filter(job=>job.operation!=='profile'),...savedToolpaths.filter(job=>job.operation==='profile')].map(job=>({...job,toolNumber:Number(job.toolNumber)||1}));nextToolpathId=Number(s.nextToolpathId)||Math.max(0,...toolpathJobs.map(job=>Number(job.id)||0))+1;setProfileFields();if(s.uiValues){$('#text-content').value=s.uiValues.textContent??'';setTextFontSelection(s.uiValues.textFont||'anton',s.uiValues.textFontLabel);$('#text-size').value=s.uiValues.textSize||25;$('#offset-distance').value=s.uiValues.offsetDistance??2}restoreDrawingToolValues(s.uiValues?.drawingTools);renderToolpathList();clearProfilePreview();$('#stock-width').value=stock.width;$('#stock-height').value=stock.height;$('#stock-thickness').value=stock.thickness;$('#auto-stock-size').checked=!stockManuallySet;resizeBoard();fitView();redraw()}
function setProjectName(name){currentProjectName=String(name||'Untitled project');$('#project-name').innerHTML=`${escapeHtml(currentProjectName)} <span class="saved-dot"></span>`;queueSessionSave()}
function askSaveBeforeNew(){const dialog=$('#new-project-dialog');return new Promise(resolve=>{dialog.returnValue='cancel';dialog.addEventListener('close',()=>resolve(dialog.returnValue||'cancel'),{once:true});dialog.showModal()})}
async function saveProjectFile(){const button=$('#save-project'),payload={format:'carve-studio-project',version:1,...projectState()};button.disabled=true;try{const result=await file.openSaveDialog({content:JSON.stringify(payload,null,2),options:{defaultFileName:'carve-studio-project.carve',title:'Save Carve Studio project',filters:[{name:'Carve Studio project',extensions:['carve']}]}});if(!result.success)return false;setProjectName(result.filePath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/,'')||'Carve Studio project');return true}catch(error){alert(`Could not save project: ${error?.message||error}`);return false}finally{button.disabled=false}}
function add(o){remember();o.id=nextId++;o.layer=o.layer||activeLayer;objects.push(o);selectedIds=new Set([o.id]);redraw()}
function boundsOf(items){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;const include=(x,y)=>{if(Number.isFinite(x)&&Number.isFinite(y)){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}};
 for(const o of items){if(o.kind==='line'||o.kind==='rect'){include(o.x1,o.y1);include(o.x2,o.y2)}else if(o.kind==='circle'){include(o.cx-o.r,o.cy-o.r);include(o.cx+o.r,o.cy+o.r)}else if(o.kind==='ellipse'){include(o.cx-o.rx,o.cy-o.ry);include(o.cx+o.rx,o.cy+o.ry)}else if(o.points){for(const p of o.points)include(p[0],p[1])}else if(o.kind==='path'){
   let el=drawing.querySelector(`[data-id="${o.id}"]`),temporary=false;if(!el){el=elemFor(o);if(el){drawing.append(el);temporary=true}}
   try{const box=el.getBBox(),ctm=el.getScreenCTM(),inv=root.getScreenCTM().inverse(),corners=[[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]];for(const [x,y] of corners){const p=canvas.createSVGPoint();p.x=x;p.y=y;const q=p.matrixTransform(ctm).matrixTransform(inv);include(q.x,stock.height-q.y)}}catch{}if(temporary)el.remove();
 }}
 return minX===Infinity?null:{minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY};
}
function transformItems(items,from,to){const fx=from.width>1e-9?to.width/from.width:1,fy=from.height>1e-9?to.height/from.height:1,tx=to.x-from.minX*fx,ty=to.y-from.minY*fy,H=stock.height;
 for(const o of items){const point=(x,y)=>[to.x+(x-from.minX)*fx,to.y+(y-from.minY)*fy];
  if(o.kind==='path'){const dxScreen=H-to.y-fy*(H-from.minY);o.dx=fx*((o.dx||0)+(o.ox||0))+tx;o.dy=fy*((o.dy||0)+(o.oy||0))+dxScreen;o.ox=0;o.oy=0;o.sx=(o.sx||1)*fx;o.sy=(o.sy||1)*fy}
  else if(o.kind==='line'||o.kind==='rect'){if(from.width<=1e-9){o.x1=to.x;o.x2=to.x+to.width}else{[o.x1,o.y1]=point(o.x1,o.y1);[o.x2,o.y2]=point(o.x2,o.y2)}if(from.height<=1e-9){o.y1=to.y;o.y2=to.y+to.height}else if(from.width<=1e-9){o.y1=to.y;o.y2=to.y+to.height}}
  else if(o.kind==='circle'){const [x,y]=point(o.cx,o.cy),rx=o.r*Math.abs(fx),ry=o.r*Math.abs(fy);o.cx=x;o.cy=y;o.r=(rx+ry)/2;if(Math.abs(rx-ry)>1e-6){o.kind='ellipse';o.rx=rx;o.ry=ry;delete o.r}}
  else if(o.kind==='ellipse'){[o.cx,o.cy]=point(o.cx,o.cy);o.rx*=Math.abs(fx);o.ry*=Math.abs(fy)}
  if(o.points)o.points=o.points.map(([x,y])=>point(x,y));
 }
}
function sizeStockToFirstImport(items){const b=boundsOf(items);if(!b)return;const marginX=Math.max(1,b.width*.05),marginY=Math.max(1,b.height*.05),dx=marginX-b.minX,dy=marginY-b.minY;for(const o of items)shift(o,dx,dy);
 stock.width=Math.max(1,b.width+marginX*2);stock.height=Math.max(1,b.height+marginY*2);stockManuallySet=false;
 $('#stock-width').value=stock.width.toFixed(1).replace(/\.0$/,'');$('#stock-height').value=stock.height.toFixed(1).replace(/\.0$/,'');
 $('#board').setAttribute('width',stock.width);$('#board').setAttribute('height',stock.height);$('#board-shadow').setAttribute('width',stock.width);$('#board-shadow').setAttribute('height',stock.height);
}
function setTool(t){showSnapMarker(null);if(t!==activeTool){nodeEditor.cancel();clearPathDraft();if(drawStart){drawStart=null;drawGesture=null;$('#drawing-preview').replaceChildren()}}activeTool=t;canvas.dataset.tool=t;canvas.dataset.panning='false';canvas.style.cursor='';if(t==='select')setPanel('selection');else if(t==='nodes'){setPanel('nodes');canvas.focus({preventScroll:true})}else if(t==='text'||t==='corner')setPanel(t);else if(pathTools.has(t)){setPanel('path');updatePathPanel();canvas.focus({preventScroll:true})}else if(['line','rect','circle','trim','pan'].includes(t))setPanel('none');document.querySelectorAll('.tool[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));syncSelectionCenter();nodeEditor.refresh()}
function updateDrawingPreview(p){const layer=$('#drawing-preview');layer.replaceChildren();if(!drawStart)return;const a=drawStart,h=stock.height,make=(tag,attrs)=>{const el=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);el.setAttribute('class','drawing-live-preview');layer.append(el)};if(activeTool==='line')make('line',{x1:a.x,y1:h-a.y,x2:p.x,y2:h-p.y});else if(activeTool==='rect')make('rect',{x:Math.min(a.x,p.x),y:h-Math.max(a.y,p.y),width:Math.abs(p.x-a.x),height:Math.abs(p.y-a.y)});else if(activeTool==='circle')make('circle',{cx:a.x,cy:h-a.y,r:Math.hypot(p.x-a.x,p.y-a.y)});make('circle',{cx:a.x,cy:h-a.y,r:1.4})}
function finishDrawing(p){const a=drawStart;drawStart=null;drawGesture=null;$('#drawing-preview').replaceChildren();let o;if(activeTool==='line')o={kind:'line',x1:a.x,y1:a.y,x2:p.x,y2:p.y};if(activeTool==='rect')o={kind:'rect',x1:Math.min(a.x,p.x),y1:Math.min(a.y,p.y),x2:Math.max(a.x,p.x),y2:Math.max(a.y,p.y)};if(activeTool==='circle')o={kind:'circle',cx:a.x,cy:a.y,r:Math.hypot(p.x-a.x,p.y-a.y)};if(o){add(o);setTool('select')}drag=null}
const pathTools = new Set(['polyline','arc']);
let pathPoints = [];

function updatePathPanel(message='') {
  const polyline=activeTool==='polyline';
  $('#path-title').textContent=polyline?'POLYLINE':'3-POINT ARC';
  $('#polyline-actions').hidden=!polyline;
  $('#finish-polyline').disabled=pathPoints.length<2;
  $('#close-polyline').disabled=pathPoints.length<3;
  const instructions=polyline
    ? (pathPoints.length<2?'Click to add vertices.':'Double-click or press Enter to finish open. Click the start point to close.')
    : ['Click the arc start.','Click a point the arc should pass through.','Click the arc end.'][pathPoints.length];
  $('#path-status').textContent=message||instructions;
}

function clearPathDraft() {
  if (!pathTools.has(activeTool)) return;
  pathPoints=[];
  showSnapMarker(null);
  $('#drawing-preview').replaceChildren();
  updatePathPanel();
}

function pathPoint(point) {
  const snapped=snapPoint(point);
  if (activeTool==='polyline' && pathPoints.length>=3 &&
      distance(point,pathPoints[0])*view.scale<=9) {
    if (gridSettings.enabled) showSnapMarker({...pathPoints[0],kind:'endpoint'});
    return pathPoints[0];
  }
  return snapped;
}

const xy = ({x,y})=>[x,y];

function drawPathDraft(cursor) {
  const layer=$('#drawing-preview');
  layer.replaceChildren();
  if (!pathPoints.length) return;
  const vertices=pathPoints.map(xy);
  function draw(points, confirmed=false) {
    if (points.length<2) return;
    const el=document.createElementNS(svgNS,'polyline');
    el.setAttribute('points',points.map(([x,y])=>x+','+(stock.height-y)).join(' '));
    el.classList.add('drawing-live-preview');
    if (confirmed) el.classList.add('draft-confirmed');
    layer.append(el);
  }
  if (activeTool==='arc' && vertices.length===2 && cursor) {
    try {
      draw(arcThroughThreePoints(...vertices,xy(cursor)));
    } catch {
      draw([...vertices,xy(cursor)]);
    }
  } else {
    draw(vertices,activeTool==='polyline');
    if (cursor && distance(pathPoints.at(-1),cursor)>1e-7) draw([vertices.at(-1),xy(cursor)]);
  }
  pathPoints.forEach((point,index)=>{
    const marker=document.createElementNS(svgNS,'circle');
    marker.setAttribute('cx',point.x);
    marker.setAttribute('cy',stock.height-point.y);
    marker.setAttribute('r',(index===0?3.5:2.5)/Math.max(view.scale,.01));
    marker.classList.add('draft-vertex');
    if (!index) marker.classList.add('draft-first-vertex');
    layer.append(marker);
  });
}

function finishPolyline(closed) {
  if (activeTool!=='polyline' || pathPoints.length<(closed?3:2)) return;
  add({kind:closed?'polygon':'polyline',points:pathPoints.map(xy)});
  setTool('select');
}

function placePathPoint(raw) {
  const point=pathPoint(raw);
  if (activeTool==='arc' && pathPoints.length===2) {
    try {
      const points=arcThroughThreePoints(xy(pathPoints[0]),xy(pathPoints[1]),xy(point));
      add({kind:'polyline',points});
      setTool('select');
    } catch (error) {
      updatePathPanel(error.message);
    }
    return;
  }
  if (activeTool==='polyline' && pathPoints.length>=3 && distance(pathPoints[0],point)<1e-7) {
    finishPolyline(true);
    return;
  }
  if (pathPoints.length && distance(pathPoints.at(-1),point)<1e-7) return;
  pathPoints.push(point);
  drawPathDraft();
  updatePathPanel();
}

function handlePathKey(event) {
  if (!pathTools.has(activeTool) || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key==='Escape') {
    setTool('select');
  } else if (event.key==='Backspace') {
    pathPoints.pop();
    showSnapMarker(null);
    drawPathDraft();
    updatePathPanel();
  } else if (event.key==='Enter' && activeTool==='polyline' && !event.target.closest('button')) {
    finishPolyline(false);
  } else {
    return false;
  }
  event.preventDefault();
  return true;
}

let textShapeKey='',textShapePromise=null,textPreviewToken=0;
function setTextFontSelection(value){const select=$('#text-font');if(value.startsWith('imported:')&&!importedFontRecords.has(value)){pendingTextFontValue=value;select.value='anton';return}pendingTextFontValue='';if(Array.from(select.options).some(item=>item.value===value))select.value=value;else select.value='anton'}
const FONT_DB_NAME='carve-studio-font-library',FONT_DB_VERSION=1;
function openFontDatabase(){return new Promise((resolve,reject)=>{const request=indexedDB.open(FONT_DB_NAME,FONT_DB_VERSION);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('fonts'))request.result.createObjectStore('fonts',{keyPath:'id'})};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
async function readImportedFontRecords(){const db=await openFontDatabase();return new Promise((resolve,reject)=>{const request=db.transaction('fonts','readonly').objectStore('fonts').getAll();request.onsuccess=()=>{db.close();resolve(request.result||[])};request.onerror=()=>{db.close();reject(request.error)}})}
async function saveImportedFontRecord(record){const db=await openFontDatabase();return new Promise((resolve,reject)=>{const request=db.transaction('fonts','readwrite').objectStore('fonts').put(record);request.onsuccess=()=>{db.close();resolve()};request.onerror=()=>{db.close();reject(request.error)}})}
async function deleteImportedFontRecords(ids){if(!ids.length)return;const db=await openFontDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction('fonts','readwrite'),store=tx.objectStore('fonts');for(const id of ids)store.delete(id);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)};tx.onabort=()=>{db.close();reject(tx.error||Error('Could not remove duplicate font entries.'))}})}
function sameFontData(left,right){const a=new Uint8Array(left),b=new Uint8Array(right);if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true}
function appendImportedFontOption(record){const key=`imported:${record.id}`,group=$('#imported-font-options');group.hidden=false;let option=Array.from(group.children).find(item=>item.value===key);if(!option){option=document.createElement('option');option.value=key;option.textContent=`${record.name} · imported`;group.append(option)}return key}
async function restoreImportedFonts(){try{const records=await readImportedFontRecords(),requested=pendingTextFontValue||$('#text-font').value,requestedId=requested.startsWith('imported:')?requested.slice('imported:'.length):'',unique=[],duplicates=[];for(const record of records){const index=unique.findIndex(item=>sameFontData(item.data,record.data));if(index<0)unique.push(record);else if(record.id===requestedId){duplicates.push(unique[index].id);unique[index]=record}else duplicates.push(record.id)}await deleteImportedFontRecords(duplicates);for(const record of unique){try{const font=parseOpenType(record.data);const key=appendImportedFontOption(record);textFontCache.set(key,font);importedFontRecords.set(key,record)}catch(error){console.warn(`Could not restore imported font ${record.name}:`,error)}}if(requested.startsWith('imported:')&&importedFontRecords.has(requested)){$('#text-font').value=requested;pendingTextFontValue='';queueSessionSave()}if(!unique.length)$('#font-import-status').textContent='Import a TTF or OTF font to add it to this gSender profile.'}catch(error){$('#font-import-status').textContent=`Could not open the saved font library: ${error?.message||error}`}}
async function importFontFile(file){if(!file)return;const status=$('#font-import-status');try{const data=await file.arrayBuffer(),font=parseOpenType(data),sample=font.getPath('Aa0',0,0,1000);if(!sample.commands.some(command=>['L','Q','C'].includes(command.type)))throw Error('This font does not contain usable vector outlines.');const name=font.names.fullName?.en||font.names.fontFamily?.en||file.name.replace(/\.(ttf|otf)$/i,''),existing=[...importedFontRecords.entries()].find(([,record])=>sameFontData(record.data,data));if(existing){$('#text-font').value=existing[0];pendingTextFontValue='';status.textContent=`${name} is already imported; using the existing font entry.`;queueSessionSave();return}const id=globalThis.crypto?.randomUUID?.()||`font-${Date.now()}-${Math.random().toString(36).slice(2,10)}`,record={id,name,fileName:file.name,data};await saveImportedFontRecord(record);const key=appendImportedFontOption(record);textFontCache.set(key,font);importedFontRecords.set(key,record);pendingTextFontValue='';$('#text-font').value=key;status.textContent=`${name} imported and saved for this gSender profile.`;queueSessionSave()}catch(error){status.textContent=`Could not import ${file.name}: ${error?.message||error}. Use a TrueType or OpenType outline font.`}}
async function loadReliefSvgFont(){if(reliefSvgFontCache)return reliefSvgFontCache;const response=await fetch(reliefSvgFontUrl);if(!response.ok)throw Error(`Relief SingleLine font file could not be loaded (${response.status}).`);const xml=new DOMParser().parseFromString(await response.text(),'image/svg+xml');if(xml.querySelector('parsererror'))throw Error('The bundled Relief SingleLine SVG font could not be parsed.');const ns=svgNS,fontElement=xml.getElementsByTagNameNS(ns,'font')[0],face=xml.getElementsByTagNameNS(ns,'font-face')[0];if(!fontElement||!face)throw Error('The bundled Relief SingleLine SVG font is missing its glyph table.');const glyphs=new Map;for(const glyph of fontElement.getElementsByTagNameNS(ns,'glyph')){const unicode=glyph.getAttribute('unicode');if(unicode)glyphs.set(unicode,{d:glyph.getAttribute('d')||'',advance:Number(glyph.getAttribute('horiz-adv-x'))||Number(fontElement.getAttribute('horiz-adv-x'))||600})}reliefSvgFontCache={glyphs,capHeight:Number(face.getAttribute('cap-height'))||Number(face.getAttribute('ascent'))||700,defaultAdvance:Number(fontElement.getAttribute('horiz-adv-x'))||600};return reliefSvgFontCache}
async function makeReliefTextShape(text,height){const font=await loadReliefSvgFont(),scale=height/font.capHeight,baseline=font.capHeight*scale,contours=[];let cursor=0;for(const char of text){const glyph=font.glyphs.get(char)||font.glyphs.get(char.toUpperCase())||font.glyphs.get(' ');if(!glyph)continue;const parts=(glyph.d.match(/[Mm][^Mm]*/g)||[]).map(d=>d.trim()).filter(Boolean);for(const d of parts)contours.push({d,closed:false,centerline:true,xOffset:cursor*scale,baseline,scale,scaleY:-scale});cursor+=glyph.advance||font.defaultAdvance}if(!contours.length)throw Error('No Relief SingleLine outlines were found for this text.');return{contours,height,text,fontName:'relief',centerlineFont:true}}
function getBlockTextShape(){const raw=$('#text-content').value.replace(/\s+/g,' ').trim(),height=Number($('#text-size').value),fontName=$('#text-font').value;if(!raw)throw Error('Enter text before placing it.');if(!Number.isFinite(height)||height<2||height>500)throw Error('Text height must be between 2 and 500 mm.');const key=JSON.stringify([raw,height,fontName]);if(key===textShapeKey&&textShapePromise)return textShapePromise;textShapeKey=key;textShapePromise=(async()=>{let font=textFontCache.get(fontName);if(fontName==='relief'||/relief\s*single.?line/i.test(font?.names?.fontFamily?.en||''))return makeReliefTextShape(raw,height);if(!font){const url=textFontUrls[fontName];if(!url)throw Error('The selected font is not bundled with Carve Studio.');const response=await fetch(url);if(!response.ok)throw Error(`Font file could not be loaded (${response.status}).`);font=parseOpenType(await response.arrayBuffer());textFontCache.set(fontName,font)}const text=fontName==='bebas'?raw.toUpperCase():raw,path=font.getPath(text,0,0,1000),box=path.getBoundingBox(),glyphHeight=box.y2-box.y1;if(!Number.isFinite(glyphHeight)||glyphHeight<=0)throw Error('This text has no printable characters.');const scale=height/glyphHeight,contours=[];let commands=[];for(const command of path.commands){if(command.type==='M'&&commands.length){contours.push(commands);commands=[]}commands.push(command)}if(commands.length)contours.push(commands);const fmt=n=>Number(n.toFixed(4)).toString(),toData=contour=>contour.map(c=>{if(c.type==='M'||c.type==='L')return`${c.type}${fmt((c.x-box.x1)*scale)} ${fmt((c.y-box.y1)*scale)}`;if(c.type==='Q')return`Q${fmt((c.x1-box.x1)*scale)} ${fmt((c.y1-box.y1)*scale)} ${fmt((c.x-box.x1)*scale)} ${fmt((c.y-box.y1)*scale)}`;if(c.type==='C')return`C${fmt((c.x1-box.x1)*scale)} ${fmt((c.y1-box.y1)*scale)} ${fmt((c.x2-box.x1)*scale)} ${fmt((c.y2-box.y1)*scale)} ${fmt((c.x-box.x1)*scale)} ${fmt((c.y-box.y1)*scale)}`;if(c.type==='Z')return'Z';return''}).join(' '),contourData=contours.map(commands=>{const d=toData(commands);return{d:/[Zz]$/.test(d)?d:d+" Z",closed:true}}).filter(item=>/[LQC]/.test(item.d));if(!contourData.length)throw Error('No vector outlines were generated for this text.');const family=font.names?.fontFamily?.en||'',centerlineFont=fontName==='relief'||/relief\s*single.?line/i.test(family);return{contours:contourData,height,text,fontName,centerlineFont}})().catch(error=>{if(key===textShapeKey)textShapePromise=null;throw error});return textShapePromise}
async function updateTextPreview(anchor){const token=++textPreviewToken,layer=$('#drawing-preview');layer.replaceChildren();try{const shape=await getBlockTextShape();if(token!==textPreviewToken||drag?.mode!=='text-place')return;const group=document.createElementNS(svgNS,'g');group.setAttribute('transform',`translate(${anchor.x} ${stock.height-anchor.y})`);for(const contour of shape.contours){const path=document.createElementNS(svgNS,'path');path.setAttribute('d',contour.d);if(contour.centerline)path.setAttribute('transform','translate('+contour.xOffset+' '+contour.baseline+') scale('+contour.scale+' '+contour.scaleY+')');path.setAttribute('class','drawing-live-preview');group.append(path)}layer.append(group)}catch(error){if(token===textPreviewToken)profileStatus(`Could not preview text: ${error?.message||error}`,true)}}
async function commitBlockTextAt(anchor){const token=++textPreviewToken;$('#drawing-preview').replaceChildren();try{const shape=await getBlockTextShape();if(token!==textPreviewToken)return;remember();selectedIds.clear();const textGroupId=`text-${Date.now()}-${nextId}`;for(const contour of shape.contours){const o={id:nextId++,kind:'path',d:contour.d,dx:anchor.x+(contour.xOffset||0),dy:stock.height-anchor.y+(contour.baseline||0),ox:0,oy:0,sx:contour.scale||1,sy:contour.scaleY??1,layer:activeLayer,textGroupId,textFont:shape.fontName,centerlineFont:shape.centerlineFont,outlineClosed:contour.closed};objects.push(o);selectedIds.add(o.id)}redraw();profileStatus(`Placed ${shape.contours.length} editable text outline${shape.contours.length===1?'':'s'} at ${shape.height} mm height.`);setTool('select')}catch(error){profileStatus(`Could not create text: ${error?.message||error}`,true)}}
function generateSingleLineVGroove(items,s){if(items.some(o=>!o.centerlineFont))throw Error('Generate single-line text separately from outlined shapes.');const strokes=items.map(o=>geometryPoints(o).filter((p,i,all)=>!i||distance(p,all[i-1])>.001)).filter(points=>points.length>1).map(points=>points.map(p=>({...p,z:s.vgrooveMaxDepth})));if(!strokes.length)throw Error('The selected CNC font did not produce any usable stroke paths.');const paths=optimizeGrooveOrder(strokes,{x:0,y:0});profileSettings=s;const lines=['(Carve Studio V Groove Profile - single-line font)','(Relief SingleLine vector strokes; drag the V-bit along each centerline.)',`(V-bit included angle ${s.vgrooveAngle} degrees; constant centerline depth ${s.vgrooveMaxDepth.toFixed(3)} mm; groove width depends on the bit angle.)`,'G21 G90 G17 G94',`G0 Z${s.safeZ.toFixed(3)}`,`M3 S${Math.round(s.rpm)}`];for(const path of paths){const start=path[0];lines.push(`G0 Z${s.safeZ.toFixed(3)}`,`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}`,`G1 Z-${s.vgrooveMaxDepth.toFixed(3)} F${s.plunge.toFixed(1)}`);for(const p of path.slice(1))lines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z-${s.vgrooveMaxDepth.toFixed(3)} F${s.feed.toFixed(1)}`)}lines.push(`G0 Z${s.safeZ.toFixed(3)}`,'M5','M30');generatedGcode=lines.join('\n')+'\n';profileContours=paths;generatedOperation='vgroove';const layer=$('#toolpath-preview');layer.replaceChildren();for(const path of paths){const el=document.createElementNS(svgNS,'polyline');el.setAttribute('points',path.map(p=>`${p.x},${stock.height-p.y}`).join(' '));el.setAttribute('class','cam-vgroove-path');layer.append(el)}$('#gcode-preview').value=generatedGcode;$('#gcode-preview').hidden=false;$('#save-gcode').disabled=false;$('#load-visualizer').disabled=false;profileStatus(`V Groove preview ready · ${paths.length} single-line stroke paths · constant depth ${s.vgrooveMaxDepth.toFixed(2)} mm. Simulate before cutting.`)}
function nearestObjectAt(p){let best=null,bestDistance=24/Math.max(view.scale,.01);for(const o of objects){if(hiddenLayers.has(o.layer))continue;const b=boundsOf([o]);if(!b)continue;const dx=Math.max(b.minX-p.x,0,p.x-b.maxX),dy=Math.max(b.minY-p.y,0,p.y-b.maxY);if(Math.hypot(dx,dy)>bestDistance)continue;const pts=geometryPoints(o);for(let i=1;i<pts.length;i++){const a=pts[i-1],c=pts[i],vx=c.x-a.x,vy=c.y-a.y,len2=vx*vx+vy*vy,t=len2?Math.max(0,Math.min(1,((p.x-a.x)*vx+(p.y-a.y)*vy)/len2)):0,d=Math.hypot(p.x-a.x-t*vx,p.y-a.y-t*vy);if(d<bestDistance){bestDistance=d;best=o}}}return best}
function selectedAreaParts() {
  return selectedRegion?.type==='multiple' ? selectedRegion.parts : selectedRegion ? [selectedRegion] : [];
}

function unionRegionContours(regions) {
  if (regions.length<2) return regions[0] || [];
  const scale=1000;
  const {Clipper,ClipType,PolyFillType,PolyType}=ClipperLib;
  const union=new Clipper();
  for (const contours of regions) {
    const paths=contours.map(points=>points.map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)})));
    const region=new Clipper();
    region.AddPaths(paths,PolyType.ptSubject,true);
    const normalized=new ClipperLib.Paths();
    region.Execute(ClipType.ctUnion,normalized,PolyFillType.pftEvenOdd,PolyFillType.pftEvenOdd);
    union.AddPaths(normalized,PolyType.ptSubject,true);
  }
  const output=new ClipperLib.Paths();
  union.Execute(ClipType.ctUnion,output,PolyFillType.pftNonZero,PolyFillType.pftNonZero);
  return output.map(ring=>ring.map(({X,Y})=>({x:X/scale,y:Y/scale})));
}

function setSelectedAreas(parts) {
  if (parts.length<2) {
    selectedRegion=parts[0] || null;
    return;
  }
  selectedRegion={
    type:'multiple',parts,ids:[...new Set(parts.flatMap(part=>part.ids))],
    contours:unionRegionContours(parts.map(part=>part.contours)),
  };
}

function sameArea(a,b) {
  const left=a.outerIds || a.ids, right=b.outerIds || b.ids;
  return left.length===right.length && left.every(id=>right.includes(id));
}

function selectionChanged() {
  const selectionDriven=generatedOperation==='vgroove' || generatedOperation==='vgroove-flat' || generatedOperation==='pocket' ||
    (generatedOperation==='profile' && profileSettings.scope==='selected') ||
    (generatedOperation==='drill' && profileSettings.drillScope==='selected');
  if (selectionDriven && generatedGcode) clearProfilePreview('Selection changed. Generate the toolpath preview again.');
  redraw();
}

function selectAt(p,additive=false) {
  const region=enclosedRegionAt(p);
  const item=region ? null : nearestObjectAt(p);
  if (!additive) {
    selectedIds=new Set(region?.ids || (item ? [item.id] : []));
    selectedRegion=region;
  } else if (region) {
    const parts=selectedAreaParts();
    const existing=parts.find(part=>sameArea(part,region));
    if (existing) {
      const remaining=parts.filter(part=>part!==existing);
      for(const id of existing.ids) {
        if(!remaining.some(part=>part.ids.includes(id))) selectedIds.delete(id);
      }
      setSelectedAreas(remaining);
    } else {
      // A Shift-click within an already selected pocket toggles the clicked island.
      const parent=parts.filter(part=>part.type==='area' &&
        pointInsidePolygon(p,part.outerContour) &&
        region.outerContour.every(point=>pointInsidePolygon(point,part.outerContour)))
        .sort((a,b)=>polygonArea(a.outerContour)-polygonArea(b.outerContour))[0];
      if (parent) {
        const exclusions=parent.exclusions || [];
        const excluded=exclusions.find(part=>sameArea(part,region));
        parent.exclusions=excluded ? exclusions.filter(part=>part!==excluded) : [...exclusions,region];
        parent.contours=[parent.outerContour,...parent.exclusions.flatMap(part=>part.contours)];
        setSelectedAreas(parts);
      } else {
        for (const id of region.ids) selectedIds.add(id);
        setSelectedAreas([...parts,region]);
      }
    }
  } else if (item) {
    if (selectedIds.has(item.id)) {
      selectedIds.delete(item.id);
      setSelectedAreas(selectedAreaParts().filter(part=>!part.ids.includes(item.id)));
    } else selectedIds.add(item.id);
  }
  selectionChanged();
  return item || (region && objects.find(object=>region.ids.includes(object.id)));
}
function drawSelectionBox(a,b,crossing){const r=$('#selection-box');r.setAttribute('x',Math.min(a.x,b.x));r.setAttribute('y',stock.height-Math.max(a.y,b.y));r.setAttribute('width',Math.abs(b.x-a.x));r.setAttribute('height',Math.abs(b.y-a.y));r.setAttribute('class',`selection-box ${crossing?'crossing':'window'}`);r.setAttribute('visibility','visible')}
function pointInBox(p,r){return p.x>=r.minX&&p.x<=r.maxX&&p.y>=r.minY&&p.y<=r.maxY}
function segmentHitsBox(a,b,r){let lo=0,hi=1,dx=b.x-a.x,dy=b.y-a.y;for(const [p,q] of [[-dx,a.x-r.minX],[dx,r.maxX-a.x],[-dy,a.y-r.minY],[dy,r.maxY-a.y]]){if(Math.abs(p)<1e-12){if(q<0)return false;continue}const t=q/p;if(p<0){if(t>hi)return false;lo=Math.max(lo,t)}else{if(t<lo)return false;hi=Math.min(hi,t)}}return true}
function geometryPoints(o,pathStep=null){if(o.kind==='line')return[{x:o.x1,y:o.y1},{x:o.x2,y:o.y2}];if(o.kind==='rect'){const x1=Math.min(o.x1,o.x2),x2=Math.max(o.x1,o.x2),y1=Math.min(o.y1,o.y2),y2=Math.max(o.y1,o.y2);return[{x:x1,y:y1},{x:x2,y:y1},{x:x2,y:y2},{x:x1,y:y2},{x:x1,y:y1}]}if(o.kind==='circle'||o.kind==='ellipse'){const rx=o.kind==='circle'?o.r:o.rx,ry=o.kind==='circle'?o.r:o.ry,steps=Math.max(72,Math.min(720,Math.ceil(2*Math.PI*Math.max(rx,ry)/.5)));return Array.from({length:steps+1},(_,i)=>{const a=i*Math.PI*2/steps;return{x:o.cx+rx*Math.cos(a),y:o.cy+ry*Math.sin(a)}})}if(o.points)return o.kind==='polygon'?[...o.points.map(([x,y])=>({x,y})),{x:o.points[0][0],y:o.points[0][1]}]:o.points.map(([x,y])=>({x,y}));if(o.kind==='path'){const el=drawing.querySelector(`[data-id="${o.id}"]`);try{const length=el.getTotalLength(),worldScale=Math.max(Math.abs(o.sx||1),Math.abs(o.sy||1)),steps=pathStep?Math.max(32,Math.min(12000,Math.ceil(length*worldScale/pathStep))):Math.max(32,Math.min(600,Math.ceil(length/3))),ctm=el.getScreenCTM(),inv=root.getScreenCTM().inverse();return Array.from({length:steps+1},(_,i)=>{const p=el.getPointAtLength(length*i/steps),svg=canvas.createSVGPoint();svg.x=p.x;svg.y=p.y;const q=svg.matrixTransform(ctm).matrixTransform(inv);return{x:q.x,y:stock.height-q.y}})}catch{}}
 return[]}
function offsetOpenPoints(input,delta){const points=input.filter((p,i)=>!i||Math.hypot(p.x-input[i-1].x,p.y-input[i-1].y)>1e-6);if(points.length<2)return[];const normals=[];for(let i=1;i<points.length;i++){const dx=points[i].x-points[i-1].x,dy=points[i].y-points[i-1].y,len=Math.hypot(dx,dy);if(len<1e-9)continue;normals.push({x:-dy/len,y:dx/len})}if(normals.length!==points.length-1)return[];const result=[{x:points[0].x+normals[0].x*delta,y:points[0].y+normals[0].y*delta}];for(let i=1;i<points.length-1;i++){const a=normals[i-1],b=normals[i],sum={x:a.x+b.x,y:a.y+b.y},length=Math.hypot(sum.x,sum.y);if(length<1e-8){result.push({x:points[i].x+a.x*delta,y:points[i].y+a.y*delta},{x:points[i].x+b.x*delta,y:points[i].y+b.y*delta});continue}const unit={x:sum.x/length,y:sum.y/length},denom=unit.x*b.x+unit.y*b.y,miter=denom?delta/denom:Infinity;if(Math.abs(miter)>Math.abs(delta)*4){result.push({x:points[i].x+a.x*delta,y:points[i].y+a.y*delta},{x:points[i].x+b.x*delta,y:points[i].y+b.y*delta})}else result.push({x:points[i].x+unit.x*miter,y:points[i].y+unit.y*miter})}const end=points.at(-1),normal=normals.at(-1);result.push({x:end.x+normal.x*delta,y:end.y+normal.y*delta});return result}
function nativeOffset(object,distance) {
  if (object.kind==='rect') {
    const b = boundsOf([object]);
    if (b.width+2*distance<=0 || b.height+2*distance<=0) return null;
    return {...object,x1:b.minX-distance,y1:b.minY-distance,x2:b.maxX+distance,y2:b.maxY+distance};
  }
  const rx = (object.r ?? object.rx)+distance, ry = (object.r ?? object.ry)+distance;
  if (rx<=0 || ry<=0) return null;
  return object.kind==='circle' ? {...object,r:rx} : {...object,rx,ry};
}

function preciseRegionRings(part, visible) {
  const members = part.ids.map(id=>visible.get(id));
  if (!members.length || members.some(object=>!object || !hasClosedGeometry(object))) return part.contours;
  return [
    ...members.flatMap(object=>vectorRings(object,stock.height,geometryPoints)),
    ...(part.exclusions || []).flatMap(area=>preciseRegionRings(area,visible))
  ];
}

function createOffsetCopies() {
  const distance = $('#offset-distance').valueAsNumber;
  if (!Number.isFinite(distance) || Math.abs(distance)<1e-6) throw Error('Enter a non-zero offset distance.');
  const visible = new Map(objects.filter(object=>!hiddenLayers.has(object.layer)).map(object=>[object.id,object]));
  const selected = [...visible.values()].filter(object=>selectedIds.has(object.id));
  if (!selected.length) throw Error('Select one or more visible vectors to offset.');

  const plans = [], covered = new Set(), groups = new Map();
  let collapsed = 0;
  function planClosed(rings,layer) {
    const components = offsetVectorRegion(rings,distance);
    if (components.length) plans.push({components,layer});
    else collapsed++;
  }

  for (const part of selectedAreaParts()) {
    if (!part.ids.every(id=>selectedIds.has(id) && visible.has(id))) continue;
    const assembled = part.ids.length>1 && part.ids.some(id=>!hasClosedGeometry(visible.get(id)));
    if (!assembled && !part.exclusions?.length) continue;
    planClosed(preciseRegionRings(part,visible),activeLayer);
    for (const id of part.ids) covered.add(id);
  }

  const open = selected.filter(object=>!covered.has(object.id) && !hasClosedGeometry(object));
  if (open.length>1) {
    for (const boundary of enclosedRegionCandidates(open)) {
      if (boundary.ids.length<2 || boundary.ids.some(id=>covered.has(id))) continue;
      planClosed([boundary.points],activeLayer);
      for (const id of boundary.ids) covered.add(id);
    }
  }

  for (const object of selected) {
    if (covered.has(object.id)) continue;
    const layer = object.layer || 'Default';
    if (['rect','circle','ellipse'].includes(object.kind)) {
      const copy = nativeOffset(object,distance);
      if (copy) plans.push({copy});
      else collapsed++;
      continue;
    }

    const contours = object.kind==='path' ? vectorPathContours(object,stock.height)
      : [{points:geometryPoints(object),closed:hasClosedGeometry(object)}];
    for (const {points,closed} of contours) {
      if (points.length<2) continue;
      if (closed) {
        const key = outlineGroup(object) || object.id;
        if (!groups.has(key)) groups.set(key,{rings:[],layer});
        groups.get(key).rings.push(points);
        continue;
      }
      const offset = offsetOpenPoints(points,distance);
      if (offset.length<2) continue;
      const [first,last] = [offset[0],offset.at(-1)];
      const copy = object.kind==='line' ? {...object,x1:first.x,y1:first.y,x2:last.x,y2:last.y}
        : {kind:'polyline',points:offset.map(({x,y})=>[x,y]),layer};
      plans.push({copy});
    }
  }
  for (const {rings,layer} of groups.values()) planClosed(rings,layer);

  if (!plans.length) throw Error(collapsed ? 'That contraction collapses the selected outlines.' : 'No offset geometry could be created.');
  remember();
  const copies = plans.flatMap(({copy,components,layer})=>copy ? [{...copy,id:nextId++}] : closedPolygonCopies(components,layer));
  objects.push(...copies);
  selectedIds = new Set(copies.map(object=>object.id));
  redraw();
  const status = $('#offset-status');
  status.textContent = 'Created '+copies.length+' offset '+(copies.length===1?'vector':'vectors')+
    ' at '+(distance>0?'+':'')+distance.toFixed(2)+' mm.';
  if (collapsed) status.textContent += ' '+collapsed+' '+(collapsed===1?'outline collapsed.':'outlines collapsed.');
}

function pointPolylineDistance(point,points){let best=Infinity;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/len2)):0;best=Math.min(best,Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy))}return best}
function connectedSelectionIds(startId){const tolerance=.35,items=[];for(const o of objects){if(hiddenLayers.has(o.layer))continue;const points=geometryPoints(o);if(!points.length)continue;let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y)}items.push({o,points,minX,minY,maxX,maxY})}const start=items.find(item=>item.o.id===startId);if(!start)return new Set([startId]);const connected=new Set([startId]),queue=[start];while(queue.length){const current=queue.shift(),ends=[current.points[0],current.points.at(-1)];for(const candidate of items){if(connected.has(candidate.o.id))continue;const dx=Math.max(candidate.minX-current.maxX,0,current.minX-candidate.maxX),dy=Math.max(candidate.minY-current.maxY,0,current.minY-candidate.maxY);if(Math.hypot(dx,dy)>tolerance)continue;const candidateEnds=[candidate.points[0],candidate.points.at(-1)],touches=ends.some(p=>pointPolylineDistance(p,candidate.points)<=tolerance)||candidateEnds.some(p=>pointPolylineDistance(p,current.points)<=tolerance);if(touches){connected.add(candidate.o.id);queue.push(candidate)}}}return connected}
function polygonArea(points){let area=0;for(let i=0,j=points.length-1;i<points.length;j=i++)area+=points[j].x*points[i].y-points[i].x*points[j].y;return Math.abs(area/2)}
function pointInsidePolygon(p,points){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j],b=points[i],dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/len2)):0;if(Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)<.02)return false;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside}return inside}
function isOutlinedGlyph(object) {
  return object.kind==='path' && !!object.textGroupId && !!object.textFont && !object.centerlineFont;
}
function enclosedRegionCandidates(source=objects){const tolerance=.35,candidates=[],open=[];for(const o of source){if(hiddenLayers.has(o.layer)||o.centerlineFont)continue;const pts=isOutlinedGlyph(o)?machiningOutline(o):geometryPoints(o);if(pts.length<2)continue;const close=Math.hypot(pts[0].x-pts.at(-1).x,pts[0].y-pts.at(-1).y)<=tolerance,primitiveClosed=['rect','circle','ellipse','polygon'].includes(o.kind)||(o.kind==='polyline'&&o.points?.length>2&&Math.hypot(o.points[0][0]-o.points.at(-1)[0],o.points[0][1]-o.points.at(-1)[1])<.05)||isOutlinedGlyph(o)||(o.kind==='path'&&(o.outlineClosed||/[zZ]\s*$/.test(o.d.trim())));if(primitiveClosed||close){const loop=close?pts.slice(0,-1):pts.slice();if(loop.length>=3&&polygonArea(loop)>1e-5)candidates.push({ids:[o.id],points:loop,area:polygonArea(loop)});continue}if(['line','polyline','path'].includes(o.kind))open.push({o,points:pts})}
 const nodes=[],nodeAt=p=>{let i=nodes.findIndex(n=>Math.hypot(n.x-p.x,n.y-p.y)<=tolerance);if(i<0){i=nodes.length;nodes.push({x:p.x,y:p.y,edges:[]})}return i},edges=[];for(const item of open){const a=nodeAt(item.points[0]),b=nodeAt(item.points.at(-1));if(a===b)continue;const e={id:item.o.id,a,b,points:item.points};edges.push(e);nodes[a].edges.push(e);nodes[b].edges.push(e)}const visited=new Set();for(const first of edges){if(visited.has(first.id))continue;const component=[],queue=[first];while(queue.length){const e=queue.pop();if(visited.has(e.id))continue;visited.add(e.id);component.push(e);for(const node of [e.a,e.b])for(const next of nodes[node].edges)if(!visited.has(next.id))queue.push(next)}const nodeIds=new Set(component.flatMap(e=>[e.a,e.b]));if(component.length<2||[...nodeIds].some(i=>nodes[i].edges.length!==2))continue;const used=new Set(),points=[];let edge=first,current=first.a,start=current,closed=false;for(let step=0;step<component.length;step++){if(used.has(edge.id))break;used.add(edge.id);const forward=edge.a===current,part=forward?edge.points:edge.points.slice().reverse();for(const p of part)if(!points.length||Math.hypot(points.at(-1).x-p.x,points.at(-1).y-p.y)>.001)points.push({...p});current=forward?edge.b:edge.a;if(current===start){closed=true;break}edge=nodes[current].edges.find(candidate=>!used.has(candidate.id));if(!edge)break}if(closed&&used.size===component.length&&points.length>3&&Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<=tolerance){points.pop();const area=polygonArea(points);if(area>1e-5)candidates.push({ids:component.map(e=>e.id),points,area})}}
 return candidates}
function groupedOutlineRegion(outer, containing, candidates) {
  const groupsByVector=new Map(objects.map(object=>[object.id,outlineGroup(object)]));
  const group=groupsByVector.get(outer.ids[0]);
  if (!group) return null;
  const inGroup=candidate=>candidate.ids.every(id=>groupsByVector.get(id)===group);
  if (containing.filter(inGroup).length%2===0) return null;

  const children=candidates.filter(candidate=>candidate.area<outer.area && inGroup(candidate) &&
    pointInsidePolygon(candidate.points[0],outer.points));
  const counters=children.filter(candidate=>!children.some(parent=>parent.area>candidate.area &&
    pointInsidePolygon(candidate.points[0],parent.points)));
  return {
    type:'outline',ids:[...outer.ids,...counters.flatMap(counter=>counter.ids)],
    outerIds:outer.ids,outerContour:outer.points,contours:[outer.points,...counters.map(counter=>counter.points)],
  };
}
function enclosedRegionAt(p) {
  const candidates=enclosedRegionCandidates();
  const containing=candidates.filter(candidate=>pointInsidePolygon(p,candidate.points)).sort((a,b)=>a.area-b.area);
  const outer=containing[0];
  if (!outer) return null;
  return groupedOutlineRegion(outer,containing,candidates) || {
    type:'area',ids:outer.ids,outerIds:outer.ids,outerContour:outer.points,contours:[outer.points],exclusions:[],
  };
}
function pathMeasures(points){const cumulative=[0];for(let i=1;i<points.length;i++)cumulative.push(cumulative.at(-1)+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));return{cumulative,length:cumulative.at(-1)||0,closed:points.length>2&&Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)<.01}}

function pointAtPath(points,measures,distance){const d=measures.closed?((distance%measures.length)+measures.length)%measures.length:Math.max(0,Math.min(measures.length,distance));for(let i=1;i<points.length;i++)if(d<=measures.cumulative[i]+1e-8){const span=measures.cumulative[i]-measures.cumulative[i-1],t=span?Math.max(0,Math.min(1,(d-measures.cumulative[i-1])/span)):0;return{x:points[i-1].x+(points[i].x-points[i-1].x)*t,y:points[i-1].y+(points[i].y-points[i-1].y)*t}}return{...points.at(-1)}}
function slicePath(points,measures,start,end){const out=[pointAtPath(points,measures,start)],L=measures.length;for(let cycle=0;cycle<=(measures.closed?1:0);cycle++)for(let i=1;i<points.length;i++){const d=measures.cumulative[i]+cycle*L;if(d>start+1e-7&&d<end-1e-7)out.push({...points[i]})}const last=pointAtPath(points,measures,end);if(Math.hypot(out.at(-1).x-last.x,out.at(-1).y-last.y)>1e-7)out.push(last);return out}
function trimVectorAt(id,click){const target=objects.find(o=>o.id===id);if(!target)return;const points=geometryPoints(target);if(points.length<2)return;const m=pathMeasures(points);if(m.length<1e-6)return;let clickDistance=0,nearest=Infinity,walk=0;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy,t=len2?Math.max(0,Math.min(1,((click.x-a.x)*dx+(click.y-a.y)*dy)/len2)):0,qx=a.x+t*dx,qy=a.y+t*dy,d2=(click.x-qx)**2+(click.y-qy)**2,seg=Math.sqrt(len2);if(d2<nearest){nearest=d2;clickDistance=walk+t*seg}walk+=seg}
 const hits=[];for(const other of objects){if(other.id===id||hiddenLayers.has(other.layer))continue;const q=geometryPoints(other);if(q.length<2)continue;let d=0;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],len=Math.hypot(b.x-a.x,b.y-a.y);for(let j=1;j<q.length;j++){const hit=intersectSegments(a,b,q[j-1],q[j]);if(hit)hits.push({distance:m.cumulative[i-1]+hit.t*len,x:hit.x,y:hit.y})}d+=len}}
 hits.sort((a,b)=>a.distance-b.distance);const unique=[];for(const h of hits)if(!unique.length||Math.abs(h.distance-unique.at(-1).distance)>.02)unique.push(h);let pieces=[];if(m.closed){if(unique.length<2)return;let chosen=null;for(let i=0;i<unique.length;i++){const start=unique[i].distance,end=unique[(i+1)%unique.length].distance+(i===unique.length-1?m.length:0),d=clickDistance<start?clickDistance+m.length:clickDistance;if(d>start+1e-5&&d<end-1e-5){chosen={start,end};break}}if(!chosen)return;pieces=[slicePath(points,m,chosen.end,chosen.start+m.length)]}else{if(!unique.length)return;const cuts=[0,...unique.map(h=>h.distance),m.length].sort((a,b)=>a-b);let interval=-1;for(let i=0;i<cuts.length-1;i++)if(clickDistance>=cuts[i]-1e-5&&clickDistance<=cuts[i+1]+1e-5){interval=i;break}if(interval<0)return;const start=cuts[interval],end=cuts[interval+1];if(start>.01)pieces.push(slicePath(points,m,0,start));if(end<m.length-.01)pieces.push(slicePath(points,m,end,m.length))}
 pieces=pieces.filter(path=>path.length>1&&path.some((p,i)=>i>0&&Math.hypot(p.x-path[0].x,p.y-path[0].y)>.01));if(pieces.length===1&&pieces[0].length<2)return;remember();objects=objects.filter(o=>o.id!==id);selectedIds.delete(id);for(const path of pieces){const replacement={id:nextId++,kind:'polyline',points:path.map(p=>[p.x,p.y]),layer:target.layer||'Default'};objects.push(replacement);selectedIds.add(replacement.id)}redraw()}
function geometryTouchesBox(o,r){const pts=geometryPoints(o);if(pts.some(p=>pointInBox(p,r)))return true;for(let i=1;i<pts.length;i++)if(segmentHitsBox(pts[i-1],pts[i],r))return true;return false}
function finishMarquee(e){const m=drag,p=point(e),moved=Math.hypot(e.clientX-m.startClientX,e.clientY-m.startClientY)>4;if(moved){const crossing=e.clientX<m.startClientX,minX=Math.min(m.start.x,p.x),maxX=Math.max(m.start.x,p.x),minY=Math.min(m.start.y,p.y),maxY=Math.max(m.start.y,p.y),box={minX,maxX,minY,maxY};selectedIds=new Set(m.baseIds);for(const o of objects){if(hiddenLayers.has(o.layer))continue;const b=boundsOf([o]);if(!b)continue;const hit=crossing?b.maxX>=minX&&b.minX<=maxX&&b.maxY>=minY&&b.minY<=maxY:b.minX>=minX&&b.maxX<=maxX&&b.minY>=minY&&b.maxY<=maxY;if(hit&&(!crossing||geometryTouchesBox(o,box)))selectedIds.add(o.id)}}else if(!m.additive)selectedIds.clear();if(!m.additive)selectedRegion=null;$('#selection-box').setAttribute('visibility','hidden');drag=null;selectionChanged()}
function shift(o,dx,dy){if('x1'in o){o.x1+=dx;o.x2+=dx;o.y1+=dy;o.y2+=dy}if('cx'in o){o.cx+=dx;o.cy+=dy}if(o.points)o.points=o.points.map(([x,y])=>[x+dx,y+dy]);if(o.kind==='path'){o.dx=(o.dx||0)+dx;o.dy=(o.dy||0)-dy}}
function svgLengthMm(value,fallback){if(!value)return fallback;const match=String(value).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))(mm|cm|in|pt|pc|px)?$/i);if(!match)return fallback;const n=Number(match[1]),unit=(match[2]||'').toLowerCase(),factor={mm:1,cm:10,in:25.4,pt:25.4/72,pc:25.4/6,px:25.4/96};return factor[unit]?n*factor[unit]:fallback}
function parseSvg(text){const doc=new DOMParser().parseFromString(text,'image/svg+xml');if(doc.querySelector('parsererror'))throw Error('The SVG could not be parsed.');
 const vb=(doc.documentElement.getAttribute('viewBox')||'0 0 300 200').trim().split(/[ ,]+/).map(Number),w=vb[2]||300,h=vb[3]||200,mmW=svgLengthMm(doc.documentElement.getAttribute('width'),w),mmH=svgLengthMm(doc.documentElement.getAttribute('height'),h);
 const sx=mmW/w,sy=mmH/h,items=[];
 for(const e of doc.querySelectorAll('path,line,rect,circle,ellipse,polyline,polygon')){let o,tag=e.localName;
  if(tag==='line')o={kind:'line',x1:Number(e.getAttribute('x1'))*sx,y1:stock.height-Number(e.getAttribute('y1'))*sy,x2:Number(e.getAttribute('x2'))*sx,y2:stock.height-Number(e.getAttribute('y2'))*sy};
  if(tag==='rect')o={kind:'rect',x1:Number(e.getAttribute('x'))*sx,y1:stock.height-(Number(e.getAttribute('y'))+Number(e.getAttribute('height')))*sy,x2:(Number(e.getAttribute('x'))+Number(e.getAttribute('width')))*sx,y2:stock.height-Number(e.getAttribute('y'))*sy};
  if(tag==='circle')o={kind:'circle',cx:Number(e.getAttribute('cx'))*sx,cy:stock.height-Number(e.getAttribute('cy'))*sy,r:Number(e.getAttribute('r'))*(sx+sy)/2};
  if(tag==='ellipse')o={kind:'ellipse',cx:Number(e.getAttribute('cx'))*sx,cy:stock.height-Number(e.getAttribute('cy'))*sy,rx:Number(e.getAttribute('rx'))*sx,ry:Number(e.getAttribute('ry'))*sy};
  if(tag==='polyline'||tag==='polygon'){const nums=(e.getAttribute('points').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)||[]).map(Number),pts=[];for(let i=0;i+1<nums.length;i+=2)pts.push([nums[i]*sx,stock.height-nums[i+1]*sy]);o={kind:tag,points:pts}}
  if(tag==='path'){const d=e.getAttribute('d');o={kind:'path',d,sx,sy,ox:-vb[0]*sx,oy:-vb[1]*sy}}
  if(o)items.push(o);
 }
 return items;
}
$('#import-button').onclick = () => {
  if (!registration.canImportDrawing()) return registration.openRegistration();
  $('#file-input').click();
};
$('#file-input').onchange = async event => {
  const input = event.target, drawingFile = input.files[0];
  try {
    if (!drawingFile) return;
    if (!registration.canImportDrawing()) return registration.openRegistration();
    const text = await drawingFile.text(), ext = drawingFile.name.split('.').pop().toLowerCase();
    const items = ext === 'svg' ? parseSvg(text) : ext === 'dxf' ? parseDxf(text) : [];
    if (!items.length) {
      throw Error('No supported vector entities found. SVG paths, lines, circles, ellipses, rectangles and polylines are supported. DXF LINE, CIRCLE, ARC and LWPOLYLINE entities are supported.');
    }
    remember();
    const firstImport = objects.length === 0;
    for (const item of items) {
      item.layer ||= drawingFile.name.replace(/\.[^.]+$/, '');
      item.id = nextId++;
    }
    objects.push(...items);
    if (firstImport && !stockManuallySet) sizeStockToFirstImport(items);
    selectedIds.clear();
    resizeBoard();
    fitView();
    redraw();
  } catch (error) {
    alert(error.message);
  } finally {
    input.value = '';
  }
};
const stockChanged=e=>{const width=Math.max(1,Number($('#stock-width').value)||300),height=Math.max(1,Number($('#stock-height').value)||200),thickness=Math.max(.1,Number($('#stock-thickness').value)||18),oldThickness=stock.thickness;remember();if(thickness!==oldThickness){for(const[op,ratio]of Object.entries({profile:1,drill:1,vgroove:.3,'vgroove-flat':.3,pocket:.5})){const depth=profileSettings.operations[op].depth;if(Math.abs(depth-oldThickness*ratio)<.051)profileSettings.operations[op].depth=thickness*ratio}}stock.width=width;stock.height=height;stock.thickness=thickness;if(e.target.id==='stock-width'||e.target.id==='stock-height'){stockManuallySet=true;$('#auto-stock-size').checked=false}$('#stock-width').value=width;$('#stock-height').value=height;$('#stock-thickness').value=thickness;setProfileFields();resizeBoard();fitView();queueSessionSave()};$('#stock-width').onchange=stockChanged;$('#stock-height').onchange=stockChanged;$('#stock-thickness').onchange=stockChanged;$('#auto-stock-size').onchange=()=>{remember();stockManuallySet=!$('#auto-stock-size').checked;queueSessionSave()};
$('#delete-selected').onclick=()=>{if(!selectedIds.size)return;remember();objects=objects.filter(o=>!selectedIds.has(o.id));selectedIds.clear();redraw()};
function duplicateObjects(originals) {
  const copies = structuredClone(originals);
  const prefix = 'copy-'+nextId+'-';
  for (const object of copies) {
    object.id = nextId++;
    if (object.outlineGroupId) object.outlineGroupId = prefix+object.outlineGroupId;
  }
  return copies;
}
$('#duplicate-selected').onclick=()=>{const originals=objects.filter(o=>selectedIds.has(o.id));if(!originals.length)return;remember();const copies=duplicateObjects(originals);for(const o of copies)shift(o,10,10);objects.push(...copies);selectedIds=new Set(copies.map(o=>o.id));redraw()};
$('#apply-offset').onclick=()=>{try{createOffsetCopies()}catch(error){$('#offset-status').textContent='';showWorkspaceError(error?.message||String(error))}};
const editGrid=$('.edit-grid');
editGrid.addEventListener('focusin',()=>{if(transformEdit)return;const ids=[...selectedIds],items=objects.filter(o=>selectedIds.has(o.id)),bounds=boundsOf(items);if(!bounds)return;transformEdit={ids,objects:JSON.parse(JSON.stringify(objects)),bounds,undoRecorded:false}});
editGrid.addEventListener('input',()=>{if(!transformEdit)return;const values=['edit-x','edit-y','edit-width','edit-height'].map(id=>$('#'+id).value.trim());if(values.some(value=>value===''))return;const [x,y,w,h]=values.map(Number);if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0)return;const source=transformEdit,baseline=source.objects,items=baseline.filter(o=>source.ids.includes(o.id)),b=source.bounds;if(!items.length)return;if(!source.undoRecorded){remember();source.undoRecorded=true}objects=JSON.parse(JSON.stringify(baseline));const liveItems=objects.filter(o=>source.ids.includes(o.id));if(liveItems.length===1&&liveItems[0].kind==='circle'){const o=liveItems[0],rx=w/2,ry=h/2;o.cx=x;o.cy=y;if(Math.abs(rx-ry)<1e-6){o.kind='circle';o.r=rx;delete o.rx;delete o.ry}else{o.kind='ellipse';o.rx=rx;o.ry=ry;delete o.r}}else{const positionUnchanged=Math.abs(x-b.minX)<.05&&Math.abs(y-b.minY)<.05;if(liveItems.length===1&&positionUnchanged&&liveItems[0].kind==='rect'){const o=liveItems[0];o.x1=b.minX;o.y1=b.minY;o.x2=b.minX+w;o.y2=b.minY+h}else if(liveItems.length===1&&positionUnchanged&&liveItems[0].kind==='line'){const o=liveItems[0],sx=o.x2<o.x1?-1:1,sy=o.y2<o.y1?-1:1;o.x2=o.x1+sx*w;o.y2=o.y1+sy*h}else transformItems(liveItems,b,{x,y,width:w,height:h})}redraw()});
editGrid.addEventListener('focusout',e=>{if(!editGrid.contains(e.relatedTarget)){transformEdit=null;redraw()}});
$('#center-on-stock').onclick=()=>{const items=objects.filter(o=>selectedIds.has(o.id)),b=boundsOf(items);if(!b)return;remember();const dx=stock.width/2-(b.minX+b.maxX)/2,dy=stock.height/2-(b.minY+b.maxY)/2;for(const o of items)shift(o,dx,dy);redraw()};
function mirrorObjects(items,b,horizontal){for(const o of items){const point=(x,y)=>horizontal?[b.minX+b.maxX-x,y]:[x,b.minY+b.maxY-y];if(o.kind==='path'){const fx=horizontal?-1:1,fy=horizontal?1:-1,tx=horizontal?b.minX+b.maxX:0,ty=horizontal?0:2*stock.height-b.minY-b.maxY;o.dx=fx*((o.dx||0)+(o.ox||0))+tx;o.dy=fy*((o.dy||0)+(o.oy||0))+ty;o.ox=0;o.oy=0;o.sx=(o.sx||1)*fx;o.sy=(o.sy||1)*fy}else if(o.kind==='line'||o.kind==='rect'){[o.x1,o.y1]=point(o.x1,o.y1);[o.x2,o.y2]=point(o.x2,o.y2)}else if(o.kind==='circle'||o.kind==='ellipse'){[o.cx,o.cy]=point(o.cx,o.cy)}if(o.points)o.points=o.points.map(([x,y])=>point(x,y))}}
function projectCenterBounds(){return{minX:0,maxX:stock.width,minY:0,maxY:stock.height}}
function mirrorSelection(horizontal){const items=objects.filter(o=>selectedIds.has(o.id));if(!items.length)return;remember();mirrorObjects(items,projectCenterBounds(),horizontal);redraw()}
function duplicateMirrored(horizontal){const originals=objects.filter(o=>selectedIds.has(o.id));if(!originals.length)return;remember();const copies=duplicateObjects(originals);objects.push(...copies);selectedIds=new Set(copies.map(o=>o.id));mirrorObjects(copies,projectCenterBounds(),horizontal);redraw()}
function selectedOperationTool(op) {
  const tool = readTool(profileSettings.tools?.[op]);
  return tool?.type === OPERATION_TOOL_TYPES[op] ? tool : null;
}

const rateFields = ['feed','plunge','rpm'];

function renderToolSelectors() {
  for (const [op,type] of Object.entries(OPERATION_TOOL_TYPES)) {
    const select = $('#'+op+'-tool');
    const current = selectedOperationTool(op);
    const choices = toolLibrary.tools.filter(tool=>tool.type===type);
    const matching = current && choices.some(tool=>JSON.stringify(tool)===JSON.stringify(current));
    select.replaceChildren(new Option(op==='vgroove-flat'?'Select a V-bit':'Manual settings',''), ...choices.map(tool=>new Option(toolLabel(tool),tool.id)));
    if (current && !matching) select.add(new Option('Saved · '+toolLabel(current),'saved'));
    select.value = current ? (matching ? current.id : 'saved') : '';
    const rates = $('#'+op+'-rates');
    const summary = rates.querySelector('summary');
    const manual = !current && op!=='vgroove-flat';
    if (summary.hidden !== manual) rates.open = manual;
    summary.hidden = manual;
    summary.querySelector('.cam-rates-modified').hidden = !current || !rateFields.some(key=>
      Number($('#'+operationInputId(op,key)).value) !== current[key]);
  }
  const profileTool = selectedOperationTool('profile');
  $('#profile-tool-empty').hidden = !!profileTool || toolLibrary.tools.some(tool=>tool.type===OPERATION_TOOL_TYPES.profile);
  $('#profile-diameter-field').hidden = $('#profile-side').value === 'on';
  $('#profile-tool-diameter').disabled = !!profileTool;
  $('#pocket-tool-diameter').disabled = !!selectedOperationTool('pocket');
  $('#vgroove-angle').disabled = !!selectedOperationTool('vgroove');
  const clearance = $('#vgroove-clearance-tool');
  const saved = readTool(profileSettings.vgrooveClearanceTool);
  const endmills = toolLibrary.tools.filter(tool=>tool.type==='endmill');
  const matching = saved && endmills.some(tool=>JSON.stringify(tool)===JSON.stringify(saved));
  clearance.replaceChildren(new Option('V-bit only',''),...endmills.map(tool=>new Option(toolLabel(tool),tool.id)));
  if (saved && !matching) clearance.add(new Option('Saved · '+toolLabel(saved),'saved'));
  clearance.value = saved ? (matching ? saved.id : 'saved') : '';
}

function applyToolPreset(op,value) {
  if (value==='saved') return;
  const tool = toolLibrary.tools.find(item=>item.id===value && item.type===OPERATION_TOOL_TYPES[op]);
  profileSettings.tools = {...profileSettings.tools,[op]:tool || null};
  if (tool) {
    for (const key of [...rateFields,'stepdown']) {
      if (tool[key] !== null) $('#'+operationInputId(op,key)).value = tool[key];
    }
    if (op==='profile') $('#profile-tool-diameter').value = tool.diameter;
    if (op==='pocket') $('#pocket-tool-diameter').value = tool.diameter;
    if (op==='vgroove') $('#vgroove-angle').value = tool.angle;
  }
  updateToolpathSettings();
}

function operationInputId(op,key){if(op==='vgroove'&&key==='depth')return'vgroove-max-depth';return`${op}-${key==='safeZ'?'safez':key}`}
function setProfileFields(){const ids={scope:'profile-scope',profileSide:'profile-side',profileToolDiameter:'profile-tool-diameter',drillScope:'drill-scope',profileTabCount:'profile-tab-count',profileTabWidth:'profile-tab-width',profileTabHeight:'profile-tab-height',vgrooveAngle:'vgroove-angle',pocketToolDiameter:'pocket-tool-diameter'};for(const [key,id] of Object.entries(ids)) $('#'+id).value=profileSettings[key];
  for (const [op,key,id] of [['profile','diameter','profile-tool-diameter'],['pocket','diameter','pocket-tool-diameter'],['vgroove','angle','vgroove-angle']]) {
    const tool = selectedOperationTool(op);
    if (tool) $('#'+id).value=tool[key];
  }
for(const op of Object.keys(profileSettings.operations))for(const key of Object.keys(profileSettings.operations[op]))$('#'+operationInputId(op,key)).value=profileSettings.operations[op][key];$('#pocket-overlap').value=profileSettings.pocketOverlap??50;$('#vgroove-singleline').checked=profileSettings.vgrooveSingleLine===true;$('#optimize-moves').checked=profileSettings.optimizeMoves!==false;$('#profile-through-stock').checked=profileSettings.profileThroughStock!==false;renderToolSelectors()}
function readProfileFields(){const operations={};for(const op of Object.keys(OPERATION_TOOL_TYPES)){operations[op]={};for(const key of Object.keys(profileSettings.operations[op]))operations[op][key]=Number($('#'+operationInputId(op,key)).value)}const current=operations[activeToolpathOperation]||operations.profile,pocketStepover=Number($('#pocket-tool-diameter').value)*(1-Number($('#pocket-overlap').value)/100);return{scope:$('#profile-scope').value,profileSide:$('#profile-side').value,profileToolDiameter:Number($('#profile-tool-diameter').value),tools:profileSettings.tools,drillScope:$('#drill-scope').value,...current,depth:current.depth,stepdown:current.stepdown,safeZ:current.safeZ,feed:current.feed,plunge:current.plunge,rpm:current.rpm,operations,optimizeMoves:$('#optimize-moves').checked,profileThroughStock:$('#profile-through-stock').checked,profileTabCount:Number($('#profile-tab-count').value),profileTabWidth:Number($('#profile-tab-width').value),profileTabHeight:Number($('#profile-tab-height').value),vgrooveAngle:Number($('#vgroove-angle').value),vgrooveMaxDepth:operations.vgroove.depth,vgrooveSingleLine:$('#vgroove-singleline').checked,vgrooveClearanceTool:profileSettings.vgrooveClearanceTool,pocketToolDiameter:Number($('#pocket-tool-diameter').value),pocketOverlap:Number($('#pocket-overlap').value),pocketStepover}}
function hasClosedGeometry(o){return isOutlinedGlyph(o)||['rect','circle','ellipse','polygon'].includes(o.kind)||(o.kind==='polyline'&&o.points?.length>2&&Math.hypot(o.points[0][0]-o.points.at(-1)[0],o.points[0][1]-o.points.at(-1)[1])<.05)||(o.kind==='path'&&(o.outlineClosed||/[zZ]\s*$/.test(o.d.trim())))}
function isClosedVector(o){return hasClosedGeometry(o)||!!selectedRegion?.ids.includes(o.id)}
function pocketContours(chosen) {
  return grooveOutlines(chosen).map(outline=>{
    const raw=distance(outline[0],outline.at(-1))>.001 ? [...outline,outline[0]] : outline;
    const points=[];
    for (let i=1;i<raw.length;i++) {
      const a=raw[i-1],b=raw[i],count=Math.max(1,Math.ceil(distance(a,b)/.25));
      for (let j=0;j<count;j++) points.push({x:a.x+(b.x-a.x)*j/count,y:a.y+(b.y-a.y)*j/count});
    }
    points.push({...points[0]});
    return points;
  });
}
function optimizeGrooveOrder(chains,start={x:0,y:0}){const remaining=chains.map(c=>[...c]),ordered=[];let current=start;while(remaining.length){let best=null;for(let i=0;i<remaining.length;i++){const c=remaining[i],a=distance(current,c[0]),b=distance(current,c.at(-1)),d=Math.min(a,b);if(!best||d<best.d)best={i,d,reverse:b<a}}const c=remaining.splice(best.i,1)[0],path=best.reverse?c.reverse():c;ordered.push(path);current=path.at(-1)}for(let pass=0;pass<20;pass++){let change=null;for(let i=0;i<ordered.length-1;i++){const previous=i?ordered[i-1].at(-1):start;for(let j=i+1;j<ordered.length;j++){const next=j+1<ordered.length?ordered[j+1][0]:null,oldCost=distance(previous,ordered[i][0])+(next?distance(ordered[j].at(-1),next):0),newCost=distance(previous,ordered[j].at(-1))+(next?distance(ordered[i][0],next):0),saving=oldCost-newCost;if(saving>.01&&(!change||saving>change.saving))change={i,j,saving}}}if(!change)break;const segment=ordered.splice(change.i,change.j-change.i+1).reverse().map(c=>[...c].reverse());ordered.splice(change.i,0,...segment)}return ordered}
function grooveOutlines(chosen, outlinesForItem = item=>[machiningOutline(item)]) {
  const byId=new Map(chosen.map(item=>[item.id,item]));
  const parts=selectedAreaParts().filter(part=>part.ids.every(id=>byId.has(id)));
  const regionIds=new Set(parts.flatMap(part=>part.ids));
  const regions=parts.map(part=>{
    if (part.type==='area') return part.contours;
    return part.ids.flatMap(id=>outlinesForItem(byId.get(id)));
  });
  const loose=chosen.filter(item=>!regionIds.has(item.id)&&isClosedVector(item)).flatMap(outlinesForItem);
  return [...unionRegionContours(regions),...loose].filter(ring=>ring.length>=3);
}

function machiningOutline(item) {
  if (item.kind !== 'path') return geometryPoints(item);
  if (!item.textFont || item.centerlineFont) {
    if ((item.d.match(/[mM]/g) || []).length > 1) {
      throw Error('Split SVG paths with multiple subpaths into separate closed outlines before generating a toolpath.');
    }
    return geometryPoints(item,.16);
  }
  const local=flattenTextOutline(item.d,item.sx||1,item.sy||1);
  const dx=(item.dx||0)+(item.ox||0),dy=(item.dy||0)+(item.oy||0);
  return local.map(p=>({x:p.x+dx,y:stock.height-p.y-dy}));
}

function drawGroovePaths(layer,paths,className) {
  for (const path of paths) {
    const el = document.createElementNS(svgNS,path.length===1?'circle':'polyline');
    if (path.length===1) {
      el.setAttribute('cx',path[0].x);
      el.setAttribute('cy',stock.height-path[0].y);
      el.setAttribute('r',.15);
    } else {
      el.setAttribute('points',path.map(p=>`${p.x},${stock.height-p.y}`).join(' '));
    }
    el.setAttribute('class',className);
    layer.append(el);
  }
}

function generateFlatBottomGroove() {
  const settings = readProfileFields();
  const flat = settings.operations['vgroove-flat'];
  const {depth,safeZ} = flat;
  if (depth>stock.thickness) throw Error('Flat-bottom V Groove depth cannot exceed stock thickness.');
  const tool = selectedOperationTool('vgroove-flat');
  const chosen = objects.filter(object=>selectedIds.has(object.id) && !hiddenLayers.has(object.layer));
  if (!tool) throw Error('Select a V-bit from the tool library for a flat-bottom groove.');
  if (!chosen.length || chosen.some(object=>object.centerlineFont || !isClosedVector(object))) {
    throw Error('Flat-bottom grooves need closed outlines. Select the letter outlines and their counters.');
  }
  const savedClearance = readTool(settings.vgrooveClearanceTool);
  const clearance = savedClearance?.type==='endmill' ? savedClearance : null;
  const {clearancePaths,finishPaths,floorPathCount} = planFlatBottomGroove(
    grooveOutlines(chosen,item=>vectorRings(item,stock.height,geometryPoints)),
    {depth,angle:tool.angle,diameter:tool.diameter,clearanceDiameter:clearance?.diameter});
  const stages = [];
  if (clearancePaths.length) {
    const gcode = writeFlatGrooveGcode(clearancePaths,{...clearance,safeZ,
      comment:`(Carve Studio groove clearance - tool diameter ${clearance.diameter} mm; flat depth ${depth} mm)`});
    stages.push({operation:'vgroove-clearance',gcode,tool:clearance,toolChangeZ:safeZ});
  }
  const finish = writeFlatGrooveGcode(finishPaths,{...flat,
    comment:`(Carve Studio flat-bottom V Groove - V-bit included angle ${tool.angle} degrees; flat depth ${depth} mm)`});
  stages.push({operation:'vgroove-flat',gcode:finish,tool,toolChangeZ:safeZ,requiresPrevious:stages.length>0});
  generatedGcode = composeToolpaths(stages.map(stage=>({...stage,toolNumber:stage.tool.number,
    name:toolpathLabel(stage.operation)})),'(Carve Studio flat-bottom groove)');
  profileSettings = settings;
  generatedOperation = 'vgroove-flat';
  profileContours = [...clearancePaths,...finishPaths];
  const layer = $('#toolpath-preview');
  layer.replaceChildren();
  drawGroovePaths(layer,clearancePaths,'cam-pocket-path');
  drawGroovePaths(layer,finishPaths,'cam-vgroove-path');
  $('#gcode-preview').value = generatedGcode;
  $('#save-gcode').disabled = false;
  $('#load-visualizer').disabled = false;
  const detail = clearancePaths.length ? 'End mill clears first, then the V-bit finishes.' :
    floorPathCount ? 'V-bit clears and finishes the floor.' : 'The selected outlines stay shallower than the flat depth.';
  profileStatus(`Flat-bottom V Groove ready · ${depth.toFixed(2)} mm. ${detail}`);
  return stages;
}

function generateVGroove() {
  const s = readProfileFields();
  const {vgrooveAngle:angle,vgrooveMaxDepth:requestedDepth,vgrooveSingleLine:fixed,safeZ,feed,plunge,rpm} = s;
  if (![angle,requestedDepth,safeZ,feed,plunge,rpm].every(value => Number.isFinite(value) && value > 0) || angle >= 180) {
    throw Error('Enter a valid V-bit angle, depth, clearance and feed settings.');
  }
  const chosen = objects.filter(o => selectedIds.has(o.id) && !hiddenLayers.has(o.layer));
  if (!chosen.length) throw Error('Select closed letter outlines or CNC single-line text first.');
  const tool=selectedOperationTool('vgroove');
  const tipDepth=tool ? tool.diameter/2/Math.tan(angle*Math.PI/360) : Infinity;
  const depth=Math.min(requestedDepth,tipDepth);
  const singleLine=chosen.some(o=>o.centerlineFont);
  if ((fixed || singleLine) && requestedDepth > tipDepth + 1e-9) {
    throw Error('The selected V-bit is too narrow for that fixed groove depth. Reduce the depth or select a wider V-bit.');
  }
  if (singleLine) {
    generateSingleLineVGroove(chosen,s);
    return;
  }

  const components = deriveGrooveCenterlines(grooveOutlines(chosen));
  if (!components.length || components.some(component => !component.paths.length)) {
    throw Error('No usable centerline could be derived for one or more selected outlines.');
  }
  const remaining = components.map(component => grooveCutPaths(component,{angle,depth,fixed}));
  const groups = [];
  let current = {x:0,y:0};
  while (remaining.length) {
    let best = 0, nearest = Infinity;
    for (let i=0; i<remaining.length; i++) {
      for (const path of remaining[i]) {
        const d = Math.min(distance(current,path[0]),distance(current,path.at(-1)));
        if (d < nearest) {best = i; nearest = d;}
      }
    }
    const paths = optimizeGrooveOrder(remaining.splice(best,1)[0],current);
    groups.push(paths);
    current = paths.at(-1).at(-1);
  }

  const lines = ['(Carve Studio V Groove Profile)',
    '(Centerline strokes from connected letter outlines.)',
    `(V-bit included angle ${angle} degrees; ${fixed ? 'constant' : 'maximum'} depth ${depth.toFixed(3)} mm.)`,
    'G21 G90 G17 G94', `G0 Z${safeZ.toFixed(3)}`, `M3 S${Math.round(rpm)}`];
  for (const [index,paths] of groups.entries()) {
    lines.push(`(Letter group ${index+1})`);
    for (const path of paths) {
      const start = path[0];
      lines.push(`G0 Z${safeZ.toFixed(3)}`,`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}`,
        `G1 Z-${start.z.toFixed(3)} F${plunge.toFixed(1)}`);
      for (const p of path.slice(1)) lines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z-${p.z.toFixed(3)} F${feed.toFixed(1)}`);
    }
  }
  lines.push(`G0 Z${safeZ.toFixed(3)}`,'M5','M30');
  profileSettings = s;
  generatedGcode = lines.join('\n')+'\n';
  profileContours = groups.flat();
  generatedOperation = 'vgroove';
  const layer = $('#toolpath-preview');
  layer.replaceChildren();
  drawGroovePaths(layer,profileContours,'cam-vgroove-path');
  $('#gcode-preview').value = generatedGcode;
  $('#save-gcode').disabled = false;
  $('#load-visualizer').disabled = false;
  profileStatus(`V Groove ready · ${groups.length} regions · ${profileContours.length} strokes${fixed ? ' · fixed depth' : ''}.${depth<requestedDepth?' Limited to '+depth.toFixed(2)+' mm by the selected bit diameter.':''}`);
}
function profileCandidates(settings){if(settings.scope==='selected'){const chosen=objects.filter(o=>selectedIds.has(o.id)&&!hiddenLayers.has(o.layer));if(!chosen.length)throw Error('Select one or more visible vectors, or choose All vectors.');return chosen}return objects.filter(o=>!hiddenLayers.has(o.layer))}
function pointsWithProfileTabs(contour,depth,settings,enabled,stockThickness){const points=contour.points;if(!enabled||!contour.closed||settings.profileTabCount<1)return points.map(p=>({...p,cutDepth:depth}));const lengths=[0];for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+distance(points[i-1],points[i]));const perimeter=lengths.at(-1),tabWidth=settings.profileTabWidth,ramp=Math.min(2,tabWidth/3),count=Math.min(settings.profileTabCount,Math.floor(perimeter/(tabWidth+2*ramp)));if(count<1)return points.map(p=>({...p,cutDepth:depth}));const centers=Array.from({length:count},(_,i)=>(i+.5)*perimeter/count),stations=[...lengths];for(const center of centers)for(const d of [center-tabWidth/2-ramp,center-tabWidth/2,center+tabWidth/2,center+tabWidth/2+ramp])stations.push(d);const sorted=[...new Set(stations.map(d=>Math.max(0,Math.min(perimeter,d))).sort((a,b)=>a-b))],tabCutDepth=Math.max(0,stockThickness-settings.profileTabHeight),liftAtThisPass=Math.max(0,depth-tabCutDepth);const atDistance=d=>{let i=1;while(i<lengths.length-1&&lengths[i]<d)i++;const span=lengths[i]-lengths[i-1],t=span?(d-lengths[i-1])/span:0,a=points[i-1],b=points[i],lift=centers.reduce((best,c)=>{const delta=Math.abs(d-c),half=tabWidth/2,rampLift=delta<=half?liftAtThisPass:delta<half+ramp?liftAtThisPass*(1-(delta-half)/ramp):0;return Math.max(best,rampLift)},0);return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,cutDepth:Math.max(0,depth-lift)}};return sorted.map(atDistance)}
function joinTouchingOpenContours(input,tolerance=.02){const closed=input.filter(c=>c.closed),remaining=input.filter(c=>!c.closed).map(c=>({id:c.id,closed:false,points:c.points.map(p=>({...p}))})),openCount=remaining.length,joined=[];
 while(remaining.length){const chain=remaining.shift();let changed=true;while(changed){changed=false;let best=null;for(let i=0;i<remaining.length;i++){const c=remaining[i],start=chain.points[0],end=chain.points.at(-1),cs=c.points[0],ce=c.points.at(-1),tests=[[distance(end,cs),'append',i,false],[distance(end,ce),'append',i,true],[distance(start,ce),'prepend',i,false],[distance(start,cs),'prepend',i,true]];for(const [d,side,index,reverse] of tests)if(d<=tolerance&&(!best||d<best.d))best={d,side,index,reverse}}
   if(best){const c=remaining.splice(best.index,1)[0],pts=best.reverse?[...c.points].reverse():c.points;if(best.side==='append')chain.points.push(...pts.slice(1));else chain.points.unshift(...pts.slice(0,-1));changed=true}}
  if(chain.points.length>2&&distance(chain.points[0],chain.points.at(-1))<=tolerance){chain.points[chain.points.length-1]={...chain.points[0]};chain.closed=true}joined.push(chain)}
 return{contours:[...closed,...joined],joinCount:openCount-joined.length}}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function optimizeContourOrder(input,start={x:0,y:0}){const remaining=input.map(c=>({...c,points:c.points.map(p=>({...p}))})),ordered=[];let current={...start};while(remaining.length){let best=null;for(let i=0;i<remaining.length;i++){const c=remaining[i],pts=c.points;if(c.closed){const n=pts.length>1&&distance(pts[0],pts.at(-1))<1e-8?pts.length-1:pts.length;for(let j=0;j<n;j++){const d=distance(current,pts[j]);if(!best||d<best.d)best={d,i,points:[...pts.slice(j,n),...pts.slice(0,j),{...pts[j]}]}}}else{const d=distance(current,pts[0]);if(!best||d<best.d)best={d,i,points:pts}}}const chosen=remaining.splice(best.i,1)[0];chosen.points=best.points;ordered.push(chosen);current=chosen.points.at(-1)}return ordered}
function generateProfile() {
  const s=readProfileFields();
  const cutDepth=s.profileThroughStock?stock.thickness:s.depth;
  if (![cutDepth,s.stepdown,s.safeZ,s.feed,s.plunge,s.rpm,s.profileTabCount,s.profileTabWidth,s.profileTabHeight].every(Number.isFinite) ||
    cutDepth<=0 || cutDepth>stock.thickness || s.stepdown<=0 || s.safeZ<=0 || s.feed<=0 || s.plunge<=0 || s.rpm<=0 ||
    !Number.isInteger(s.profileTabCount) || s.profileTabCount<0 || s.profileTabCount>12 || s.profileTabWidth<=0 ||
    s.profileTabHeight<=0 || (s.profileThroughStock && s.profileTabCount>0 && s.profileTabHeight>=cutDepth)) {
    throw Error('Enter valid profile settings. Enabled tabs need a positive width and a height below the profile cut depth.');
  }
  s.stepdown=Math.min(s.stepdown,cutDepth);

  const compensated=s.profileSide!=='on';
  let contours=[];
  for (const object of profileCandidates(s)) {
    if (object.kind==='path' && (object.d.match(/[mM]/g)||[]).length>1) {
      throw Error('A selected SVG path contains multiple subpaths. Split it into separate paths before profiling.');
    }
    let points=geometryPoints(object,compensated ? .15 : null);
    if (points.length<2) {
      if (compensated) throw Error('A selected vector has no usable profile geometry.');
      continue;
    }
    const closed=['rect','circle','ellipse','polygon'].includes(object.kind) ||
      (object.kind==='path' && (object.outlineClosed || /[zZ]s*$/.test(object.d.trim())));
    if (closed && distance(points[0],points.at(-1))>0.001) points=[...points,{...points[0]}];
    contours.push({id:object.id,points,closed});
  }
  if (!contours.length) throw Error('No supported vectors are available for a profile.');
  let joinedCount=0;
  if (compensated || s.optimizeMoves) ({contours,joinCount:joinedCount}=joinTouchingOpenContours(contours));
  if (compensated) {
    contours=compensateProfile(contours,s.profileSide,s.profileToolDiameter);
    if (s.optimizeMoves) {
      const ordered=[];
      for (const depth of new Set(contours.map(contour=>contour.depth))) {
        ordered.push(...optimizeContourOrder(contours.filter(contour=>contour.depth===depth),ordered.at(-1)?.points.at(-1)));
      }
      contours=ordered;
    }
  } else if (s.optimizeMoves) {
    contours=optimizeContourOrder(contours);
  }
  profileSettings=s;
  const tabsActive=s.profileThroughStock && s.profileTabCount>0;
  const sideLabel={on:'On vector',inside:'Inside',outside:'Outside'}[s.profileSide];
  const lines=['(Carve Studio profile)',`(Depth ${cutDepth.toFixed(3)} mm${s.profileThroughStock?' through stock thickness':''}.)`,`(Cut side: ${sideLabel}${s.profileSide==='on'?'':'; cutter diameter '+s.profileToolDiameter.toFixed(3)+' mm'}.)`,...(tabsActive?[`(Up to ${s.profileTabCount} evenly spaced holding tabs per closed contour, ${s.profileTabWidth.toFixed(1)} mm wide and ${s.profileTabHeight.toFixed(1)} mm high; lifts begin only inside the reserved tab thickness.)`]:[]),...(joinedCount?[`(Joined ${joinedCount} touching open vectors to reduce retracts.)`]:[]),'G21 G90 G17 G94',`G0 Z${s.safeZ.toFixed(3)}`,`M3 S${Math.round(s.rpm)}`];
 for(const c of contours){for(let d=Math.min(s.stepdown,cutDepth);;d=Math.min(cutDepth,d+s.stepdown)){const path=pointsWithProfileTabs(c,d,s,tabsActive,stock.thickness),start=path[0];lines.push(`G0 Z${s.safeZ.toFixed(3)}`,`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}`,`G1 Z-${start.cutDepth.toFixed(3)} F${s.plunge.toFixed(1)}`);for(const p of path.slice(1))lines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} Z-${p.cutDepth.toFixed(3)} F${s.feed.toFixed(1)}`);if(d>=cutDepth-1e-9)break}}
 lines.push(`G0 Z${s.safeZ.toFixed(3)}`,'M5','M30');generatedGcode=lines.join('\n')+'\n';profileContours=contours;generatedOperation='profile';const layer=$('#toolpath-preview');layer.replaceChildren();for(const c of contours){const el=document.createElementNS(svgNS,'polyline');el.setAttribute('points',c.points.map(p=>`${p.x},${stock.height-p.y}`).join(' '));el.setAttribute('class','cam-preview-path');layer.append(el)}$('#gcode-preview').value=generatedGcode;$('#gcode-preview').hidden=false;$('#save-gcode').disabled=false;$('#load-visualizer').disabled=false;profileStatus(`Preview ready · ${contours.length} contour${contours.length===1?'':'s'}${joinedCount?` · joined ${joinedCount} vectors`:''} · ${cutDepth.toFixed(1)} mm cut depth · ${Math.ceil(cutDepth/s.stepdown)} depth passes · ${sideLabel}.`)}
function generateDrilling(){const s=readProfileFields();if(![s.depth,s.stepdown,s.safeZ,s.plunge,s.rpm].every(Number.isFinite)||s.depth<=0||s.stepdown<=0||s.safeZ<=0||s.plunge<=0||s.rpm<=0)throw Error('Enter positive values for depth, peck depth, safe Z, plunge and spindle RPM.');if(s.stepdown>s.depth)s.stepdown=s.depth;const candidates=s.drillScope==='selected'?objects.filter(o=>selectedIds.has(o.id)&&!hiddenLayers.has(o.layer)):objects.filter(o=>!hiddenLayers.has(o.layer)),holes=candidates.filter(o=>o.kind==='circle'&&o.r>0);if(!holes.length)throw Error(s.drillScope==='selected'?'Select one or more visible circle vectors first.':'No visible circle vectors found to drill.');profileSettings=s;const drillTool=selectedOperationTool('drill'),pecks=Math.ceil(s.depth/s.stepdown),lines=['(Carve Studio center drilling)',...(drillTool?['(Actual drill diameter '+drillTool.diameter.toFixed(3)+' mm.)']:[]),'(Drills circle centers; verify hole sizes, stock zero, work offset and clearances.)','G21 G90 G17 G94',`G0 Z${s.safeZ.toFixed(3)}`,`M3 S${Math.round(s.rpm)}`];for(const [i,hole] of holes.entries()){lines.push(`(Hole ${i+1} drawn diameter ${(hole.r*2).toFixed(3)} mm)`,`G0 Z${s.safeZ.toFixed(3)}`,`G0 X${hole.cx.toFixed(3)} Y${hole.cy.toFixed(3)}`);for(let d=Math.min(s.stepdown,s.depth);;d=Math.min(s.depth,d+s.stepdown)){lines.push(`G1 Z-${d.toFixed(3)} F${s.plunge.toFixed(1)}`,`G0 Z${s.safeZ.toFixed(3)}`);if(d>=s.depth-1e-9)break}}lines.push('M5','M30');generatedGcode=lines.join('\n')+'\n';profileContours=[];generatedOperation='drill';const layer=$('#toolpath-preview');layer.replaceChildren();for(const hole of holes){const x=hole.cx,y=stock.height-hole.cy,mark=document.createElementNS(svgNS,'path');mark.setAttribute('d',`M ${x-2} ${y} L ${x+2} ${y} M ${x} ${y-2} L ${x} ${y+2}`);mark.setAttribute('class','cam-drill-mark');layer.append(mark)}$('#gcode-preview').value=generatedGcode;$('#gcode-preview').hidden=false;$('#save-gcode').disabled=false;$('#load-visualizer').disabled=false;profileStatus(`Drilling preview ready · ${holes.length} hole${holes.length===1?'':'s'} · ${pecks} peck${pecks===1?'':'s'} per hole.${drillTool && holes.some(hole=>Math.abs(hole.r*2-drillTool.diameter)>.01)?' The chosen bit differs from one or more drawn hole diameters.':''}`)}
function generatePocket(){const s=readProfileFields();if(![s.depth,s.stepdown,s.safeZ,s.feed,s.plunge,s.rpm,s.pocketToolDiameter,s.pocketStepover].every(Number.isFinite)||s.depth<=0||s.stepdown<=0||s.safeZ<=0||s.feed<=0||s.plunge<=0||s.rpm<=0||s.pocketToolDiameter<=0||s.pocketStepover<=0||s.pocketStepover>s.pocketToolDiameter)throw Error('Enter positive pocket parameters; stepover must not exceed the tool diameter.');const chosen=objects.filter(o=>selectedIds.has(o.id)&&!hiddenLayers.has(o.layer));if(!chosen.some(isClosedVector))throw Error('Select one or more visible closed shapes to pocket, including their counter boundaries.');const contours=pocketContours(chosen),scale=1000,paths=contours.map(ring=>ring.slice(0,-1).map(p=>({X:Math.round(p.x*scale),Y:Math.round(p.y*scale)}))).filter(p=>p.length>=3);if(!paths.length)throw Error('No valid closed boundaries were found for pocketing.');const clipper=new ClipperLib.Clipper();clipper.AddPaths(paths,ClipperLib.PolyType.ptSubject,true);const normalized=new ClipperLib.Paths();if(!clipper.Execute(ClipperLib.ClipType.ctUnion,normalized,ClipperLib.PolyFillType.pftEvenOdd,ClipperLib.PolyFillType.pftEvenOdd)||!normalized.length)throw Error('Could not resolve the selected boundaries. Check for open or overlapping outlines.');const offsetter=new ClipperLib.ClipperOffset(2,.25);offsetter.AddPaths(normalized,ClipperLib.JoinType.jtRound,ClipperLib.EndType.etClosedPolygon);const loopLevels=[],maxOffsets=500,toolRadius=s.pocketToolDiameter/2;for(let i=0;i<maxOffsets;i++){const result=new ClipperLib.Paths(),inset=toolRadius+i*s.pocketStepover;offsetter.Execute(result,-inset*scale);if(!result.length)break;const loops=result.map(path=>{const points=path.map(p=>({x:p.X/scale,y:p.Y/scale}));if(points.length>2&&distance(points[0],points.at(-1))>1e-4)points.push({...points[0]});return{id:`pocket-${i}`,closed:true,points}}).filter(c=>c.points.length>=4);if(!loops.length)break;loopLevels.push(loops)}if(!loopLevels.length)throw Error('The tool does not fit inside the selected pocket area. Use a smaller tool or wider shape.');if(loopLevels.reduce((n,level)=>n+level.length,0)>5000)throw Error('Pocketing produced more than 5,000 clearing loops. Increase the tool diameter or stepover.');if(s.stepdown>s.depth)s.stepdown=s.depth;const passes=[];for(let d=Math.min(s.stepdown,s.depth);;d=Math.min(s.depth,d+s.stepdown)){passes.push(d);if(d>=s.depth-1e-9)break}profileSettings=s;const lines=['(Carve Studio pocket clearing)','(Nested offsets include cutter radius. Verify boundaries, stock zero and clearances.)',`(Tool diameter ${s.pocketToolDiameter.toFixed(3)} mm; stepover ${s.pocketStepover.toFixed(3)} mm.)`,`(Loops per depth: ${loopLevels.reduce((n,l)=>n+l.length,0)}; depth passes: ${passes.length}.)`,'G21 G90 G17 G94',`G0 Z${s.safeZ.toFixed(3)}`,`M3 S${Math.round(s.rpm)}`];let current={x:0,y:0};for(const depth of passes){for(let level=0;level<loopLevels.length;level++){const ordered=optimizeContourOrder(loopLevels[level],current);for(const contour of ordered){const start=contour.points[0];lines.push(`(Pocket pass depth ${depth.toFixed(3)} mm, inset ${(toolRadius+level*s.pocketStepover).toFixed(3)} mm)`,`G0 Z${s.safeZ.toFixed(3)}`,`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)}`,`G1 Z-${depth.toFixed(3)} F${s.plunge.toFixed(1)}`);for(const p of contour.points.slice(1))lines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} F${s.feed.toFixed(1)}`);lines.push(`G0 Z${s.safeZ.toFixed(3)}`);current={...start}}}}lines.push('M5','M30');generatedGcode=lines.join('\n')+'\n';const preview=loopLevels.flat();profileContours=preview;generatedOperation='pocket';const layer=$('#toolpath-preview');layer.replaceChildren();for(const contour of preview){const el=document.createElementNS(svgNS,'polyline');el.setAttribute('points',contour.points.map(p=>`${p.x},${stock.height-p.y}`).join(' '));el.setAttribute('class','cam-pocket-path');layer.append(el)}$('#gcode-preview').value=generatedGcode;$('#gcode-preview').hidden=false;$('#save-gcode').disabled=false;$('#load-visualizer').disabled=false;profileStatus(`Pocket preview ready · ${preview.length} offset loops per depth · ${passes.length} depth passes · ${s.pocketStepover.toFixed(2)} mm stepover. Simulate before cutting.`)}
$('#preview-profile').onclick=()=>{activeToolpathOperation='profile';try{generateProfile();addToolpathJob(generatedOperation,generatedGcode)}catch(e){clearProfilePreview();profileStatus(e.message,true)}};
$('#preview-drill').onclick=()=>{activeToolpathOperation='drill';try{if(readProfileFields().depth>stock.thickness)throw Error('Drill depth cannot exceed stock thickness.');generateDrilling();addToolpathJob(generatedOperation,generatedGcode)}catch(e){clearProfilePreview();profileStatus(e.message,true)}};
$('#preview-vgroove').onclick=()=>{activeToolpathOperation='vgroove';try{if(readProfileFields().vgrooveMaxDepth>stock.thickness)throw Error('V Groove maximum depth cannot exceed stock thickness.');generateVGroove();addToolpathJob(generatedOperation,generatedGcode)}catch(e){clearProfilePreview();profileStatus(e.message,true)}};
$('#preview-vgroove-flat').onclick=()=>{
  activeToolpathOperation='vgroove-flat';
  try {
    addToolpathStages(generateFlatBottomGroove());
  } catch (error) {
    clearProfilePreview();
    profileStatus(error.message,true);
  }
};
$('#preview-pocket').onclick=()=>{activeToolpathOperation='pocket';try{if(readProfileFields().depth>stock.thickness)throw Error('Pocket depth cannot exceed stock thickness.');generatePocket();addToolpathJob(generatedOperation,generatedGcode)}catch(e){clearProfilePreview();profileStatus(e.message,true)}};
$('#build-combined-nc').onclick=()=>{try{buildCombinedNc()}catch(error){profileStatus(error?.message||String(error),true)}};
$('#toolpath-list').addEventListener('change',e=>{const nameInput=e.target.closest('[data-job-name]'),toolInput=e.target.closest('[data-job-tool]');if(!nameInput&&!toolInput)return;const id=Number((nameInput||toolInput).dataset.jobName??(nameInput||toolInput).dataset.jobTool),job=toolpathJobs.find(item=>item.id===id);if(!job)return;if(nameInput){const name=nameInput.value.trim();if(!name||name===job.name){nameInput.value=job.name;return}rememberToolpathChange();job.name=name}else{const toolNumber=Number(toolInput.value);if(!Number.isInteger(toolNumber)||toolNumber<1){toolInput.value=String(job.toolNumber||1);return}if(toolNumber===job.toolNumber)return;rememberToolpathChange();job.toolNumber=toolNumber}invalidateFinalNc();renderToolpathList()});
$('#toolpath-list').addEventListener('click',e=>{const button=e.target.closest('[data-job-action]');if(!button)return;const index=toolpathJobs.findIndex(job=>job.id===Number(button.dataset.jobId));if(index<0)return;const action=button.dataset.jobAction;if(action==='up'&&index===0||action==='down'&&index===toolpathJobs.length-1)return;rememberToolpathChange();if(action==='remove')toolpathJobs.splice(index,1);else{const target=action==='up'?index-1:index+1;[toolpathJobs[index],toolpathJobs[target]]=[toolpathJobs[target],toolpathJobs[index]]}invalidateFinalNc();renderToolpathList()});
$('#load-visualizer').onclick=async()=>{if(!generatedGcode)return;const button=$('#load-visualizer'),fileName=generatedOperation==='combined'?'carve-studio-combined.nc':generatedOperation==='drill'?'carve-studio-drilling.nc':generatedOperation==='vgroove-flat'?'carve-studio-flat-bottom-groove.nc':generatedOperation==='vgroove'?'carve-studio-v-groove.nc':generatedOperation==='pocket'?'carve-studio-pocket.nc':'carve-studio-profile.nc';button.disabled=true;button.textContent='Loading…';try{await gcode.loadToVisualizer(generatedGcode,fileName);try{await navigation.navigateToCarve();profileStatus('Loaded into gSender and opened Carve for review. No job was started.')}catch(e){profileStatus(`Loaded into the visualizer, but could not open Carve: ${e?.message||e}. No job was started.`,true)}}catch(e){profileStatus(`Could not load G-code into the visualizer: ${e?.message||e}. Check plugin permissions.`,true)}finally{button.textContent='Load into Visualizer';button.disabled=!generatedGcode}};
$('#save-gcode').onclick=async()=>{if(!generatedGcode)return;const button=$('#save-gcode'),fileName=generatedOperation==='combined'?'carve-studio-combined.nc':generatedOperation==='drill'?'carve-studio-drilling.nc':generatedOperation==='vgroove-flat'?'carve-studio-flat-bottom-groove.nc':generatedOperation==='vgroove'?'carve-studio-v-groove.nc':generatedOperation==='pocket'?'carve-studio-pocket.nc':'carve-studio-profile.nc';button.disabled=true;try{const result=await file.openSaveDialog({content:generatedGcode,options:{defaultFileName:fileName,title:'Save Carve Studio G-code',filters:[{name:'G-code files',extensions:['nc','gcode','tap']}]}});if(result.success)profileStatus('G-code saved. Simulate it and verify setup before cutting.')}catch(e){profileStatus(`Could not save G-code: ${e?.message||e}`,true)}finally{button.disabled=!generatedGcode}};
$('#mirror-x').onclick=()=>mirrorSelection(true);$('#mirror-y').onclick=()=>mirrorSelection(false);$('#duplicate-mirror-x').onclick=()=>duplicateMirrored(true);$('#duplicate-mirror-y').onclick=()=>duplicateMirrored(false);
const nodeEditor = setupNodeEditor({
  overlay: $('#node-overlay'),
  fields: [$('#node-x'), $('#node-y')],
  status: $('#node-status'),
  removeButton: $('#delete-node'),
  getObject: () => activeTool === 'nodes' && selectedIds.size === 1
    ? objects.find(object => selectedIds.has(object.id) && !hiddenLayers.has(object.layer))
    : undefined,
  getView: () => ({height: stock.height, scale: Math.max(view.scale, .01)}),
  selectAt(point, target) {
    const id = target.closest('#drawing .vector')?.dataset.id;
    const object = objects.find(item => String(item.id) === id) || nearestObjectAt(point);
    if (!selectedRegion && selectedIds.size === 1 && object && selectedIds.has(object.id)) return;
    selectedRegion = null;
    selectedIds = new Set(object ? [object.id] : []);
    if (generatedGcode) clearProfilePreview('Selection changed. Generate the toolpath preview again.');
    redraw();
  },
  preview(object) {
    const current = document.getElementById('drawing').querySelector('[data-id="'+CSS.escape(String(object.id))+'"]');
    const replacement = elemFor(object);
    replacement.classList.add('selected');
    current?.replaceWith(replacement);
  },
  commit(object, recordUndo = true) {
    if (recordUndo) remember();
    objects = objects.map(item => item.id === object.id ? object : item);
    redraw();
  },
  snap: (point, id) => snapPoint(point, gridSettings.enabled
    ? visibleSnapScene().filter(record => record.object.id !== id) : []),
  clearSnap: () => showSnapMarker(null)
});

document.querySelectorAll('.tool[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
document.querySelectorAll('.tool[data-panel]:not([data-tool])').forEach(b=>b.onclick=()=>{
  if (activeTool==='nodes'||activeTool==='corner'||pathTools.has(activeTool)) setTool('select');
  setPanel(b.dataset.panel);
});
canvas.addEventListener('pointerleave',()=>{
  showSnapMarker(null);
  if (activeTool==='corner') $('#geometry-preview').replaceChildren();
  if (pathTools.has(activeTool)) drawPathDraft();
});
$('#place-text').onclick=()=>{if(!$('#text-content').value.trim()){$('#text-content').focus();profileStatus('Enter text before placing it.',true);return}setTool('text')};
canvas.addEventListener('pointermove',e=>{
  const p=point(e);
  $('#coordinates').textContent=`X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)} mm`;
  if (activeTool==='nodes' && drag?.mode!=='pan') { nodeEditor.pointerMove(p,e); return; }
  if (activeTool==='corner' && !drag) previewDrawingCorner(p);
  if (['select','trim'].includes(activeTool) && !drag && !drawStart) {
    const near=!canvas.classList.contains('picking-array-center') && nearestObjectAt(p);
    canvas.style.cursor=near?'pointer':'';
  }
  if (drag?.mode==='text-place') {
    const anchor=snapPoint(p);
    if (anchor.x!==drag.anchor.x || anchor.y!==drag.anchor.y) {
      drag.anchor=anchor;
      updateTextPreview(anchor);
    }
  } else if (drag?.mode==='move') {
    moveSelectionTo(p,e);
  } else if (drag?.mode==='pan') {
    view.tx+=e.clientX-drag.last.x;
    view.ty+=e.clientY-drag.last.y;
    drag.last={x:e.clientX,y:e.clientY};
    renderView();
  } else if (drag?.mode==='pending-area' && Math.hypot(e.clientX-drag.startClientX,e.clientY-drag.startClientY)>4) {
    drag.mode='marquee';
    drag.moved=true;
  }
  if (drag?.mode==='marquee' && drag.moved) drawSelectionBox(drag.start,p,e.clientX<drag.startClientX);
  if (drawStart) {
    if (drawGesture && Math.hypot(e.clientX-drawGesture.startClientX,e.clientY-drawGesture.startClientY)>4) drawGesture.moved=true;
    updateDrawingPreview(snapPoint(p));
  } else if (!drag && pathTools.has(activeTool)) {
    drawPathDraft(pathPoint(p));
  } else if (!drag && (snapTools.has(activeTool) || canvas.classList.contains('picking-array-center'))) {
    snapPoint(p);
  }
});
canvas.addEventListener('pointerdown',e=>{const p=point(e);canvas.setPointerCapture(e.pointerId);if(activeTool==='pan'||e.button===1){drag={mode:'pan',last:{x:e.clientX,y:e.clientY}};canvas.dataset.panning='true';return}if(activeTool==='nodes'){if(e.button===0){canvas.focus({preventScroll:true});nodeEditor.pointerDown(p,e)}return}if(e.button===0&&canvas.classList.contains('picking-array-center')){const center=snapPoint(p);$('#array-center-x').value=Number(center.x.toFixed(3));$('#array-center-y').value=Number(center.y.toFixed(3));setPickingArrayCenter(false);refreshDrawingTools();queueSessionSave();return}if(activeTool==='corner'){if(e.button===0){const corner=nearestDrawingCorner(p,$('#corner-mode').value);if(corner)applyDrawingCorners(corner)}return}if(activeTool==='trim'){const o=nearestObjectAt(p);if(o)trimVectorAt(o.id,p);return}if(activeTool==='text'){if(!$('#text-content').value.trim()){$('#text-content').focus();profileStatus('Enter text before placing it.',true);return}const anchor=snapPoint(p);drag={mode:'text-place',anchor};updateTextPreview(anchor);return}if(pathTools.has(activeTool))return;if(activeTool==='select'){if(e.target.closest('#selection-center')){const items=objects.filter(item=>selectedIds.has(item.id)&&!hiddenLayers.has(item.layer));if(items.length)startSelectionMove(items,p,e,true);return}if (!e.shiftKey && nearestObjectAt(p)) {
  const item=selectAt(p);
  if (item && selectedIds.has(item.id)) {
    startSelectionMove(objects.filter(object=>selectedIds.has(object.id)),p,e);
    return;
  }
}
drag={mode:'pending-area',start:p,startClientX:e.clientX,startClientY:e.clientY,baseIds:e.shiftKey?new Set(selectedIds):new Set(),additive:e.shiftKey,moved:false};
return}if(!drawStart){drawStart=snapPoint(p);drawGesture={phase:'first',startClientX:e.clientX,startClientY:e.clientY,moved:false}}else drawGesture={phase:'second',startClientX:e.clientX,startClientY:e.clientY,moved:false};updateDrawingPreview(snapPoint(p))});
canvas.addEventListener('click',e=>{if(pathTools.has(activeTool)&&e.detail===1)placePathPoint(point(e))});
canvas.addEventListener('dblclick',e=>{if(activeTool==='nodes'&&e.button===0){nodeEditor.insert(point(e),e.target);e.preventDefault();return}if(activeTool==='polyline'&&e.button===0){finishPolyline(false);e.preventDefault();return}if(activeTool!=='select'||e.target.closest('#selection-center'))return;const item=nearestObjectAt(point(e));if(!item)return;selectedRegion=null;selectedIds=connectedSelectionIds(item.id);if((generatedOperation==='profile'&&profileSettings.scope==='selected'||generatedOperation==='drill'&&profileSettings.drillScope==='selected'||generatedOperation==='vgroove'||generatedOperation==='pocket')&&generatedGcode)clearProfilePreview('Selection changed. Generate the toolpath preview again.');redraw();e.preventDefault()});
canvas.addEventListener('pointerup',e=>{if(drag?.mode==='pan'){drag=null;canvas.dataset.panning='false';return}if(activeTool==='nodes'){nodeEditor.pointerUp(point(e),e);return}if(pathTools.has(activeTool))return;if(drag?.mode==='move'){moveSelectionTo(point(e),e);drag=null;showSnapMarker(null);return}if(drag?.mode==='text-place'){const anchor=snapPoint(point(e));showSnapMarker(null);drag=null;textPreviewToken++;$('#drawing-preview').replaceChildren();commitBlockTextAt(anchor);return}if(drag?.mode==='pending-area'){const pending=drag;drag=null;const p=point(e);if(Math.hypot(e.clientX-pending.startClientX,e.clientY-pending.startClientY)<=4)selectAt(p,pending.additive);else{drag=pending;drag.mode='marquee';finishMarquee(e)}return}if(drag?.mode==='marquee'){finishMarquee(e);return}if(!drawStart){drag=null;return}const p=snapPoint(point(e)),moved=drawGesture?.moved||Math.hypot(e.clientX-(drawGesture?.startClientX??e.clientX),e.clientY-(drawGesture?.startClientY??e.clientY))>4;if(drawGesture?.phase==='first'&&!moved){drawGesture=null;updateDrawingPreview(p);return}finishDrawing(p)});
canvas.addEventListener('pointercancel',()=>{nodeEditor.cancel();clearPathDraft();showSnapMarker(null);drawStart=null;drawGesture=null;drag=null;canvas.dataset.panning='false';$('#drawing-preview').replaceChildren();$('#selection-box').setAttribute('visibility','hidden')});
canvas.addEventListener('wheel',e=>{e.preventDefault();const before=point(e),factor=e.deltaY<0?1.12:.89;view.scale=Math.max(.08,Math.min(8,view.scale*factor));const after=point(e);view.tx+=(after.x-before.x)*view.scale;renderView()},{passive:false});
$('#zoom-in').onclick=()=>{view.scale=Math.min(8,view.scale*1.2);renderView()};$('#zoom-out').onclick=()=>{view.scale=Math.max(.08,view.scale/1.2);renderView()};$('#fit-view').onclick=fitView;$('#grid-toggle').onclick=()=>{gridSettings.enabled=!gridSettings.enabled;updateGrid();queueSessionSave()};$('#grid-resolution').onchange=()=>{gridSettings.resolution=Number($('#grid-resolution').value)||5;updateGrid();queueSessionSave()};
$('#add-layer').onclick=()=>{const name=prompt('Layer name');if(name?.trim()){const layer=name.trim();if(customLayers.includes(layer)||objects.some(o=>o.layer===layer)){alert('A layer with that name already exists.');return}remember();customLayers.push(layer);activeLayer=layer;redraw()}};
$('#new-project').onclick=async()=>{if(objects.length||toolpathJobs.length){const choice=await askSaveBeforeNew();if(choice==='cancel')return;if(choice==='save'&&!await saveProjectFile())return}clearPathDraft();objects=[];customLayers=['Default'];activeLayer='Default';hiddenLayers.clear();selectedIds.clear();selectedRegion=null;nextId=1;toolpathJobs=[];nextToolpathId=1;renderToolpathList();stock.width=300;stock.height=200;stock.thickness=18;stockManuallySet=false;gridSettings.enabled=false;gridSettings.resolution=5;$('#stock-width').value=300;$('#stock-height').value=200;$('#stock-thickness').value=18;$('#auto-stock-size').checked=true;undoStack=[];redoStack=[];clearProfilePreview();setProjectName('Untitled project');resizeBoard();fitView();redraw()};
$('#export').onclick = async () => {
  const button = $('#export');
  button.disabled = true;
  try {
    const body = objects.filter(o => !hiddenLayers.has(o.layer))
      .map(o => elemFor(o)?.outerHTML || '').join('\n');
    const data=`<svg xmlns="${svgNS}" width="${stock.width}mm" height="${stock.height}mm" viewBox="0 0 ${stock.width} ${stock.height}">${body}</svg>`;
    await file.openSaveDialog({
      content: data,
      options: {
        defaultFileName: 'carve-studio-design.svg',
        title: 'Save Carve Studio SVG',
        filters: [{name: 'SVG files', extensions: ['svg']}],
      },
    });
  } catch (error) {
    alert('Could not export vectors: ' + (error?.message || error));
  } finally {
    button.disabled = false;
  }
};
$('#undo').onclick=()=>{if(!undoStack.length)return;redoStack.push(projectState());restoreState(undoStack.pop())};
$('#redo').onclick=()=>{if(!redoStack.length)return;undoStack.push(projectState());restoreState(redoStack.pop())};
$('#save-project').onclick=saveProjectFile;
$('#open-project').onclick=()=>$('#project-input').click();
$('#project-input').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(data.format!=='carve-studio-project'||data.version!==1||!data.stock||!Array.isArray(data.objects))throw Error('This is not a supported Carve Studio project file.');remember();restoreState({stock:data.stock,grid:data.grid,objects:data.objects,selected:Array.isArray(data.selected)?data.selected:[],selectedRegion:data.selectedRegion,nextId:Number(data.nextId)||Math.max(1,...data.objects.map(o=>Number(o.id)||0))+1,layers:data.layers,activeLayer:data.activeLayer,hiddenLayers:data.hiddenLayers,profileSettings:data.profileSettings,toolpaths:data.toolpaths,nextToolpathId:data.nextToolpathId,uiValues:data.uiValues});setProjectName(f.name.replace(/\.[^.]+$/,''))}catch(err){alert(err.message)}e.target.value=''};
for(const id of ['profile-scope','profile-side','profile-tool-diameter','drill-scope','profile-depth','profile-stepdown','profile-safez','profile-feed','profile-plunge','profile-rpm','drill-depth','drill-stepdown','drill-safez','drill-feed','drill-plunge','drill-rpm','profile-tab-count','profile-tab-width','profile-tab-height','optimize-moves','profile-through-stock','vgroove-angle','vgroove-max-depth','vgroove-singleline','vgroove-safez','vgroove-feed','vgroove-plunge','vgroove-rpm','pocket-depth','pocket-stepdown','pocket-safez','pocket-feed','pocket-plunge','pocket-rpm','pocket-tool-diameter','pocket-overlap','vgroove-flat-depth','vgroove-flat-stepdown','vgroove-flat-safez','vgroove-flat-feed','vgroove-flat-plunge','vgroove-flat-rpm'])$('#'+id).addEventListener('change',updateToolpathSettings);

$('#vgroove-clearance-tool').addEventListener('change',event=>{
  const value = event.target.value;
  if (value==='saved') return;
  profileSettings.vgrooveClearanceTool = toolLibrary.tools.find(tool=>tool.id===value && tool.type==='endmill') || null;
  updateToolpathSettings();
});

function updateToolpathSettings() {
  profileSettings=readProfileFields();
  renderToolSelectors();
  if (generatedGcode) clearProfilePreview('Toolpath settings changed. Generate the preview again.');
  redraw();
}
for (const op of Object.keys(OPERATION_TOOL_TYPES)) {
  $('#'+op+'-tool').addEventListener('change',event=>applyToolPreset(op,event.target.value));
}
for(const id of ['text-content','text-size','offset-distance'])$('#'+id).addEventListener('change',queueSessionSave);
$('#text-font').addEventListener('change',()=>{pendingTextFontValue='';queueSessionSave()});$('#import-font-button').onclick=()=>$('#font-file-input').click();$('#font-file-input').onchange=async e=>{await importFontFile(e.target.files?.[0]);e.target.value=''};
window.addEventListener('keydown',e=>{if(document.getElementById('editor-panel').hidden||document.querySelector('dialog[open]')||e.target.matches('input,textarea,select'))return;if(handlePathKey(e))return;if(activeTool==='nodes'){if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();nodeEditor.remove();return}if(e.key==='Escape'){if(!nodeEditor.cancel())setTool('select');return}}if(e.key==='Escape'&&(activeTool==='corner'||activePanel==='array')){setTool('select');return}if(e.key==='Escape'&&drawStart){showSnapMarker(null);drawStart=null;drawGesture=null;$('#drawing-preview').replaceChildren();return}if(e.key==='Delete'||e.key==='Backspace'){if(selectedIds.size){e.preventDefault();$('#delete-selected').click()}return}if(!(e.ctrlKey||e.metaKey))return;const key=e.key.toLowerCase();if(key==='z'){e.preventDefault();(e.shiftKey?$('#redo'):$('#undo')).click()}else if(key==='y'){e.preventDefault();$('#redo').click()}else if(key==='s'){e.preventDefault();$('#save-project').click()}else if(key==='a'){e.preventDefault();selectedIds=new Set(objects.filter(o=>!hiddenLayers.has(o.layer)).map(o=>o.id));redraw()}else if(key==='d'){e.preventDefault();$('#duplicate-selected').click()}});
$('#finish-polyline').onclick=()=>finishPolyline(false);
$('#close-polyline').onclick=()=>finishPolyline(true);
setupDrawingToolControls();
setupCutPreview(()=>({...stock}),()=>toolpathJobs);
window.addEventListener('resize',fitView);window.addEventListener('beforeunload',saveSessionNow);setPanel('selection');if(!restoreLastSession()){setProfileFields();renderToolpathList();resizeBoard();fitView();redraw()}restoreImportedFonts();
