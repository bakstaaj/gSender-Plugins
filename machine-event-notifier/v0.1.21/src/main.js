import { storage } from '@sienci/gsender-plugin-sdk';
import './style.css';

const $ = id => document.getElementById(id);
const DEFAULTS = {
  host: 'smtp.gmail.com', port: 587, tls: 'starttls', from: '', to: '', username: '',
  helperUrl: 'http://127.0.0.1:1985', remoteUrl: 'http://127.0.0.1:8000', token: '',
  ntfyEnabled: false, ntfyServer: 'https://ntfy.sh', ntfyTopic: '',
  events: { jobEnd: true, machineAlarm: true, toolChange: true, jobStart: false, pause: false, resume: false, disconnect: false }
};
const EVENT_INFO = {
  jobEnd: ['Job ended', 'When the CNC job finishes.'],
  machineAlarm: ['Machine alarm', 'When gSender reports a controller alarm.'],
  toolChange: ['Tool change', 'When the job requests a tool change.'],
  jobStart: ['Job started', 'When a CNC job begins.'],
  pause: ['Job paused', 'When the job enters a paused state.'],
  resume: ['Job resumed', 'When a paused job resumes.'],
  disconnect: ['Controller disconnected', 'If gSender loses its controller connection during a job.']
};
let cfg = { ...DEFAULTS, events: { ...DEFAULTS.events } };
let helperConfigLoaded = false;
const app = document.querySelector('#app');
app.innerHTML = `<header><div class="eyebrow">GSENDER TOOLS</div><h1>Machine Event Notifications</h1><p>Configure machine alerts once. The Windows helper watches gSender Wireless Control and sends notifications in the background, even when this page is closed.</p></header>
<section class="panel"><div class="heading"><div><div class="step">01 · ALERT EVENTS</div><h2>Choose which events send an alert</h2></div></div><div id="events" class="event-grid"></div></section>
<section class="panel"><div class="heading"><div><div class="step">02 · GSENDER CONNECTION</div><h2>Background event monitoring</h2></div><span class="badge" id="monitorBadge">Checking monitor…</span></div><label class="field">gSender Wireless Control address<input id="remoteUrl" spellcheck="false" placeholder="http://127.0.0.1:8000"></label><p class="help">Enable Wireless Control in gSender, set its address and port, then restart gSender. The helper connects to this event stream and does not issue CNC commands. Common default port: 8000.</p><div id="monitorDetails" class="status-box">Waiting for helper status.</div></section>
<section class="panel"><div class="heading"><div><div class="step">03 · EMAIL DELIVERY</div><h2>Email notifications (optional)</h2></div><span class="badge" id="helperBadge">Helper not connected</span></div><div class="fields"><label>SMTP server<input id="host"></label><label>Port<input id="port" type="number" min="1" max="65535"></label><label>Security<select id="tls"><option value="starttls">STARTTLS</option></select></label><label>From email address<input id="from" type="email"></label><label>SMTP username<input id="username" autocomplete="username"></label><label>Send alerts to<input id="to" type="email"></label><label class="wide">SMTP password / app password<input id="password" type="password" autocomplete="new-password" placeholder="Not saved yet"></label></div><p class="help">Gmail default: smtp.gmail.com, port 587, STARTTLS. Gmail SMTP requires an App Password before sending. <a id="appPasswordLink" href="https://myaccount.google.com/apppasswords">Create a Google App Password</a>. If gSender blocks the link, copy this URL into another browser: <code class="copyable-url">https://myaccount.google.com/apppasswords</code>. The password is sent only to the local helper.</p>
<section class="delivery-card"><div class="delivery-heading"><div><div class="step">04 · PHONE PUSH</div><h2>ntfy notifications</h2></div><div class="toggle-wrap"><label class="toggle"><input id="ntfyEnabled" type="checkbox"><span>Enable ntfy</span></label><small id="ntfyState" class="field-state"></small></div></div><p class="help">Install the ntfy app on your phone, then subscribe to the same server and topic below. The generated topic uses this computer’s name and the last number of its gSender IP address. Treat it as public on ntfy.sh; avoid putting sensitive details in alerts.</p><div class="ntfy-fields"><label>ntfy server<input id="ntfyServer" spellcheck="false" placeholder="https://ntfy.sh"></label><label class="topic-field">Topic name<input id="ntfyTopic" spellcheck="false" autocomplete="off" placeholder="Generate a computer topic"></label><button id="generateTopic" class="secondary">Generate computer topic</button></div><div class="actions"><button id="sendNtfyTest" class="secondary">Send test push</button></div><p class="help small-help">In the app, add a server subscription using this exact server URL and topic. The Windows helper sends alerts directly to ntfy over HTTPS. The topic is stored with the helper’s protected settings.</p></section>
<div class="helper-row"><label>Helper address<input id="helperUrl" spellcheck="false"></label><div class="pair-help">Pair with the helper installed on this computer. Pairing is accepted only from gSender Edge.</div><button id="pair" class="secondary">Pair helper</button></div><div id="notice" class="notice" role="status" aria-live="polite">Checking local helper…</div><div class="actions"><button id="save" class="primary">Save settings</button><button id="sendTest" class="secondary">Send test email</button><button id="refresh" class="text">Check helper</button></div><p class="help">Fields marked <strong>Saved</strong> were loaded from the Windows helper. A saved password is never shown; leave its box blank to keep it. Delivery settings and event preferences persist when you close gSender.</p></section>
<footer>Background monitoring · local Windows helper · no CNC commands are sent</footer>`;

