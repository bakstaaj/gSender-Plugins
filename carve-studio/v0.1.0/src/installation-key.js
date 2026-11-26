const DATABASE = 'com.bakstaaj.carve-studio.installation';
const STORE = 'keys';
const KEY = 'signing';
const KEY_ALGORITHM = {name: 'ECDSA', namedCurve: 'P-256'};
const SIGN_ALGORITHM = {name: 'ECDSA', hash: 'SHA-256'};

function transact(db, mode, issueRequest) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = issueRequest(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readKeyPair(create) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const existing = await transact(db, 'readonly', store => store.get(KEY));
    if (existing || !create) return existing;

    const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['sign', 'verify']);
    try {
      await transact(db, 'readwrite', store => store.add(pair, KEY));
      return pair;
    } catch (error) {
      // Another instance of Carve Studio may have created the key first.
      if (error?.name !== 'ConstraintError') throw error;
      return await transact(db, 'readonly', store => store.get(KEY));
    }
  } finally {
    db.close();
  }
}

export async function installationRequestForKey(pair) {
  if (!pair || pair.privateKey.extractable) return null;
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM, pair.privateKey, challenge);
  if (!await crypto.subtle.verify(SIGN_ALGORITHM, pair.publicKey, signature, challenge)) return null;
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  return 'CS2-' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function getInstallationRequest(create = false) {
  return installationRequestForKey(await readKeyPair(create));
}
