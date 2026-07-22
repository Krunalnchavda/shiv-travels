/* =====================================================
   Shiv Travels — real-time cloud sync (Firebase Firestore)
   -----------------------------------------------------
   Every device that signs in shares one database, so a trip
   added on a phone shows up on the laptop straight away.

   Two separate datasets live in the same Firebase project:
     envs/prod  — the real business data (the deployed site)
     envs/dev   — a scratch copy used automatically whenever
                  the app runs on localhost or off the disk
   so testing on a laptop can never touch real trips.

   If firebase-config.js is left blank the whole module stands
   down and the app keeps running on browser-only storage.
   ===================================================== */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, setDoc, deleteDoc, onSnapshot, getDoc, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

/* ---------- read target vs. write permission ----------
   Local (localhost or opened off the disk) runs as a live MIRROR of production:
   it READS envs/prod, so you always see the real business data, but every write
   stays inside this browser and is never sent to the cloud. That means you can
   add / edit / delete freely on your laptop and production can never change.
   Only the real deployed site both reads and writes envs/prod. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', ''];
const IS_LOCAL = LOCAL_HOSTS.includes(location.hostname) || location.protocol === 'file:';
const ENV = 'prod';               // both local and live read production data
const WRITE_TO_CLOUD = !IS_LOCAL; // only the deployed site is allowed to write back

/* record collections mirror the arrays on `db`; settings and seq are single docs */
const COLLECTIONS = ['trips', 'drivers', 'clients', 'vehicles', 'expenses', 'investments'];

const cfg = window.FIREBASE_CONFIG || {};
const CONFIGURED = !!(cfg.apiKey && cfg.projectId);

/* Whatever this browser held before it ever talked to the cloud, kept under its
   own key. The first snapshot from an empty cloud legitimately empties db and
   the normal cache with it, so without this copy a device's records would be
   unrecoverable the moment it signed in. Written once and never overwritten. */
const PRESYNC_KEY = 'urbania-partner-db-v1-presync';
function keepPreSyncCopy() {
  try {
    if (localStorage.getItem(PRESYNC_KEY)) return;
    const raw = localStorage.getItem('urbania-partner-db-v1');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const count = ['trips', 'drivers', 'clients', 'vehicles', 'expenses', 'investments']
      .reduce((n, k) => n + ((parsed || {})[k] || []).length, 0);
    if (count) localStorage.setItem(PRESYNC_KEY, raw);
  } catch (e) { /* best effort */ }
}

const Sync = {
  env: ENV,
  mirror: IS_LOCAL,   // true on localhost/off-disk: reads prod, writes stay local only
  configured: CONFIGURED,
  active: false,      // true once signed in and listening
  ready: false,       // true once the first full snapshot has arrived
  status: CONFIGURED ? 'connecting' : 'local',
  error: '',
  _app: null, _auth: null, _fs: null,
  _last: null,        // last known server state, used to diff local edits
  _unsubs: [],
  _pending: 0,
};
window.Sync = Sync;

/* ---------- helpers ---------- */
const envDoc = () => doc(Sync._fs, 'envs', ENV);
const colRef = name => collection(envDoc(), name);
const metaRef = name => doc(envDoc(), 'meta', name);

function snapshotOf(database) {
  const out = { settings: JSON.parse(JSON.stringify(database.settings || {})), seq: JSON.parse(JSON.stringify(database.seq || {})) };
  COLLECTIONS.forEach(c => { out[c] = JSON.parse(JSON.stringify(database[c] || [])); });
  return out;
}

function setStatus(status, error = '') {
  Sync.status = status;
  Sync.error = error;
  if (typeof updateSyncBadge === 'function') updateSyncBadge();
}

/* =====================================================
   INBOUND — server changes stream into the app
   ===================================================== */
function listen() {
  stopListening();

  let seen = 0;
  const expected = COLLECTIONS.length + 2;
  const markReady = () => {
    seen++;
    if (seen >= expected && !Sync.ready) {
      Sync.ready = true;
      setStatus('synced');
    }
  };

  COLLECTIONS.forEach(name => {
    Sync._unsubs.push(onSnapshot(colRef(name), snap => {
      const rows = [];
      snap.forEach(d => rows.push(Object.assign({ id: d.id }, d.data())));
      db[name] = rows;
      afterInbound();
      markReady();
    }, err => setStatus('error', err.message)));
  });

  Sync._unsubs.push(onSnapshot(metaRef('settings'), snap => {
    if (snap.exists()) {
      // keep the local theme choice — it is a per-device preference, not business data
      const theme = db.settings.theme;
      Object.assign(db.settings, snap.data(), { theme });
    }
    afterInbound();
    markReady();
  }, err => setStatus('error', err.message)));

  Sync._unsubs.push(onSnapshot(metaRef('seq'), snap => {
    if (snap.exists()) db.seq = Object.assign({ booking: 0 }, snap.data());
    afterInbound();
    markReady();
  }, err => setStatus('error', err.message)));
}

// a server update is now the truth: remember it, cache it, and redraw
function afterInbound() {
  Sync._last = snapshotOf(db);
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* cache only */ }
  if (Sync.ready && typeof render === 'function') render();
}

function stopListening() {
  Sync._unsubs.forEach(u => { try { u(); } catch (e) {} });
  Sync._unsubs = [];
}

/* =====================================================
   OUTBOUND — local edits are diffed against the last
   server state, so only what actually changed is written.
   Called from saveDB(), which every write already funnels
   through, so no individual save function needed changing.
   ===================================================== */