$('events').innerHTML = Object.entries(EVENT_INFO).map(([key, [label, detail]]) => `<label class="event"><input type="checkbox" id="ev-${key}"><span><b>${label}</b><small>${detail}</small></span></label>`).join('');
const SAVED_FIELD_IDS = ['remoteUrl', 'host', 'port', 'tls', 'from', 'username', 'to', 'password', 'helperUrl', 'ntfyServer', 'ntfyTopic'];
for (const id of SAVED_FIELD_IDS) {
  const input = $(id), label = input?.closest('label');
  const text = label && [...label.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (!text) continue;
  const line = document.createElement('span'); line.className = 'field-label-line';
  const caption = document.createElement('span'); caption.textContent = text.textContent.trim();
  const state = document.createElement('small'); state.id = `state-${id}`; state.className = 'field-state';
  line.append(caption, state); text.replaceWith(line);
}
function notice(message, kind = 'info') { $('notice').textContent = message; $('notice').className = `notice ${kind}`; }
function fieldState(id, message, kind = '') { const state = $(`state-${id}`); if (!state) return; state.textContent = message; state.className = `field-state ${kind}`; $(id)?.classList.toggle('saved-input', kind === 'saved'); $(id)?.classList.toggle('dirty-input', kind === 'dirty'); }
function markSavedFields() {
  for (const id of SAVED_FIELD_IDS) fieldState(id, 'Saved', 'saved');
  fieldState('helperUrl', 'Saved on this device', 'saved');
  if (cfg.hasPassword) {
    $('password').placeholder = 'Saved in Windows Credential Manager · leave blank to keep';
    fieldState('password', 'Saved securely', 'saved');
  } else {
    $('password').placeholder = 'Not saved yet';
    fieldState('password', 'Not set', '');
  }
  $('ntfyState').textContent = 'Saved'; $('ntfyState').className = 'field-state saved';
}
function apiUrl(path) { return cfg.helperUrl.replace(/\/$/, '') + path; }
async function api(path, body, auth = true) {
  const base = new URL(cfg.helperUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw Error('Helper address must use local loopback HTTP.');
  const headers = { 'Content-Type': 'application/json' };
  if (auth && cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const response = await fetch(apiUrl(path), { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), mode: 'cors' });
  let result = {}; try { result = await response.json(); } catch { }
  if (!response.ok) throw Error(result.error || `HTTP ${response.status}`);
  return result;
}
function readForm() {
  for (const id of ['host', 'from', 'to', 'username', 'helperUrl', 'remoteUrl', 'tls', 'ntfyServer', 'ntfyTopic']) cfg[id] = $(id).value.trim();
  cfg.port = Number($('port').value) || 587;
  cfg.ntfyEnabled = $('ntfyEnabled').checked;
  for (const key of Object.keys(EVENT_INFO)) cfg.events[key] = $(`ev-${key}`).checked;
}
function fill() {
  for (const id of ['host', 'port', 'tls', 'from', 'to', 'username', 'helperUrl', 'remoteUrl', 'ntfyServer', 'ntfyTopic']) $(id).value = cfg[id] ?? DEFAULTS[id];
  $('ntfyEnabled').checked = !!cfg.ntfyEnabled;
  for (const key of Object.keys(EVENT_INFO)) $(`ev-${key}`).checked = !!cfg.events[key];
  if (helperConfigLoaded) markSavedFields();
}
async function persistLocal() { await storage.set('settings', { helperUrl: cfg.helperUrl, token: cfg.token }); }
async function sync(requiredChannel = '') {
  readForm();
  if (!cfg.token) throw Error('Pair the helper first.');
  const smtpTouched = !!(cfg.from || cfg.to || cfg.username || $('password').value || cfg.hasPassword);
  const smtpReady = !!(cfg.from && cfg.to && cfg.username && (cfg.hasPassword || $('password').value));
  if (requiredChannel === 'email' && !smtpReady) throw Error('Complete the email fields and save an SMTP password before sending a test email.');
  if (smtpTouched && !smtpReady) throw Error('Email settings are partly filled in. Complete sender, recipient, username, and password, or clear the incomplete email fields to use ntfy only.');
  if (cfg.ntfyEnabled) {
    if (!/^https:\/\//i.test(cfg.ntfyServer)) throw Error('ntfy server must use HTTPS.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.ntfyTopic)) throw Error('Use a topic with 1–64 letters, numbers, underscores, or hyphens.');
  }
  if (requiredChannel === 'ntfy' && !cfg.ntfyEnabled) throw Error('Enable ntfy before sending a test push.');
  if (!requiredChannel && !smtpReady && !cfg.ntfyEnabled) throw Error('Configure email or enable ntfy before saving alert settings.');
  const payload = { host: cfg.host, port: cfg.port, tls: cfg.tls, from: cfg.from, to: cfg.to, username: cfg.username, remoteUrl: cfg.remoteUrl, events: cfg.events, ntfyEnabled: cfg.ntfyEnabled, ntfyServer: cfg.ntfyServer, ntfyTopic: cfg.ntfyTopic };
  if ($('password').value) payload.password = $('password').value;
  const saved = await api('/api/config', payload);
  cfg.hasPassword = saved.hasPassword ?? (!!payload.password || !!cfg.hasPassword);
  $('password').value = '';
  await persistLocal();
  helperConfigLoaded = true;
  markSavedFields();
}
function renderMonitor(status) {
  const connected = !!status.remoteConnected;
  $('monitorBadge').textContent = connected ? 'gSender connected' : 'Waiting for gSender';
  $('monitorBadge').className = `badge ${connected ? 'good' : ''}`;
  const last = status.lastEvent ? `${status.lastEvent.label || status.lastEvent.event} · ${new Date(status.lastEvent.at).toLocaleString()}${status.lastEvent.result ? ` · ${status.lastEvent.result}` : ''}` : 'No events received yet.';
  $('monitorDetails').textContent = `${status.message || (connected ? 'Connected to Wireless Control.' : 'Wireless Control is not connected.')} Last event: ${last}`;
}
async function check(loadConfig = false) {
  try {
    const status = await api('/api/status', undefined, false);
    $('helperBadge').textContent = `Helper running · ${status.version}`;
    $('helperBadge').className = 'badge good';
    if (cfg.token) { if (loadConfig) { const saved = await api('/api/config'); cfg = { ...cfg, ...saved, token: cfg.token, events: { ...DEFAULTS.events, ...saved.events } }; helperConfigLoaded = true; fill(); } renderMonitor(await api('/api/monitor-status')); }
    else { $('monitorBadge').textContent = 'Pair to check monitor'; $('monitorDetails').textContent = 'Pair the helper to view background monitor status.'; }
    return true;
  } catch {
    $('helperBadge').textContent = 'Helper not connected'; $('helperBadge').className = 'badge';
    $('monitorBadge').textContent = 'Monitor unavailable'; $('monitorBadge').className = 'badge';
    return false;
  }
}
$('appPasswordLink').addEventListener('click', event => { event.preventDefault(); const page = event.currentTarget.href; const popup = window.open(page, '_blank', 'noopener,noreferrer'); if (popup) { notice('Opened Google App Passwords in a new browser tab.', 'success'); } else { notice(`gSender blocked the browser popup. Copy this address into your browser: ${page}`, 'error'); } });
$('pair').onclick = async () => { try { readForm(); if (window.location.origin !== 'http://127.0.0.1:8000') throw Error(`Automatic pairing requires gSender Edge at http://127.0.0.1:8000 (current origin: ${window.location.origin}).`); const result = await api('/api/pair-local', {}, false); cfg.token = result.token; await persistLocal(); notice(result.alreadyPaired ? 'This plugin is paired with the helper. Settings are ready to load.' : 'Helper paired with this gSender installation. Load or save its settings below.', 'success'); await check(true); } catch (error) { notice(`Could not pair helper: ${error.message}`, 'error'); } };
$('save').onclick = async () => { try { await sync(); notice('Settings saved by the Windows helper. Monitoring continues when gSender is closed.', 'success'); await check(false); } catch (error) { notice(`Could not save settings: ${error.message}`, 'error'); } };
$('sendTest').onclick = async () => { try { await sync('email'); const result = await api('/api/test', {}); notice(result.message || 'Test email delivered.', 'success'); } catch (error) { notice(`Test email failed: ${error.message}`, 'error'); } };
$('sendNtfyTest').onclick = async () => { try { await sync('ntfy'); const result = await api('/api/test-ntfy', {}); notice(result.message || 'Test push sent. Check the ntfy app subscription.', 'success'); } catch (error) { notice(`Test push failed: ${error.message}`, 'error'); } };
$('generateTopic').onclick = async () => { try { readForm(); const result = await api('/api/generate-topic', { remoteUrl: cfg.remoteUrl }); $('ntfyTopic').value = result.topic; $('ntfyTopic').dispatchEvent(new Event('input', { bubbles: true })); notice(`Generated ${result.topic}. Save settings, then subscribe to this exact topic in the phone app.`, 'info'); } catch (error) { notice(`Could not generate topic: ${error.message}`, 'error'); } };
$('refresh').onclick = async () => { const ok = await check(); notice(ok ? 'Local helper is responding.' : 'Start the Machine Event Email Helper service and check its address.', ok ? 'success' : 'error'); };
for (const id of ['host', 'port', 'tls', 'from', 'to', 'username', 'helperUrl', 'remoteUrl', 'password', 'ntfyServer', 'ntfyTopic']) {
  $(id).addEventListener('input', () => { if (id !== 'helperUrl') fieldState(id, id === 'password' ? 'New password · not saved' : 'Unsaved changes', 'dirty'); if (id === 'ntfyServer' || id === 'ntfyTopic') { $('ntfyState').textContent = 'Unsaved'; $('ntfyState').className = 'field-state dirty'; } });
  $(id).addEventListener('change', () => {
    readForm();
    if (id === 'helperUrl') persistLocal().then(() => fieldState(id, 'Saved on this device', 'saved')).catch(() => fieldState(id, 'Could not save locally', 'dirty'));
  });
}
$('ntfyEnabled').addEventListener('change', () => { readForm(); $('ntfyState').textContent = 'Unsaved'; $('ntfyState').className = 'field-state dirty'; notice('ntfy setting changed. Select Save settings to store it.', 'info'); });
for (const key of Object.keys(EVENT_INFO)) $(`ev-${key}`).addEventListener('change', () => { readForm(); notice('Event choices changed. Select Save settings to store them.', 'info'); });
(async () => {
  try {
    const saved = await storage.get('settings');
    if (saved) cfg = { ...cfg, helperUrl: saved.helperUrl || cfg.helperUrl, token: saved.token || '' };
    if (cfg.token) {
      const remote = await api('/api/config'); cfg = { ...cfg, ...remote, token: cfg.token, events: { ...DEFAULTS.events, ...remote.events } }; helperConfigLoaded = true;
    }
    fill();
    if (saved?.helperUrl) fieldState('helperUrl', 'Saved on this device', 'saved');
    const ok = await check(false);
    notice(ok ? (cfg.token ? 'Helper settings loaded. Background monitoring is managed by the Windows service.' : 'Pair with the installed Windows helper to configure monitoring.') : 'Start the Windows helper service, then pair it here.', ok ? 'success' : 'info');
  } catch (error) { fill(); notice(`Could not load helper settings: ${error.message}`, 'error'); }
  setInterval(() => { if (cfg.token) check(false).catch(() => {}); }, 5000);
})();
