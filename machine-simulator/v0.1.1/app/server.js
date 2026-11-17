import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import occtImportJs from 'occt-import-js';
import { findProbeRelease, probeBallTouches, sweepProbeBall } from './src/probe-collision.js';
import { handleGrblHalEnumeration } from './grblhal-enumerations.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.use(express.json({limit:'2mb'}));
let installedFiles=new Map();
let installedPlugin=null;
const stateDir=process.env.SIMULATOR_STATE_DIR || path.join(here,'simulator-state');
fs.mkdirSync(stateDir,{recursive:true});
const statePath=name=>path.join(stateDir,name);
function saveAtomic(name,data){const temp=statePath(`${name}.${process.pid}.${Date.now()}.tmp`);try{fs.writeFileSync(temp,data);fs.renameSync(temp,statePath(name));}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
function packFile(name,buffer){const meta=Buffer.from(JSON.stringify({name}));const len=Buffer.alloc(4);len.writeUInt32BE(meta.length);return Buffer.concat([len,meta,buffer]);}
function readFile(name){const data=fs.readFileSync(statePath(name));const size=data.readUInt32BE(0);if(size>65536||size+4>data.length)throw new Error('Invalid saved file metadata');return {name:JSON.parse(data.subarray(4,size+4).toString('utf8')).name,buffer:data.subarray(size+4)};}
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:60*1024*1024}});

