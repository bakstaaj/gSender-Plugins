import {getInstallationRequest} from './installation-key.js';

export const CARVE_PRODUCT = 'carve-studio';
export const LICENSE_ENDPOINT = 'https://www.n0jcg.com/api/v1/licenses/validate';
const LEGACY_STORAGE_KEY = 'com.bakstaaj.carve-studio.license.v1';
const STORAGE_KEY = 'com.bakstaaj.carve-studio.license.v2';
export const OFFLINE_ACTIVATION_URL = 'https://www.n0jcg.com/api/v1/licenses/carve-studio-offline';
const REQUEST_PATTERN = /^CS2-[0-9A-F]{64}$/;
const RESPONSE_PATTERN = /^CS2.([A-Za-z0-9_-]{1,8192})$/;
const SERIAL_PATTERN = /^N0JCG-[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;
const CODE_PATTERN = /^N0JCG-[A-Z0-9]{3}(?:-[A-Z2-9]{4}){4}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LEASE_FIELDS = [
  'version', 'key_id', 'license_id', 'license_suffix', 'product_slug',
  'installation_serial', 'email_hash', 'issued_at', 'expires_at', 'grace_until',
];
const SIGNING_ALGORITHM = {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'};
const encoder = new TextEncoder();

function asHex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function asBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

async function verifyProof(proof, serial, keys) {
  const {lease, signature} = proof || {};
  if (!lease || typeof signature !== 'string' || lease.version !== (REQUEST_PATTERN.test(serial) ? 2 : 1) ||
    lease.product_slug !== CARVE_PRODUCT || lease.installation_serial !== serial ||
    typeof lease.license_id !== 'string' || !lease.license_id ||
    !/^(?:[A-Z2-9]{4}-)?[A-Z2-9]{4}$/.test(lease.license_suffix) || !/^[0-9a-f]{64}$/.test(lease.email_hash) ||
    ![lease.issued_at, lease.expires_at, lease.grace_until].every(Number.isSafeInteger) ||
    lease.issued_at <= 0 || lease.expires_at < lease.issued_at || lease.grace_until < lease.expires_at) return false;

  const key = Object.hasOwn(keys, lease.key_id) && keys[lease.key_id];
  if (!key || key.algorithm !== 'RSASSA-PKCS1-v1_5-SHA256' || key.exponent !== 65537) return false;
  try {
    const modulus = Uint8Array.from(key.modulus_hex.match(/../g), byte => Number.parseInt(byte, 16));
    const publicKey = await crypto.subtle.importKey(
      'jwk', {kty: 'RSA', n: asBase64Url(modulus), e: 'AQAB'}, SIGNING_ALGORITHM, false, ['verify'],
    );
    const signedFields = Object.fromEntries(LEASE_FIELDS.map(field => [field, lease[field]]));
    return await crypto.subtle.verify(
      SIGNING_ALGORITHM, publicKey, fromBase64Url(signature), encoder.encode(JSON.stringify(signedFields)),
    );
  } catch {
    return false;
  }
}

export function createCarveLicense({
  storage, keys, appVersion, request = globalThis.fetch, now = Date.now, installationRequest = getInstallationRequest,
}) {
  function read(key) {
    try {
      return JSON.parse(storage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }

  async function localRequest(create) {
    try {
      const value = await installationRequest(create);
      if (value && REQUEST_PATTERN.test(value)) return value;
    } catch {
      // IndexedDB may be unavailable in private mode or in an unsupported host.
    }
    if (create) throw Error('Could not save the installation key. Open Carve Studio in your normal gSender profile.');
    return null;
  }

  async function restore() {
    const proof = read(STORAGE_KEY);
    if (proof) {
      const serial = await localRequest(false);
      if (serial && await verifyProof(proof, serial, keys)) return proof.lease;
    }
    const legacy = read(LEGACY_STORAGE_KEY);
    if (SERIAL_PATTERN.test(legacy?.serial) && await verifyProof(legacy.proof, legacy.serial, keys)) {
      return legacy.proof.lease;
    }
    return null;
  }

  function saveProof(proof) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(proof));
    } catch {
      throw Error('Carve Studio could not save the activation in this gSender profile. Try again in this profile.');
    }
    return proof.lease;
  }

  async function applyOffline(responseCode) {
    const encoded = RESPONSE_PATTERN.exec(responseCode.trim())?.[1];
    let proof;
    try {
      if (encoded) proof = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(fromBase64Url(encoded)));
    } catch {
      // The signature check also handles incomplete and malformed codes.
    }
    const serial = await localRequest(false);
    if (!proof || !serial || !await verifyProof(proof, serial, keys)) {
      throw Error('This activation response is invalid or belongs to another installation. Check that it matches your offline request.');
    }
    const timestamp = Math.floor(now() / 1000);
    if (proof.lease.issued_at > timestamp + 300) throw Error('Check the date and time on this computer, then try again.');
    if (proof.lease.grace_until < timestamp) throw Error('This response expired. Use the same request to generate a fresh response.');
    return saveProof(proof);
  }

  async function activate(code, purchaserEmail) {
    const licenseSerial = code.trim().toUpperCase();
    const email = purchaserEmail.trim().toLowerCase();
    if (!CODE_PATTERN.test(licenseSerial)) throw Error('Enter the full registration code, including the N0JCG prefix.');
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw Error('Enter the email address used at checkout.');
    const serial = await localRequest(true);

    let response, result;
    try {
      response = await request(LICENSE_ENDPOINT, {
        method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({
          license_serial: licenseSerial, email, installation_serial: serial,
          product_slug: CARVE_PRODUCT, app_version: appVersion,
        }),
        signal: AbortSignal.timeout(12000),
      });
      result = await response.json();
    } catch {
      throw Error('Could not reach the registration service. Check your connection and try again.');
    }
    if (response.status === 429) throw Error('Too many attempts. Wait a moment and try again.');
    if (response.status >= 500) throw Error('The registration service is temporarily unavailable.');
    if (!response.ok || result?.valid !== true) {
      const messages = {
        license_not_found: 'Registration code not found. Check the code in your license email.',
        wrong_product: 'This registration code is for a different product.',
        email_mismatch: 'Use the same email address you used to purchase Carve Studio.',
        activation_limit: 'This registration code has reached its installation limit.',
        license_revoked: 'This registration code has been revoked.',
        license_expired: 'This registration code has expired.',
        installation_upgrade_required: 'Update Carve Studio before activating this license.',
      };
      throw Error(Object.hasOwn(messages, result?.reason) ? messages[result.reason] :
        'The service rejected this registration. Check the email and code and try again.');
    }

    const proof = {lease: result.lease, signature: result.signature};
    const emailHash = asHex(await crypto.subtle.digest('SHA-256', encoder.encode(email)));
    const timestamp = Math.floor(now() / 1000);
    if (!await verifyProof(proof, serial, keys) || proof.lease.email_hash !== emailHash ||
      !licenseSerial.endsWith(proof.lease.license_suffix) ||
      proof.lease.issued_at > timestamp + 300 || proof.lease.expires_at < timestamp) {
      throw Error('The service returned a registration that Carve Studio could not verify.');
    }
    return saveProof(proof);
  }

  async function createOfflineRequest() {
    const serial = await localRequest(true);
    const checksum = asHex(await crypto.subtle.digest('SHA-256', encoder.encode(serial))).slice(0, 8).toUpperCase();
    return serial + '-' + checksum;
  }

  return {restore, activate, createOfflineRequest, applyOffline};
}