Sync.push = async function push() {
  if (!WRITE_TO_CLOUD) return; // local mirror — every edit stays in this browser, never the cloud
  if (!Sync.active || !Sync.ready) return;
  const prev = Sync._last || { settings: {}, seq: {} };
  const next = snapshotOf(db);
  const batch = writeBatch(Sync._fs);
  let writes = 0;

  COLLECTIONS.forEach(name => {
    const before = new Map((prev[name] || []).map(o => [o.id, JSON.stringify(o)]));
    const after = new Map((next[name] || []).map(o => [o.id, o]));

    after.forEach((obj, id) => {
      if (before.get(id) !== JSON.stringify(obj)) {
        const { id: _drop, ...data } = obj; // id lives in the document key
        batch.set(doc(colRef(name), id), data);
        writes++;
      }
    });
    before.forEach((_json, id) => {
      if (!after.has(id)) { batch.delete(doc(colRef(name), id)); writes++; }
    });
  });

  // theme is per-device, so it is stripped before the shared settings doc is written
  const { theme: _t, ...sharedSettings } = next.settings;
  const { theme: _p, ...prevShared } = prev.settings || {};
  if (JSON.stringify(prevShared) !== JSON.stringify(sharedSettings)) {
    batch.set(metaRef('settings'), sharedSettings);
    writes++;
  }
  if (JSON.stringify(prev.seq) !== JSON.stringify(next.seq)) {
    batch.set(metaRef('seq'), next.seq);
    writes++;
  }

  if (!writes) return;
  Sync._last = next; // assume success; a failure below rolls the marker back
  Sync._pending++;
  setStatus('saving');
  try {
    await batch.commit();
    Sync._pending--;
    if (Sync._pending <= 0) { Sync._pending = 0; setStatus('synced'); }
  } catch (err) {
    Sync._pending = Math.max(0, Sync._pending - 1);
    Sync._last = prev; // let the next save retry the same changes
    setStatus('error', err.code === 'permission-denied'
      ? 'Read-only account — change not saved'
      : err.message);
    if (typeof toast === 'function') {
      toast(err.code === 'permission-denied' ? '🔒 View-only account — not saved' : '⚠ Could not save to cloud');
    }
  }
};

/* =====================================================
   AUTH — real accounts, shared across every device
   ===================================================== */
Sync.signIn = async function (username, password) {
  const email = username.includes('@') ? username : `${username}@${window.LOGIN_DOMAIN}`;
  const cred = await signInWithEmailAndPassword(Sync._auth, email, password);
  return cred.user;
};

Sync.signOut = async function () {
  stopListening();
  Sync.active = false;
  Sync.ready = false;
  await signOut(Sync._auth);
};

// the role lives server-side, so a guest cannot promote themselves
Sync.loadRole = async function (uid) {
  try {
    const snap = await getDoc(doc(Sync._fs, 'users', uid));
    if (snap.exists()) {
      const d = snap.data();
      return { role: d.role === 'admin' ? 'admin' : 'guest', name: d.name || '' };
    }
  } catch (e) { /* fall through to the safe default */ }
  return { role: 'guest', name: '' }; // no record = least privilege
};

Sync.changePassword = async function (currentPassword, newPassword) {
  const user = Sync._auth.currentUser;
  if (!user) throw new Error('Not signed in');
  // Firebase requires a fresh sign-in before a password change
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword));
  await updatePassword(user, newPassword);
};

/* =====================================================
   Move the data that is already in this browser up to an
   empty cloud dataset. Offered once, on the first admin
   sign-in, so the phone is not staring at a blank app.
   ===================================================== */
Sync.uploadLocalData = async function (localDb) {
  const batch = writeBatch(Sync._fs);
  COLLECTIONS.forEach(name => {
    (localDb[name] || []).forEach(obj => {
      const { id, ...data } = obj;
      batch.set(doc(colRef(name), id), data);
    });
  });
  const { theme: _t, ...settings } = localDb.settings || {};
  batch.set(metaRef('settings'), settings);
  batch.set(metaRef('seq'), localDb.seq || { booking: 0 });
  await batch.commit();
};

Sync.isEmpty = function () {
  return COLLECTIONS.every(c => !(db[c] || []).length);
};

// what this browser held before it first synced — the source for a manual upload
Sync.preSyncData = function () {
  try { return JSON.parse(localStorage.getItem(PRESYNC_KEY)); } catch (e) { return null; }
};
Sync.preSyncCount = function () {
  const d = Sync.preSyncData();
  return d ? COLLECTIONS.reduce((n, c) => n + ((d[c] || []).length), 0) : 0;
};

/* =====================================================
   BOOT
   ===================================================== */
async function boot() {
  // must happen before any listener can replace db with the cloud's version
  if (CONFIGURED) keepPreSyncCopy();

  if (!CONFIGURED) {
    // no cloud configured — run exactly as before, on this browser only
    setStatus('local');
    startApp();
    return;
  }

  try {
    Sync._app = initializeApp(cfg);
    Sync._auth = getAuth(Sync._app);
    // the cache keeps the app usable with no signal and syncs when it returns
    Sync._fs = initializeFirestore(Sync._app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    setStatus('error', err.message);
    startApp();
    return;
  }

  onAuthStateChanged(Sync._auth, async user => {
    if (!user) {
      stopListening();
      Sync.active = false;
      Sync.ready = false;
      setStatus('signed-out');
      onCloudSignedOut();
      return;
    }
    const profile = await Sync.loadRole(user.uid);
    Sync.active = true;
    setStatus('connecting');
    listen();
    onCloudSignedIn({
      username: (user.email || '').split('@')[0],
      name: profile.name || user.displayName || (user.email || '').split('@')[0],
      role: profile.role,
      uid: user.uid,
      email: user.email,
    });
  });

  startApp();
}

boot();
