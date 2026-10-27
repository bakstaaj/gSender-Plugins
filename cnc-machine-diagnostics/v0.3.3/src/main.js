import { machine, redux, storage } from '@sienci/gsender-plugin-sdk';
import './style.css';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'machineProfiles';
const STATUS_PARSER_ID = 'cnc-machine-diagnostics-status';

const DEFAULT_CONTROLS = [
  { id: 'spindle', name: 'Spindle', enabled: true, type: 'range-toggle', min: 0, max: 14000, initial: 10000, unit: 'RPM', on: 'M3S{value}', off: 'M5', command: '' },
  { id: 'spindle-fan', name: 'Spindle Fan', enabled: true, type: 'range-toggle', min: 0, max: 100, initial: 20, unit: '%', on: 'M811S{value}', off: 'M812', command: '' },
  { id: 'power-fan', name: 'Power Fan', enabled: true, type: 'range-toggle', min: 0, max: 100, initial: 20, unit: '%', on: 'M801S{value}', off: 'M802', command: '' },
  { id: 'laser', name: 'Laser mode', enabled: true, type: 'toggle', min: 0, max: 100, initial: 0, unit: '', on: 'M321.2', off: 'M322.2', command: '' },
  { id: 'laser-test', name: 'Laser beam test', enabled: true, type: 'range-toggle', min: 0, max: 100, initial: 10, unit: 'test scale %', on: 'M323', off: 'M324', power: 'M325 S{value}', command: '' },
  { id: 'extend-output', name: 'Extended Output', enabled: true, type: 'range-toggle', min: 0, max: 100, initial: 5, unit: '%', on: 'M851S{value}', off: 'M852', command: '' },
  { id: 'light', name: 'Light', enabled: true, type: 'action', min: 0, max: 100, initial: 0, unit: '', on: '', off: '', command: 'M822' },
  { id: 'probe-laser', name: 'Probe Laser', enabled: true, type: 'toggle', min: 0, max: 100, initial: 0, unit: '', on: 'M494.0', off: 'M494.2', command: '' },
  { id: 'anti-static', name: 'Anti-Static', enabled: true, type: 'toggle', min: 0, max: 100, initial: 0, unit: '', on: 'M331.4', off: 'M332.4', command: '' },
  { id: 'beeper', name: 'Beeper', enabled: true, type: 'toggle', min: 0, max: 100, initial: 0, unit: '', on: 'M861', off: 'M862', command: '' },
];

