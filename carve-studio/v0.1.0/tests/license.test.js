import assert from 'node:assert/strict';
import {test} from 'node:test';
import {installationRequestForKey} from '../src/installation-key.js';
import {CARVE_PRODUCT, LICENSE_ENDPOINT, createCarveLicense} from '../src/license.js';

const now = 1_800_000_000_000;
const code = 'N0JCG-CRV-AAAA-BBBB-CCCC-DDDD';
const email = 'purchaser@example.test';
const algorithm = {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'};
const encoder = new TextEncoder();
const hex = bytes => Buffer.from(bytes).toString('hex');

const installation = 'CS2-' + 'A'.repeat(64);

async function fixture(changeLease = lease => lease) {
  const pair = await crypto.subtle.generateKey({...algorithm, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1])}, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const keys = {test: {algorithm: 'RSASSA-PKCS1-v1_5-SHA256', exponent: 65537, modulus_hex: Buffer.from(jwk.n, 'base64url').toString('hex')}};
  const storage = new Map();
  const calls = [];
  const settings = {
    storage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    keys, appVersion: '0.1.0', now: () => now, installationRequest: async () => installation,
    request: async (url, options) => {
      const req = JSON.parse(options.body);
      calls.push(req);
      assert.equal(url, LICENSE_ENDPOINT);
      assert.equal(options.credentials, 'omit');
      assert.equal(req.product_slug, CARVE_PRODUCT);
      assert.equal(req.license_serial, code);
      assert.equal(req.email, email);
      const lease = changeLease({
        version: 2, key_id: 'test', license_id: 'test-license', license_suffix: 'CCCC-DDDD',
        product_slug: CARVE_PRODUCT, installation_serial: req.installation_serial,
        email_hash: hex(await crypto.subtle.digest('SHA-256', encoder.encode(email))),
        issued_at: now / 1000, expires_at: now / 1000 + 300, grace_until: now / 1000 + 600,
      });
      const signature = Buffer.from(await crypto.subtle.sign(algorithm, pair.privateKey, encoder.encode(JSON.stringify(lease)))).toString('base64url');
      return Response.json({valid: true, lease, signature});
    },
  };
  return {settings, storage, calls};
}

test('a fresh profile is in trial and a signed activation persists without credentials', async () => {
  const {settings,storage,calls} = await fixture();
  const client = createCarveLicense(settings);
  assert.equal(await client.restore(), null);
  const lease = await client.activate(code.toLowerCase(), email.toUpperCase());
  assert.equal(lease.license_suffix, 'CCCC-DDDD');
  assert.equal(calls[0].installation_serial, installation);
  const [serialized] = storage.values();
  assert.ok(!serialized.includes(code));
  assert.ok(!serialized.includes(email));
  const offlineClient = createCarveLicense({...settings, request: () => assert.fail('restore must work offline')});
  assert.deepEqual(await offlineClient.restore(), lease);
  const [key] = storage.keys();
  storage.set(key, serialized.replace('test-license','tampered'));
  assert.equal(await offlineClient.restore(), null);
});

test('a signed license for a different product does not unlock the trial', async () => {
  const {settings} = await fixture(lease => ({...lease, product_slug: 'scanner'}));
  const client = createCarveLicense(settings);
  await assert.rejects(client.activate(code, email), /could not verify/);
  assert.equal(await client.restore(), null);
});

test('offline activation verifies the signature and installation without a network call', async () => {
  const {settings} = await fixture();
  const {lease, signature} = await (await settings.request(LICENSE_ENDPOINT, {
    credentials: 'omit',
    body: JSON.stringify({license_serial: code, email, product_slug: CARVE_PRODUCT, installation_serial: installation}),
  })).json();
  const format = proof => 'CS2.' + Buffer.from(JSON.stringify(proof)).toString('base64url');
  const response = format({lease, signature});
  const offlineSettings = {...settings, request: () => assert.fail('Offline activation cannot fetch')};
  const client = createCarveLicense(offlineSettings);
  const checksum = hex(await crypto.subtle.digest('SHA-256', encoder.encode(installation))).slice(0, 8).toUpperCase();
  assert.equal(await client.createOfflineRequest(), installation + '-' + checksum);
  const secondProfile = createCarveLicense({...offlineSettings, installationRequest: async () => 'CS2-' + 'B'.repeat(64)});
  await assert.rejects(secondProfile.applyOffline(response), /another installation/);
  await assert.rejects(client.applyOffline(format({lease: {...lease, license_id: 'changed'}, signature})), /invalid/);
  const expiredResponseClient = createCarveLicense({...offlineSettings, now: () => now + 601_000});
  await assert.rejects(expiredResponseClient.applyOffline(response), /expired/);
  assert.deepEqual(await client.applyOffline(response), lease);
  assert.deepEqual(await createCarveLicense(offlineSettings).restore(), lease);
  // Even copying the saved proof without its own private key cannot unlock a second profile.
  assert.equal(await secondProfile.restore(), null);
});

test('installation requests prove possession of a non-extractable key', async () => {
  const algorithm = {name: 'ECDSA', namedCurve: 'P-256'};
  const keyPair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  const other = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  assert.equal(keyPair.privateKey.extractable, false);
  const request = await installationRequestForKey(keyPair);
  assert.match(request, /^CS2-[0-9A-F]{64}$/);
  assert.equal(await installationRequestForKey(keyPair), request);
  assert.notEqual(await installationRequestForKey(other), request);
  assert.equal(await installationRequestForKey({...keyPair, publicKey: other.publicKey}), null);
});
