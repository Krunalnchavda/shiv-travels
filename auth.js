/* =====================================================
   Shiv Travels — Authentication & roles
   Two built-in accounts:
     admin — full rights (add / edit / delete / settings)
     guest — view rights only
   Passwords are hashed before they are stored. This is a
   local-first app, so treat this as access control for the
   people sharing the device, not as server-grade security.
   ===================================================== */

const AUTH_USERS_KEY = 'urbania-users-v1';
const AUTH_SESSION_KEY = 'urbania-session-v1';

// seeded on first run only — after that the stored (possibly changed) passwords win
const DEFAULT_USERS = [
  { username: 'admin', role: 'admin', name: 'Administrator', pass: 'admin123' },
  { username: 'guest', role: 'guest', name: 'Guest', pass: 'guest123' },
];

let users = [];
let currentUser = null;

/* ---------- password hashing ---------- */
// crypto.subtle needs a secure context — it is missing when the app is opened
// straight off the disk with file://, so fall back to a non-crypto digest there.
async function hashPass(text) {
  if (window.crypto && window.crypto.subtle) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* fall through */ }
  }
  let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i) * (i + 7), 2654435761) >>> 0;
  }
  return 'fb' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/* ---------- user store ---------- */
function loadUsers() {
  try { return JSON.parse(localStorage.getItem(AUTH_USERS_KEY)) || []; }
  catch (e) { return []; }
}
function saveUsers() { localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users)); }

async function seedUsers() {
  users = loadUsers();
  const missing = DEFAULT_USERS.filter(d => !users.some(u => u.username === d.username));
  if (!missing.length) return;
  for (const d of missing) {
    users.push({ username: d.username, role: d.role, name: d.name, hash: await hashPass(d.pass) });
  }
  saveUsers();
}

/* ---------- session ---------- */
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_SESSION_KEY));
    if (!s) return null;
    return users.find(u => u.username === s.username) ? s : null;
  } catch (e) { return null; }
}
function saveSession(u) {
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ username: u.username, role: u.role, name: u.name }));
}

/* ---------- role helpers (used by app.js) ---------- */
function canEdit() { return !!currentUser && currentUser.role === 'admin'; }
// guard for every function that changes data — blocks guests even if a control
// is reached some other way (keyboard shortcut, console, stale DOM)
function requireEdit() {
  if (canEdit()) return true;
  if (typeof toast === 'function') toast('🔒 Guest access is view-only');
  return false;
}

/* ---------- login screen ---------- */
let failedTries = 0;
let lockedUntil = 0;

function showLogin() {
  document.body.classList.add('locked');
  document.getElementById('loginScreen').classList.remove('hidden');
  const f = document.getElementById('loginForm');
  f.reset();
  document.getElementById('loginError').textContent = '';
  setTimeout(() => document.getElementById('loginUser').focus(), 50);
}
function hideLogin() {
  document.body.classList.remove('locked');
  document.getElementById('loginScreen').classList.add('hidden');
}

function cloudMode() { return !!(window.Sync && Sync.configured); }