const DEFAULT_SENSORS = [
  { id: 'x-limit', name: 'X limit input', enabled: true, pin: 'X' },
  { id: 'y-limit', name: 'Y limit input', enabled: true, pin: 'Y' },
  { id: 'z-limit', name: 'Z limit input', enabled: true, pin: 'Z' },
  { id: 'a-limit', name: 'Rotary A limit', enabled: true, pin: 'Z1:E[6]' },
  { id: 'b-limit', name: 'B axis limit', enabled: false, pin: 'B' },
  { id: 'probe', name: 'Probe switch', enabled: true, pin: 'P' },
  { id: 'probe-calibration', name: 'Tool calibration sensor', enabled: true, pin: 'Z1:P[1]' },
  { id: 'tool-sensor', name: 'Tool sensor', enabled: true, pin: 'Z1:T' },
  { id: 'atc-home', name: 'ATC home sensor', enabled: true, pin: 'Z1:A[0]' },
  { id: 'atc-tool-detect', name: 'ATC tool detector', enabled: true, pin: 'Z1:A[1]' },
  { id: 'estop', name: 'Emergency stop', enabled: true, pin: 'Z1:I' },
  { id: 'cover', name: 'Cover open', enabled: true, pin: '!Z1:E[5]' },
  { id: 'motor-alarm', name: 'Motor alarm input', enabled: true, pin: 'Z1:E[7]' },
  { id: 'auxiliary', name: 'Auxiliary input', enabled: false, pin: '' },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDefaultStore() {
  return {
    activeProfileId: 'makera-z1',
    profiles: [{
      id: 'makera-z1',
      name: 'Makera Z1',
      controllerType: 'makera-z1',
      controls: clone(DEFAULT_CONTROLS),
      sensors: clone(DEFAULT_SENSORS),
    }],
  };
}

const state = {
  connected: false,
  activeState: 'Unknown',
  busy: new Set(),
  lastPins: null,
  pinReportingSupported: false,
  lastMakeraFields: null,
  lastStatusFields: null,
  lastStatusAt: null,
  unsubscribeStatus: null,
  parserStatus: 'Status listener is not initialized.',
  statusQueryInFlight: false,
  statusTimer: null,
  profileStore: makeDefaultStore(),
  currentPage: 'diagnostics',
  dirty: false,
  storageError: '',
  requestedStates: {},
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function newId() {
  return 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function activeProfile() {
  return state.profileStore.profiles.find((profile) => profile.id === state.profileStore.activeProfileId)
    || state.profileStore.profiles[0];
}

function normalizeStore(saved) {
  if (!saved || !Array.isArray(saved.profiles) || !saved.profiles.length) return makeDefaultStore();
  const profiles = saved.profiles.filter((profile) => profile && typeof profile.id === 'string' && typeof profile.name === 'string')
    .map((profile) => {
      const sensors = Array.isArray(profile.sensors) ? profile.sensors.map((sensor) => ({ ...sensor })) : [];
      const controls = Array.isArray(profile.controls) ? profile.controls.map((control) => ({ ...control })) : [];
      const isMakeraZ1Profile = profile.id === 'makera-z1' || profile.name.trim().toLowerCase() === 'makera z1';
      const controllerType = profile.controllerType === 'makera-z1' || profile.controllerType === 'grbl'
        ? profile.controllerType : (isMakeraZ1Profile ? 'makera-z1' : 'grbl');
      for (const sensor of sensors) {
        if (sensor.id === 'cover' && String(sensor.pin || '').trim().toUpperCase() === 'Z1:E[5]') {
          sensor.pin = '!Z1:E[5]';
          if (sensor.name === 'Cover switch') sensor.name = 'Cover open';
        }
        // Firmware reports E[5]=0 with the cover open and E[5]=1 when closed.
        // Repair the known Z1 profile if a previously saved mapping or polarity was stale.
        if (isMakeraZ1Profile && sensor.id === 'cover') {
          sensor.pin = '!Z1:E[5]';
          sensor.name = 'Cover open';
          sensor.enabled = true;
        }
      }
      if (isMakeraZ1Profile) {
        for (const defaults of DEFAULT_SENSORS) {
          let current = sensors.find((sensor) => sensor.id === defaults.id);
          if (!current) {
            current = clone(defaults);
            sensors.push(current);
          } else if (!String(current.pin || '').trim()) current.pin = defaults.pin;
          // Z1 firmware appends rotary A limit at E[6] and motor alarm at E[7].
          if (defaults.id === 'a-limit' || defaults.id === 'motor-alarm') {
            current.name = defaults.name;
            current.pin = defaults.pin;
            current.enabled = true;
          }
          if (defaults.id === 'cover') {
            current.pin = defaults.pin;
            current.name = defaults.name;
            current.enabled = true;
          }
        }
        for (const defaults of DEFAULT_CONTROLS) {
          let current = controls.find((control) => control.id === defaults.id);
          if (!current) {
            current = clone(defaults);
            controls.push(current);
          }
          // Repair the earlier guessed laser commands while preserving custom edits.
          if (defaults.id === 'laser' && ['M310|M3', 'M3|M310', 'M3|M3 10'].includes(
            String(current.on || '').trim().toUpperCase() + '|' + String(current.off || '').trim().toUpperCase()
          )) {
            current.name = defaults.name;
            current.on = defaults.on;
            current.off = defaults.off;
            current.initial = defaults.initial;
            current.unit = defaults.unit;
          }
          if (defaults.id === 'probe-laser' || defaults.id === 'beeper') {
            if (!String(current.on || '').trim()) current.on = defaults.on;
            if (!String(current.off || '').trim()) current.off = defaults.off;
            if (!current.name) current.name = defaults.name;
            if (defaults.id === 'beeper') current.enabled = true;
          }
        }
      }
      return {
        id: profile.id,
        name: profile.name,
        controllerType,
        controls,
        sensors,
      };
    });
  if (!profiles.length) return makeDefaultStore();
  const activeProfileId = profiles.some((profile) => profile.id === saved.activeProfileId)
    ? saved.activeProfileId : profiles[0].id;
  return { activeProfileId, profiles };
}

function renderControl(control) {
  const name = escapeHtml(control.name);
  const id = escapeHtml(control.id);
  const initial = Number.isFinite(Number(control.initial)) ? Number(control.initial) : 0;
  const feedback = control.id === 'spindle' || control.id === 'laser'
    ? '<p class="control-note controller-feedback" id="feedback-' + id + '">Waiting for controller status.</p>' : '';
  if (control.type === 'action') {
    return '<article class="control-card">' +
      '<div class="control-top"><strong>' + name + '</strong><span class="state-label" id="state-' + id + '">State not reported</span></div>' +
      '<p class="control-note">This control sends a single G-code command. Its output state is not read back.</p>' +
      '<button class="action-button" type="button" data-action="' + id + '" data-command>Run command</button></article>';
  }
  if (control.type === 'toggle') {
    const checked = state.requestedStates[control.id] ? ' checked' : '';
    const note = control.id === 'laser'
      ? 'Switches firmware laser mode only. The Z1 also changes fan outputs with this mode; it does not directly switch the laser beam on.'
      : 'Output state is not reported by the controller.';
    return '<article class="control-card"><div class="control-top"><strong>' + name + '</strong>' +
      '<label class="switch-wrap"><input type="checkbox" data-switch="' + id + '" aria-label="' + name + ' on or off"' + checked + '><span class="switch"></span></label></div>' +
      '<p class="control-note" id="state-' + id + '">' + note + '</p>' + feedback + '</article>';
  }
  const min = Number.isFinite(Number(control.min)) ? Number(control.min) : 0;
  const max = Number.isFinite(Number(control.max)) ? Number(control.max) : 100;
  const unit = escapeHtml(control.unit || '');
  const checked = state.requestedStates[control.id] ? ' checked' : '';
  const note = control.id === 'laser-test'
    ? 'This emits the laser beam and is enabled only while gSender reports Idle. The slider sets 0–100% of firmware test power (default 10%, possibly changed in machine config). Use a safe enclosure and beam path.'
    : 'Output state is not reported by the controller.';
  return '<article class="control-card"><div class="control-top"><strong>' + name + '</strong>' +
    '<label class="switch-wrap"><input type="checkbox" data-switch="' + id + '" aria-label="' + name + ' on or off"' + checked + '><span class="switch"></span></label></div>' +
    '<div class="range-line"><input type="range" data-range="' + id + '" min="' + min + '" max="' + max + '" value="' + initial + '" aria-label="' + name + ' ' + unit + '">' +
    '<output id="value-' + id + '">' + initial + '</output></div><div class="range-labels"><span>' + min + '</span><span>' + unit + '</span><span>' + max + '</span></div>' +
    '<p class="control-note" id="state-' + id + '">' + note + '</p>' + feedback + '</article>';
}

function renderControllerFeedback() {
  const fields = state.lastStatusFields;
  const spindle = $('feedback-spindle');
  if (spindle) {
    const values = fields?.get('S')?.split(',').map((value) => Number(value.trim())) || [];
    if (values.length >= 2 && values.slice(0, 2).every(Number.isFinite)) {
      spindle.textContent = 'Controller: ' + (values[0] > 0 ? 'Running' : 'Stopped') +
        ' · actual ' + values[0].toFixed(0) + ' RPM · target ' + values[1].toFixed(0) + ' RPM' +
        (Number.isFinite(values[4]) ? ' · spindle temp ' + values[4].toFixed(1) + '°' : '');
    } else spindle.textContent = 'Spindle feedback not present in the latest controller status.';
  }
  const laser = $('feedback-laser');
  if (laser) {
    const values = fields?.get('L')?.split(',').map((value) => Number(value.trim())) || [];
    if (values.length >= 4 && values.slice(0, 4).every(Number.isFinite)) {
      laser.textContent = 'Controller: laser mode ' + (values[0] !== 0 ? 'On' : 'Off') +
        ' · output ' + (values[1] !== 0 ? 'On' : 'Off') +
        ' · test ' + (values[2] !== 0 ? 'On' : 'Off') + ' · power ' + values[3].toFixed(1) + '%';
    } else laser.textContent = 'Laser feedback not present in the latest controller status.';
  }
}

function renderSensor(sensor) {
  const configuredPin = String(sensor.pin || '').trim().toUpperCase();
  const invertByDefault = sensor.id === 'cover' && configuredPin === 'Z1:E[5]';
  const inverted = configuredPin.startsWith('!') || invertByDefault;
  const pin = configuredPin.startsWith('!') ? configuredPin.slice(1).trim() : configuredPin;
  let label = 'Not reported';
  let kind = 'unknown';
  let active;
  const makeraMapping = pin.match(/^Z1:([A-Z]+)(?:\[(\d+)\])?$/i);
  if (!pin) {
    label = 'Pin not mapped';
  } else if (makeraMapping) {
    const raw = state.lastMakeraFields?.get(makeraMapping[1]);
    const index = makeraMapping[2] === undefined ? 0 : Number(makeraMapping[2]);
    const values = raw === undefined ? [] : raw.split(',');
    const parsed = index < values.length ? Number(values[index].trim()) : NaN;
    if (Number.isFinite(parsed)) active = parsed !== 0;
  } else if (state.lastPins !== null) {
    active = state.lastPins.has(pin);
  }
  if (active !== undefined && inverted) active = !active;
  if (active !== undefined) {
    label = active ? 'Active' : 'Inactive';
    kind = active ? 'active' : 'inactive';
  }
  const sensorName = sensor.id === 'cover' && pin === 'Z1:E[5]' && sensor.name === 'Cover switch'
    ? 'Cover open' : sensor.name;
  return '<article class="status-card"><strong>' + escapeHtml(sensorName) + '</strong>' +
    '<span class="indicator ' + kind + '" id="sensor-' + escapeHtml(sensor.id) + '"><i></i><b>' + label + '</b></span></article>';
}

function renderSensors() {
  const profile = activeProfile();
  if (!profile) return;
  const enabledSensors = profile.sensors.filter((sensor) => sensor.enabled);
  $('diagnosticSensors').innerHTML = enabledSensors.length
    ? enabledSensors.map(renderSensor).join('')
    : '<p class="empty-state">No sensors are enabled for this profile. Open Configuration to add sensors.</p>';
  $('pinSummary').textContent = state.lastStatusAt === null
    ? state.parserStatus
    : 'Pn: ' + (state.lastPins === null ? 'not reported by this controller status' : (state.lastPins.size ? Array.from(state.lastPins).join(', ') : 'no inputs active')) +
      ' · ' + new Date(state.lastStatusAt).toLocaleTimeString() +
      (state.lastMakeraFields
        ? ' · Z1: ' + Array.from(state.lastMakeraFields, ([key, value]) => key + '=' + value).join(';')
        : ' · No Makera Z1 fields in this status');
}

function updateControlAvailability() {
  document.querySelectorAll('.diagnostic-controls input, .diagnostic-controls button[data-command]').forEach((element) => {
    const isLaserTestControl = element.matches('[data-switch="laser-test"], [data-range="laser-test"]');
    element.disabled = !state.connected || state.busy.size > 0 || (isLaserTestControl && state.activeState !== 'Idle');
  });
}

function renderDiagnostics() {
  const profile = activeProfile();
  if (!profile) return;
  $('profileSummary').textContent = profile.name;
  const enabledControls = profile.controls.filter((control) => control.enabled);
  $('diagnosticControls').innerHTML = enabledControls.length
    ? enabledControls.map(renderControl).join('')
    : '<p class="empty-state">No controls are enabled for this profile. Open Configuration to add controls.</p>';
  renderControllerFeedback();
  renderSensors();
  updateControlAvailability();
}

function renderControlEditor(control) {
  const id = escapeHtml(control.id);
  const name = escapeHtml(control.name);
  const checked = control.enabled ? ' checked' : '';
  const type = control.type || 'toggle';
  const commandFields = type === 'action'
    ? '<label class="field command-field"><span>Command</span><input type="text" data-control-id="' + id + '" data-field="command" value="' + escapeHtml(control.command || '') + '" placeholder="Example: M822"></label>'
    : '<div class="command-pair">' +
      '<label class="field"><span>On command</span><input type="text" data-control-id="' + id + '" data-field="on" value="' + escapeHtml(control.on || '') + '" placeholder="Use {value} for a range value"></label>' +
      '<label class="field"><span>Off command</span><input type="text" data-control-id="' + id + '" data-field="off" value="' + escapeHtml(control.off || '') + '"></label></div>' +
      (control.power !== undefined ? '<label class="field command-field"><span>Power command</span><input type="text" data-control-id="' + id + '" data-field="power" value="' + escapeHtml(control.power || '') + '" placeholder="Use {value} for slider value"></label>' : '');
  const rangeFields = type === 'range-toggle'
    ? '<div class="range-config">' +
      '<label class="field"><span>Minimum</span><input type="number" data-control-id="' + id + '" data-field="min" value="' + Number(control.min || 0) + '"></label>' +
      '<label class="field"><span>Maximum</span><input type="number" data-control-id="' + id + '" data-field="max" value="' + Number(control.max || 100) + '"></label>' +
      '<label class="field"><span>Default</span><input type="number" data-control-id="' + id + '" data-field="initial" value="' + Number(control.initial || 0) + '"></label>' +
      '<label class="field"><span>Unit</span><input type="text" data-control-id="' + id + '" data-field="unit" value="' + escapeHtml(control.unit || '') + '" placeholder="RPM, %, mm…"></label></div>'
    : '';
  return '<article class="editor-card"><div class="editor-card-head">' +
    '<label class="enable-control"><input type="checkbox" data-control-id="' + id + '" data-field="enabled"' + checked + '> Enabled</label>' +
    '<label class="field control-name"><span>Control name</span><input type="text" data-control-id="' + id + '" data-field="name" value="' + name + '"></label>' +
    '<label class="field type-field"><span>Control type</span><select data-control-id="' + id + '" data-field="type">' +
    '<option value="toggle"' + (type === 'toggle' ? ' selected' : '') + '>On / off toggle</option>' +
    '<option value="range-toggle"' + (type === 'range-toggle' ? ' selected' : '') + '>Value and on / off</option>' +
    '<option value="action"' + (type === 'action' ? ' selected' : '') + '>Single action</option></select></label>' +
    (control.custom ? '<button class="quiet-button danger-button remove-item" type="button" data-remove-control="' + id + '">Remove</button>' : '') + '</div>' +
    commandFields + rangeFields + '</article>';
}

function renderSensorEditor(sensor) {
  const id = escapeHtml(sensor.id);
  const checked = sensor.enabled ? ' checked' : '';
  return '<article class="sensor-editor"><label class="enable-control"><input type="checkbox" data-sensor-id="' + id + '" data-field="enabled"' + checked + '> Enabled</label>' +
    '<label class="field"><span>Sensor name</span><input type="text" data-sensor-id="' + id + '" data-field="name" value="' + escapeHtml(sensor.name) + '"></label>' +
    '<label class="field pin-field"><span>Status mapping</span><input type="text" maxlength="24" data-sensor-id="' + id + '" data-field="pin" value="' + escapeHtml(sensor.pin || '') + '" placeholder="X, P, Z1:E[5], !Z1:E[5]…"></label>' +
    (sensor.custom ? '<button class="quiet-button danger-button remove-item" type="button" data-remove-sensor="' + id + '">Remove</button>' : '') + '</article>';
}

function profilePollingDescription(profile) {
  return profile?.controllerType === 'makera-z1'
    ? 'While connected and on Diagnostics, Makera Z1 mode queries status every 700 ms in Idle or Alarm and reads the Z1 extended sensor fields.'
    : 'While connected and on Diagnostics, Standard GRBL mode queries status every 700 ms in Idle or Alarm and reads the GRBL Pn input pins.';
}

function canPollControllerStatus() {
  return state.connected && ['Idle', 'Alarm'].includes(state.activeState) && state.currentPage === 'diagnostics';
}

function renderProfileSelect() {
  const options = state.profileStore.profiles.map((profile) =>
    '<option value="' + escapeHtml(profile.id) + '"' + (profile.id === state.profileStore.activeProfileId ? ' selected' : '') + '>' +
    escapeHtml(profile.name) + '</option>').join('');
  $('profileSelect').innerHTML = options;
  $('deleteProfile').disabled = state.profileStore.profiles.length <= 1;
}

function renderConfiguration() {
  const profile = activeProfile();
  if (!profile) return;
  $('profileName').value = profile.name;
  $('controllerType').value = profile.controllerType || 'grbl';
  $('controllerTypeHelp').textContent = profilePollingDescription(profile);
  $('controlEditor').innerHTML = profile.controls.map(renderControlEditor).join('');
  $('sensorEditor').innerHTML = profile.sensors.map(renderSensorEditor).join('');
  $('configNotice').textContent = state.storageError || (state.dirty
    ? 'Unsaved changes. Save the profile to keep your edits.'
    : 'Profile changes are stored in gSender and apply to the Diagnostics page.');
  $('configNotice').className = 'notice ' + (state.storageError ? 'error' : (state.dirty ? 'info' : 'success'));
}

function render() {
  $('app').innerHTML = '<div class="page">' +
    '<header class="page-head"><div><div class="eyebrow">CNC MACHINE DIAGNOSTICS</div><h1 id="pageTitle">Diagnostics</h1><p>Machine profile: <strong id="profileSummary"></strong></p></div>' +
    '<div class="header-actions"><div id="connection" class="connection error"><span class="dot"></span><span id="connectionText">Not connected</span></div>' +
    '<button id="openConfig" class="quiet-button" type="button">Configure profiles</button></div></header>' +
    '<nav class="page-tabs" aria-label="Plugin pages"><button type="button" data-page="diagnostics" class="tab active">Diagnostics</button>' +
    '<button type="button" data-page="configuration" class="tab">Configuration</button></nav>' +
    '<main id="diagnosticsPage"><section class="section"><h2>Controls</h2><div id="diagnosticControls" class="control-grid diagnostic-controls"></div>' +
    '<p id="commandMessage" class="notice info" role="status" aria-live="polite">Connect gSender to the machine before using diagnostic controls.</p></section>' +
    '<section class="section"><div class="section-head"><div><h2>Sensors</h2><p>Sensor states update from gSender’s live controller status.</p></div></div><div id="diagnosticSensors" class="status-grid"></div>' +
    '<p id="pinSummary" class="pin-summary"></p><p class="help-note">Use standard GRBL Pn: tokens such as X or P, or Makera bridge fields such as Z1:E[5] and Z1:P[1]. Prefix a mapping with ! to invert its displayed state.</p></section></main>' +
    '<main id="configurationPage" hidden><section class="section"><h2>Machine profiles</h2>' +
    '<div class="profile-tools"><label class="field"><span>Selected profile</span><select id="profileSelect"></select></label>' +
    '<label class="field"><span>Profile name</span><input id="profileName" type="text" maxlength="80"></label>' +
    '<label class="field"><span>Controller status mode</span><select id="controllerType"><option value="makera-z1">Makera Z1</option><option value="grbl">Standard GRBL</option></select><small id="controllerTypeHelp" class="field-help"></small></label>' +
    '<div class="profile-buttons"><button id="newProfile" class="quiet-button" type="button">New profile</button>' +
    '<button id="duplicateProfile" class="quiet-button" type="button">Duplicate</button>' +
    '<button id="deleteProfile" class="quiet-button danger-button" type="button">Delete</button>' +
    '<button id="saveProfile" class="primary-button" type="button">Save profile</button></div></div>' +
    '<p id="configNotice" class="notice success" role="status" aria-live="polite"></p></section>' +
    '<section class="section"><div class="section-head"><div><h2>Diagnostic controls</h2><p>Enable only controls supported by this machine. Use {value} in an on command to insert the range value.</p></div><button id="addControl" class="quiet-button" type="button">Add control</button></div><div id="controlEditor" class="editor-list"></div></section>' +
    '<section class="section"><div class="section-head"><div><h2>Sensors and switches</h2><p>Use a GRBL Pn: token (X, Y, Z, P) or a Makera bridge field such as Z1:E[5]. Prefix a mapping with ! to invert it.</p></div><button id="addSensor" class="quiet-button" type="button">Add sensor</button></div><div id="sensorEditor" class="editor-list"></div></section></main>' +
    '<footer>Commands are sent through gSender’s active controller connection. The controller may not report the state of accessory outputs; confirm those at the machine.</footer></div>';
  renderProfileSelect();
  renderDiagnostics();
  renderConfiguration();
  bindEvents();
  setConnection(state.connected, state.activeState);
}

function setNotice(message, kind) {
  const node = $('commandMessage');
  if (!node) return;
  node.textContent = message;
  node.className = 'notice ' + (kind || 'info');
}

function setConnection(connected, activeState) {
  const wasConnected = state.connected;
  state.connected = !!connected;
  state.activeState = activeState || 'Unknown';
  const node = $('connection');
  if (!node) return;
  const idle = state.connected && state.activeState === 'Idle';
  node.className = 'connection ' + (!state.connected ? 'error' : (idle ? 'ok' : 'busy'));
  $('connectionText').textContent = !state.connected ? 'Not connected' : 'Connected · ' + state.activeState;
  updateControlAvailability();
  const notice = $('commandMessage');
  if (notice && (wasConnected !== state.connected || notice.dataset.connectionInitialized !== 'true')) {
    notice.dataset.connectionInitialized = 'true';
    setNotice(state.connected
      ? 'Connected to gSender. Controller status is queried every 700 ms in Idle or Alarm while the Diagnostics page is open.'
      : 'Connect gSender to the machine before using diagnostic controls.', 'info');
  }
  syncStatusPolling();
}

async function refreshMachineState() {
  try {
    const snapshot = await redux.getState();
    const connected = !!snapshot?.connection?.isConnected;
    const activeState = snapshot?.controller?.state?.status?.activeState || 'Unknown';
    setConnection(connected, activeState);
    if (!connected) {
      state.lastPins = null;
      state.pinReportingSupported = false;
      state.lastMakeraFields = null;
      state.lastStatusFields = null;
      state.lastStatusAt = null;
      renderSensors();
      renderControllerFeedback();
    }
  } catch (error) {
    setConnection(false, 'Unknown');
    setNotice('Could not read gSender connection state: ' + (error.message || error), 'error');
  }
}

function parsePinTokens(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return new Set();
  if (/[\s,]/.test(value)) return new Set(value.split(/[\s,]+/).filter(Boolean));
  return new Set(Array.from(value));
}

function readStatusLine(result) {
  const line = String(result?.line || result?.lines?.find((item) => /^\s*</.test(item)) || '').trim();
  const statusFields = new Map();
  for (const field of line.replace(/^</, '').replace(/>$/, '').split('|')) {
    const match = field.match(/^([A-Z][A-Z0-9]*):\s*(.*)$/i);
    if (match) statusFields.set(match[1].toUpperCase(), match[2].trim());
  }
  state.lastStatusFields = statusFields;
  const laserValues = statusFields.get('L')?.split(',').map((value) => Number(value.trim())) || [];
  if (laserValues.length >= 3 && laserValues.slice(0, 3).every(Number.isFinite)) {
    state.requestedStates.laser = laserValues[0] !== 0;
    state.requestedStates['laser-test'] = laserValues[2] !== 0;
    const modeSwitch = document.querySelector('[data-switch="laser"]');
    const testSwitch = document.querySelector('[data-switch="laser-test"]');
    if (modeSwitch && !state.busy.has('laser')) modeSwitch.checked = state.requestedStates.laser;
    if (testSwitch && !state.busy.has('laser-test')) testSwitch.checked = state.requestedStates['laser-test'];
  }
  const pins = line.match(/\|Pn:([^|>]*)/i);
  const makera = line.match(/\|Z1:([^>]*)/i);
  // GRBL omits Pn when no input is triggered. Once we've seen Pn, an omitted
  // field means all supported inputs are inactive; before that, it is unknown.
  if (pins) {
    state.pinReportingSupported = true;
    state.lastPins = parsePinTokens(pins[1]);
  } else if (state.pinReportingSupported) {
    state.lastPins = new Set();
  }
  state.lastMakeraFields = null;
  if (makera) {
    const fields = new Map();
    for (const item of makera[1].split(';')) {
      const equals = item.indexOf('=');
      if (equals <= 0) continue;
      fields.set(item.slice(0, equals).trim().toUpperCase(), item.slice(equals + 1).trim());
    }
    state.lastMakeraFields = fields;
  }
  state.lastStatusAt = Date.now();
  renderSensors();
  renderControllerFeedback();
}

async function pollControllerStatus() {
  if (!canPollControllerStatus() || state.statusQueryInFlight || state.busy.size > 0) return;
  state.statusQueryInFlight = true;
  try {
    const result = await machine.query('?', {
      until: /^<[^>]+>$/,
      timeout: 1200,
      maxLines: 10,
      allowDuringJob: false,
      includeStatusReports: true,
    });
    const line = result.lines?.find((item) => /^\s*</.test(item));
    if (line) readStatusLine({ line });
    else if (result.reason !== 'busy') {
      state.parserStatus = 'Status query returned no controller report (' + result.reason + ').';
      renderSensors();
    }
  } catch (error) {
    state.parserStatus = 'Status query error: ' + (error.message || error);
    renderSensors();
  } finally {
    state.statusQueryInFlight = false;
  }
}

function syncStatusPolling() {
  const shouldPoll = canPollControllerStatus();
  if (!shouldPoll) {
    if (state.statusTimer !== null) window.clearTimeout(state.statusTimer);
    state.statusTimer = null;
    return;
  }
  if (state.statusTimer !== null || state.statusQueryInFlight) return;
  const run = async () => {
    state.statusTimer = null;
    if (!canPollControllerStatus()) return;
    await pollControllerStatus();
    if (canPollControllerStatus()) {
      state.statusTimer = window.setTimeout(run, 700);
    }
  };
  void run();
}

function resolveCommand(template, value) {
  return String(template || '').replaceAll('{value}', String(value));
}

async function sendCommand(command, actionId, successText) {
  const value = String(command || '').trim();
  if (!value || /[\r\n]/.test(value)) {
    setNotice('This profile has no valid one-line command configured for that control.', 'error');
    return false;
  }
  if (!state.connected) {
    setNotice('Connect gSender to the machine before changing diagnostic outputs.', 'error');
    return false;
  }
  if (state.busy.size > 0) {
    setNotice('Wait for the current diagnostic command to finish sending.', 'info');
    return false;
  }
  state.busy.add(actionId);
  updateControlAvailability();
  setNotice('Sending ' + value + '…', 'info');
  try {
    await machine.command('gcode', value);
    setNotice(successText + ' · ' + value + ' sent through gSender. Verify the machine response.', 'success');
    return true;
  } catch (error) {
    setNotice(value + ' failed: ' + (error.message || error), 'error');
    return false;
  } finally {
    state.busy.delete(actionId);
    updateControlAvailability();
  }
}

async function sendSequence(commands, actionId, successText) {
  const sequence = commands.map((command) => String(command || '').trim()).filter(Boolean);
  if (!sequence.length || sequence.some((command) => /[\r\n]/.test(command))) {
    setNotice('This profile has an invalid command sequence for that control.', 'error');
    return false;
  }
  if (!state.connected) {
    setNotice('Connect gSender to the machine before changing diagnostic outputs.', 'error');
    return false;
  }
  if (state.busy.size > 0) {
    setNotice('Wait for the current diagnostic command to finish sending.', 'info');
    return false;
  }
  state.busy.add(actionId);
  updateControlAvailability();
  const sent = [];
  try {
    for (const command of sequence) {
      setNotice('Sending ' + command + '…', 'info');
      await machine.command('gcode', command);
      sent.push(command);
    }
    setNotice(successText + ' · ' + sent.join(' → ') + ' sent through gSender. Confirm beam state at the machine.', 'success');
    return true;
  } catch (error) {
    setNotice('Command sequence stopped after ' + (sent.join(' → ') || 'no commands') + ': ' + (error.message || error), 'error');
    return false;
  } finally {
    state.busy.delete(actionId);
    updateControlAvailability();
  }
}

function bindDiagnosticEvents() {
  $('diagnosticControls').addEventListener('input', (event) => {
    const target = event.target;
    if (target.matches('[data-range]')) {
      const output = $('value-' + target.dataset.range);
      if (output) output.textContent = target.value;
    }
  });
  $('diagnosticControls').addEventListener('change', async (event) => {
    const target = event.target;
    if (target.matches('[data-switch]')) {
      const profile = activeProfile();
      const control = profile.controls.find((item) => item.id === target.dataset.switch);
      if (!control) return;
      const enabled = target.checked;
      const previous = !!state.requestedStates[control.id];
      state.requestedStates[control.id] = enabled;
      let command = enabled ? control.on : control.off;
      if (control.type === 'range-toggle') {
        const range = document.querySelector('[data-range="' + control.id + '"]');
        command = resolveCommand(command, range ? range.value : control.initial);
      }
      let ok;
      if (control.id === 'laser-test') {
        const range = document.querySelector('[data-range="laser-test"]');
        const powerCommand = resolveCommand(control.power, range ? range.value : control.initial);
        const modeControl = profile.controls.find((item) => item.id === 'laser');
        ok = enabled
          ? await sendSequence([modeControl?.on || 'M321.2', powerCommand, control.on], control.id, control.name + ' on')
          : await sendCommand(control.off, control.id, control.name + ' off');
      } else if (control.id === 'laser' && !enabled && state.requestedStates['laser-test']) {
        const testControl = profile.controls.find((item) => item.id === 'laser-test');
        ok = await sendSequence([testControl?.off || 'M324', command], control.id, control.name + ' off');
        if (ok) {
          state.requestedStates['laser-test'] = false;
          const testSwitch = document.querySelector('[data-switch="laser-test"]');
          if (testSwitch) testSwitch.checked = false;
        }
      } else {
        ok = await sendCommand(command, control.id, control.name + (enabled ? ' on' : ' off'));
      }
      if (!ok) {
        state.requestedStates[control.id] = previous;
        target.checked = previous;
      }
      else {
        state.requestedStates[control.id] = enabled;
        const note = $('state-' + control.id);
        if (note) note.textContent = 'Last requested: ' + (enabled ? 'on' : 'off') + ' · output state not reported';
      }
    }
    if (target.matches('[data-range]')) {
      const profile = activeProfile();
      const control = profile.controls.find((item) => item.id === target.dataset.range);
      const toggle = document.querySelector('[data-switch="' + target.dataset.range + '"]');
      if (!control || !toggle?.checked) return;
      const rangeCommand = control.id === 'laser-test' ? control.power : control.on;
      const ok = await sendCommand(resolveCommand(rangeCommand, target.value), control.id,
        control.name + ' set to ' + target.value + ' ' + (control.unit || ''));
      if (ok) {
        const note = $('state-' + control.id);
        if (note) note.textContent = 'Last requested: ' + target.value + ' ' + (control.unit || '') + ' · output state not reported';
      }
    }
  });
  $('diagnosticControls').addEventListener('click', async (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const control = activeProfile().controls.find((item) => item.id === target.dataset.action);
    if (control) await sendCommand(control.command, control.id, control.name + ' command sent');
  });
}

function captureProfileEditor() {
  const profile = activeProfile();
  if (!profile) return;
  const name = $('profileName').value.trim();
  if (name) profile.name = name;
  const controllerType = $('controllerType');
  if (controllerType) profile.controllerType = controllerType.value;
  for (const control of profile.controls) {
    const read = (field) => document.querySelector('[data-control-id="' + control.id + '"][data-field="' + field + '"]');
    const enabled = read('enabled');
    const title = read('name');
    const type = read('type');
    if (enabled) control.enabled = enabled.checked;
    if (title) control.name = title.value.trim();
    if (type) control.type = type.value;
    for (const field of ['on', 'off', 'command', 'power', 'unit']) {
      const input = read(field);
      if (input) control[field] = input.value.trim();
    }
    for (const field of ['min', 'max', 'initial']) {
      const input = read(field);
      if (input && input.value !== '') control[field] = Number(input.value);
    }
  }
  for (const sensor of profile.sensors) {
    const read = (field) => document.querySelector('[data-sensor-id="' + sensor.id + '"][data-field="' + field + '"]');
    const enabled = read('enabled');
    const nameInput = read('name');
    const pin = read('pin');
    if (enabled) sensor.enabled = enabled.checked;
    if (nameInput) sensor.name = nameInput.value.trim();
    if (pin) sensor.pin = pin.value.trim().toUpperCase();
  }
}

function validateStore() {
  const names = new Set();
  for (const profile of state.profileStore.profiles) {
    const name = String(profile.name || '').trim();
    if (!name) throw new Error('Every machine profile needs a name.');
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) throw new Error('Machine profile names must be unique.');
    names.add(normalizedName);
    for (const control of profile.controls) {
      if (!control.enabled) continue;
      if (!String(control.name || '').trim()) throw new Error('Enabled controls need a name.');
      const commands = control.type === 'action' ? [control.command] : [control.on, control.off, ...(control.power !== undefined ? [control.power] : [])];
      if (commands.some((command) => !String(command || '').trim() || /[\r\n]/.test(command))) {
        throw new Error('Each enabled control needs its one-line command or on/off commands.');
      }
      if (control.type === 'range-toggle' && (!Number.isFinite(Number(control.min)) ||
          !Number.isFinite(Number(control.max)) || Number(control.max) <= Number(control.min) ||
          !Number.isFinite(Number(control.initial)) || Number(control.initial) < Number(control.min) ||
          Number(control.initial) > Number(control.max))) {
        throw new Error('Range control minimum, maximum, and default values are invalid.');
      }
    }
    for (const sensor of profile.sensors) {
      if (sensor.enabled && (!String(sensor.name || '').trim() || !String(sensor.pin || '').trim())) {
        throw new Error('Enabled sensors need both a name and a status mapping.');
      }
    }
  }
}

function setConfigNotice(message, kind) {
  const node = $('configNotice');
  node.textContent = message;
  node.className = 'notice ' + (kind || 'info');
}

function bindConfigurationEvents() {
  $('profileSelect').addEventListener('change', () => {
    captureProfileEditor();
    state.profileStore.activeProfileId = $('profileSelect').value;
    state.dirty = true;
    renderProfileSelect();
    renderConfiguration();
    renderDiagnostics();
    syncStatusPolling();
    setConfigNotice('Profile selection changed. Save profiles to remember this selection.', 'info');
  });
  $('profileName').addEventListener('input', () => {
    captureProfileEditor();
    state.dirty = true;
    setConfigNotice('Unsaved changes. Save the profile to keep your edits.', 'info');
  });
  $('controllerType').addEventListener('change', () => {
    captureProfileEditor();
    state.dirty = true;
    syncStatusPolling();
    renderDiagnostics();
    setConfigNotice('Controller mode changed. Save the profile to keep this setting. ' + profilePollingDescription(activeProfile()), 'info');
  });
  $('controlEditor').addEventListener('input', () => {
    captureProfileEditor();
    state.dirty = true;
    setConfigNotice('Unsaved changes. Save the profile to keep your edits.', 'info');
  });
  $('sensorEditor').addEventListener('input', () => {
    captureProfileEditor();
    state.dirty = true;
    setConfigNotice('Unsaved changes. Save the profile to keep your edits.', 'info');
  });
  $('controlEditor').addEventListener('change', (event) => {
    captureProfileEditor();
    state.dirty = true;
    if (event.target.matches('select[data-field="type"]')) renderConfiguration();
    else setConfigNotice('Unsaved changes. Save the profile to keep your edits.', 'info');
  });
  $('sensorEditor').addEventListener('change', () => {
    captureProfileEditor();
    state.dirty = true;
    setConfigNotice('Unsaved changes. Save the profile to keep your edits.', 'info');
  });
  $('addControl').addEventListener('click', () => {
    captureProfileEditor();
    activeProfile().controls.push({
      id: 'custom-' + newId(), name: 'Custom control', custom: true, enabled: false,
      type: 'toggle', min: 0, max: 100, initial: 0, unit: '', on: '', off: '', command: '',
    });
    state.dirty = true;
    renderConfiguration();
    setConfigNotice('Custom control added. Configure its command and enable it when ready.', 'info');
  });
  $('addSensor').addEventListener('click', () => {
    captureProfileEditor();
    activeProfile().sensors.push({
      id: 'sensor-' + newId(), name: 'Custom sensor', custom: true, enabled: false, pin: '',
    });
    state.dirty = true;
    renderConfiguration();
    setConfigNotice('Custom sensor added. Map its status field and enable it when ready.', 'info');
  });
  $('controlEditor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-control]');
    if (!button) return;
    captureProfileEditor();
    const profile = activeProfile();
    profile.controls = profile.controls.filter((control) => control.id !== button.dataset.removeControl);
    state.dirty = true;
    renderConfiguration();
    setConfigNotice('Custom control removed. Save profiles to keep this change.', 'info');
  });
  $('sensorEditor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-sensor]');
    if (!button) return;
    captureProfileEditor();
    const profile = activeProfile();
    profile.sensors = profile.sensors.filter((sensor) => sensor.id !== button.dataset.removeSensor);
    state.dirty = true;
    renderConfiguration();
    setConfigNotice('Custom sensor removed. Save profiles to keep this change.', 'info');
  });
  $('newProfile').addEventListener('click', () => {
    captureProfileEditor();
    const profile = {
      id: newId(),
      name: 'New Machine',
      controllerType: 'grbl',
      controls: clone(DEFAULT_CONTROLS).map((control) => ({
        ...control, enabled: false, on: '', off: '', command: '',
      })),
      sensors: clone(DEFAULT_SENSORS).map((sensor) => ({ ...sensor, enabled: false, pin: '' })),
    };
    state.profileStore.profiles.push(profile);
    state.profileStore.activeProfileId = profile.id;
    state.dirty = true;
    renderProfileSelect();
    renderConfiguration();
    syncStatusPolling();
    setConfigNotice('New profile created. Configure it and save when ready.', 'info');
  });
  $('duplicateProfile').addEventListener('click', () => {
    captureProfileEditor();
    const copy = clone(activeProfile());
    copy.id = newId();
    copy.name = 'Copy of ' + copy.name;
    state.profileStore.profiles.push(copy);
    state.profileStore.activeProfileId = copy.id;
    state.dirty = true;
    renderProfileSelect();
    renderConfiguration();
    syncStatusPolling();
    setConfigNotice('Profile duplicated. Save your copy when ready.', 'info');
  });
  $('deleteProfile').addEventListener('click', () => {
    captureProfileEditor();
    if (state.profileStore.profiles.length <= 1) return;
    const profile = activeProfile();
    if (!window.confirm('Delete machine profile "' + profile.name + '"?')) return;
    state.profileStore.profiles = state.profileStore.profiles.filter((item) => item.id !== profile.id);
    state.profileStore.activeProfileId = state.profileStore.profiles[0].id;
    state.dirty = true;
    renderProfileSelect();
    renderConfiguration();
    renderDiagnostics();
    syncStatusPolling();
    setConfigNotice('Profile deleted. Save profiles to keep this change.', 'info');
  });
  $('saveProfile').addEventListener('click', async () => {
    captureProfileEditor();
    try {
      validateStore();
      await storage.set(STORAGE_KEY, state.profileStore);
      state.dirty = false;
      renderProfileSelect();
      renderConfiguration();
      renderDiagnostics();
      setConfigNotice('Machine profiles saved in gSender.', 'success');
    } catch (error) {
      setConfigNotice('Could not save profiles: ' + (error.message || error), 'error');
    }
  });
}

