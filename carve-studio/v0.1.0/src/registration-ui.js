import {file} from '@sienci/gsender-plugin-sdk';
import {createCarveLicense, OFFLINE_ACTIVATION_URL} from './license.js';
import {keys as publicKeys} from './n0jcg-license-public-keys.json';

export function initRegistration(appVersion) {
  const get = id => document.getElementById(id);
  const tabs = [get('editor-tab'), get('registration-tab')];
  const panels = tabs.map(tab => get(tab.getAttribute('aria-controls')));
  const form = get('registration-form'), status = get('registration-message');
  const importButton = get('import-button'), fileInput = get('file-input');
  const client = createCarveLicense({
    keys: publicKeys,
    appVersion,
    storage: {
      getItem: key => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
  });
  let registered = false;

  function show(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    document.querySelector('.top-actions').hidden = index !== 0;
    if (focus) tabs[index].focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => show(index));
    tab.addEventListener('keydown', event => {
      const next = {ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      show(next, true);
    });
  });

  function updateRegistration(lease) {
    registered = true;
    get('registration-mode').textContent = `Registered · code ending in ${lease.license_suffix.slice(-4)}`;
    importButton.textContent = '＋ Import SVG or DXF';
    get('drawing-import-hint').textContent = 'Imported vectors stay editable. Units are interpreted as millimeters.';
    fileInput.disabled = false;
    form.hidden = true;
    get('offline-registration').hidden = true;
    get('return-to-design').hidden = false;
    get('registration-code').value = '';
    get('registration-email').value = '';
  }

  get('return-to-design').addEventListener('click', () => show(0, true));

  const purchaseLink = get('purchase-link');
  const purchaseUrl = get('purchase-link-copy');
  const copyButton = get('copy-purchase-link');
  const purchaseStatus = get('purchase-link-status');
  purchaseUrl.value = purchaseLink.href;
  // gSender's plugin iframe does not allow popups or external navigation.
  if (window.self === window.top) {
    purchaseLink.hidden = false;
    copyButton.classList.remove('primary');
  }
  purchaseUrl.addEventListener('focus', () => purchaseUrl.select());
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(purchaseUrl.value);
      purchaseStatus.textContent = 'Checkout link copied. Paste it into your browser.';
    } catch {
      purchaseUrl.focus();
      purchaseUrl.select();
      purchaseStatus.textContent = 'Copy the selected link, then paste it into your browser.';
    }
  });

  const qrButton = get('toggle-purchase-qr'), qr = get('purchase-qr');
  qrButton.addEventListener('click', () => {
    const showCode = qr.hidden;
    qr.hidden = !showCode;
    qrButton.setAttribute('aria-expanded', String(showCode));
    qrButton.textContent = showCode ? 'Hide QR code' : 'Show QR code';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = get('activate-registration');
    if (registered || submit.disabled) return;
    submit.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Checking registration…';
    try {
      const lease = await client.activate(get('registration-code').value, get('registration-email').value);
      updateRegistration(lease);
      status.textContent = 'Carve Studio is registered. SVG and DXF import is unlocked.';
      if (!panels[1].hidden) get('return-to-design').focus();
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  const offlineMessage = get('offline-message');
  const requestField = get('offline-request');
  const portalField = get('offline-portal-url');
  const responseField = get('offline-response');
  const responseFile = get('offline-response-file');
  portalField.value = OFFLINE_ACTIVATION_URL;

  function showOfflineMessage(message, error = false) {
    offlineMessage.classList.toggle('error', error);
    offlineMessage.textContent = message;
  }

  function copyOfflineField(button, field, name) {
    field.addEventListener('focus', () => field.select());
    get(button).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(field.value);
        showOfflineMessage(name + ' copied.');
      } catch {
        field.focus();
        field.select();
        showOfflineMessage('Copy the selected text.');
      }
    });
  }
  copyOfflineField('copy-offline-request', requestField, 'Activation request');
  copyOfflineField('copy-offline-portal', portalField, 'Activation page link');

  get('create-offline-request').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      requestField.value = await client.createOfflineRequest();
      get('offline-request-actions').hidden = false;
      showOfflineMessage('Activation request ready.');
    } catch (error) {
      showOfflineMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  get('save-offline-request').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await file.openSaveDialog({
        content: requestField.value,
        options: {defaultFileName: 'carve-studio-request.txt', title: 'Save activation request',
          filters: [{name: 'Text files', extensions: ['txt']}]},
      });
      if (result.success) showOfflineMessage('Activation request saved.');
    } catch {
      showOfflineMessage('Could not save the request. Use Copy request to transfer it.', true);
    } finally {
      button.disabled = false;
    }
  });

  responseFile.addEventListener('change', async () => {
    const selected = responseFile.files[0];
    responseFile.value = '';
    if (!selected) return;
    try {
      if (selected.size > 8220) throw Error('The response file is too large.');
      responseField.value = (await selected.text()).trim();
      showOfflineMessage('Response loaded. Select Activate offline.');
    } catch (error) {
      showOfflineMessage(error.message, true);
    }
  });

  get('offline-response-form').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = get('apply-offline-response');
    if (registered || submit.disabled) return;
    submit.disabled = true;
    try {
      updateRegistration(await client.applyOffline(responseField.value));
      responseField.value = '';
      status.textContent = 'Carve Studio is registered. SVG and DXF import is unlocked.';
      if (!panels[1].hidden) get('return-to-design').focus();
    } catch (error) {
      showOfflineMessage(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  void client.restore().then(lease => {
    if (lease && !registered) updateRegistration(lease);
  });

  return {
    canImportDrawing: () => registered,
    openRegistration: () => show(1, true),
  };
}