async function handleLogin(e) {
  e.preventDefault();
  const err = document.getElementById('loginError');
  const btn = document.querySelector('.login-btn');
  const wait = Math.ceil((lockedUntil - Date.now()) / 1000);
  if (wait > 0) { err.textContent = `Too many attempts. Try again in ${wait}s.`; return; }

  const username = document.getElementById('loginUser').value.trim().toLowerCase();
  const password = document.getElementById('loginPass').value;

  // With a cloud configured the account lives in Firebase, so it is the same
  // login on every device and the role is enforced server-side.
  if (cloudMode()) {
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await Sync.signIn(username, password);
      // onCloudSignedIn() takes over from here via onAuthStateChanged
    } catch (ex) {
      // setup mistakes get their own message — the raw Firebase text is no help
      const msg = {
        'auth/invalid-credential': 'Incorrect username or password.',
        'auth/invalid-email': 'Incorrect username or password.',
        'auth/user-not-found': 'Incorrect username or password.',
        'auth/wrong-password': 'Incorrect username or password.',
        'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
        'auth/network-request-failed': 'No internet connection.',
        'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Setup problem: the Firebase config in firebase-config.js is not valid.',
        'auth/invalid-api-key': 'Setup problem: the Firebase config in firebase-config.js is not valid.',
        'auth/configuration-not-found': 'Setup problem: turn on Email/Password sign-in in Firebase → Authentication → Sign-in method.',
        'auth/operation-not-allowed': 'Setup problem: turn on Email/Password sign-in in Firebase → Authentication → Sign-in method.',
      }[ex.code] || ex.message;
      err.textContent = msg;
      document.getElementById('loginPass').select();
    } finally {
      btn.disabled = false; btn.textContent = 'Sign In';
    }
    return;
  }

  const user = users.find(u => u.username === username);
  const hash = await hashPass(password);

  if (!user || user.hash !== hash) {
    failedTries++;
    if (failedTries >= 5) { lockedUntil = Date.now() + 30000; failedTries = 0; err.textContent = 'Too many attempts. Try again in 30s.'; }
    else err.textContent = 'Incorrect username or password.';
    document.getElementById('loginPass').select();
    return;
  }

  failedTries = 0;
  currentUser = { username: user.username, role: user.role, name: user.name };
  saveSession(currentUser);
  hideLogin();
  applyRoleUI();
  if (typeof render === 'function') render();
  if (typeof toast === 'function') toast(`Welcome, ${currentUser.name} 👋`);
}

function logout() {
  if (!confirm('Sign out of Shiv Travels?')) return;
  localStorage.removeItem(AUTH_SESSION_KEY);
  if (cloudMode()) { Sync.signOut(); return; } // onCloudSignedOut() finishes up
  currentUser = null;
  applyRoleUI();
  showLogin();
}

/* ---------- called by sync.js when Firebase settles ---------- */
function onCloudSignedIn(user) {
  currentUser = { username: user.username, role: user.role, name: user.name, uid: user.uid };
  hideLogin();
  applyRoleUI();
  if (typeof render === 'function') render();
  if (typeof toast === 'function') toast(`Welcome, ${currentUser.name} 👋`);
  maybeOfferUpload();
}

function onCloudSignedOut() {
  currentUser = null;
  applyRoleUI();
  showLogin();
}

/* First admin sign-in against an empty cloud: offer to lift whatever is already
   in this browser up to the shared database, so the other devices are not
   looking at a blank app. Only ever offered when the cloud has no records. */