function setPage(page) {
  state.currentPage = page;
  const diagnostics = page === 'diagnostics';
  $('diagnosticsPage').hidden = !diagnostics;
  $('configurationPage').hidden = diagnostics;
  $('pageTitle').textContent = diagnostics ? 'Diagnostics' : 'Configuration';
  document.querySelectorAll('.page-tabs .tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === page);
  });
  syncStatusPolling();
}

function bindEvents() {
  document.querySelectorAll('.page-tabs .tab').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });
  $('openConfig').addEventListener('click', () => setPage('configuration'));
  bindDiagnosticEvents();
  bindConfigurationEvents();
}

async function initialize() {
  try {
    const saved = await storage.get(STORAGE_KEY, null);
    if (saved) {
      state.profileStore = normalizeStore(saved);
      if (JSON.stringify(saved) !== JSON.stringify(state.profileStore)) {
        await storage.set(STORAGE_KEY, state.profileStore);
      }
    }
  } catch (error) {
    state.storageError = 'Profile storage is unavailable: ' + (error.message || error);
  }
  render();
  try {
    const registration = await machine.registerParser({
      id: STATUS_PARSER_ID,
      mode: 'line',
      match: /^<.*>$/,
    });
    const errors = Array.isArray(registration?.errors) ? registration.errors : [];
    const registered = Array.isArray(registration?.registered) && registration.registered.includes(STATUS_PARSER_ID);
    if (errors.length || !registered) {
      throw new Error(errors.map((entry) => entry.error || entry.message || String(entry)).join('; ') ||
        'gSender did not confirm parser registration.');
    }
    state.parserStatus = 'Status listener registered; waiting for live controller reports.';
    state.unsubscribeStatus = machine.onParsed(STATUS_PARSER_ID, readStatusLine);
  } catch (error) {
    state.parserStatus = 'Status listener error: ' + (error.message || error);
    setNotice('Could not listen for controller status: ' + (error.message || error), 'error');
  }
  renderSensors();
  await refreshMachineState();
  const stateTimer = window.setInterval(() => { void refreshMachineState(); }, 1000);
  machine.addListener('workflow:state', () => { void refreshMachineState(); });
  syncStatusPolling();
  window.addEventListener('beforeunload', () => {
    window.clearInterval(stateTimer);
    if (state.statusTimer !== null) window.clearTimeout(state.statusTimer);
    state.unsubscribeStatus?.();
    void machine.unregisterParser(STATUS_PARSER_ID).catch(() => {});
  });
}

void initialize();
