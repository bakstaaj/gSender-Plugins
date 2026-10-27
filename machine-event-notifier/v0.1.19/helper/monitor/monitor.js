import fs from 'node:fs';
import path from 'node:path';
import { io } from 'socket.io-client';

const dataDir = process.env.GSENDER_EMAIL_DATA || path.join(process.env.ProgramData || 'C:\\ProgramData', 'Bakstaaj', 'MachineEventEmailNotifier');
const configPath = path.join(dataDir, 'monitor-config.json');
const statusPath = path.join(dataDir, 'monitor-status.json');
const apiUrl = process.env.GSENDER_EMAIL_API || 'http://127.0.0.1:1985';
const labels = { jobEnd: 'Job ended', machineAlarm: 'Machine alarm', toolChange: 'Tool change', jobStart: 'Job started', pause: 'Job paused', resume: 'Job resumed', disconnect: 'Controller disconnected' };
let config = {};
let socket;
let jobActive = false;
let workflow = '';
let alarmActive = false;
let currentJob = '';
let lastEvent = null;
let lastError = '';
let connected = false;
let socketEvents = 0;
let activeController = null;
let subscribedPort = '';

function writeStatus(message = '') {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({ remoteConnected: connected, remoteUrl: config.remoteUrl || '', activeController, message: message || lastError || (connected ? 'Connected to gSender Wireless Control.' : 'Waiting for gSender Wireless Control.'), socketEvents, lastEvent, updatedAt: new Date().toISOString() }, null, 2));
}
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}
function textOf(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
async function sendAlert(key, eventName, args) {
  if (!config.events?.[key]) return;
  const event = { event: labels[key], key, occurredAt: new Date().toISOString(), job: currentJob, details: { sourceEvent: eventName, payload: args } };
  try {
    const response = await fetch(`${apiUrl}/api/monitor-event`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Monitor-Token': config.monitorToken || '' }, body: JSON.stringify(event) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const delivered = Object.entries(result.channels || {}).filter(([, state]) => state === 'sent').map(([channel]) => channel);
    lastEvent = { key, label: labels[key], at: event.occurredAt, result: result.message || (delivered.length ? `sent via ${delivered.join(' and ')}` : 'sent') };
    lastError = '';
    console.log(`[alert] ${labels[key]} sent via ${delivered.join(' and ') || 'configured channel'}`);
  } catch (error) {
    lastEvent = { key, label: labels[key], at: event.occurredAt, result: 'failed', error: error.message };
    lastError = `Alert delivery failed: ${error.message}`;
    console.error(`[alert] ${labels[key]} failed: ${error.message}`);
  }
  writeStatus();
}
function walkForAlarm(value) {
  const text = textOf(value);
  const match = text.match(/(?:ALARM:\s*\d+|<Alarm(?:\||>))/i);
  return match ? match[0] : '';
}
function classify(eventName, args) {
  const name = String(eventName).toLowerCase();
  const payloadText = textOf(args).toLowerCase();
  const alarmState = /["']?(?:state|status)["']?\s*:\s*["']alarm(?:["']|\b)/i.test(payloadText);
  if (/alarm|fault/.test(name) || walkForAlarm(args) || alarmState) {
    if (!alarmActive) { alarmActive = true; void sendAlert('machineAlarm', eventName, args); }
    return;
  }
  if (/status|workflow/.test(name) && !payloadText.includes('alarm')) alarmActive = false;
  if (/job[:_-](start|started)|job:start/.test(name)) {
    jobActive = true;
    const jobData = args.find(value => value && typeof value === 'object') || {};
    currentJob = jobData.name || jobData.fileName || jobData.filename || jobData.path || jobData.file || textOf(args[0]).slice(0, 180);
    void sendAlert('jobStart', eventName, args); return;
  }
  if (/tool.?change/.test(name) && /(start|request|change|tool)/.test(payloadText + name)) { void sendAlert('toolChange', eventName, args); return; }
  if (/workflow:pause|job:pause|job:paused/.test(name)) { workflow = 'paused'; void sendAlert('pause', eventName, args); return; }
  if (/workflow:state/.test(name)) {
    const state = payloadText;
    if (/paused/.test(state) && workflow !== 'paused') void sendAlert('pause', eventName, args);
    if (/(running|active)/.test(state) && workflow === 'paused') void sendAlert('resume', eventName, args);
    workflow = /paused/.test(state) ? 'paused' : /running|active/.test(state) ? 'running' : workflow;
    return;
  }
  if (/job[:_-](stop|end|complete|completed)|job:stop/.test(name)) { if (jobActive) void sendAlert('jobEnd', eventName, args); jobActive = false; return; }
  if (/serialport:(close|disconnect)|controller:disconnect/.test(name)) { if (jobActive) void sendAlert('disconnect', eventName, args); jobActive = false; connected = false; writeStatus('Controller disconnected from gSender.'); }
}
function subscribeToActiveController(port) {
  if (!port || !socket?.connected) return;
  const portName = String(port);
  if (subscribedPort === portName) return;
  subscribedPort = portName;
  console.log(`[monitor] requesting Wireless Control event stream for active controller: ${portName}`);
  // Wireless Control clients subscribe to an already-open controller by emitting
  // `open` with its existing port. This attaches the socket to controller
  // events; it does not send G-code or motion commands.
  socket.emit('open', portName);
}
function attach(url) {
  if (!url || !/^https?:\/\//i.test(url)) { connected = false; lastError = 'Enter the gSender Wireless Control URL in the plugin.'; writeStatus(); return; }
  console.log(`[monitor] connecting to ${url}`);
  socket = io(url, { reconnection: true, reconnectionDelay: 1500, reconnectionDelayMax: 10000, timeout: 5000, transports: ['websocket', 'polling'] });
  socket.on('connect', () => { connected = true; subscribedPort = ''; lastError = ''; writeStatus('Connected to gSender Wireless Control.'); console.log('[monitor] Wireless Control connected'); socket.emit('list'); });
  socket.on('disconnect', reason => { connected = false; subscribedPort = ''; lastError = `Wireless Control disconnected: ${reason}`; writeStatus(); console.log(`[monitor] disconnected: ${reason}`); });
  socket.on('connect_error', error => { connected = false; lastError = `Wireless Control connection failed: ${error.message}`; writeStatus(); console.error(`[monitor] ${lastError}`); });
  // Wireless Control reports the active connection in its startup payload. Ethernet
  // controllers do not appear in serialport:list, so use either source to join
  // the existing controller event stream.
  socket.on('startup', state => {
    const active = state?.activeConnection;
    if (active?.port) {
      activeController = { port: active.port, baudrate: active.baudrate, controllerType: active.controllerType || '' };
      lastError = '';
      console.log(`[monitor] active controller reported by Wireless Control: ${activeController.port}`);
      subscribeToActiveController(activeController.port);
      writeStatus(`Wireless Control connected; active ${activeController.controllerType || 'controller'} at ${activeController.port}. Monitoring events.`);
    } else {
      activeController = null;
      writeStatus('Wireless Control connected; no active controller is reported by gSender.');
    }
  });
  socket.on('serialport:list', ports => {
    const all = (Array.isArray(ports) ? ports : Object.values(ports || {})).flat(Infinity);
    const active = all.find(port => port && (port.inUse || port.isOpen || port.active || port.connected));
    if (active) {
      const portName = active.port || active.path || active.name || active.serialport;
      if (portName) {
        activeController = { port: portName, controllerType: active.controllerType || '' };
        console.log(`[monitor] active controller reported in serialport list: ${portName}`);
        subscribeToActiveController(portName);
        writeStatus(`Wireless Control connected; active controller at ${portName}. Monitoring events.`);
      }
    } else if (!activeController) {
      lastError = 'gSender is reachable, but its Wireless Control did not report an active controller.';
      writeStatus();
    }
  });
  socket.onAny((eventName, ...args) => { socketEvents += 1; classify(eventName, args); if (socketEvents % 25 === 0) writeStatus(); });
}

function applyConfig() {
  const next = readConfig();
  const changed = next.remoteUrl !== config.remoteUrl;
  config = next;
  if (changed) { if (socket) socket.disconnect(); socket = null; connected = false; attach(config.remoteUrl); }
  else if (!socket) attach(config.remoteUrl);
  writeStatus();
}
console.log('[monitor] gSender machine event monitor starting');
applyConfig();
setInterval(applyConfig, 3000);
setInterval(() => writeStatus(), 10000);
process.on('SIGINT', () => { if (socket) socket.disconnect(); process.exit(0); });
process.on('SIGTERM', () => { if (socket) socket.disconnect(); process.exit(0); });