let uploadOffered = false;
async function maybeOfferUpload() {
  if (uploadOffered || !cloudMode() || !canEdit()) return;
  uploadOffered = true;
  // wait for the first full snapshot so "is the cloud empty?" is a real answer
  const started = Date.now();
  while (!Sync.ready && Date.now() - started < 8000) await new Promise(r => setTimeout(r, 200));
  if (!Sync.ready || !Sync.isEmpty()) return;

  let local;
  try { local = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { return; }
  const count = local ? ['trips', 'drivers', 'clients', 'vehicles', 'expenses', 'investments']
    .reduce((n, k) => n + (local[k] || []).length, 0) : 0;
  if (!count) return;

  if (!confirm(`The ${Sync.env === 'dev' ? 'TEST' : 'shared'} database is empty, but this browser has ${count} records.\n\nUpload them now so your other devices can see them?`)) return;
  try {
    await Sync.uploadLocalData(local);
    toast('Uploaded to cloud ✔');
  } catch (ex) {
    alert('Upload failed: ' + ex.message);
  }
}

/* password show / hide eye */
function togglePassword(btn) {
  const input = document.getElementById('loginPass');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁️';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.setAttribute('aria-pressed', String(show));
  input.focus();
}
// same eye behaviour for the password boxes inside the Change Password pop-up
function togglePasswordFor(btn, inputId) {
  const input = document.getElementById(inputId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁️';
  btn.setAttribute('aria-pressed', String(show));
}

/* ---------- change password (admin, from Settings) ---------- */
function openPasswordForm() {
  if (!requireEdit()) return;

  // Firebase only lets a signed-in user change their own password, and it wants
  // the current one first. Other accounts are managed from the Firebase console.
  if (cloudMode()) {
    openModal('Change Password', `
      <form onsubmit="saveCloudPassword(event)">
        <p class="muted">Changing the password for <b>${esc(currentUser ? currentUser.username : '')}</b>. This applies on every device straight away.</p>
        <div class="form-grid">
          <div class="field full"><label>Current password</label>
            <div class="pass-wrap">
              <input type="password" id="pwCur" name="cur" required autocomplete="current-password">
              <button type="button" class="eye-btn" onclick="togglePasswordFor(this,'pwCur')" aria-label="Show password">👁️</button>
            </div>
          </div>
          <div class="field full"><label>New password</label>
            <div class="pass-wrap">
              <input type="password" id="pwNew" name="pw1" minlength="6" required autocomplete="new-password">
              <button type="button" class="eye-btn" onclick="togglePasswordFor(this,'pwNew')" aria-label="Show password">👁️</button>
            </div>
          </div>
          <div class="field full"><label>Confirm new password</label>
            <div class="pass-wrap">
              <input type="password" id="pwConfirm" name="pw2" minlength="6" required autocomplete="new-password">
              <button type="button" class="eye-btn" onclick="togglePasswordFor(this,'pwConfirm')" aria-label="Show password">👁️</button>
            </div>
          </div>
        </div>
        <p class="muted">Minimum 6 characters. To change the <b>guest</b> password, use the Firebase console → Authentication → Users.</p>
        <div class="btn-row">
          <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button>
          <button type="submit" class="btn primary">Save Password</button>
        </div>
      </form>`);
    return;
  }

  const opts = users.map(u => `<option value="${u.username}">${u.name} (${u.username} — ${u.role})</option>`).join('');
  openModal('Change Password', `
    <form onsubmit="savePassword(event)">
      <div class="form-grid">
        <div class="field full"><label>Account</label><select name="username" required>${opts}</select></div>
        <div class="field full"><label>New password</label>
          <div class="pass-wrap">
            <input type="password" id="pwNew" name="pw1" minlength="4" required autocomplete="new-password">
            <button type="button" class="eye-btn" onclick="togglePasswordFor(this,'pwNew')" aria-label="Show password">👁️</button>
          </div>
        </div>
        <div class="field full"><label>Confirm new password</label>
          <div class="pass-wrap">
            <input type="password" id="pwConfirm" name="pw2" minlength="4" required autocomplete="new-password">
            <button type="button" class="eye-btn" onclick="togglePasswordFor(this,'pwConfirm')" aria-label="Show password">👁️</button>
          </div>
        </div>
      </div>
      <p class="muted">Minimum 4 characters. If you forget it, use Settings → Reset Logins on this device.</p>
      <div class="btn-row">
        <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button>
        <button type="submit" class="btn primary">Save Password</button>
      </div>
    </form>`);
}

async function savePassword(e) {
  e.preventDefault();
  if (!requireEdit()) return;
  const f = new FormData(e.target);
  if (f.get('pw1') !== f.get('pw2')) { alert('The two passwords do not match.'); return; }
  const user = users.find(u => u.username === f.get('username'));
  if (!user) return;
  user.hash = await hashPass(f.get('pw1'));
  saveUsers();
  closeModal();
  toast(`Password updated for ${user.username} ✔`);
}

async function saveCloudPassword(e) {
  e.preventDefault();
  if (!requireEdit()) return;
  const f = new FormData(e.target);
  if (f.get('pw1') !== f.get('pw2')) { alert('The two passwords do not match.'); return; }
  try {
    await Sync.changePassword(f.get('cur'), f.get('pw1'));
    closeModal();
    toast('Password updated on all devices ✔');
  } catch (ex) {
    alert(ex.code === 'auth/invalid-credential' || ex.code === 'auth/wrong-password'
      ? 'The current password is not correct.'
      : 'Could not change password: ' + ex.message);
  }
}

function resetLogins() {
  if (!requireEdit()) return;
  if (cloudMode()) {
    alert('Cloud accounts are managed in the Firebase console:\nAuthentication → Users → ⋮ → Reset password.');
    return;
  }
  if (!confirm('Reset both logins back to their default passwords?\n\nYour trips, drivers and other business data are NOT touched.')) return;
  localStorage.removeItem(AUTH_USERS_KEY);
  seedUsers().then(() => toast('Logins reset to defaults ✔'));
}

/* =====================================================
   ROLE-BASED UI
   Runs after every render and every pop-up. Admin sees
   everything; guest keeps all read controls and loses
   every control that would change data.
   ===================================================== */

// functions that write to the database
const WRITE_FN = /\b(open[A-Za-z]*Form|save[A-Z]\w*|delete[A-Z]\w*|quickAddClient|restoreData|clearAllData|loadSampleData|resetLogins|openEmiForm)\b/;
// a form-opener whose first argument is empty is an "Add new" button — a guest has
// nothing to view there, so it goes. With a record id it stays and opens read-only.
const CREATE_FN = /\bopen[A-Za-z]*Form\(\s*(''|""|)\s*[,)]/;

function applyRoleUI() {
  document.documentElement.dataset.role = currentUser ? currentUser.role : 'none';

  const access = currentUser && currentUser.role === 'admin' ? 'Full access' : 'View only';
  const chip = document.getElementById('userChip');
  if (chip) {
    chip.innerHTML = currentUser
      ? `<span class="user-name">${currentUser.name}</span><span class="role-tag ${currentUser.role}">${access}</span>`
      : '';
  }
  // the drawer carries the same identity on phones, where the top bar has no room
  const drawerUser = document.getElementById('drawerUser');
  if (drawerUser) {
    drawerUser.innerHTML = currentUser
      ? `<span class="du-avatar">${currentUser.role === 'admin' ? '👤' : '👁️'}</span>
         <span class="du-text"><b>${currentUser.name}</b><small>${access}</small></span>`
      : '';
  }
  document.getElementById('logoutBtn').classList.toggle('hidden', !currentUser);

  if (canEdit()) return;

  ['#viewContainer', '#modalBody'].forEach(sel => {
    const root = document.querySelector(sel);
    if (!root) return;

    root.querySelectorAll('[onclick]').forEach(el => {
      const code = el.getAttribute('onclick');
      if (!WRITE_FN.test(code)) return;
      // a form opened on an existing record stays available — it shows the full
      // detail read-only. Everything else that writes is removed outright.
      if (/\bopen[A-Za-z]*Form\(/.test(code) && !CREATE_FN.test(code)) {
        el.title = 'View details (read-only)';
        return;
      }
      el.remove();
    });

    root.querySelectorAll('form[onsubmit]').forEach(f => {
      if (!WRITE_FN.test(f.getAttribute('onsubmit'))) return;
      f.setAttribute('onsubmit', 'event.preventDefault(); return false;');
      f.querySelectorAll('input, select, textarea').forEach(i => { i.disabled = true; });
      f.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(b => b.remove());
    });

    // backup restore is a file picker rather than a button
    root.querySelectorAll('input[type="file"]').forEach(i => (i.closest('label') || i).remove());
  });

  // a read-only pop-up should say so
  const body = document.querySelector('#modalBody');
  if (body && body.querySelector('form') && !body.querySelector('.readonly-note')) {
    body.insertAdjacentHTML('afterbegin',
      '<div class="alert info readonly-note">👁️ <div>View only — you are signed in as Guest.</div></div>');
  }
}

/* ---------- boot ---------- */
async function initAuth() {
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('logoutBtn').addEventListener('click', logout);

  if (cloudMode()) {
    // Firebase decides who is signed in; onCloudSignedIn/Out drive the screen.
    // Show the login card in the meantime rather than flashing the app.
    showLogin();
    applyRoleUI();
    return;
  }

  await seedUsers();
  currentUser = loadSession();
  if (currentUser) { hideLogin(); } else { showLogin(); }
  applyRoleUI();
  if (typeof render === 'function') render();
}