// A line-oriented serial-over-TCP controller for connecting gSender directly.
const defaultMachineSettings = {'$0':'10','$1':'25','$2':'0','$3':'0','$4':'0','$5':'0','$6':'0','$10':'1','$11':'0.010','$12':'0.002','$13':'0','$20':'0','$21':'0','$22':'0','$23':'0','$24':'25','$25':'500','$26':'250','$27':'1','$30':'1000','$31':'0','$32':'0','$100':'250','$101':'250','$102':'250','$110':'3000','$111':'3000','$112':'1000','$120':'30','$121':'30','$122':'10','$130':'300','$131':'180','$132':'75'};
const defaultToolSetter={enabled:false,x:0,y:0,z:0};
const settingDescriptions={'$0':'Step pulse time, μs','$1':'Step idle delay, ms','$2':'Step pulse invert, mask','$3':'Step direction invert, mask','$4':'Invert step enable pin, boolean','$5':'Invert limit pins, boolean','$6':'Invert probe pin, boolean','$10':'Status report options, mask','$11':'Junction deviation, mm','$12':'Arc tolerance, mm','$13':'Report in inches, boolean','$20':'Soft limits enable, boolean','$21':'Hard limits enable, mask','$22':'Homing cycle enable, mask','$23':'Homing direction invert, mask','$24':'Homing locate feed rate, mm/min','$25':'Homing search seek rate, mm/min','$26':'Homing switch debounce delay, ms','$27':'Homing switch pull-off distance, mm','$30':'Maximum spindle speed, rpm','$31':'Spindle Mode,','$32':'Laser-mode enabled as spindle, boolean','$100':'X-axis travel resolution, step/mm','$101':'Y-axis travel resolution, step/mm','$102':'Z-axis travel resolution, step/mm','$110':'X-axis maximum rate, mm/min','$111':'Y-axis maximum rate, mm/min','$112':'Z-axis maximum rate, mm/min','$120':'X-axis acceleration, mm/sec^2','$121':'Y-axis acceleration, mm/sec^2','$122':'Z-axis acceleration, mm/sec^2','$130':'X-axis maximum travel, mm','$131':'Y-axis maximum travel, mm','$132':'Z-axis maximum travel, mm'};
let machineConfigs = { activeId: 'default', configs: [{ id:'default', name:'Default GRBL', firmware:'grbl', settings:defaultMachineSettings }] };
try { const saved=JSON.parse(fs.readFileSync(statePath('machine-configs.json'),'utf8')); if(Array.isArray(saved.configs)&&saved.configs.length) machineConfigs=saved; } catch {}
machineConfigs.configs=machineConfigs.configs.map(config=>({...config,toolSetter:normalizeToolSetter(config.toolSetter)}));
function normalizeToolSetter(value={}){const toolSetter={enabled:value?.enabled===true};for(const axis of ['x','y','z']){const number=Number(value?.[axis]??0);if(!Number.isFinite(number)||Math.abs(number)>10000)throw new Error(`Tool setter ${axis.toUpperCase()} must be within ±10000 mm.`);toolSetter[axis]=number;}return toolSetter;}
function persistMachineConfigs(){saveAtomic('machine-configs.json',JSON.stringify(machineConfigs,null,2));}
const activeConfig=()=>machineConfigs.configs.find(c=>c.id===machineConfigs.activeId)||machineConfigs.configs[0];
const defaultStockTransform={rotationZ:0,x:0,y:0,z:0,probeDiameter:2};
let machineStock={type:null,name:null,shape:null,dimensions:null,buffer:null,base:null,root:null,bounds:null,transform:{...defaultStockTransform}};
const stockLibraryDir=path.join(stateDir,'stock-library');fs.mkdirSync(stockLibraryDir,{recursive:true});
let stockLibrary={activeId:null,items:[]};
try{const saved=JSON.parse(fs.readFileSync(statePath('stock-library.json'),'utf8'));if(Array.isArray(saved.items))stockLibrary={activeId:saved.activeId||null,items:saved.items};}catch{}
function persistStockLibrary(){saveAtomic('stock-library.json',JSON.stringify(stockLibrary,null,2));}
let stockOcctPromise;
function stockOcct(){if(!stockOcctPromise)stockOcctPromise=occtImportJs({locateFile:file=>path.join(here,'node_modules','occt-import-js','dist',file)});return stockOcctPromise;}
function normalizeStockTransform(value={}){const transform={};for(const key of Object.keys(defaultStockTransform)){const number=Number(value[key]??defaultStockTransform[key]);if(!Number.isFinite(number))throw new Error(`Stock ${key} must be a finite number.`);transform[key]=number;}if(transform.probeDiameter<=0||transform.probeDiameter>50)throw new Error('Probe tip diameter must be greater than 0 and no more than 50 mm.');if(Math.abs(transform.x)>10000||Math.abs(transform.y)>10000||Math.abs(transform.z)>10000)throw new Error('Stock position must be within ±10000 mm.');return transform;}
async function parseStockModel(name,buffer){const extension=path.extname(name).toLowerCase(),base=new THREE.Group();if(extension==='.stl'){const arrayBuffer=buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),geometry=new STLLoader().parse(arrayBuffer);if(!geometry.attributes.position||geometry.attributes.position.count<3)throw new Error('STL file contains no triangles.');base.add(new THREE.Mesh(geometry));}else if(extension==='.step'||extension==='.stp'){const occt=await stockOcct(),result=occt.ReadStepFile(new Uint8Array(buffer),null);if(!result.success||!result.meshes?.length)throw new Error('STEP import failed or the file contains no meshes.');for(const source of result.meshes){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(source.attributes.position.array,3));if(source.attributes.normal)geometry.setAttribute('normal',new THREE.Float32BufferAttribute(source.attributes.normal.array,3));geometry.setIndex(Array.from(source.index.array));base.add(new THREE.Mesh(geometry));}}else throw new Error('Choose an STL, STEP, or STP stock file.');const localBounds=new THREE.Box3().setFromObject(base);if(localBounds.isEmpty())throw new Error('Stock model has no usable geometry.');return{base,localBounds};}
function buildManualStock(shape,dimensions={}){const base=new THREE.Group();if(shape==='cube'){const x=Number(dimensions.x),y=Number(dimensions.y),z=Number(dimensions.z);if(![x,y,z].every(v=>Number.isFinite(v)&&v>0&&v<=10000))throw new Error('Cube X, Y, and Z dimensions must be greater than 0 and no more than 10000 mm.');const geometry=new THREE.BoxGeometry(x,y,z);geometry.translate(x/2,y/2,z/2);base.add(new THREE.Mesh(geometry));return{base,dimensions:{x,y,z}};}if(shape==='cylinder'){const diameter=Number(dimensions.diameter),height=Number(dimensions.height);if(![diameter,height].every(v=>Number.isFinite(v)&&v>0&&v<=10000))throw new Error('Cylinder diameter and height must be greater than 0 and no more than 10000 mm.');const geometry=new THREE.CylinderGeometry(diameter/2,diameter/2,height,64);geometry.rotateX(Math.PI/2);geometry.translate(0,0,height/2);base.add(new THREE.Mesh(geometry));return{base,dimensions:{diameter,height}};}throw new Error('Choose Cube or Cylinder.');}
function applyStockTransform(transform){machineStock.transform=normalizeStockTransform(transform);if(!machineStock.base){machineStock.root=null;machineStock.bounds=null;return;}const root=new THREE.Group();root.add(machineStock.base);root.rotation.z=machineStock.transform.rotationZ*Math.PI/180;root.position.set(machineStock.transform.x,machineStock.transform.y,machineStock.transform.z);root.updateWorldMatrix(true,true);const bounds=new THREE.Box3().setFromObject(root);machineStock.root=root;machineStock.bounds={min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new THREE.Vector3()).toArray()};}
function stockProbeRadius(){return Math.max(0.01,Number(machineStock.transform.probeDiameter)||2)/2;}
function stockPoint(position){return new THREE.Vector3(position[0],position[1],position[2]);}
function stockTouchesPoint(position){return Boolean(machineStock.root&&probeBallTouches(machineStock.root,stockPoint(position),stockProbeRadius()));}
function toolSetterTouchesPoint(position){const setter=activeConfig()?.toolSetter;if(!setter?.enabled)return false;const radius=stockProbeRadius(),dx=position[0]-setter.x,dy=position[1]-setter.y,dz=position[2]-setter.z;return dx*dx+dy*dy+dz*dz<=(radius+1e-6)**2;}
function probeTouchesPoint(position){return stockTouchesPoint(position)||toolSetterTouchesPoint(position);}
function sweepPointSensor(from,to,center,radius){const delta=to.clone().sub(from),relative=from.clone().sub(center),a=delta.dot(delta),c=relative.dot(relative)-radius*radius;if(c<=0)return from.clone();if(a<=1e-18)return null;const b=2*relative.dot(delta),discriminant=b*b-4*a*c;if(discriminant<0)return null;const t=(-b-Math.sqrt(discriminant))/(2*a);return t>=0&&t<=1?from.clone().addScaledVector(delta,t):null;}
function sweepToolSetterProbe(from,to,radius){const setter=activeConfig()?.toolSetter;if(!setter?.enabled)return null;return sweepPointSensor(from,to,new THREE.Vector3(setter.x,setter.y,setter.z),radius);}
function findProbeContact(from,to,radius){const contacts=[];if(machineStock.root){const contact=sweepProbeBall(machineStock.root,from,to,radius);if(contact)contacts.push(contact);}const setter=sweepToolSetterProbe(from,to,radius);if(setter)contacts.push(setter);return contacts.sort((a,b)=>a.distanceToSquared(from)-b.distanceToSquared(from))[0]||null;}
try{if(fs.existsSync(statePath('machine-stock.json'))){const config=JSON.parse(fs.readFileSync(statePath('machine-stock.json'),'utf8'));if(config.type==='manual'){const model=buildManualStock(config.shape,config.dimensions);machineStock={...machineStock,type:'manual',shape:config.shape,dimensions:model.dimensions,base:model.base};}else if(fs.existsSync(statePath('machine-stock.saved'))){const saved=readFile('machine-stock.saved'),parsed=await parseStockModel(saved.name,saved.buffer);machineStock={...machineStock,type:'file',name:saved.name,buffer:saved.buffer,base:parsed.base};}if(machineStock.base)applyStockTransform(config.transform||config);}}catch(error){console.warn('Could not restore stock model:',error.message);}
function machineStockInfo(){return machineStock.base?{type:machineStock.type,name:machineStock.name,fileName:machineStock.type==='file'?(machineStock.fileName||machineStock.name):null,shape:machineStock.shape,dimensions:machineStock.dimensions,transform:machineStock.transform,bounds:machineStock.bounds}:null;}
const persistedActiveStock=stockLibrary.items.find(item=>item.id===stockLibrary.activeId);if(machineStock.base&&persistedActiveStock){machineStock.name=persistedActiveStock.name;machineStock.fileName=persistedActiveStock.fileName||machineStock.fileName||null;if(persistedActiveStock.transform)applyStockTransform(persistedActiveStock.transform);}
function stockLibraryInfo(){return stockLibrary.items.map(item=>({...item,active:item.id===stockLibrary.activeId}));}
function saveLibraryItem(item,buffer){if(buffer)fs.writeFileSync(path.join(stockLibraryDir,`${item.id}.saved`),packFile(item.fileName,buffer));stockLibrary.items=stockLibrary.items.filter(entry=>entry.id!==item.id).concat(item);stockLibrary.activeId=item.id;persistStockLibrary();}
function persistActiveStock(){const item=stockLibrary.items.find(entry=>entry.id===stockLibrary.activeId);if(item){item.transform={...machineStock.transform};persistStockLibrary();}if(machineStock.type==='file'&&machineStock.buffer)saveAtomic('machine-stock.saved',packFile(machineStock.fileName||machineStock.name,machineStock.buffer));else try{fs.unlinkSync(statePath('machine-stock.saved'));}catch{}saveAtomic('machine-stock.json',JSON.stringify({type:machineStock.type,shape:machineStock.shape,dimensions:machineStock.dimensions,transform:machineStock.transform}));}
async function activateStockItem(id){const item=stockLibrary.items.find(entry=>entry.id===id);if(!item)throw new Error('Stock entry was not found.');let next;if(item.type==='manual'){const model=buildManualStock(item.shape,item.dimensions);next={...machineStock,type:'manual',name:item.name,fileName:null,shape:item.shape,dimensions:model.dimensions,buffer:null,base:model.base};}else{const saved=readFile(path.join('stock-library',`${item.id}.saved`)),parsed=await parseStockModel(saved.name,saved.buffer);next={...machineStock,type:'file',name:item.name,fileName:saved.name,shape:null,dimensions:null,buffer:saved.buffer,base:parsed.base};}machineStock=next;stockLibrary.activeId=id;applyStockTransform(item.transform||defaultStockTransform);persistStockLibrary();persistActiveStock();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}return machineStockInfo();}
if(machineStock.base&&!stockLibrary.items.length){const id=randomUUID(),name=machineStock.type==='file'?(machineStock.name||'Imported stock'):`${machineStock.shape==='cube'?'Cube':'Cylinder'} stock`;const item={id,name,type:machineStock.type,shape:machineStock.shape,dimensions:machineStock.dimensions,transform:{...machineStock.transform},fileName:machineStock.name||null};machineStock.name=name;saveLibraryItem(item,machineStock.buffer);}
app.get('/',(_req,res)=>res.redirect('/machine'));
app.get('/machine',(_req,res)=>res.sendFile(path.join(here,'machine-ui.html')));
app.get('/api/machine/configs',(_req,res)=>res.json({...machineConfigs,tcpPort,simulator:'gsender-machine-simulator'}));
app.post('/api/server/restart',(_req,res)=>{
  res.status(202).json({ok:true,restarting:true});
  res.once('finish',()=>setTimeout(()=>{
    for(const client of machineClients)client.destroy();
    tcpServer.close(()=>webServer.close(()=>{
      const child=spawn(process.execPath,[path.resolve(process.argv[1])],{cwd:here,env:process.env,detached:true,stdio:'ignore'});
      child.unref();
      process.exit(0);
    }));
    webServer.closeAllConnections();
  },250));
});
app.put('/api/machine/configs',(req,res)=>{try{const {configs,activeId}=req.body||{};if(!Array.isArray(configs)||!configs.length)throw new Error('Keep at least one machine configuration.');for(const c of configs){if(!c.id||!c.name||!['grbl','grblhal'].includes(c.firmware)||!c.settings||typeof c.settings!=='object')throw new Error('Each config needs a name, firmware type, and settings.');}if(!configs.some(c=>c.id===activeId))throw new Error('Select a current running configuration.');machineConfigs={configs:configs.map(c=>({...c,toolSetter:normalizeToolSetter(c.toolSetter)})),activeId};persistMachineConfigs();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}res.json({...machineConfigs,tcpPort});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/machine/stock-library',(_req,res)=>res.json({items:stockLibraryInfo(),activeId:stockLibrary.activeId}));
app.post('/api/machine/stock-library/file',upload.single('stock'),async(req,res)=>{try{if(!req.file)throw new Error('Choose an STL or STEP stock file.');const fileName=path.basename(req.file.originalname),name=String(req.body.name||'').trim();if(!name)throw new Error('Enter a name for this stock library item.');const transform=normalizeStockTransform(req.body||{}),parsed=await parseStockModel(fileName,req.file.buffer),id=randomUUID(),item={id,name,type:'file',shape:null,dimensions:null,transform,fileName};saveLibraryItem(item,req.file.buffer);machineStock={...machineStock,type:'file',name,fileName,shape:null,dimensions:null,buffer:req.file.buffer,base:parsed.base};applyStockTransform(transform);persistActiveStock();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}res.json({stock:machineStockInfo(),items:stockLibraryInfo(),activeId:id});}catch(error){res.status(400).json({error:error.message});}});
app.post('/api/machine/stock-library/manual',(req,res)=>{try{const {shape,dimensions}=req.body||{},name=String(req.body?.name||'').trim();if(!name)throw new Error('Enter a name for this stock library item.');const transform=normalizeStockTransform(req.body||{}),model=buildManualStock(shape,dimensions),id=randomUUID(),item={id,name,type:'manual',shape,dimensions:model.dimensions,transform};saveLibraryItem(item);machineStock={...machineStock,type:'manual',name,fileName:null,shape,dimensions:model.dimensions,buffer:null,base:model.base};applyStockTransform(transform);persistActiveStock();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}res.json({stock:machineStockInfo(),items:stockLibraryInfo(),activeId:id});}catch(error){res.status(400).json({error:error.message});}});
app.post('/api/machine/stock-library/:id/activate',async(req,res)=>{try{const stock=await activateStockItem(req.params.id);res.json({stock,items:stockLibraryInfo(),activeId:stockLibrary.activeId});}catch(error){res.status(404).json({error:error.message});}});
app.delete('/api/machine/stock-library/:id',(req,res)=>{const item=stockLibrary.items.find(entry=>entry.id===req.params.id);if(!item)return res.sendStatus(404);const wasActive=stockLibrary.activeId===item.id;stockLibrary.items=stockLibrary.items.filter(entry=>entry.id!==item.id);try{fs.unlinkSync(path.join(stockLibraryDir,`${item.id}.saved`));}catch{}if(wasActive){stockLibrary.activeId=null;machineStock={type:null,name:null,shape:null,dimensions:null,buffer:null,base:null,root:null,bounds:null,transform:{...defaultStockTransform}};for(const name of ['machine-stock.saved','machine-stock.json'])try{fs.unlinkSync(statePath(name));}catch{}for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}}persistStockLibrary();res.json({items:stockLibraryInfo(),activeId:stockLibrary.activeId,stock:machineStockInfo()});});
app.get('/api/machine/stock',(_req,res)=>res.json({stock:machineStockInfo()}));
app.get('/api/machine/stock/file',(_req,res)=>{if(machineStock.type!=='file'||!machineStock.name||!machineStock.buffer)return res.sendStatus(404);const fileName=machineStock.fileName||machineStock.name;res.set('Content-Disposition',`attachment; filename="${fileName.replace(/["\\]/g,'_')}"`).type('application/octet-stream').send(machineStock.buffer);});
app.put('/api/machine/stock',(req,res)=>{try{if(!machineStock.base)throw new Error('Load or create stock first.');applyStockTransform(normalizeStockTransform(req.body||{}));persistActiveStock();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}res.json({stock:machineStockInfo()});}catch(error){res.status(400).json({error:error.message});}});
app.delete('/api/machine/stock',(_req,res)=>{for(const name of ['machine-stock.saved','machine-stock.json'])try{fs.unlinkSync(statePath(name));}catch{}machineStock={type:null,name:null,shape:null,dimensions:null,buffer:null,base:null,root:null,bounds:null,transform:{...defaultStockTransform}};stockLibrary.activeId=null;persistStockLibrary();for(const client of machineClients){client.simProbeActive=probeTouchesPoint(client.simPos);machineStatus(client);}res.json({stock:null});});
app.post('/api/machine/import',(req,res)=>{try{const text=String(req.body?.text||'');const settings=Object.fromEntries([...text.matchAll(/^\s*(\$\d+)\s*=\s*([^\s(]+).*$/gm)].map(m=>[m[1],m[2]]));if(!Object.keys(settings).length)throw new Error('No GRBL settings such as $100=250 were found.');res.json({settings,count:Object.keys(settings).length});}catch(e){res.status(400).json({error:e.message});}});
app.get('/api/machine/settings.txt',(_req,res)=>{const c=activeConfig();res.type('text/plain').send(Object.entries(c.settings).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');});
const machineClients=new Set();
const machineTraffic=[];
const machineDiagnostics=[];
const machinePlannerQueueLimit=16;
function recordMachineTraffic(direction,line){machineTraffic.push(`${new Date().toLocaleTimeString()} ${direction} ${line}`);if(machineTraffic.length>500)machineTraffic.splice(0,machineTraffic.length-500);}
function recordMachineDiagnostic(entry){machineDiagnostics.push({time:new Date().toISOString(),...entry});if(machineDiagnostics.length>100)machineDiagnostics.splice(0,machineDiagnostics.length-100);}
app.get('/api/machine/traffic',(_req,res)=>res.json({lines:machineTraffic.slice(-250)}));
app.get('/api/machine/diagnostics',(_req,res)=>res.json({entries:machineDiagnostics.slice(-100)}));
function controllerReply(socket,line){recordMachineTraffic('←',line);if(!socket.destroyed)socket.write(line+'\r\n');}
function machineStatus(socket,state=socket.simState||'Idle'){const c=activeConfig();const hal=c.firmware==='grblhal';const offset=socket.simOffsets?.[socket.simWcs]||[0,0,0],wpos=socket.simPos.map((v,i)=>v-offset[i]-(socket.simG92?.[i]||0)-(i===2?(socket.simTlo||0):0));const pins=(socket.simLimitPins||[]).map((v,i)=>v?'XYZ'[i]:'').join('')+(socket.simProbeActive?'P':'');const feed=['Run','Jog','Home'].includes(state)?Number(socket.simFeed)||0:0,spindle=socket.simSpindleMode&&socket.simSpindleMode!=='M5'?Number(socket.simSpindleSpeed)||0:0;const line=`<${state}|MPos:${socket.simPos.map(v=>v.toFixed(3)).join(',')}|WPos:${wpos.map(v=>v.toFixed(3)).join(',')}|${hal?`FS:${feed},${spindle}`:`FS:${feed},${spindle}`}|Pn:${pins}>`;controllerReply(socket,line);}
const tcpPort=Number(process.env.MACHINE_SIM_TCP_PORT)||2327;
const tcpServer=net.createServer(socket=>{
  machineClients.add(socket);socket.simPos=[0,0,0];socket.simPlannedPos=[0,0,0];socket.simQueue=[];socket.simPendingLines=[];socket.simOffsets=Object.fromEntries(['G54','G55','G56','G57','G58','G59'].map(id=>[id,[0,0,0]]));socket.simStoredPositions={G28:[0,0,0],G30:[0,0,0]};socket.simWcs='G54';socket.simG92=[0,0,0];socket.simTlo=0;socket.simLastProbe=[0,0,0];socket.simProbeSuccess=false;socket.simProbeActive=false;socket.simLimitPins=[false,false,false];socket.simAbsolute=true;socket.simUnits=1;socket.simArcCenterMode='G91.1';socket.simPlane='G17';socket.simFeedMode='G94';socket.simPathControl='G61';socket.simCutterComp='G40';socket.simMotionMode='G0';socket.simSpindleMode='M5';socket.simSpindleSpeed=0;socket.simCoolant='M9';socket.simTool=0;socket.simProgramMode=null;socket.simPaused=false;socket.simState='Idle';socket.simBuffer='';
  socket.simProbeActive=probeTouchesPoint(socket.simPos);const greet=()=>{const c=activeConfig();controllerReply(socket,c.firmware==='grblhal'?"GrblHAL 1.1f ['$' for help]":"Grbl 1.1h ['$' for help]");};
  // Slightly defer the banner so gSender has time to finish opening the socket.
  setTimeout(greet,80);
  socket.on('close',()=>{machineClients.delete(socket);cancelMachineMotion(socket);});
  socket.on('data',chunk=>{for(const byte of chunk){const ch=String.fromCharCode(byte);if(byte===63){recordMachineTraffic('→','?');machineStatus(socket);continue;}if(byte===33){recordMachineTraffic('→','!');socket.simPaused=true;socket.simState='Hold:0';machineStatus(socket);continue;}if(byte===126){recordMachineTraffic('→','~');socket.simPaused=false;socket.simProgramMode=null;socket.simState=socket.simMotion?.state||'Idle';machineStatus(socket);startNextMachineMotion(socket);continue;}if(byte===24){recordMachineTraffic('→','[CTRL-X]');cancelMachineMotion(socket);resetMachineParser(socket);socket.simPos=[0,0,0];socket.simPlannedPos=[0,0,0];socket.simState='Idle';greet();machineStatus(socket);continue;}if(byte===133){recordMachineTraffic('→','[0x85 realtime]');if(socket.simMotion?.state==='Jog'){cancelMachineMotion(socket);socket.simState='Idle';machineStatus(socket);}continue;}if(byte===10||byte===13){const line=socket.simBuffer.trim();socket.simBuffer='';if(line)submitMachineLine(socket,line);continue;}if(byte>=32&&byte<=126)socket.simBuffer+=ch;}});
});
function handleMachineLine(socket,line){
  const c=activeConfig(),s=c.settings,command=line.replace(/\([^)]*\)/g,'').replace(/;.*$/,'').trim();
  if(!command||command==='%'){controllerReply(socket,'ok');return;}
  if(c.firmware==='grblhal'&&handleGrblHalEnumeration(command,s,settingDescriptions,reply=>controllerReply(socket,reply)))return;
  const machineIdle=['Idle','Alarm'].includes(socket.simState||'Idle');
  if(command==='$$'){if(!machineIdle){recordMachineDiagnostic({kind:'busy-settings-read',command,state:socket.simState});controllerReply(socket,'error:8');return;}for(const [key,value] of Object.entries(s).sort((a,b)=>Number(a[0].slice(1))-Number(b[0].slice(1))))controllerReply(socket,`${key}=${value} (${settingDescriptions[key]||'Controller setting'})`);controllerReply(socket,'ok');return;}
  if(command==='$I'){controllerReply(socket,c.firmware==='grblhal'?'[VER:1.1f.20260101:]':'[VER:1.1h.20260101:]');controllerReply(socket,'[OPT:V,15,128]');controllerReply(socket,'ok');return;}
  if(command==='$G'){const modes=[socket.simMotionMode||'G0',socket.simWcs||'G54',socket.simPlane||'G17',socket.simUnits===25.4?'G20':'G21',socket.simAbsolute?'G90':'G91',socket.simFeedMode||'G94',socket.simCutterComp||'G40',socket.simSpindleMode||'M5',socket.simCoolant||'M9',`T${socket.simTool||0}`,`F${socket.simFeed||0}`,`S${socket.simSpindleSpeed||0}`];if(socket.simTlo)modes.push('G43.1');if(socket.simPathControl)modes.push(socket.simPathControl);controllerReply(socket,`[GC:${modes.join(' ')}]`);controllerReply(socket,'ok');return;}
  if(command==='$#'){for(const id of ['G54','G55','G56','G57','G58','G59'])controllerReply(socket,`[${id}:${(socket.simOffsets[id]||[0,0,0]).map(v=>v.toFixed(3)).join(',')}]`);for(const id of ['G28','G30'])controllerReply(socket,`[${id}:${(socket.simStoredPositions[id]||[0,0,0]).map(v=>v.toFixed(3)).join(',')}]`);controllerReply(socket,`[G92:${socket.simG92.map(v=>v.toFixed(3)).join(',')}]`);controllerReply(socket,`[TLO:${Number(socket.simTlo||0).toFixed(3)}]`);controllerReply(socket,`[PRB:${socket.simLastProbe.map(v=>v.toFixed(3)).join(',')}:${socket.simProbeSuccess?1:0}]`);controllerReply(socket,'ok');return;}
  if(command==='$N'){controllerReply(socket,'[N0:]');controllerReply(socket,'[N1:]');controllerReply(socket,'ok');return;}
  if(command==='$C'){socket.simCheckMode=!socket.simCheckMode;controllerReply(socket,`[MSG:${socket.simCheckMode?'Enabled':'Disabled'}]`);controllerReply(socket,'ok');return;}
  if(command==='$'){controllerReply(socket,"[HLP:$$ $# $G $I $N $x=val $x=value]");controllerReply(socket,'ok');return;}
  if(command==='$X'){socket.simState='Idle';socket.simPaused=false;controllerReply(socket,'ok');machineStatus(socket);return;}
  if(command==='$H'){if((Number(s.$22)||0)&1){startHoming(socket,s);return;}controllerReply(socket,'error:5');return;}
  const settingWrite=command.match(/^\$(\d+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$/);
  if(settingWrite){if(!machineIdle){recordMachineDiagnostic({kind:'busy-setting-write',command,state:socket.simState});controllerReply(socket,'error:8');return;}const key=`$${settingWrite[1]}`,value=settingWrite[2];try{s[key]=value;persistMachineConfigs();controllerReply(socket,'ok');}catch{controllerReply(socket,'error:1');}return;}
  if(command.startsWith('$J=')){handleMachineGcode(socket,command.slice(3),true);return;}
  const numbered=command.replace(/^\//,'').replace(/^N\d+\s*/i,'').replace(/\*\d+\s*$/,'').trim();if(!numbered){controllerReply(socket,'ok');return;}
  if(/^(G|M|T|S|F|X|Y|Z|I|J|K|R|P|L|N)/i.test(numbered)){handleMachineGcode(socket,numbered,false);return;}
  if(command.startsWith('[')){controllerReply(socket,'ok');return;}
  controllerReply(socket,command.startsWith('$')?'error:3':'error:20');
}
function cancelMachineMotion(socket){if(socket.simMotionTimer){clearInterval(socket.simMotionTimer);socket.simMotionTimer=null;}socket.simMotion=null;socket.simQueue=[];socket.simPendingLines=[];socket.simPaused=false;socket.simPlannedPos=[...(socket.simPos||[0,0,0])];}
function submitMachineLine(socket,line){recordMachineTraffic('→',line);if(socket.simPendingLines.length||socket.simQueue.length>=machinePlannerQueueLimit){socket.simPendingLines.push(line);return;}handleMachineLine(socket,line);}
function processPendingMachineLines(socket){while(!socket.destroyed&&!socket.simPaused&&socket.simPendingLines.length&&socket.simQueue.length<machinePlannerQueueLimit){const line=socket.simPendingLines.shift();handleMachineLine(socket,line);}}
function resetMachineParser(socket){socket.simWcs='G54';socket.simG92=[0,0,0];socket.simTlo=0;socket.simAbsolute=true;socket.simUnits=1;socket.simArcCenterMode='G91.1';socket.simPlane='G17';socket.simFeedMode='G94';socket.simPathControl='G61';socket.simCutterComp='G40';socket.simMotionMode='G0';socket.simFeed=0;socket.simSpindleMode='M5';socket.simSpindleSpeed=0;socket.simCoolant='M9';socket.simTool=0;socket.simProgramMode=null;}
function motionDuration(from,to,feed,rapidSettings){if(rapidSettings){let duration=0;for(let i=0;i<3;i++){const distance=Math.abs(to[i]-from[i]);if(!distance)continue;const rate=Number(rapidSettings[i]);if(!(rate>0))return null;duration=Math.max(duration,distance*60000/rate);}return duration;}const distance=Math.hypot(to[0]-from[0],to[1]-from[1],to[2]-from[2]);return feed>0?distance*60000/feed:null;}
function planeDefinition(plane){return plane==='G18'?{u:2,v:0,w:1,offsetU:'K',offsetV:'I'}:plane==='G19'?{u:1,v:2,w:0,offsetU:'J',offsetV:'K'}:{u:0,v:1,w:2,offsetU:'I',offsetV:'J'};}
function buildArcPath(from,target,words,plane,clockwise,units,settings){const axes=planeDefinition(plane),value=letter=>words.find(([key])=>key===letter)?.[1],offsetU=value(axes.offsetU),offsetV=value(axes.offsetV),radiusWord=value('R');let cu,cv,radius;
  if(offsetU!==undefined&&offsetV!==undefined){cu=from[axes.u]+offsetU*units;cv=from[axes.v]+offsetV*units;radius=Math.hypot(from[axes.u]-cu,from[axes.v]-cv);}
  else if(radiusWord!==undefined){const dx=target[axes.u]-from[axes.u],dy=target[axes.v]-from[axes.v],chord=Math.hypot(dx,dy),r=Math.abs(radiusWord*units);if(!chord||chord>2*r+1e-9)return{error:'34'};const h=Math.sqrt(Math.max(0,r*r-chord*chord/4)),mx=(from[axes.u]+target[axes.u])/2,my=(from[axes.v]+target[axes.v])/2,px=-dy/chord,py=dx/chord,centers=[[mx+h*px,my+h*py],[mx-h*px,my-h*py]],wantsMajor=radiusWord<0;let chosen=null;for(const center of centers){const a0=Math.atan2(from[axes.v]-center[1],from[axes.u]-center[0]),a1=Math.atan2(target[axes.v]-center[1],target[axes.u]-center[0]);let sw=a1-a0;if(clockwise){while(sw>=0)sw-=Math.PI*2;}else{while(sw<=0)sw+=Math.PI*2;}if((Math.abs(sw)>Math.PI+1e-7)===wantsMajor){chosen={center,a0,sw};break;}if(!chosen)chosen={center,a0,sw};}if(!chosen)return{error:'34'};[cu,cv]=chosen.center;radius=r;}
  else return{error:'35'};if(!(radius>1e-9))return{error:'33'};const startAngle=Math.atan2(from[axes.v]-cv,from[axes.u]-cu),endAngle=Math.atan2(target[axes.v]-cv,target[axes.u]-cu);let sweep=endAngle-startAngle;if(clockwise){while(sweep>=0)sweep-=Math.PI*2;}else{while(sweep<=0)sweep+=Math.PI*2;}const endRadius=Math.hypot(target[axes.u]-cu,target[axes.v]-cv),radiusDelta=Math.abs(radius-endRadius),radiusTolerance=Math.max(0.005,Math.min(0.5,radius*0.001));if(radiusDelta>radiusTolerance)return{error:'34',debug:{plane,from:[...from],target:[...target],center:[cu,cv],radius,endRadius,radiusDelta,radiusTolerance}};const planarLength=radius*Math.abs(sweep),length=Math.hypot(planarLength,target[axes.w]-from[axes.w]);return{axes,cU:cu,cV:cv,radius,startAngle,sweep,length};}
function motionProfile(from,target,requestedDuration,settings,pathDistance){const distance=pathDistance??Math.hypot(...target.map((value,i)=>value-from[i]));if(distance<1e-9)return{duration:Math.max(1,requestedDuration),distance,acceleration:0,peakSpeed:0,accelTime:0,cruiseTime:0};const maxSpeed=distance*1000/Math.max(1,requestedDuration),limits=[settings.$120,settings.$121,settings.$122].map(Number);let acceleration=Infinity;for(let i=0;i<3;i++){const delta=Math.abs(target[i]-from[i]);if(delta)acceleration=Math.min(acceleration,pathDistance?limits[i]:limits[i]*distance/delta);}if(!(acceleration>0)||!Number.isFinite(acceleration))return{duration:Math.max(1,requestedDuration),distance,acceleration:0,peakSpeed:maxSpeed,accelTime:0,cruiseTime:requestedDuration/1000};const accelTime=Math.min(maxSpeed/acceleration,Math.sqrt(distance/acceleration)),peakSpeed=accelTime*acceleration,accelDistance=0.5*acceleration*accelTime*accelTime,cruiseTime=Math.max(0,(distance-2*accelDistance)/peakSpeed),duration=(2*accelTime+cruiseTime)*1000;return{duration:Math.max(1,duration),distance,acceleration,peakSpeed,accelTime,cruiseTime};}
function motionProgress(move){if(move.elapsed>=move.duration)return 1;if(!move.acceleration||!move.distance)return move.elapsed/move.duration;const seconds=move.elapsed/1000;if(seconds<move.accelTime)return Math.min(1,0.5*move.acceleration*seconds*seconds/move.distance);if(seconds<move.accelTime+move.cruiseTime)return Math.min(1,(0.5*move.acceleration*move.accelTime*move.accelTime+move.peakSpeed*(seconds-move.accelTime))/move.distance);const remaining=Math.max(0,(move.duration-move.elapsed)/1000);return Math.max(0,1-0.5*move.acceleration*remaining*remaining/move.distance);}
function enqueueMachineMotion(socket,target,duration,state='Run',onComplete=null,path=null){if(socket.simQueue.length>=64){controllerReply(socket,'error:8');return false;}const from=[...(socket.simPlannedPos||socket.simPos)],profile=motionProfile(from,target,Math.max(1,duration),activeConfig().settings,path?.length);socket.simQueue.push({from,target:[...target],...profile,state,onComplete,arc:path&&!path.error?path:null});socket.simPlannedPos=[...target];startNextMachineMotion(socket);return true;}
function motionPosition(move,progress){if(!move.arc)return move.from.map((value,i)=>value+(move.target[i]-value)*progress);const angle=move.arc.startAngle+move.arc.sweep*progress,pos=move.from.map((value,i)=>value+(move.target[i]-value)*progress);pos[move.arc.axes.u]=move.arc.cU+move.arc.radius*Math.cos(angle);pos[move.arc.axes.v]=move.arc.cV+move.arc.radius*Math.sin(angle);return pos;}
function startNextMachineMotion(socket){if(socket.destroyed||socket.simPaused||socket.simMotion||!socket.simQueue.length)return;const move=socket.simQueue.shift();move.elapsed=0;move.lastTick=Date.now();socket.simMotion=move;socket.simState=move.state;machineStatus(socket);socket.simMotionTimer=setInterval(()=>{if(socket.destroyed){cancelMachineMotion(socket);return;}const now=Date.now();if(!socket.simPaused){move.elapsed+=now-move.lastTick;const t=motionProgress(move);socket.simPos=motionPosition(move,t);socket.simProbeActive=probeTouchesPoint(socket.simPos);machineStatus(socket);if(t>=1){clearInterval(socket.simMotionTimer);socket.simMotionTimer=null;socket.simPos=[...move.target];socket.simMotion=null;socket.simProbeActive=probeTouchesPoint(socket.simPos);const continuing=move.onComplete?.()===true;processPendingMachineLines(socket);if(!continuing&&!socket.simPaused&&socket.simState!=='Alarm'&&!socket.simMotion&&!socket.simQueue.length){socket.simState='Idle';socket.simPlannedPos=[...socket.simPos];}machineStatus(socket);startNextMachineMotion(socket);}}move.lastTick=now;},50);}
function handleMachineGcode(socket,command,isJog){
  const config=activeConfig(),settings=config.settings,words=[...command.matchAll(/([A-Z])\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi)].map(([,letter,value])=>[letter.toUpperCase(),Number(value)]),gCodes=words.filter(([letter])=>letter==='G').map(([,value])=>value),mCodes=words.filter(([letter])=>letter==='M').map(([,value])=>value),word=letter=>words.find(([key])=>key===letter)?.[1],all=letter=>words.filter(([key])=>key===letter).map(([,value])=>value),has=code=>gCodes.some(value=>Math.abs(value-code)<1e-8),near=(a,b)=>Math.abs(a-b)<1e-8;
  if(!words.length){controllerReply(socket,'error:2');return;}
  const supported=[0,1,2,3,4,10,17,18,19,20,21,28,28.1,30,30.1,38.2,38.3,38.4,38.5,40,43.1,49,53,54,55,56,57,58,59,61,80,90,91,91.1,92,92.1,93,94];if(gCodes.some(code=>!supported.some(value=>near(code,value)))){controllerReply(socket,'error:20');return;}if(gCodes.some(code=>near(code,90.1))){controllerReply(socket,'error:20');return;}
  if(mCodes.some(code=>![0,1,2,3,4,5,6,7,8,9,30,61].some(value=>near(code,value)))){controllerReply(socket,'error:20');return;}
  if(isJog&&gCodes.some(code=>[4,10,28,28.1,30,30.1,38.2,38.3,38.4,38.5,43.1,49,53,80,92,92.1].some(value=>near(code,value)))){controllerReply(socket,'error:20');return;}
  const unitsWord=gCodes.find(code=>near(code,20)||near(code,21));if(unitsWord!==undefined)socket.simUnits=near(unitsWord,20)?25.4:1;const units=socket.simUnits;
  if(gCodes.some(code=>near(code,90.1))){controllerReply(socket,'error:20');return;}if(has(90))socket.simAbsolute=true;if(has(91))socket.simAbsolute=false;if(has(91.1))socket.simArcCenterMode='G91.1';if(has(17))socket.simPlane='G17';if(has(18))socket.simPlane='G18';if(has(19))socket.simPlane='G19';if(has(93))socket.simFeedMode='G93';if(has(94))socket.simFeedMode='G94';if(has(61))socket.simPathControl='G61';if(has(40))socket.simCutterComp='G40';
  for(let i=0;i<6;i++)if(has(54+i))socket.simWcs=`G${54+i}`;const motion=[0,1,2,3,38.2,38.3,38.4,38.5,80].find(code=>has(code));if(motion!==undefined)socket.simMotionMode=motion===80?'G80':`G${motion}`;
  const tool=word('T'),spindle=word('S');if(tool!==undefined)socket.simTool=Math.trunc(tool);if(spindle!==undefined)socket.simSpindleSpeed=spindle;
  if(has(43.1)){if(word('Z')===undefined){controllerReply(socket,'error:26');return;}socket.simTlo=word('Z')*units;controllerReply(socket,'ok');machineStatus(socket);return;}if(has(49))socket.simTlo=0;
  if(mCodes.some(code=>near(code,3)))socket.simSpindleMode='M3';if(mCodes.some(code=>near(code,4)))socket.simSpindleMode='M4';if(mCodes.some(code=>near(code,5)))socket.simSpindleMode='M5';if(mCodes.some(code=>near(code,7)))socket.simCoolant='M7';if(mCodes.some(code=>near(code,8)))socket.simCoolant='M8';if(mCodes.some(code=>near(code,9)))socket.simCoolant='M9';
  const feedWord=word('F');if(feedWord!==undefined)socket.simFeed=socket.simFeedMode==='G93'?feedWord:feedWord*units;
  const axes=words.filter(([letter])=>'XYZ'.includes(letter)),axisValues=Object.fromEntries(axes),from=[...(socket.simPlannedPos||socket.simPos)],wco=socket.simOffsets[socket.simWcs]||[0,0,0];
  if(has(28.1)||has(30.1)){const id=has(28.1)?'G28':'G30';socket.simStoredPositions[id]=[...socket.simPlannedPos];controllerReply(socket,'ok');return;}
  if(has(92.1)){socket.simG92=[0,0,0];controllerReply(socket,'ok');machineStatus(socket);return;}
  if(has(10)){const l=word('L'),p=word('P');if(p===undefined||![2,20].some(value=>near(l,value))){controllerReply(socket,'error:28');return;}if(!axes.length){controllerReply(socket,'error:26');return;}const id=`G${53+Math.max(1,Math.min(6,Math.trunc(p)))}`,offset=[...(socket.simOffsets[id]||[0,0,0])];for(const [letter,value] of axes){const i='XYZ'.indexOf(letter),n=value*units;offset[i]=near(l,2)?n:(from[i]-n-(socket.simG92[i]||0)-(i===2?socket.simTlo:0));}socket.simOffsets[id]=offset;controllerReply(socket,'ok');return;}
  if(has(92)){if(!axes.length){controllerReply(socket,'error:26');return;}for(const [letter,value] of axes){const i='XYZ'.indexOf(letter);socket.simG92[i]=from[i]-value*units-wco[i]-(i===2?socket.simTlo:0);}controllerReply(socket,'ok');machineStatus(socket);return;}
  const g28=has(28),g30=has(30);if(g28||g30){const id=g28?'G28':'G30',stored=socket.simStoredPositions[id]||[0,0,0],targets=[];if(axes.length){const intermediate=[...from];for(const [letter,value] of axes){const i='XYZ'.indexOf(letter),n=value*units;intermediate[i]=socket.simAbsolute?n+wco[i]+(socket.simG92[i]||0)+(i===2?socket.simTlo:0):from[i]+n;}targets.push(intermediate);}targets.push([...stored]);for(const target of targets){const start=[...(socket.simPlannedPos||socket.simPos)],duration=motionDuration(start,target,0,[settings.$110,settings.$111,settings.$112]);if(duration===null){controllerReply(socket,'error:2');return;}enqueueMachineMotion(socket,target,duration,'Run');}controllerReply(socket,'ok');return;}
  if(has(4)){const p=word('P');if(p===undefined||p<0){controllerReply(socket,'error:28');return;}const duration=Math.max(1,p*1000);if(enqueueMachineMotion(socket,from,duration,'Run'))controllerReply(socket,'ok');return;}
  const g53=has(53),explicitLinear=gCodes.some(code=>near(code,0)||near(code,1));if(g53&&!explicitLinear){controllerReply(socket,'error:30');return;}
  if(socket.simMotionMode==='G80'&&axes.length){controllerReply(socket,'error:31');return;}if(!axes.length){if(mCodes.some(code=>near(code,0)||near(code,1))){socket.simProgramMode=near(mCodes.find(code=>near(code,0)||near(code,1)),0)?'M0':'M1';socket.simPaused=true;socket.simState='Hold:0';controllerReply(socket,'ok');machineStatus(socket);return;}if(mCodes.some(code=>near(code,2)||near(code,30))){socket.simProgramMode=near(mCodes.find(code=>near(code,2)||near(code,30)),2)?'M2':'M30';socket.simQueue=[];socket.simPendingLines=[];socket.simPlannedPos=[...socket.simPos];socket.simState='Idle';controllerReply(socket,'ok');machineStatus(socket);return;}controllerReply(socket,'ok');return;}
  if(socket.simCheckMode){controllerReply(socket,'ok');return;}
  const relative=isJog?/G91(?=[^0-9.]|$)/i.test(command):!socket.simAbsolute&&!g53,target=[...from];for(const [letter,value] of axes){const i='XYZ'.indexOf(letter),n=value*units;target[i]=relative?from[i]+n:(g53?n:n+wco[i]+(socket.simG92[i]||0)+(i===2?socket.simTlo:0));}
  const mode=isJog?'G1':socket.simMotionMode||'G0',arc=mode==='G2'||mode==='G3',probe=['G38.2','G38.3','G38.4','G38.5'].includes(mode),probeAway=mode==='G38.4'||mode==='G38.5';let duration,path=null,probeResult=null;
  if(probe){const start=stockPoint(from),end=stockPoint(target),radius=stockProbeRadius(),activeAtStart=probeTouchesPoint(from);if(!probeAway&&activeAtStart){cancelMachineMotion(socket);socket.simState='Alarm';controllerReply(socket,'ALARM:4');machineStatus(socket);return;}if(probeAway){const release=activeAtStart?findProbeRelease(start,end,point=>probeTouchesPoint(point.toArray())):null;if(release)target.splice(0,3,...release.toArray());const released=Boolean(activeAtStart&&release);probeResult={triggered:Boolean(activeAtStart&&!released),success:released,alarmOnFailure:mode==='G38.4'};}else{const contact=findProbeContact(start,end,radius);if(contact)target.splice(0,3,...contact.toArray());probeResult={triggered:Boolean(contact),success:Boolean(contact),alarmOnFailure:mode==='G38.2'};}}
  if(arc){path=buildArcPath(from,target,words,socket.simPlane,mode==='G2',units,settings);if(path.error){if(path.debug)recordMachineDiagnostic({kind:'arc-reject',command,firmware:config.firmware,state:socket.simState,debug:path.debug});controllerReply(socket,`error:${path.error}`);return;}}
  let feed=feedWord===undefined?socket.simFeed:(socket.simFeedMode==='G93'?feedWord:feedWord*units);if(isJog&&!feedWord){feed=Infinity;const distance=Math.hypot(...target.map((v,i)=>v-from[i])),caps=[settings.$110,settings.$111,settings.$112].map(Number);for(let i=0;i<3;i++){const delta=Math.abs(target[i]-from[i]);if(delta)feed=Math.min(feed,caps[i]*distance/delta);}}
  if(mode==='G0')duration=motionDuration(from,target,0,[settings.$110,settings.$111,settings.$112]);else if(feed>0)duration=socket.simFeedMode==='G93'&&!isJog?60000/feed:(arc?path.length:Math.hypot(...target.map((v,i)=>v-from[i])))*60000/feed;else{controllerReply(socket,'error:22');return;}
  if(duration===null){controllerReply(socket,mode==='G0'?'error:2':'error:22');return;}
  const probeCallback=probe?()=>{const triggered=Boolean(probeResult?.triggered);socket.simLastProbe=[...socket.simPos];socket.simProbeSuccess=triggered;socket.simProbeActive=probeTouchesPoint(socket.simPos);controllerReply(socket,`[PRB:${socket.simLastProbe.map(v=>v.toFixed(3)).join(',')}:${triggered?1:0}]`);machineStatus(socket);if(!probeResult?.success&&probeResult?.alarmOnFailure){socket.simQueue=[];socket.simPendingLines=[];socket.simPlannedPos=[...socket.simPos];socket.simState='Alarm';controllerReply(socket,'ALARM:5');machineStatus(socket);}return false;}:null;
  const pause=mCodes.some(code=>near(code,0)||near(code,1)),end=mCodes.some(code=>near(code,2)||near(code,30)),callback=probeCallback||((pause||end)?()=>{if(pause){socket.simProgramMode=near(mCodes.find(code=>near(code,0)||near(code,1)),0)?'M0':'M1';socket.simPaused=true;socket.simState='Hold:0';}if(end){socket.simProgramMode=near(mCodes.find(code=>near(code,2)||near(code,30)),2)?'M2':'M30';socket.simQueue=[];socket.simPendingLines=[];socket.simPlannedPos=[...socket.simPos];}return false;}:null);
  if(enqueueMachineMotion(socket,target,duration,probe?'Run':isJog?'Jog':'Run',callback,path)){if(arc)recordMachineDiagnostic({kind:'arc-queued',command,firmware:config.firmware,plannedStart:from,target,center:[path.cU,path.cV],radius:path.radius,queueDepth:socket.simQueue.length});controllerReply(socket,'ok');}
}
function startHoming(socket,settings){
  cancelMachineMotion(socket);
  const enabled=Number(settings.$22)||0,dir=Number(settings.$23)||0,
    travel=[settings.$130,settings.$131,settings.$132].map(Number),
    seek=Number(settings.$25)||0,locate=Number(settings.$24)||0,
    pull=Math.max(0,Number(settings.$27)||0),debounce=Math.max(0,Number(settings.$26)||0);
  socket.simState='Home';socket.simLimitPins=[false,false,false];
  const groups=[[2],[0,1]];let group=0;
  const finish=()=>{socket.simLimitPins=[false,false,false];socket.simState='Idle';socket.simPlannedPos=[...socket.simPos];controllerReply(socket,'ok');machineStatus(socket);};
  const runGroup=()=>{
    if(group>=groups.length){finish();return;}
    const axes=groups[group++],searchTarget=[...socket.simPos],searchRates=[0,0,0];
    for(const i of axes){searchTarget[i]=(dir&(1<<i))?-Math.abs(travel[i]):Math.abs(travel[i]);searchRates[i]=seek;}
    const searchDuration=motionDuration(socket.simPos,searchTarget,0,searchRates);
    if(searchDuration===null){controllerReply(socket,'error:2');finish();return;}
    enqueueMachineMotion(socket,searchTarget,searchDuration,'Home',()=>{
      // The limit switch is machine zero. Locate away, return to the switch,
      // then pull off in the negative machine-coordinate direction.
      for(const i of axes){socket.simPos[i]=0;socket.simLimitPins[i]=true;}
      socket.simPlannedPos=[...socket.simPos];machineStatus(socket);
      setTimeout(()=>{
        const locateTarget=[...socket.simPos],locateRates=[0,0,0];
        for(const i of axes){locateTarget[i]=(dir&(1<<i))?1:-1;locateRates[i]=locate;}
        const locateDuration=motionDuration(socket.simPos,locateTarget,0,locateRates);
        if(locateDuration===null){finish();return;}
        enqueueMachineMotion(socket,locateTarget,locateDuration,'Home',()=>{
          for(const i of axes)socket.simPos[i]=0;
          socket.simPlannedPos=[...socket.simPos];
          const pullTarget=[...socket.simPos],pullRates=[0,0,0];
          for(const i of axes){pullTarget[i]=-pull;pullRates[i]=seek;socket.simLimitPins[i]=false;}
          const pullDuration=motionDuration(socket.simPos,pullTarget,0,pullRates);
          if(pullDuration===null){finish();return;}
          enqueueMachineMotion(socket,pullTarget,pullDuration,'Home',()=>{
            for(const i of axes)socket.simPos[i]=-pull;
            socket.simPlannedPos=[...socket.simPos];runGroup();return true;
          });
          return true;
        });
      },debounce);
      return true;
    });
  };
  if(!groups.length){controllerReply(socket,'error:5');return;}
  runGroup();
}
tcpServer.listen(tcpPort,'127.0.0.1',()=>console.log(`GRBL machine simulator TCP: 127.0.0.1:${tcpPort}`));
function unpackPlugin(buffer,originalname){
    const zip=new AdmZip(buffer), entries=zip.getEntries().map(entry=>({entry,name:entry.entryName.replaceAll('\\','/')}));
    const index=entries.find(e=>/(^|\/)ui\/index\.html$/i.test(e.name));
    if(!index)throw new Error('This ZIP does not contain a built plugin ui/index.html. Build/package the plugin first.');
    const uiRoot=index.name.slice(0,-'index.html'.length);
    const files=new Map();let total=0;
    for(const {entry,name} of entries){
      if(entry.isDirectory||!name.startsWith(uiRoot))continue;
      const rel=name.slice(uiRoot.length);
      if(!rel||rel.startsWith('/')||rel.split('/').some(p=>p==='..'||p==='.'||!p))continue;
      total+=entry.header.size;if(total>120*1024*1024)throw new Error('The unpacked plugin exceeds the 120 MB limit.');
      files.set(rel,entry.getData());
    }
    if(!files.has('index.html'))throw new Error('Plugin entry page is missing.');
    const manifestEntry=entries.find(e=>/(^|\/)gsender-plugin\.json$/i.test(e.name))?.entry;
    let manifest={name:path.basename(originalname,'.zip')};
    if(manifestEntry){try{manifest=JSON.parse(manifestEntry.getData().toString('utf8'));}catch{}}
    return {files,info:{name:manifest.name||path.basename(originalname,'.zip'),url:'/installed/index.html'}};
}
try{if(fs.existsSync(statePath('plugin.saved'))){const saved=readFile('plugin.saved');const plugin=unpackPlugin(saved.buffer,saved.name);installedFiles=plugin.files;installedPlugin=plugin.info;}}catch(error){console.warn('Could not restore plugin:',error.message);}
app.post('/api/install',upload.single('plugin'),(req,res)=>{
  try{
    if(!req.file)throw new Error('Choose a plugin ZIP file.');
    const plugin=unpackPlugin(req.file.buffer,req.file.originalname);
    saveAtomic('plugin.saved',packFile(req.file.originalname,req.file.buffer));
    installedFiles=plugin.files;installedPlugin=plugin.info;
    res.json(plugin.info);
  }catch(error){res.status(400).json({error:error.message});}
});
app.get('/api/session',(_req,res)=>{let model=null,settings=null;try{model={name:readFile('model.saved').name};}catch{}try{settings=fs.readFileSync(statePath('settings.txt'),'utf8');}catch{}res.json({plugin:installedPlugin,model,settings});});
app.post('/api/session/model',upload.single('model'),(req,res)=>{try{if(!req.file)throw new Error('Choose a model.');const name=path.basename(req.file.originalname);if(!/\.(stl|step|stp)$/i.test(name))throw new Error('Choose an STL or STEP model.');saveAtomic('model.saved',packFile(name,req.file.buffer));res.json({ok:true});}catch(error){res.status(400).json({error:error.message});}});
app.get('/api/session/model',(_req,res)=>{try{res.type('application/octet-stream').send(readFile('model.saved').buffer);}catch{return res.sendStatus(404);}});
app.post('/api/session/settings',upload.single('settings'),(req,res)=>{try{if(!req.file)throw new Error('Choose a settings file.');const text=req.file.buffer.toString('utf8');if(!/^\$\d+\s*=\s*-?\d+(?:\.\d+)?/m.test(text))throw new Error('No GRBL $$ settings found in this file.');saveAtomic('settings.txt',text);res.json({ok:true});}catch(error){res.status(400).json({error:error.message});}});
app.use('/installed',(req,res)=>{let rel;try{rel=decodeURIComponent(req.path).replace(/^\/+/, '');}catch{return res.sendStatus(400);}const data=installedFiles.get(rel);if(!data)return res.sendStatus(404);res.type(path.extname(rel)||'application/octet-stream');res.set('Cache-Control','no-store');res.send(data);});
app.get('/plugin-sdk/index.js',(_req,res)=>res.sendFile(path.join(here,'public/sim-sdk/index.js')));
app.get('/plugin-sdk/react.js',(_req,res)=>res.sendFile(path.join(here,'public/sim-sdk/index.js')));
app.get('/plugin-sdk/viewer.js',(_req,res)=>res.sendFile(path.join(here,'public/sim-sdk/index.js')));
const vite=await createViteServer({server:{middlewareMode:true},appType:'spa'});
app.use(vite.middlewares);
const port=Number(process.env.SIMULATOR_PORT)||4176;const webServer=app.listen(port,'127.0.0.1',()=>console.log(`gSender Machine Simulator: http://127.0.0.1:${port}/machine`));
