/* =====================================================
   Shiv Travels — Urbania Partner Manager
   Local-first app: all data stored in this browser
   (use Settings → Backup to export/restore as JSON)
   ===================================================== */

// ---------- Storage ----------
const DB_KEY = 'urbania-partner-db-v1';

const defaultDB = () => ({
  settings: {
    businessName: 'Shiv Travels',
    businessPhone: '',
    businessAddress: '',
    gstin: '',
    partner1Name: 'Me',
    partner2Name: 'Partner',
    defaultP1: 50,
    defaultP2: 50,
    theme: 'light',
    emi: { monthly: 60000, years: 5, startDate: '', vehicleId: '' },
  },
  trips: [],
  drivers: [],
  clients: [],
  vehicles: [],
  expenses: [], // general (non-trip) expenses
  investments: [], // partner capital contributions
  settlements: [], // settle-up payments one partner made to the other
  seq: { booking: 0 },
});

let db = loadDB();

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return defaultDB();
    const parsed = JSON.parse(raw);
    const out = Object.assign(defaultDB(), parsed, {
      settings: Object.assign(defaultDB().settings, parsed.settings || {}),
    });
    // migration: driver pay is a per-trip expense now — fold old "driverSalary" into driverExpense
    out.trips.forEach(t => {
      const sal = parseFloat(t.driverSalary) || 0;
      if (sal) {
        t.driverExpense = (parseFloat(t.driverExpense) || 0) + sal;
        t.driverSalary = 0;
      }
    });
    // migration: expenses recorded before the type field are one-time (setup) expenses,
    // except EMI payments — those always count as monthly expenses
    out.expenses.forEach(e => {
      if (e.category === 'EMI') e.type = 'monthly';
      else if (!e.type) e.type = 'onetime';
    });
    return out;
  } catch (e) {
    console.error('Failed to load data', e);
    return defaultDB();
  }
}
/* Every write in the app ends up here, which makes it the one place that has to
   know about the cloud. The local copy is always written first so the app stays
   instant and works offline; Sync.push() then diffs against the last known
   server state and uploads only what actually changed. */
function saveDB() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (window.Sync && Sync.active) Sync.push();
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
// format as YYYY-MM-DD in LOCAL time — toISOString() shifts to UTC and can be off by a day
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => localISO(new Date());
function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + days);
  return localISO(d);
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function monthKey(dateStr) { return (dateStr || '').slice(0, 7); }
function thisMonth() { return todayStr().slice(0, 7); }

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---------- Modal ----------
let modalOpenState = '';
// snapshot of every form control, so a close attempt can detect unsaved edits
function modalFormState() {
  return $$('#modalBody input, #modalBody select, #modalBody textarea')
    .map(el => el.name + '=' + (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value))
    .join('|');
}
function openModal(title, bodyHTML) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHTML;
  $('#modalOverlay').classList.remove('hidden');
  if (typeof applyRoleUI === 'function') applyRoleUI(); // pop-ups are read-only for guests
  applyCardTables();
  modalOpenState = modalFormState();
}
function closeModal() { $('#modalOverlay').classList.add('hidden'); }
// user-initiated close (ESC / ✕ / overlay / Cancel) — confirm if there are unsaved changes;
// closeModal() itself stays unconditional for programmatic close after save
function requestCloseModal() {
  if ($('#modalOverlay').classList.contains('hidden')) return;
  if (modalFormState() !== modalOpenState && !confirm('You have unsaved changes. Close without saving?')) return;
  closeModal();
}
$('#modalClose').addEventListener('click', requestCloseModal);
$('#modalOverlay').addEventListener('click', e => { if (e.target === $('#modalOverlay')) requestCloseModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') requestCloseModal(); });

// ---------- Lookups ----------
const driverById = id => db.drivers.find(d => d.id === id);
const clientById = id => db.clients.find(c => c.id === id);
const vehicleById = id => db.vehicles.find(v => v.id === id);
const driverName = id => (driverById(id) || {}).name || '—';
const clientName = id => (clientById(id) || {}).name || '—';
const vehicleNo = id => (vehicleById(id) || {}).number || '—';

// ---------- Trip calculations ----------
const INCOME_FIELDS = ['tripAmount', 'nightCharges', 'extraKm', 'extraHours', 'miscIncome'];
const EXPENSE_FIELDS = ['diesel', 'toll', 'parking', 'driverExpense', 'food', 'hotel', 'cleaning', 'maintenance', 'policeFine', 'otherExpense'];
const EXPENSE_LABELS = {
  diesel: 'Diesel', toll: 'Toll', parking: 'Parking', driverExpense: 'Driver Payment (Kandhu)',
  food: 'Food', hotel: 'Hotel', cleaning: 'Cleaning', maintenance: 'Maintenance',
  policeFine: 'Police Fine', otherExpense: 'Other',
};

// ---------- Vehicle purchase (on-road) cost ----------
const PURCHASE_FIELDS = [
  ['exShowroom', 'Ex-Showroom Price'],
  ['rto', 'RTO / Road Tax'],
  ['rmc', 'RMC'],
  ['crtm', 'CRTM'],
  ['tcs', 'TCS'],
  ['purchInsurance', 'Insurance (1st Year)'],
  ['permitCost', 'Permit'],
  ['fastagCost', 'FASTag'],
  ['gpsCharges', 'GPS Charges'],
  ['accessories', 'Accessories / Fitting'],
  ['otherPurchase', 'Other Charges'],
];
// discount is deducted from the on-road total
const vehiclePurchaseTotal = v => PURCHASE_FIELDS.reduce((s, [f]) => s + num(v[f]), 0) - num(v.discount);

// extra one-time expenses done after purchase — part of the one-time investment,
// never counted in monthly / general expenses
const SETUP_FIELDS = [
  ['videoShoot', 'Video Shoot'],
  ['flower', 'Flower'],
  ['radium', 'Radium'],
  ['sofaSeat', 'Sofa Seat'],
  ['otherSetup', 'Other'],
];
const vehicleSetupTotal = v => SETUP_FIELDS.reduce((s, [f]) => s + num(v[f]), 0);
const vehicleOneTimeTotal = v => vehiclePurchaseTotal(v) + vehicleSetupTotal(v);

const tripIncome = t => INCOME_FIELDS.reduce((s, f) => s + num(t[f]), 0);
const tripExpense = t => EXPENSE_FIELDS.reduce((s, f) => s + num(t[f]), 0);
const tripProfit = t => tripIncome(t) - tripExpense(t);
const tripBalance = t => Math.max(0, tripIncome(t) - num(t.advance));
const tripKm = t => Math.max(0, num(t.endKm) - num(t.startKm));
const activeTrips = () => db.trips.filter(t => t.status !== 'Cancelled');

// ---------- Theme ----------
function applyTheme() {
  document.documentElement.dataset.theme = db.settings.theme;
  $('#themeBtn').textContent = db.settings.theme === 'dark' ? '☀️' : '🌙';
}
$('#themeBtn').addEventListener('click', () => {
  db.settings.theme = db.settings.theme === 'dark' ? 'light' : 'dark';
  saveDB(); applyTheme();
});

// ---------- Navigation ----------
const VIEW_KEY = 'urbania-current-view';
let currentView = 'dashboard';
// keyboard shortcut per pill: 1–9 and 0 for the first ten, S for Settings
const TAB_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 's'];
// left sidebar mirrors the top pills — same items, same switching.
// On a wide screen it is always visible; on a phone it is the slide-in drawer.
$('#sideNav').innerHTML =
  `<div class="side-nav-head">
     <span class="side-nav-title">Menu</span>
     <button class="icon-btn" id="navCloseBtn" title="Close menu" aria-label="Close menu">✕</button>
   </div>
   <div class="side-nav-user" id="drawerUser"></div>` +
  $$('#mainTabs .tab')
    .map((t, i) => `<button class="tab ${t.classList.contains('active') ? 'active' : ''}" data-view="${t.dataset.view}"
      title="Shortcut: ${(TAB_KEYS[i] || '').toUpperCase()}">${t.innerHTML}</button>`).join('') +
  `<button class="btn ghost side-nav-signout" id="drawerLogout">🚪 Sign Out</button>`;
$$('#mainTabs .tab').forEach((t, i) => { if (TAB_KEYS[i]) t.title = `Shortcut: ${TAB_KEYS[i].toUpperCase()}`; });
$$('.tab[data-view]').forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view)));

// ---------- Slide-in menu (phones / tablets) ----------
function isDrawerMode() { return window.matchMedia('(max-width: 999px)').matches; }
function openDrawer() {
  $('#sideNav').classList.add('open');
  $('#navBackdrop').classList.remove('hidden');
  $('#navToggle').setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
}
function closeDrawer() {
  $('#sideNav').classList.remove('open');
  $('#navBackdrop').classList.add('hidden');
  $('#navToggle').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
}
function toggleDrawer() { $('#sideNav').classList.contains('open') ? closeDrawer() : openDrawer(); }

$('#navToggle').addEventListener('click', toggleDrawer);
$('#drawerLogout').addEventListener('click', () => { closeDrawer(); logout(); });
$('#navBackdrop').addEventListener('click', closeDrawer);
$('#navCloseBtn').addEventListener('click', closeDrawer);
// ESC closes the menu — but let an open pop-up handle ESC first
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#modalOverlay').classList.contains('hidden')) closeDrawer();
});
// leaving phone width must not strand the drawer state on the desktop layout
window.addEventListener('resize', () => { if (!isDrawerMode()) closeDrawer(); });

// press the key anywhere (except while typing or inside a pop-up) to switch pill
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (!$('#modalOverlay').classList.contains('hidden')) return;
  const el = e.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
  const idx = TAB_KEYS.indexOf(e.key.toLowerCase());
  const view = $$('#mainTabs .tab')[idx];
  if (view) showView(view.dataset.view);
});
function showView(view) {
  currentView = view;
  localStorage.setItem(VIEW_KEY, view); // survive refresh: reopen on the same tab
  $$('.tab[data-view]').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  closeDrawer(); // picking a screen dismisses the slide-in menu
  render();
}
/* On a phone a wide table can only be read by scrolling it sideways, so every
   row is turned into a stacked card with the column name printed beside each
   value. Done here rather than in each renderer: it reads the header row that
   is already in the markup, so new tables get the treatment automatically.
   The card layout itself is CSS — this only supplies the labels. */
function applyCardTables() {
  $$('#viewContainer table, #modalBody table').forEach(tbl => {
    const headRow = tbl.querySelector('thead tr') || tbl.rows[0];
    if (!headRow) return;
    const heads = [...headRow.cells].filter(c => c.tagName === 'TH').map(th => th.textContent.trim());
    if (heads.length < 3) return; // two-column tables already fit a phone
    tbl.classList.add('as-cards');
    headRow.classList.add('head-row');
    [...tbl.rows].forEach(tr => {
      if (tr === headRow) return;
      [...tr.cells].forEach((td, i) => {
        if (heads[i]) td.setAttribute('data-label', heads[i]);
      });
    });
  });
}

function render() {
  const renderers = {
    dashboard: renderDashboard, trips: renderTrips, drivers: renderDrivers,
    clients: renderClients, vehicles: renderVehicles, purchase: renderPurchase,
    investments: renderInvestments, expenses: renderExpenses,
    profit: renderProfit, reports: renderReports, settings: renderSettings,
  };
  renderers[currentView]();
  updateNotifBadge();
  applyRoleUI();     // strip write controls when a guest is signed in
  applyCardTables(); // label table cells so phones can stack them as cards
}

/* =====================================================
   NOTIFICATIONS
   ===================================================== */
function getNotifications() {
  const notes = [];
  const today = todayStr();
  const soon = addDays(today, 30);

  const expiryCheck = (label, dateStr, owner) => {
    if (!dateStr) return;
    if (dateStr < today) notes.push({ level: 'danger', text: `${label} of ${owner} EXPIRED on ${fmtDate(dateStr)}` });
    else if (dateStr <= soon) notes.push({ level: 'warn', text: `${label} of ${owner} expires on ${fmtDate(dateStr)}` });
  };

  db.vehicles.forEach(v => {
    expiryCheck('Insurance', v.insuranceExpiry, v.number);
    expiryCheck('Permit', v.permitExpiry, v.number);
    expiryCheck('Fitness', v.fitnessExpiry, v.number);
    expiryCheck('PUC', v.pucExpiry, v.number);
    if (v.nextServiceDate) expiryCheck('Service due', v.nextServiceDate, v.number);
  });
  db.drivers.forEach(d => expiryCheck('Driving license', d.licenseExpiry, d.name));

  activeTrips().forEach(t => {
    if (t.status === 'Completed' && t.paymentStatus !== 'Completed' && tripBalance(t) > 0) {
      notes.push({ level: 'danger', text: `Payment pending ${fmt(tripBalance(t))} from ${clientName(t.clientId)} — trip ${t.bookingId}` });
    }
    if (t.status === 'Completed' && t.settlementStatus !== 'Settled' && tripProfit(t) !== 0) {
      notes.push({ level: 'warn', text: `Partner settlement pending for trip ${t.bookingId} (profit ${fmt(tripProfit(t))})` });
    }
    if (t.status === 'Booked' && t.startDate >= today && t.startDate <= addDays(today, 2)) {
      notes.push({ level: 'info', text: `Upcoming trip ${t.bookingId} — ${esc(t.route)} on ${fmtDate(t.startDate)}` });
    }
  });
  return notes;
}
function updateNotifBadge() {
  const n = getNotifications().length;
  const badge = $('#notifBadge');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}
$('#notifBtn').addEventListener('click', () => {
  const notes = getNotifications();
  const html = notes.length
    ? notes.map(n => `<div class="alert ${n.level}">${n.level === 'danger' ? '🔴' : n.level === 'warn' ? '🟡' : '🔵'} <div>${n.text}</div></div>`).join('')
    : `<div class="empty-state"><div class="big">✅</div>All clear — no reminders right now.</div>`;
  openModal('Notifications & Reminders', html);
});

/* =====================================================
   DASHBOARD
   ===================================================== */
function renderDashboard() {
  const el = $('#view-dashboard');
  const today = todayStr();
  const mk = thisMonth();

  const monthTrips = activeTrips().filter(t => monthKey(t.startDate) === mk);
  const monthRevenue = monthTrips.reduce((s, t) => s + tripIncome(t), 0);
  const monthTripExp = monthTrips.reduce((s, t) => s + tripExpense(t), 0);
  const monthGenExp = db.expenses.filter(e => monthKey(e.date) === mk && e.type !== 'onetime').reduce((s, e) => s + num(e.amount), 0);
  const monthExpense = monthTripExp + monthGenExp;
  const pendingPay = activeTrips().filter(t => t.paymentStatus !== 'Completed').reduce((s, t) => s + tripBalance(t), 0);
  const todaysTrips = activeTrips().filter(t => t.startDate <= today && (t.endDate || t.startDate) >= today);
  const upcoming = activeTrips().filter(t => t.status === 'Booked' && t.startDate > today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 6);
  const notes = getNotifications();

  const vehicleRows = db.vehicles.map(v => {
    const onTrip = todaysTrips.find(t => t.vehicleId === v.id);
    return `<tr><td>${esc(v.number)}</td><td>${esc(v.model || '')}</td>
      <td>${onTrip ? `<span class="chip started">On Trip — ${esc(onTrip.route)}</span>` : '<span class="chip completed">Available</span>'}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="view-header"><h2>Dashboard</h2></div>

    <div class="cards">
      <div class="stat-card"><div class="label">Total Trips</div><div class="value">${activeTrips().length}</div><div class="sub">all time</div></div>
      <div class="stat-card"><div class="label">Today's Trips</div><div class="value">${todaysTrips.length}</div><div class="sub">${fmtDate(today)}</div></div>
      <div class="stat-card green"><div class="label">Monthly Revenue</div><div class="value">${fmt(monthRevenue)}</div><div class="sub">this month</div></div>
      <div class="stat-card red"><div class="label">Monthly Expenses</div><div class="value">${fmt(monthExpense)}</div><div class="sub">trips + general</div></div>
      <div class="stat-card ${monthRevenue - monthExpense >= 0 ? 'green' : 'red'}"><div class="label">Net Profit</div><div class="value">${fmt(monthRevenue - monthExpense)}</div><div class="sub">this month</div></div>
      <div class="stat-card amber"><div class="label">Pending Payments</div><div class="value">${fmt(pendingPay)}</div><div class="sub">to collect</div></div>
    </div>

    <div class="two-col">
      <div class="panel">
        <h3>🗓️ Upcoming Trips</h3>
        ${upcoming.length ? `<div class="table-wrap"><table>
          <tr><th>Date</th><th>Route</th><th>Client</th><th>Vehicle</th></tr>
          ${upcoming.map(t => `<tr><td>${fmtDate(t.startDate)}</td><td>${esc(t.route)}</td><td>${esc(clientName(t.clientId))}</td><td>${esc(vehicleNo(t.vehicleId))}</td></tr>`).join('')}
        </table></div>` : `<div class="muted">No upcoming bookings. Add one from the 🧳 Trips tab.</div>`}
      </div>

      <div class="panel">
        <h3>🚐 Vehicle Status</h3>
        ${db.vehicles.length ? `<div class="table-wrap"><table><tr><th>Vehicle</th><th>Model</th><th>Status</th></tr>${vehicleRows}</table></div>`
          : `<div class="muted">No vehicles yet — add one in the Vehicles tab.</div>`}
      </div>
    </div>

    <div class="panel">
      <h3>🔔 Reminders</h3>
      ${notes.length ? notes.slice(0, 6).map(n => `<div class="alert ${n.level}">${n.level === 'danger' ? '🔴' : n.level === 'warn' ? '🟡' : '🔵'} <div>${n.text}</div></div>`).join('')
        : `<div class="muted">All clear — nothing due.</div>`}
    </div>`;
}

/* =====================================================
   TRIPS
   ===================================================== */
let tripFilter = { status: '', month: thisMonth(), search: '' }; // default to current month

function renderTrips(refocusSearch) {
  const el = $('#view-trips');
  let list = [...db.trips].sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  if (tripFilter.status) list = list.filter(t => t.status === tripFilter.status);
  if (tripFilter.month) list = list.filter(t => monthKey(t.startDate) === tripFilter.month);
  if (tripFilter.search) {
    const q = tripFilter.search.toLowerCase();
    list = list.filter(t => [t.bookingId, t.route, clientName(t.clientId), driverName(t.driverId), vehicleNo(t.vehicleId)]
      .join(' ').toLowerCase().includes(q));
  }

  const rows = list.map(t => `
    <tr>
      <td><b>${esc(t.bookingId)}</b></td>
      <td>${fmtDate(t.startDate)}</td>
      <td class="wrap">${esc(t.route)}</td>
      <td>${esc(clientName(t.clientId))}</td>
      <td class="num">${fmt(tripIncome(t))}</td>
      <td class="num">${fmt(tripExpense(t))}</td>
      <td class="num ${tripProfit(t) >= 0 ? 'pos' : 'neg'}">${fmt(tripProfit(t))}</td>
      <td><span class="chip ${(t.paymentStatus || 'Pending').toLowerCase()}">${esc(t.paymentStatus || 'Pending')}</span></td>
      <td><span class="chip ${(t.status || 'Booked').toLowerCase()}">${esc(t.status || 'Booked')}</span></td>
      <td>
        <button class="btn small" onclick="openTripForm('${t.id}')">✏️</button>
        <button class="btn small" onclick="printInvoice('${t.id}')" title="Invoice PDF">🧾</button>
        <button class="btn small" onclick="whatsappTrip('${t.id}')" title="WhatsApp">💬</button>
        <button class="btn small danger" onclick="deleteTrip('${t.id}')">🗑️</button>
      </td>
    </tr>`).join('');

  el.innerHTML = `
    <div class="view-header"><h2>Trips</h2>
      <div class="btn-row">
        <button class="btn ghost" onclick="exportTripsCSV()">⬇️ Export Excel (CSV)</button>
        <button class="btn primary" onclick="openTripForm()">＋ New Trip</button>
      </div>
    </div>
    <div class="filter-row">
      <input type="search" id="tripSearch" placeholder="Search booking, route, client…" value="${esc(tripFilter.search)}"
        oninput="tripFilter.search=this.value; renderTrips(true)">
      <select onchange="tripFilter.status=this.value; renderTrips()">
        <option value="">All statuses</option>
        ${['Booked', 'Started', 'Completed', 'Cancelled'].map(s => `<option ${tripFilter.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
      <input type="month" value="${tripFilter.month}" onchange="tripFilter.month=this.value; renderTrips()">
      ${tripFilter.month || tripFilter.status || tripFilter.search ? `<button class="btn small ghost" onclick="tripFilter={status:'',month:'',search:''}; renderTrips()">Clear filters</button>` : ''}
    </div>
    ${list.length ? `<div class="panel table-wrap"><table>
      <tr><th>Booking</th><th>Start</th><th>Route</th><th>Client</th>
      <th class="num">Income</th><th class="num">Expense</th><th class="num">Profit</th><th>Payment</th><th>Status</th><th>Actions</th></tr>
      ${rows}</table></div>`
      : `<div class="panel empty-state"><div class="big">🧳</div>No trips found.<br><br><button class="btn primary" onclick="openTripForm()">＋ Add your first trip</button></div>`}`;

  // re-render replaces the search box — put focus & caret back so typing continues
  if (refocusSearch) {
    const s = $('#tripSearch');
    if (s) {
      s.focus();
      const n = s.value.length;
      try { s.setSelectionRange(n, n); } catch (e) { /* not all input types support it */ }
    }
  }
}

function nextBookingId() {
  db.seq.booking += 1;
  return `ST-${new Date().getFullYear()}-${String(db.seq.booking).padStart(3, '0')}`;
}

function selectOptions(items, valueKey, labelFn, selected) {
  return `<option value="">— Select —</option>` +
    items.map(i => `<option value="${i[valueKey]}" ${i[valueKey] === selected ? 'selected' : ''}>${esc(labelFn(i))}</option>`).join('');
}

// Source dropdown — "Other…" opens a popup (like New Client) asking for the source name
const SOURCES = ['Instagram', 'WhatsApp', 'Google', 'Facebook', 'Reference', 'Travel Agent', 'Repeat Customer'];
function sourceSelectHTML(current) {
  const isCustom = !!current && !SOURCES.includes(current);
  return `
    <select name="source" onchange="handleSourceChange(this)">
      <option value="">— Select —</option>
      ${SOURCES.map(s => `<option ${current === s ? 'selected' : ''}>${s}</option>`).join('')}
      ${isCustom ? `<option selected>${esc(current)}</option>` : ''}
      <option value="Other">Other…</option>
    </select>`;
}
function handleSourceChange(sel) {
  if (sel.value !== 'Other') return;
  const name = (prompt('Enter source name:') || '').trim();
  if (name) {
    let opt = [...sel.options].find(o => o.value === name);
    if (!opt) {
      opt = new Option(name, name);
      sel.insertBefore(opt, sel.querySelector('option[value="Other"]'));
    }
    sel.value = name;
  } else {
    sel.value = ''; // cancelled — back to "— Select —"
  }
}
function resolveSource(f) {
  return f.source.value === 'Other' ? '' : f.source.value;
}

function openTripForm(id) {
  const t = id ? db.trips.find(x => x.id === id) : null;
  const s = db.settings;
  const v = (field, def = '') => esc(t ? (t[field] ?? '') : def);
  const numField = (name, label, value) => `
    <div class="field"><label>${label}</label>
      <input type="number" step="any" min="0" name="${name}" value="${value}" oninput="recalcTripForm()"></div>`;

  openModal(t ? `Edit Trip — ${t.bookingId}` : 'New Trip', `
  <form id="tripForm" onsubmit="saveTrip(event, '${id || ''}')">
    <div class="wizard-steps">
      <div class="wstep" onclick="gotoTripStep(0)">1️⃣ Booking & Client</div>
      <div class="wstep" onclick="gotoTripStep(1)">2️⃣ Vehicle & Driver</div>
      <div class="wstep" onclick="gotoTripStep(2)">3️⃣ Income & Expenses</div>
      <div class="wstep" onclick="gotoTripStep(3)">4️⃣ Payment & Share</div>
    </div>

    <div class="wizard-step" data-step="0">
    <fieldset><legend>📋 Booking Information</legend>
      <div class="form-grid">
        <div class="field"><label>Booking ID</label><input name="bookingId" readonly value="${v('bookingId', '(auto)')}"></div>
        <div class="field"><label>Booking Date</label><input type="date" name="bookingDate" value="${v('bookingDate', todayStr())}"></div>
        <div class="field"><label>Trip Start Date *</label><input type="date" name="startDate" value="${v('startDate', todayStr())}" oninput="recalcTripForm()"></div>
        <div class="field"><label>Trip End Date</label><input type="date" name="endDate" value="${v('endDate')}" oninput="recalcTripForm()"></div>
        <div class="field"><label>Total Days</label><input name="days" readonly value="${v('days', '1')}"></div>
        <div class="field"><label>Trip Status</label>
          <select name="status">${['Booked', 'Started', 'Completed', 'Cancelled'].map(x => `<option ${v('status', 'Booked') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="field full"><label>Route *</label><input name="route" placeholder="e.g. Pune → Shirdi → Pune" value="${v('route')}"></div>
      </div>
    </fieldset>

    <fieldset><legend>🤝 Client Information</legend>
      <div class="form-grid">
        <div class="field"><label>Client</label><select name="clientId">${selectOptions(db.clients, 'id', c => c.name + (c.mobile ? ' · ' + c.mobile : ''), t?.clientId)}</select></div>
        <div class="field"><label>&nbsp;</label><button type="button" class="btn small ghost" onclick="quickAddClient()">＋ New Client</button></div>
        <div class="field"><label>Pickup Location</label><input name="pickup" value="${v('pickup')}"></div>
        <div class="field"><label>Drop Location</label><input name="drop" value="${v('drop')}"></div>
        <div class="field"><label>Source</label>${sourceSelectHTML(t?.source ?? '')}</div>
      </div>
    </fieldset>
    </div>

    <div class="wizard-step" data-step="1">
    <fieldset><legend>👨‍✈️ Driver</legend>
      <div class="form-grid">
        <div class="field"><label>Driver</label><select name="driverId">${selectOptions(db.drivers, 'id', d => d.name, t?.driverId)}</select></div>
        ${numField('driverAdvance', 'Driver Advance (₹)', v('driverAdvance'))}
      </div>
      <p class="muted">Driver's trip payment (kandhu/bhatta) is entered in step 3️⃣ under "Driver Payment (Kandhu)" — it counts as a trip expense.</p>
    </fieldset>

    <fieldset><legend>🚐 Vehicle & KM</legend>
      <div class="form-grid">
        <div class="field"><label>Vehicle</label><select name="vehicleId">${selectOptions(db.vehicles, 'id', x => x.number + ' · ' + (x.model || ''), t?.vehicleId)}</select></div>
        ${numField('startKm', 'Start KM', v('startKm'))}
        ${numField('endKm', 'End KM', v('endKm'))}
        <div class="field"><label>Total KM</label><input name="totalKm" readonly value="${t ? tripKm(t) : ''}"></div>
        ${numField('fuelLitres', 'Fuel Filled (Litres)', v('fuelLitres'))}
        <div class="field"><label>Average (km/l)</label><input name="mileage" readonly value=""></div>
      </div>
    </fieldset>
    </div>

    <div class="wizard-step" data-step="2">
    <fieldset><legend>💰 Income</legend>
      <div class="form-grid">
        ${numField('tripAmount', 'Trip Amount (₹)', v('tripAmount'))}
        ${numField('nightCharges', 'Night Charges (₹)', v('nightCharges'))}
        ${numField('extraKm', 'Extra KM Charges (₹)', v('extraKm'))}
        ${numField('extraHours', 'Extra Hours (₹)', v('extraHours'))}
        ${numField('miscIncome', 'Misc Income (₹)', v('miscIncome'))}
      </div>
      <div class="totals-line"><span>Total Income</span><span id="tIncome" class="pos">₹0</span></div>
    </fieldset>

    <fieldset><legend>💸 Trip Expenses</legend>
      <div class="form-grid">
        ${EXPENSE_FIELDS.map(f => numField(f, EXPENSE_LABELS[f] + ' (₹)', v(f))).join('')}
      </div>
      <div class="totals-line"><span>Total Expense</span><span id="tExpense" class="neg">₹0</span></div>
      <div class="totals-line profit"><span>Net Profit</span><span id="tProfit">₹0</span></div>
    </fieldset>
    </div>

    <div class="wizard-step" data-step="3">
    <fieldset><legend>👥 Partnership</legend>
      <div class="form-grid">
        ${numField('p1Pct', `${esc(s.partner1Name)} — Your Share %`, v('p1Pct', s.defaultP1))}
        ${numField('p2Pct', `${esc(s.partner2Name)} — Partner Share %`, v('p2Pct', s.defaultP2))}
        <div class="field"><label>Your Share (₹)</label><input readonly id="yourShare"></div>
        <div class="field"><label>Partner Share (₹)</label><input readonly id="partnerShare"></div>
        <div class="field"><label>Settlement Status</label>
          <select name="settlementStatus">${['Pending', 'Settled'].map(x => `<option ${v('settlementStatus', 'Pending') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="field"><label>Settlement Date</label><input type="date" name="settlementDate" value="${v('settlementDate')}"></div>
      </div>
    </fieldset>

    <fieldset><legend>💳 Payment</legend>
      <div class="form-grid">
        ${numField('advance', 'Advance Received (₹)', v('advance'))}
        <div class="field"><label>Balance (₹)</label><input readonly id="tBalance"></div>
        <div class="field"><label>Payment Method</label>
          <select name="paymentMethod">${['', 'Cash', 'UPI', 'Bank', 'Cheque'].map(x => `<option ${v('paymentMethod') === x ? 'selected' : ''}>${x || '— Select —'}</option>`).join('')}</select></div>
        <div class="field"><label>Payment Status</label>
          <select name="paymentStatus">${['Pending', 'Partial', 'Completed'].map(x => `<option ${v('paymentStatus', 'Pending') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
    </fieldset>

    <fieldset><legend>📝 Notes</legend>
      <div class="field"><textarea name="notes" rows="2" placeholder="Anything to remember about this trip…">${v('notes')}</textarea></div>
    </fieldset>
    </div>

    <div class="btn-row">
      <button type="button" class="btn ghost" id="wBack" onclick="gotoTripStep(tripStep - 1)">← Back</button>
      <button type="button" class="btn primary" id="wNext" onclick="gotoTripStep(tripStep + 1)">Next →</button>
      <button type="submit" class="btn ghost" id="wSave">💾 Save Trip</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button>
    </div>
  </form>`);
  gotoTripStep(0);
  recalcTripForm();
}

let tripStep = 0;
function gotoTripStep(i) {
  const steps = $$('#tripForm .wizard-step');
  if (!steps.length) return;
  tripStep = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach(s => s.classList.toggle('active', +s.dataset.step === tripStep));
  $$('#tripForm .wstep').forEach((c, idx) => {
    c.classList.toggle('active', idx === tripStep);
    c.classList.toggle('done', idx < tripStep);
  });
  const last = tripStep === steps.length - 1;
  // Save is absent for a guest (read-only view), so every button here is optional
  const back = $('#wBack'), next = $('#wNext'), save = $('#wSave');
  if (back) back.classList.toggle('hidden', tripStep === 0);
  if (next) next.classList.toggle('hidden', last);
  if (save) {
    save.classList.toggle('primary', last);
    save.classList.toggle('ghost', !last);
  }
  $('#modalBody').scrollTop = 0;
}

function recalcTripForm() {
  const f = $('#tripForm');
  if (!f) return;
  const g = name => num(f[name]?.value);

  const income = INCOME_FIELDS.reduce((s, x) => s + g(x), 0);
  const expense = EXPENSE_FIELDS.reduce((s, x) => s + g(x), 0);
  const profit = income - expense;
  const km = Math.max(0, g('endKm') - g('startKm'));
  const litres = g('fuelLitres');

  if (f.startDate.value) {
    const days = f.endDate.value ? Math.max(1, daysBetween(f.startDate.value, f.endDate.value) + 1) : 1;
    f.days.value = days;
  }
  f.totalKm.value = km || '';
  f.mileage.value = km && litres ? (km / litres).toFixed(1) : '';

  $('#tIncome').textContent = fmt(income);
  $('#tExpense').textContent = fmt(expense);
  const p = $('#tProfit');
  p.textContent = fmt(profit);
  p.className = profit >= 0 ? 'pos' : 'neg';
  $('#yourShare').value = fmt(profit * g('p1Pct') / 100);
  $('#partnerShare').value = fmt(profit * g('p2Pct') / 100);
  $('#tBalance').value = fmt(Math.max(0, income - g('advance')));
}

function saveTrip(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  if (!f.startDate.value || !f.route.value.trim()) {
    gotoTripStep(0);
    toast('⚠ Please fill Trip Start Date and Route');
    (!f.startDate.value ? f.startDate : f.route).focus();
    return;
  }
  const data = {};
  ['bookingDate', 'startDate', 'endDate', 'days', 'route', 'status', 'clientId', 'pickup', 'drop', 'source',
    'driverId', 'driverAdvance', 'vehicleId', 'startKm', 'endKm', 'fuelLitres',
    ...INCOME_FIELDS, ...EXPENSE_FIELDS, 'p1Pct', 'p2Pct', 'settlementStatus', 'settlementDate',
    'advance', 'paymentMethod', 'paymentStatus', 'notes'
  ].forEach(k => data[k] = f[k]?.value ?? '');
  data.source = resolveSource(f);

  if (id) {
    const t = db.trips.find(x => x.id === id);
    Object.assign(t, data);
  } else {
    data.id = uid();
    data.bookingId = nextBookingId();
    db.trips.push(data);
  }
  saveDB(); closeModal(); render();
  toast(id ? 'Trip updated ✔' : `Trip ${data.bookingId} saved ✔`);
}

function deleteTrip(id) {
  if (!requireEdit()) return;
  const t = db.trips.find(x => x.id === id);
  if (!confirm(`Delete trip ${t.bookingId} (${t.route})? This cannot be undone.`)) return;
  db.trips = db.trips.filter(x => x.id !== id);
  saveDB(); render(); toast('Trip deleted');
}

function quickAddClient() {
  if (!requireEdit()) return;
  const name = prompt('Client name:');
  if (!name) return;
  const mobile = prompt('Mobile number (optional):') || '';
  const c = { id: uid(), name: name.trim(), mobile: mobile.trim(), altMobile: '', source: '', notes: '' };
  db.clients.push(c); saveDB();
  const sel = $('#tripForm [name=clientId]');
  sel.insertAdjacentHTML('beforeend', `<option value="${c.id}" selected>${esc(c.name)}</option>`);
  sel.value = c.id;
  toast('Client added ✔');
}

/* =====================================================
   DRIVERS
   ===================================================== */
function renderDrivers() {
  const el = $('#view-drivers');
  const rows = db.drivers.map(d => {
    const trips = activeTrips().filter(t => t.driverId === d.id);
    const km = trips.reduce((s, t) => s + tripKm(t), 0);
    const paid = trips.reduce((s, t) => s + num(t.driverExpense), 0);
    const expWarn = d.licenseExpiry && d.licenseExpiry <= addDays(todayStr(), 30);
    return `<tr>
      <td><b>${esc(d.name)}</b></td>
      <td>${esc(d.mobile || '—')}</td>
      <td>${esc(d.license || '—')}</td>
      <td>${d.licenseExpiry ? `<span class="${expWarn ? 'neg' : ''}">${fmtDate(d.licenseExpiry)}${expWarn ? ' ⚠️' : ''}</span>` : '—'}</td>
      <td class="num">${trips.length}</td>
      <td class="num">${km.toLocaleString('en-IN')}</td>
      <td class="num">${fmt(paid)}</td>
      <td>
        <button class="btn small" onclick="openDriverForm('${d.id}')">✏️</button>
        <button class="btn small danger" onclick="deleteDriver('${d.id}')">🗑️</button>
      </td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="view-header"><h2>Drivers</h2>
      <button class="btn primary" onclick="openDriverForm()">＋ Add Driver</button></div>
    ${db.drivers.length ? `<div class="panel table-wrap"><table>
      <tr><th>Name</th><th>Mobile</th><th>License No</th><th>License Expiry</th><th class="num">Trips</th><th class="num">Total KM</th><th class="num">Driver Payment</th><th>Actions</th></tr>
      ${rows}</table></div>`
      : `<div class="panel empty-state"><div class="big">👨‍✈️</div>No drivers yet.<br><br><button class="btn primary" onclick="openDriverForm()">＋ Add Driver</button></div>`}`;
}

function openDriverForm(id) {
  const d = id ? db.drivers.find(x => x.id === id) : {};
  openModal(id ? 'Edit Driver' : 'Add Driver', `
    <form onsubmit="saveDriver(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Name *</label><input name="name" required value="${esc(d.name || '')}"></div>
        <div class="field"><label>Mobile</label><input name="mobile" value="${esc(d.mobile || '')}"></div>
        <div class="field"><label>License Number</label><input name="license" value="${esc(d.license || '')}"></div>
        <div class="field"><label>License Expiry</label><input type="date" name="licenseExpiry" value="${esc(d.licenseExpiry || '')}"></div>
        <div class="field full"><label>Notes (salary terms, address…)</label><textarea name="notes" rows="2">${esc(d.notes || '')}</textarea></div>
      </div><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveDriver(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const data = { name: f.name.value.trim(), mobile: f.mobile.value.trim(), license: f.license.value.trim(), licenseExpiry: f.licenseExpiry.value, notes: f.notes.value };
  if (id) Object.assign(db.drivers.find(x => x.id === id), data);
  else db.drivers.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Driver saved ✔');
}
function deleteDriver(id) {
  if (!requireEdit()) return;
  const d = db.drivers.find(x => x.id === id);
  if (!confirm(`Delete driver ${d.name}? Trip records will keep working but show no driver.`)) return;
  db.drivers = db.drivers.filter(x => x.id !== id);
  saveDB(); render(); toast('Driver deleted');
}

/* =====================================================
   CLIENTS
   ===================================================== */
function renderClients() {
  const el = $('#view-clients');
  const rows = db.clients.map(c => {
    const trips = activeTrips().filter(t => t.clientId === c.id);
    const business = trips.reduce((s, t) => s + tripIncome(t), 0);
    const outstanding = trips.filter(t => t.paymentStatus !== 'Completed').reduce((s, t) => s + tripBalance(t), 0);
    return `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${esc(c.mobile || '—')}</td>
      <td>${esc(c.source || '—')}</td>
      <td class="num">${trips.length}</td>
      <td class="num">${fmt(business)}</td>
      <td class="num ${outstanding > 0 ? 'neg' : ''}">${fmt(outstanding)}</td>
      <td>
        <button class="btn small" onclick="showClientHistory('${c.id}')">📜 History</button>
        <button class="btn small" onclick="openClientForm('${c.id}')">✏️</button>
        <button class="btn small danger" onclick="deleteClient('${c.id}')">🗑️</button>
      </td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="view-header"><h2>Clients</h2>
      <button class="btn primary" onclick="openClientForm()">＋ Add Client</button></div>
    ${db.clients.length ? `<div class="panel table-wrap"><table>
      <tr><th>Name</th><th>Mobile</th><th>Source</th><th class="num">Trips</th><th class="num">Total Business</th><th class="num">Outstanding</th><th>Actions</th></tr>
      ${rows}</table></div>`
      : `<div class="panel empty-state"><div class="big">🤝</div>No clients yet.<br><br><button class="btn primary" onclick="openClientForm()">＋ Add Client</button></div>`}`;
}

function showClientHistory(id) {
  const c = clientById(id);
  const trips = activeTrips().filter(t => t.clientId === id).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  const routes = {};
  trips.forEach(t => routes[t.route] = (routes[t.route] || 0) + 1);
  const fav = Object.entries(routes).sort((a, b) => b[1] - a[1])[0];
  openModal(`Client History — ${c.name}`, `
    <p class="muted">📱 ${esc(c.mobile || '—')} ${c.altMobile ? '· ' + esc(c.altMobile) : ''} · Source: ${esc(c.source || '—')}
    ${fav ? `<br>⭐ Favourite route: <b>${esc(fav[0])}</b> (${fav[1]} trips)` : ''}</p>
    ${trips.length ? `<div class="table-wrap"><table>
      <tr><th>Booking</th><th>Date</th><th>Route</th><th class="num">Amount</th><th class="num">Balance</th><th>Status</th></tr>
      ${trips.map(t => `<tr><td>${esc(t.bookingId)}</td><td>${fmtDate(t.startDate)}</td><td>${esc(t.route)}</td>
        <td class="num">${fmt(tripIncome(t))}</td><td class="num ${tripBalance(t) > 0 && t.paymentStatus !== 'Completed' ? 'neg' : ''}">${t.paymentStatus === 'Completed' ? '—' : fmt(tripBalance(t))}</td>
        <td><span class="chip ${(t.status || '').toLowerCase()}">${esc(t.status)}</span></td></tr>`).join('')}
    </table></div>` : '<div class="muted">No trips yet for this client.</div>'}`);
}

function openClientForm(id) {
  const c = id ? db.clients.find(x => x.id === id) : {};
  openModal(id ? 'Edit Client' : 'Add Client', `
    <form onsubmit="saveClient(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Name *</label><input name="name" required value="${esc(c.name || '')}"></div>
        <div class="field"><label>Mobile</label><input name="mobile" value="${esc(c.mobile || '')}"></div>
        <div class="field"><label>Alternate Number</label><input name="altMobile" value="${esc(c.altMobile || '')}"></div>
        <div class="field"><label>Source</label>${sourceSelectHTML(c.source || '')}</div>
        <div class="field full"><label>Notes</label><textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></div>
      </div><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveClient(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const data = { name: f.name.value.trim(), mobile: f.mobile.value.trim(), altMobile: f.altMobile.value.trim(), source: resolveSource(f), notes: f.notes.value };
  if (id) Object.assign(db.clients.find(x => x.id === id), data);
  else db.clients.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Client saved ✔');
}
function deleteClient(id) {
  if (!requireEdit()) return;
  const c = db.clients.find(x => x.id === id);
  if (!confirm(`Delete client ${c.name}?`)) return;
  db.clients = db.clients.filter(x => x.id !== id);
  saveDB(); render(); toast('Client deleted');
}

/* =====================================================
   VEHICLES
   ===================================================== */
function renderVehicles() {
  const el = $('#view-vehicles');
  const today = todayStr(), soon = addDays(today, 30);
  const expChip = d => !d ? '—'
    : d < today ? `<span class="chip cancelled">${fmtDate(d)} ⚠</span>`
    : d <= soon ? `<span class="chip partial">${fmtDate(d)}</span>`
    : `<span class="chip completed">${fmtDate(d)}</span>`;

  const rows = db.vehicles.map(v => {
    const trips = activeTrips().filter(t => t.vehicleId === v.id);
    const km = trips.reduce((s, t) => s + tripKm(t), 0);
    return `<tr>
      <td><b>${esc(v.number)}</b><div class="muted">${esc(v.model || '')}</div></td>
      <td>${expChip(v.insuranceExpiry)}</td>
      <td>${expChip(v.permitExpiry)}</td>
      <td>${expChip(v.fitnessExpiry)}</td>
      <td>${expChip(v.pucExpiry)}</td>
      <td>${expChip(v.nextServiceDate)}</td>
      <td class="num">${trips.length}</td>
      <td class="num">${km.toLocaleString('en-IN')}</td>
      <td>
        <button class="btn small" onclick="openVehicleForm('${v.id}')">✏️</button>
        <button class="btn small danger" onclick="deleteVehicle('${v.id}')">🗑️</button>
      </td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="view-header"><h2>Vehicles</h2>
      <button class="btn primary" onclick="openVehicleForm()">＋ Add Vehicle</button></div>
    ${db.vehicles.length ? `<div class="panel table-wrap"><table>
      <tr><th>Vehicle</th><th>Insurance</th><th>Permit</th><th>Fitness</th><th>PUC</th><th>Next Service</th><th class="num">Trips</th><th class="num">KM Run</th><th>Actions</th></tr>
      ${rows}</table></div>`
      : `<div class="panel empty-state"><div class="big">🚐</div>No vehicles yet.<br><br><button class="btn primary" onclick="openVehicleForm()">＋ Add your Urbania</button></div>`}
    <p class="muted">🟢 valid · 🟡 expiring within 30 days · 🔴 expired</p>`;
}

function openVehicleForm(id) {
  const v = id ? db.vehicles.find(x => x.id === id) : {};
  openModal(id ? 'Edit Vehicle' : 'Add Vehicle', `
    <form onsubmit="saveVehicle(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Vehicle Number *</label><input name="number" required placeholder="MH 12 AB 1234" value="${esc(v.number || '')}"></div>
        <div class="field"><label>Model</label><input name="model" placeholder="Force Urbania 17-Seater" value="${esc(v.model || '')}"></div>
        <div class="field"><label>Insurance Expiry</label><input type="date" name="insuranceExpiry" value="${esc(v.insuranceExpiry || '')}"></div>
        <div class="field"><label>Permit Expiry</label><input type="date" name="permitExpiry" value="${esc(v.permitExpiry || '')}"></div>
        <div class="field"><label>Fitness Expiry</label><input type="date" name="fitnessExpiry" value="${esc(v.fitnessExpiry || '')}"></div>
        <div class="field"><label>PUC Expiry</label><input type="date" name="pucExpiry" value="${esc(v.pucExpiry || '')}"></div>
        <div class="field"><label>Next Service Date</label><input type="date" name="nextServiceDate" value="${esc(v.nextServiceDate || '')}"></div>
        <div class="field full"><label>Notes (tyres, FASTag, EMI…)</label><textarea name="notes" rows="2">${esc(v.notes || '')}</textarea></div>
      </div><br>
      ${id ? '' : `<p class="muted">🧾 Purchase cost (ex-showroom, RTO, TCS…) is entered in the <b>🧾 Purchase</b> tab after saving the vehicle.</p>`}
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function updPurchaseTotal(form) {
  const onRoad = PURCHASE_FIELDS.reduce((s, [f]) => s + num(form[f].value), 0) - num(form.discount.value);
  const setup = SETUP_FIELDS.reduce((s, [f]) => s + num(form[f].value), 0);
  $('#vPurchTotal').textContent = fmt(onRoad);
  $('#vSetupTotal').textContent = fmt(setup);
  $('#vGrandTotal').textContent = fmt(onRoad + setup);
}

// Purchase cost is its own popup, separate from vehicle details
function openPurchaseForm(id) {
  const v = db.vehicles.find(x => x.id === id);
  openModal('🧾 Purchase Cost — ' + v.number, `
    <form onsubmit="savePurchase(event,'${id}')">
      <div class="form-grid">
        <div class="field"><label>Purchase Date</label><input type="date" name="purchaseDate" value="${esc(v.purchaseDate || '')}"></div>
        ${PURCHASE_FIELDS.map(([f, l]) => `<div class="field"><label>${l} (₹)</label>
          <input type="number" step="any" min="0" name="${f}" value="${esc(v[f] || '')}" oninput="updPurchaseTotal(this.form)"></div>`).join('')}
        <div class="field"><label>Discount (₹) — deducted</label>
          <input type="number" step="any" min="0" name="discount" value="${esc(v.discount || '')}" oninput="updPurchaseTotal(this.form)"></div>
      </div>
      <div class="totals-line"><span>Total On-Road Cost (after discount)</span><span id="vPurchTotal">${fmt(vehiclePurchaseTotal(v))}</span></div>
      <fieldset><legend>🎀 Extra One-time Expenses (after purchase)</legend>
        <div class="form-grid">
          ${SETUP_FIELDS.map(([f, l]) => `<div class="field"><label>${l} (₹)</label>
            <input type="number" step="any" min="0" name="${f}" value="${esc(v[f] || '')}" oninput="updPurchaseTotal(this.form)"></div>`).join('')}
          <div class="field full"><label>Remarks</label><input name="setupRemarks" value="${esc(v.setupRemarks || '')}"></div>
        </div>
        <div class="totals-line"><span>Extra One-time Total</span><span id="vSetupTotal">${fmt(vehicleSetupTotal(v))}</span></div>
        <p class="muted">One-time investment only — never counted in monthly or general expenses.</p>
      </fieldset>
      <div class="totals-line profit"><span>Total One-time Investment</span><span id="vGrandTotal">${fmt(vehicleOneTimeTotal(v))}</span></div><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function savePurchase(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const v = db.vehicles.find(x => x.id === id);
  v.purchaseDate = f.purchaseDate.value;
  PURCHASE_FIELDS.forEach(([field]) => v[field] = num(f[field].value));
  v.discount = num(f.discount.value);
  SETUP_FIELDS.forEach(([field]) => v[field] = num(f[field].value));
  v.setupRemarks = f.setupRemarks.value;
  saveDB(); closeModal(); render(); toast('Purchase cost saved ✔');
}

/* =====================================================
   VEHICLE PURCHASE (own tab)
   ===================================================== */
function renderPurchase() {
  const el = $('#view-purchase');
  const list = db.vehicles;
  const grand = list.reduce((s, v) => s + vehicleOneTimeTotal(v), 0);

  el.innerHTML = `
    <div class="view-header"><h2>Vehicle Purchase Cost <span class="muted">(on-road, one-time investment)</span></h2></div>
    ${list.length ? `
    <div class="cards">
      <div class="stat-card"><div class="label">Vehicles</div><div class="value">${list.length}</div></div>
      <div class="stat-card red"><div class="label">Total Investment</div><div class="value">${fmt(grand)}</div><div class="sub">after discount</div></div>
    </div>
    <div class="purchase-grid">${list.map(v => purchaseCardHTML(v, true)).join('')}</div>
    <p class="muted">Kept separate from monthly running expenses — does not affect trip P&L.</p>`
    : `<div class="panel empty-state"><div class="big">🧾</div>No vehicles yet — add one in the Vehicles tab first.<br><br><button class="btn primary" onclick="showView('vehicles')">🚐 Go to Vehicles</button></div>`}`;
}

const vehicleHasPurchase = v => PURCHASE_FIELDS.some(([f]) => num(v[f])) || num(v.discount) || vehicleSetupTotal(v) > 0;

// one card per vehicle: cost heads listed vertically — no horizontal scrolling
function purchaseCardHTML(v, withEdit) {
  const rows = PURCHASE_FIELDS.filter(([f]) => num(v[f]))
    .map(([f, l]) => `<tr><td>${l}</td><td class="num">${fmt(v[f])}</td></tr>`).join('');
  const setupRows = SETUP_FIELDS.filter(([f]) => num(v[f]))
    .map(([f, l]) => `<tr><td>${l}</td><td class="num">${fmt(v[f])}</td></tr>`).join('');
  return `<div class="panel purchase-card">
    <div class="purchase-card-head">
      <div><b>${esc(v.number)}</b>
        <div class="muted">${esc(v.model || '')}${v.purchaseDate ? ` · ${fmtDate(v.purchaseDate)}` : ''}</div></div>
      ${withEdit ? `<button class="btn small" onclick="openPurchaseForm('${v.id}')">✏️</button>` : ''}
    </div>
    ${vehicleHasPurchase(v) ? `<table>
      ${rows}
      ${num(v.discount) ? `<tr><td>Discount</td><td class="num pos">− ${fmt(v.discount)}</td></tr>` : ''}
    </table>
    <div class="totals-line"><span>Total On-Road</span><span>${fmt(vehiclePurchaseTotal(v))}</span></div>
    ${setupRows ? `<div class="muted" style="margin-top:6px"><b>🎀 Extra one-time (after purchase)</b></div>
    <table>${setupRows}</table>
    ${v.setupRemarks ? `<div class="muted">📝 ${esc(v.setupRemarks)}</div>` : ''}
    <div class="totals-line"><span>Extra One-time Total</span><span>${fmt(vehicleSetupTotal(v))}</span></div>` : ''}
    <div class="totals-line profit"><span>Total One-time Investment</span><span>${fmt(vehicleOneTimeTotal(v))}</span></div>`
    : `<p class="muted">No purchase details yet.</p>
    ${withEdit ? `<button class="btn primary small" onclick="openPurchaseForm('${v.id}')">＋ Add purchase cost</button>` : ''}`}
  </div>`;
}

// compact purchase summary for the Reports view
function vehiclePurchasePanel() {
  const list = db.vehicles.filter(vehicleHasPurchase);
  if (!list.length) return '';
  const grand = list.reduce((s, v) => s + vehicleOneTimeTotal(v), 0);
  return `<div class="panel"><h3>🧾 Vehicle Purchase (Investment)</h3>
    <div class="purchase-grid">${list.map(v => purchaseCardHTML(v, false)).join('')}</div>
    ${list.length > 1 ? `<div class="totals-line profit"><span>Total Investment</span><span>${fmt(grand)}</span></div>` : ''}
    <p class="muted">One-time investment per vehicle — kept separate from monthly running expenses.</p></div>`;
}

function saveVehicle(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const data = {
    number: f.number.value.trim().toUpperCase(), model: f.model.value.trim(),
    insuranceExpiry: f.insuranceExpiry.value, permitExpiry: f.permitExpiry.value,
    fitnessExpiry: f.fitnessExpiry.value, pucExpiry: f.pucExpiry.value,
    nextServiceDate: f.nextServiceDate.value, notes: f.notes.value,
  };
  if (id) Object.assign(db.vehicles.find(x => x.id === id), data);
  else db.vehicles.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Vehicle saved ✔');
}
function deleteVehicle(id) {
  if (!requireEdit()) return;
  const v = db.vehicles.find(x => x.id === id);
  if (!confirm(`Delete vehicle ${v.number}?`)) return;
  db.vehicles = db.vehicles.filter(x => x.id !== id);
  saveDB(); render(); toast('Vehicle deleted');
}

/* =====================================================
   PARTNER INVESTMENTS (own tab)
   ===================================================== */
const partnerLabel = p => p === 'p2' ? db.settings.partner2Name : db.settings.partner1Name;

// effective contribution per partner: investments count toward the payer;
// an adjustment (partner paying partner back) credits the payer and debits the receiver
function investmentTotals() {
  let p1 = 0, p2 = 0;
  db.investments.forEach(i => {
    const amt = num(i.amount);
    if (i.kind === 'adjustment') {
      if (i.partner === 'p2') { p2 += amt; p1 -= amt; } else { p1 += amt; p2 -= amt; }
    } else {
      if (i.partner === 'p2') p2 += amt; else p1 += amt;
    }
  });
  return { p1, p2, total: p1 + p2 };
}

function renderInvestments() {
  const el = $('#view-investments');
  const list = [...db.investments].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const { p1, p2, total } = investmentTotals();
  const pct = n => total ? Math.round(n / total * 100) + '%' : '—';
  const purchTotal = db.vehicles.reduce((s, v) => s + vehicleOneTimeTotal(v), 0);
  const p1N = db.settings.partner1Name, p2N = db.settings.partner2Name;

  // to match the agreed split (Settings), the partner below target pays the other the difference
  const r1 = num(db.settings.defaultP1) / 100;
  const diff = Math.round(p1 - total * r1); // >0 → p1 has put in more than his share
  const balanced = Math.abs(diff) < 1;
  const payer = diff > 0 ? 'p2' : 'p1';
  const balanceHTML = total ? `<div class="panel"><h3>⚖️ Investment Balance <span class="muted">(target ${num(db.settings.defaultP1)}/${num(db.settings.defaultP2)})</span></h3>
    ${balanced ? `<p>✅ <b>Balanced</b> — both partners are exactly at their agreed share.</p>`
    : `<p>⚠ <b>${esc(partnerLabel(payer))}</b> should pay <b>${esc(partnerLabel(payer === 'p2' ? 'p1' : 'p2'))}</b>
       <b class="neg">${fmt(Math.abs(diff))}</b> to make the investment equal.</p>
      <button class="btn small primary" onclick="openAdjustmentForm('', ${Math.abs(diff)}, '${payer}')">⇄ Record this payment</button>`}
    <p class="muted">Adjustments (one partner paying the other back) shift the balance without changing the total invested.</p></div>` : '';

  const rowHTML = i => {
    const isAdj = i.kind === 'adjustment';
    const other = i.partner === 'p2' ? 'p1' : 'p2';
    return `<tr>
      <td>${fmtDate(i.date)}</td>
      <td><span class="chip ${isAdj ? 'partial' : 'completed'}">${isAdj ? 'Adjustment' : 'Investment'}</span></td>
      <td>${esc(partnerLabel(i.partner))}${isAdj ? ` → ${esc(partnerLabel(other))}` : ''}</td>
      <td>${isAdj ? '—' : esc(vehicleNo(i.vehicleId))}</td>
      <td class="num pos">${fmt(i.amount)}</td><td class="wrap">${esc(i.notes || '')}</td>
      <td><button class="btn small" onclick="${isAdj ? 'openAdjustmentForm' : 'openInvestmentForm'}('${i.id}')">✏️</button>
      <button class="btn small danger" onclick="deleteInvestment('${i.id}')">🗑️</button></td></tr>`;
  };

  el.innerHTML = `
    <div class="view-header"><h2>Partner Investment <span class="muted">(capital put into the business)</span></h2>
      <div class="btn-row">
        <button class="btn ghost" onclick="openAdjustmentForm()">⇄ Adjustment</button>
        <button class="btn primary" onclick="openInvestmentForm()">＋ Add Investment</button>
      </div></div>
    <div class="cards">
      <div class="stat-card green"><div class="label">Total Invested</div><div class="value">${fmt(total)}</div><div class="sub">both partners</div></div>
      <div class="stat-card"><div class="label">${esc(p1N)}</div><div class="value">${fmt(p1)}</div><div class="sub">${pct(p1)} of total (after adjustments)</div></div>
      <div class="stat-card"><div class="label">${esc(p2N)}</div><div class="value">${fmt(p2)}</div><div class="sub">${pct(p2)} of total (after adjustments)</div></div>
      <div class="stat-card red"><div class="label">Vehicle Purchase Cost</div><div class="value">${fmt(purchTotal)}</div><div class="sub">🧾 Purchase tab</div></div>
    </div>
    ${balanceHTML}
    ${list.length ? `${vehicleWiseInvestmentPanel(list.filter(i => i.kind !== 'adjustment'))}<div class="panel table-wrap"><table>
      <tr><th>Date</th><th>Type</th><th>Partner</th><th>Vehicle</th><th class="num">Amount</th><th class="wrap">Notes</th><th>Actions</th></tr>
      ${list.map(rowHTML).join('')}
      <tr><th>Total (effective)</th><th></th><th></th><th></th><th class="num">${fmt(total)}</th><th></th><th></th></tr>
    </table></div>`
      : `<div class="panel empty-state"><div class="big">💰</div>No investments recorded yet.<br><br><button class="btn primary" onclick="openInvestmentForm()">＋ Add first investment</button></div>`}`;
}

// vehicle-wise split: how much each partner put into each vehicle
function vehicleWiseInvestmentPanel(list) {
  const groups = {};
  list.forEach(i => {
    const k = i.vehicleId || '';
    groups[k] = groups[k] || { p1: 0, p2: 0 };
    groups[k][i.partner === 'p2' ? 'p2' : 'p1'] += num(i.amount);
  });
  const keys = Object.keys(groups);
  if (!keys.length) return '';
  // vehicles first (in db order), unlinked entries last
  keys.sort((a, b) => (a === '') - (b === ''));
  return `<div class="panel"><h3>🚐 Vehicle-wise Investment</h3><div class="table-wrap"><table>
    <tr><th>Vehicle</th><th class="num">${esc(db.settings.partner1Name)}</th><th class="num">${esc(db.settings.partner2Name)}</th><th class="num">Total Invested</th><th class="num">Purchase Cost</th></tr>
    ${keys.map(k => {
      const g = groups[k];
      const v = vehicleById(k);
      const purch = v ? vehicleOneTimeTotal(v) : 0;
      return `<tr><td>${v ? `<b>${esc(v.number)}</b><div class="muted">${esc(v.model || '')}</div>` : '(not linked to a vehicle)'}</td>
        <td class="num">${g.p1 ? fmt(g.p1) : '—'}</td><td class="num">${g.p2 ? fmt(g.p2) : '—'}</td>
        <td class="num"><b>${fmt(g.p1 + g.p2)}</b></td>
        <td class="num">${purch ? fmt(purch) : '—'}</td></tr>`;
    }).join('')}
  </table></div></div>`;
}

function openInvestmentForm(id) {
  const x = id ? db.investments.find(i => i.id === id) : {};
  openModal(id ? 'Edit Investment' : 'Add Investment', `
    <form onsubmit="saveInvestment(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Date *</label><input type="date" name="date" required value="${esc(x.date || todayStr())}"></div>
        <div class="field"><label>Partner *</label>
          <select name="partner" required>
            <option value="p1" ${x.partner !== 'p2' ? 'selected' : ''}>${esc(db.settings.partner1Name)}</option>
            <option value="p2" ${x.partner === 'p2' ? 'selected' : ''}>${esc(db.settings.partner2Name)}</option>
          </select></div>
        <div class="field"><label>Vehicle</label><select name="vehicleId">${selectOptions(db.vehicles, 'id', v => v.number, x.vehicleId)}</select></div>
        <div class="field"><label>Amount (₹) *</label><input type="number" step="any" min="0" name="amount" required value="${esc(x.amount || '')}"></div>
        <div class="field full"><label>Notes (e.g. down payment, RTO, EMI…)</label><input name="notes" value="${esc(x.notes || '')}"></div>
      </div><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveInvestment(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const data = { date: f.date.value, partner: f.partner.value, vehicleId: f.vehicleId.value, amount: num(f.amount.value), notes: f.notes.value };
  if (id) Object.assign(db.investments.find(i => i.id === id), data);
  else db.investments.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Investment saved ✔');
}

// adjustment: one partner pays the other back to even out contributions —
// the payer's investment goes up, the receiver's goes down, total stays the same
function openAdjustmentForm(id, presetAmount, presetPayer) {
  const x = id ? db.investments.find(i => i.id === id) : { amount: presetAmount || '', partner: presetPayer || 'p2' };
  const optLabel = p => `${esc(partnerLabel(p))} pays ${esc(partnerLabel(p === 'p2' ? 'p1' : 'p2'))}`;
  openModal(id ? 'Edit Adjustment' : '⇄ Partner Adjustment', `
    <form onsubmit="saveAdjustment(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Date *</label><input type="date" name="date" required value="${esc(x.date || todayStr())}"></div>
        <div class="field"><label>Who paid whom *</label>
          <select name="partner" required>
            <option value="p1" ${x.partner !== 'p2' ? 'selected' : ''}>${optLabel('p1')}</option>
            <option value="p2" ${x.partner === 'p2' ? 'selected' : ''}>${optLabel('p2')}</option>
          </select></div>
        <div class="field"><label>Amount (₹) *</label><input type="number" step="any" min="0" name="amount" required value="${esc(x.amount || '')}"></div>
        <div class="field full"><label>Notes</label><input name="notes" value="${esc(x.notes || '')}" placeholder="e.g. GPay transfer to equalize investment"></div>
      </div>
      <p class="muted">The payer's investment increases and the receiver's decreases by this amount — total invested stays the same.</p><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveAdjustment(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  const data = { kind: 'adjustment', date: f.date.value, partner: f.partner.value, vehicleId: '', amount: num(f.amount.value), notes: f.notes.value };
  if (id) Object.assign(db.investments.find(i => i.id === id), data);
  else db.investments.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Adjustment saved ✔');
}
function deleteInvestment(id) {
  if (!requireEdit()) return;
  if (!confirm('Delete this investment entry?')) return;
  db.investments = db.investments.filter(i => i.id !== id);
  saveDB(); render(); toast('Investment deleted');
}

/* =====================================================
   GENERAL EXPENSES
   ===================================================== */
const GEN_EXP_CATEGORIES = ['Fuel', 'Maintenance', 'Insurance', 'Service', 'Tyres', 'FASTag Recharge', 'EMI', 'Cleaning', 'Other'];
let expMonthFilter = thisMonth(); // default to current month

// EMI plan summary — paid / remaining / tenure left / next due, all derived
// from the plan in Settings plus recorded expenses with category "EMI"
function emiPanelHTML() {
  const emi = db.settings.emi || {};
  const monthly = num(emi.monthly);
  const months = Math.round(num(emi.years) * 12);
  const total = monthly * months;
  const paid = db.expenses.filter(e => e.category === 'EMI');
  const paidAmt = paid.reduce((s, e) => s + num(e.amount), 0);
  const paidCount = paid.length;
  const remAmt = Math.max(0, total - paidAmt);
  const remEmis = Math.max(0, months - paidCount);
  const remTenure = remEmis ? `${Math.floor(remEmis / 12)} yr ${remEmis % 12} mo` : 'Done 🎉';
  const pct = total ? Math.min(100, Math.round(paidAmt / total * 100)) : 0;

  const addMonths = (dateStr, n) => { const d = new Date(dateStr); d.setMonth(d.getMonth() + n); return localISO(d); };
  let nextDue = '', lastDate = '', overdue = 0;
  if (emi.startDate && months) {
    lastDate = addMonths(emi.startDate, months - 1);
    nextDue = remEmis ? addMonths(emi.startDate, paidCount) : '';
    const t = new Date(todayStr()), s = new Date(emi.startDate);
    let due = (t.getFullYear() - s.getFullYear()) * 12 + (t.getMonth() - s.getMonth()) + (t.getDate() >= s.getDate() ? 1 : 0);
    due = Math.max(0, Math.min(months, due));
    overdue = Math.max(0, due - paidCount);
  }

  return `<div class="panel"><h3>🏦 Vehicle EMI ${emi.vehicleId ? `<span class="muted">— ${esc(vehicleNo(emi.vehicleId))}</span>` : ''}</h3>
    <div class="cards" style="margin-bottom:0">
      <div class="stat-card"><div class="label">Monthly EMI</div><div class="value">${fmt(monthly)}</div><div class="sub">${emi.startDate ? `from ${fmtDate(emi.startDate)}` : 'set first EMI date'}</div></div>
      <div class="stat-card"><div class="label">Total EMI</div><div class="value">${fmt(total)}</div><div class="sub">${months} EMIs · ${num(emi.years)} yrs</div></div>
      <div class="stat-card ${paidAmt ? 'green' : ''}"><div class="label">Paid</div><div class="value">${fmt(paidAmt)}</div><div class="sub">${paidCount} of ${months} EMIs</div></div>
      <div class="stat-card red"><div class="label">Remaining Amount</div><div class="value">${fmt(remAmt)}</div><div class="sub">${remEmis} EMIs left</div></div>
      <div class="stat-card"><div class="label">Remaining Tenure</div><div class="value">${remTenure}</div><div class="sub">${lastDate ? `last EMI ${fmtDate(lastDate)}` : ''}</div></div>
      <div class="stat-card ${overdue ? 'amber' : ''}"><div class="label">Next EMI</div><div class="value">${nextDue ? fmtDate(nextDue) : '—'}</div><div class="sub">${overdue ? `⚠ ${overdue} EMI${overdue > 1 ? 's' : ''} overdue` : (remEmis ? 'on track' : 'completed')}</div></div>
    </div>
    <div class="progress" title="${pct}% paid"><i style="width:${pct}%"></i></div>
    <div class="muted" style="margin-top:4px">${pct}% paid · ${fmt(paidAmt)} of ${fmt(total)}</div>
    <br><button class="btn small ghost" onclick="openEmiForm()">⚙️ Edit EMI Plan</button>
    <span class="muted"> Record each month's payment as an expense with category "EMI" — it counts in monthly expenses.</span></div>`;
}

function openEmiForm() {
  const emi = db.settings.emi || {};
  openModal('🏦 EMI Plan', `
    <form onsubmit="saveEmi(event)">
      <div class="form-grid">
        <div class="field"><label>Monthly EMI (₹) *</label><input type="number" step="any" min="0" name="monthly" required value="${esc(emi.monthly || '')}"></div>
        <div class="field"><label>Tenure (years) *</label><input type="number" step="any" min="0" name="years" required value="${esc(emi.years || '')}"></div>
        <div class="field"><label>First EMI Date</label><input type="date" name="startDate" value="${esc(emi.startDate || '')}"></div>
        <div class="field"><label>Vehicle</label><select name="vehicleId">${selectOptions(db.vehicles, 'id', v => v.number, emi.vehicleId)}</select></div>
      </div><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveEmi(e) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  db.settings.emi = { monthly: num(f.monthly.value), years: num(f.years.value), startDate: f.startDate.value, vehicleId: f.vehicleId.value };
  saveDB(); closeModal(); render(); toast('EMI plan saved ✔');
}

/* Partner settlement — who fronted the cash vs. their agreed share of the cost.
   Only expenses that record a "Paid by" partner are counted; a missing share
   falls back to the Settings default split. Works across one-time and monthly
   expenses alike, because it is about real money paid, not profit accounting. */
function computeSettlement(expenses) {
  let paidP1 = 0, paidP2 = 0, oweP1 = 0, oweP2 = 0, skipped = 0, counted = 0;
  (expenses || db.expenses).forEach(e => {
    const A = num(e.amount);
    if (!A) return;
    if (e.paidBy !== 'p1' && e.paidBy !== 'p2') { skipped++; return; }
    const s1 = e.shareP1 != null ? num(e.shareP1) : num(db.settings.defaultP1);
    const s2 = e.shareP1 != null ? num(e.shareP2) : num(db.settings.defaultP2);
    oweP1 += A * s1 / 100;
    oweP2 += A * s2 / 100;
    if (e.paidBy === 'p2') paidP2 += A; else paidP1 += A;
    counted++;
  });
  // settle-up payments already made between the partners cancel out the debt
  let paidBackToP1 = 0, paidBackToP2 = 0; // p2→p1 and p1→p2
  (db.settlements || []).forEach(s => {
    const A = num(s.amount);
    if (!A) return;
    if (s.payer === 'p2') paidBackToP1 += A; else paidBackToP2 += A;
  });
  // expenseNet > 0 → p2 owes p1. A p2→p1 payment shrinks that; a p1→p2 payment grows it.
  const expenseNet = paidP1 - oweP1;
  const net = expenseNet - paidBackToP1 + paidBackToP2;
  return { paidP1, paidP2, oweP1, oweP2, expenseNet, net, skipped, counted,
    settledCount: (db.settlements || []).length, paidBackToP1, paidBackToP2 };
}

function settlementPanelHTML() {
  const s = computeSettlement();
  const p1N = db.settings.partner1Name, p2N = db.settings.partner2Name;
  const head = `<h3>🤝 Partner Settlement <span class="muted">(who owes whom, across all expenses)</span></h3>`;
  const payBtn = `<button class="btn small" onclick="openSettlementForm()">＋ Record a Payment</button>`;

  // no expense has a "Paid by" yet and no payments logged — still show the panel so it is findable
  if (!s.counted && !s.settledCount) {
    return `<div class="panel">${head}
      <p class="muted">Nothing to settle yet. Add an expense (or edit an existing one) and set <b>Paid by</b> plus the <b>Share %</b> — the balance between ${esc(p1N)} and ${esc(p2N)} will appear here.
      ${s.skipped ? `<br>⚠️ ${s.skipped} existing expense(s) have no “Paid by” set.` : ''}</p>
      <div class="btn-row">${payBtn}</div>
    </div>`;
  }

  const net = Math.round(s.net);
  const line = net === 0
    ? `<span class="pos">✅ All settled — nobody owes anything.</span>`
    : net > 0
      ? `<b>${esc(p2N)}</b> owes <b>${esc(p1N)}</b> <b class="pos">${fmt(net)}</b>`
      : `<b>${esc(p1N)}</b> owes <b>${esc(p2N)}</b> <b class="pos">${fmt(-net)}</b>`;

  // settle-up payment history, newest first
  const pays = [...(db.settlements || [])].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const payLabel = p => p === 'p2' ? p2N : p1N;
  const historyHTML = pays.length ? `
    <details class="settle-history"><summary class="muted">Settle-up payments (${pays.length}) — total ${fmt(Math.round(s.paidBackToP1 + s.paidBackToP2))}</summary>
    <table class="mini-table">
      ${pays.map(p => `<tr>
        <td>${fmtDate(p.date)}</td>
        <td>${esc(payLabel(p.payer))} → ${esc(payLabel(p.payer === 'p2' ? 'p1' : 'p2'))}</td>
        <td class="num">${fmt(p.amount)}</td>
        <td class="wrap">${p.expenseLabel ? `<span class="chip partial">${esc(p.expenseLabel)}</span> ` : ''}${esc(p.notes || '')}</td>
        <td><button class="btn small danger" onclick="deleteSettlement('${p.id}')">🗑️</button></td>
      </tr>`).join('')}
    </table></details>` : '';

  return `<div class="panel">${head}
    <div class="settle-grid">
      <div><div class="muted">${esc(p1N)} paid</div><b>${fmt(Math.round(s.paidP1))}</b><div class="muted">fair share ${fmt(Math.round(s.oweP1))}</div></div>
      <div><div class="muted">${esc(p2N)} paid</div><b>${fmt(Math.round(s.paidP2))}</b><div class="muted">fair share ${fmt(Math.round(s.oweP2))}</div></div>
    </div>
    <div class="settle-result">${line}</div>
    <div class="btn-row">${payBtn}</div>
    ${historyHTML}
    ${s.skipped ? `<p class="muted">⚠️ ${s.skipped} expense(s) not counted — no “Paid by” set. Edit them to include in settlement.</p>` : ''}
  </div>`;
}

/* Every expense where one partner owes the other, with the owed amount and who
   should pay it back — used to offer a "settle one record" choice. */
function settleableExpenses() {
  const out = [];
  (db.expenses || []).forEach(e => {
    if (e.paidBy !== 'p1' && e.paidBy !== 'p2') return;
    const A = num(e.amount);
    if (!A) return;
    const s1 = e.shareP1 != null ? num(e.shareP1) : num(db.settings.defaultP1);
    const s2 = e.shareP1 != null ? num(e.shareP2) : num(db.settings.defaultP2);
    // the payer fronted the whole amount; the other partner owes their share
    const owed = e.paidBy === 'p1' ? A * s2 / 100 : A * s1 / 100;
    const payer = e.paidBy === 'p1' ? 'p2' : 'p1'; // whoever owes is the one who pays back
    if (owed <= 0) return;
    out.push({ id: e.id, owed: Math.round(owed), payer, label: `${fmtDate(e.date)} • ${e.category}` });
  });
  return out;
}

// pre-fill amount + direction when a specific expense (or "whole balance") is chosen
function onSettleAgainstChange(sel) {
  const opt = sel.options[sel.selectedIndex];
  const f = sel.form;
  const amt = opt.getAttribute('data-amount');
  const payer = opt.getAttribute('data-payer');
  if (amt != null && amt !== '') f.amount.value = amt;
  if (payer) f.payer.value = payer;
}

/* Record a settle-up payment one partner made to the other. Two ways to fill it:
   the whole outstanding balance (lump-sum) or one specific expense (record-wise). */
function openSettlementForm(id) {
  if (!requireEdit()) return;
  const x = id ? (db.settlements || []).find(p => p.id === id) : {};
  const s = computeSettlement();
  const p1N = db.settings.partner1Name, p2N = db.settings.partner2Name;
  const nameOf = p => p === 'p2' ? p2N : p1N;
  const lumpPayer = s.net > 0 ? 'p2' : s.net < 0 ? 'p1' : 'p2';
  const lumpAmount = Math.abs(Math.round(s.net));

  const defaultPayer = x.payer || lumpPayer;
  const defaultAmount = x.amount != null ? x.amount : (lumpAmount || '');
  const items = settleableExpenses();
  const againstOpts = `
    <option value="" data-amount="${lumpAmount}" data-payer="${lumpPayer}" ${!x.expenseId ? 'selected' : ''}>Whole outstanding balance (lump-sum) — ${fmt(lumpAmount)}</option>
    ${items.map(it => `<option value="${it.id}" data-amount="${it.owed}" data-payer="${it.payer}" ${x.expenseId === it.id ? 'selected' : ''}>${esc(it.label)} — ${esc(nameOf(it.payer))} owes ${fmt(it.owed)}</option>`).join('')}`;

  openModal(id ? 'Edit Payment' : 'Record a Settle-up Payment', `
    <form onsubmit="saveSettlement(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field full"><label>Settle *</label>
          <select name="against" onchange="onSettleAgainstChange(this)">${againstOpts}</select></div>
        <div class="field"><label>Date *</label><input type="date" name="date" required value="${esc(x.date || todayStr())}"></div>
        <div class="field"><label>Paid by *</label>
          <select name="payer" required>
            <option value="p2" ${defaultPayer === 'p2' ? 'selected' : ''}>${esc(p2N)} → ${esc(p1N)}</option>
            <option value="p1" ${defaultPayer === 'p1' ? 'selected' : ''}>${esc(p1N)} → ${esc(p2N)}</option>
          </select></div>
        <div class="field"><label>Amount (₹) *</label><input type="number" step="any" min="0" name="amount" required value="${esc(defaultAmount)}"></div>
        <div class="field full"><label>Notes</label><input name="notes" value="${esc(x.notes || '')}" placeholder="e.g. paid by UPI"></div>
      </div>
      <p class="muted">Pick <b>Whole outstanding balance</b> for a lump-sum, or a single expense to settle just that record. The amount stays editable for part-payments.</p><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveSettlement(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  const f = e.target;
  const expenseId = f.against ? f.against.value : '';
  const exp = expenseId ? (db.expenses || []).find(x => x.id === expenseId) : null;
  const data = {
    date: f.date.value,
    payer: f.payer.value === 'p1' ? 'p1' : 'p2',
    amount: num(f.amount.value),
    expenseId: expenseId || '',
    expenseLabel: exp ? `${fmtDate(exp.date)} • ${exp.category}` : '',
    notes: f.notes.value,
  };
  if (!db.settlements) db.settlements = [];
  if (id) Object.assign(db.settlements.find(p => p.id === id), data);
  else db.settlements.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Payment recorded ✔');
}
function deleteSettlement(id) {
  if (!requireEdit()) return;
  if (!confirm('Delete this settle-up payment?')) return;
  db.settlements = (db.settlements || []).filter(p => p.id !== id);
  saveDB(); render(); toast('Payment deleted');
}

function renderExpenses() {
  const el = $('#view-expenses');
  let list = [...db.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (expMonthFilter) list = list.filter(e => monthKey(e.date) === expMonthFilter);
  const oneTotal = list.filter(e => e.type === 'onetime').reduce((s, e) => s + num(e.amount), 0);
  const monTotal = list.filter(e => e.type !== 'onetime').reduce((s, e) => s + num(e.amount), 0);
  const typeChip = x => x.type === 'onetime'
    ? '<span class="chip partial">One-time</span>'
    : '<span class="chip completed">Monthly</span>';

  el.innerHTML = `
    <div class="view-header"><h2>Expenses <span class="muted">(vehicle & business — trip expenses are inside each trip)</span></h2>
      <button class="btn primary" onclick="openExpenseForm()">＋ Add Expense</button></div>
    ${emiPanelHTML()}
    ${settlementPanelHTML()}
    <div class="filter-row">
      <input type="month" value="${expMonthFilter}" onchange="expMonthFilter=this.value; renderExpenses()">
      ${expMonthFilter ? `<button class="btn small ghost" onclick="expMonthFilter=''; renderExpenses()">Clear</button>` : ''}
      <span class="muted">One-time: <b>${fmt(oneTotal)}</b> · Monthly: <b>${fmt(monTotal)}</b></span>
    </div>
    ${list.length ? `<div class="panel table-wrap"><table>
      <tr><th>Date</th><th>Type</th><th>Category</th><th>Vehicle</th><th class="num">Amount</th><th>Paid by</th><th>Share</th><th class="wrap">Notes</th><th>Actions</th></tr>
      ${list.map(x => `<tr>
        <td>${fmtDate(x.date)}</td><td>${typeChip(x)}</td><td>${esc(x.category)}</td><td>${esc(vehicleNo(x.vehicleId))}</td>
        <td class="num neg">${fmt(x.amount)}</td>
        <td>${x.paidBy ? esc(partnerLabel(x.paidBy)) : '—'}</td>
        <td>${x.shareP1 != null ? `${num(x.shareP1)}/${num(x.shareP2)}` : '—'}</td>
        <td class="wrap">${esc(x.notes || '')}</td>
        <td><button class="btn small" onclick="openExpenseForm('${x.id}')">✏️</button>
        <button class="btn small danger" onclick="deleteExpense('${x.id}')">🗑️</button></td></tr>`).join('')}
    </table></div>
    <p class="muted">One-time (setup) expenses are <b>not</b> counted in monthly expenses or profit — only Monthly (running) expenses are.</p>`
      : `<div class="panel empty-state"><div class="big">💸</div>No general expenses recorded${expMonthFilter ? ' for this month' : ''}.</div>`}`;
}

function openExpenseForm(id) {
  const x = id ? db.expenses.find(e => e.id === id) : {};
  openModal(id ? 'Edit Expense' : 'Add Expense', `
    <form onsubmit="saveExpense(event,'${id || ''}')">
      <div class="form-grid">
        <div class="field"><label>Date *</label><input type="date" name="date" required value="${esc(x.date || todayStr())}"></div>
        <div class="field"><label>Type *</label>
          <select name="type" required>
            <option value="onetime" ${(x.type || 'onetime') === 'onetime' ? 'selected' : ''}>One-time (setup — not in monthly)</option>
            <option value="monthly" ${x.type === 'monthly' ? 'selected' : ''}>Monthly (running expense)</option>
          </select></div>
        <div class="field"><label>Category *</label>
          <select name="category" required onchange="if(this.value==='EMI')this.form.type.value='monthly'">${GEN_EXP_CATEGORIES.map(c => `<option ${(x.category || '') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Vehicle</label><select name="vehicleId">${selectOptions(db.vehicles, 'id', v => v.number, x.vehicleId)}</select></div>
        <div class="field"><label>Amount (₹) *</label><input type="number" step="any" min="0" name="amount" required value="${esc(x.amount || '')}"></div>
        <div class="field"><label>Paid by *</label>
          <select name="paidBy" required>
            <option value="p1" ${(x.paidBy || 'p1') === 'p1' ? 'selected' : ''}>${esc(db.settings.partner1Name)}</option>
            <option value="p2" ${x.paidBy === 'p2' ? 'selected' : ''}>${esc(db.settings.partner2Name)}</option>
          </select></div>
        <div class="field"><label>${esc(db.settings.partner1Name)} Share %</label>
          <input type="number" step="any" min="0" max="100" name="shareP1" value="${esc(x.shareP1 != null ? x.shareP1 : db.settings.defaultP1)}"
            oninput="this.form.shareP2.value = Math.max(0, 100 - (parseFloat(this.value) || 0))"></div>
        <div class="field"><label>${esc(db.settings.partner2Name)} Share %</label>
          <input type="number" step="any" min="0" max="100" name="shareP2" value="${esc(x.shareP2 != null ? x.shareP2 : db.settings.defaultP2)}"
            oninput="this.form.shareP1.value = Math.max(0, 100 - (parseFloat(this.value) || 0))"></div>
        <div class="field full"><label>Notes</label><input name="notes" value="${esc(x.notes || '')}"></div>
      </div>
      <p class="muted">“Paid by” is who actually spent the money. The share % is how this cost is divided between the two of you (defaults come from Settings).</p><br>
      <div class="btn-row"><button class="btn primary">💾 Save</button>
      <button type="button" class="btn ghost" onclick="requestCloseModal()">Cancel</button></div>
    </form>`);
}
function saveExpense(e, id) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  // EMI payments always count as monthly expenses
  const type = f.category.value === 'EMI' ? 'monthly' : f.type.value;
  const data = { date: f.date.value, type, category: f.category.value, vehicleId: f.vehicleId.value, amount: num(f.amount.value),
    paidBy: f.paidBy.value === 'p2' ? 'p2' : 'p1', shareP1: num(f.shareP1.value), shareP2: num(f.shareP2.value), notes: f.notes.value };
  if (id) Object.assign(db.expenses.find(x => x.id === id), data);
  else db.expenses.push({ id: uid(), ...data });
  saveDB(); closeModal(); render(); toast('Expense saved ✔');
}
function deleteExpense(id) {
  if (!requireEdit()) return;
  if (!confirm('Delete this expense?')) return;
  db.expenses = db.expenses.filter(x => x.id !== id);
  saveDB(); render(); toast('Expense deleted');
}

/* =====================================================
   MONTHLY PROFIT (own tab)
   ===================================================== */
function renderProfit() {
  const el = $('#view-profit');
  const p1N = db.settings.partner1Name, p2N = db.settings.partner2Name;

  // month-wise: trip profit split per-trip by its own %, monthly general
  // expenses split by the default partnership % (one-time expenses excluded)
  const byMonth = {};
  const monthOf = k => byMonth[k] = byMonth[k] || { trips: 0, income: 0, tripExp: 0, genExp: 0, p1: 0, p2: 0 };
  activeTrips().forEach(t => {
    const k = monthKey(t.startDate);
    if (!k) return;
    const m = monthOf(k);
    m.trips++; m.income += tripIncome(t); m.tripExp += tripExpense(t);
    const pf = tripProfit(t);
    m.p1 += pf * num(t.p1Pct) / 100;
    m.p2 += pf * num(t.p2Pct) / 100;
  });
  db.expenses.filter(e => e.type !== 'onetime').forEach(e => {
    const k = monthKey(e.date);
    if (!k) return;
    const m = monthOf(k);
    m.genExp += num(e.amount);
    // each expense carries its own split; older ones fall back to the Settings default
    const s1 = e.shareP1 != null ? num(e.shareP1) : num(db.settings.defaultP1);
    const s2 = e.shareP1 != null ? num(e.shareP2) : num(db.settings.defaultP2);
    m.p1 -= num(e.amount) * s1 / 100;
    m.p2 -= num(e.amount) * s2 / 100;
  });

  const months = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));
  const net = m => m.income - m.tripExp - m.genExp;
  const cur = byMonth[thisMonth()] || { trips: 0, income: 0, tripExp: 0, genExp: 0, p1: 0, p2: 0 };
  const tot = { trips: 0, income: 0, tripExp: 0, genExp: 0, p1: 0, p2: 0 };
  months.forEach(([, m]) => Object.keys(tot).forEach(f => tot[f] += m[f]));
  const monthName = k => new Date(k + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const cls = n => n >= 0 ? 'pos' : 'neg';

  el.innerHTML = `
    <div class="view-header"><h2>Monthly Profit <span class="muted">(with partner share)</span></h2></div>
    <div class="cards">
      <div class="stat-card ${net(cur) >= 0 ? 'green' : 'red'}"><div class="label">Net Profit</div><div class="value">${fmt(net(cur))}</div><div class="sub">this month</div></div>
      <div class="stat-card"><div class="label">${esc(p1N)}</div><div class="value">${fmt(Math.round(cur.p1))}</div><div class="sub">share this month</div></div>
      <div class="stat-card"><div class="label">${esc(p2N)}</div><div class="value">${fmt(Math.round(cur.p2))}</div><div class="sub">share this month</div></div>
      <div class="stat-card ${net(tot) >= 0 ? 'green' : 'red'}"><div class="label">All-time Net Profit</div><div class="value">${fmt(net(tot))}</div></div>
    </div>
    ${months.length ? `<div class="panel table-wrap"><table>
      <tr><th>Month</th><th class="num">Trips</th><th class="num">Income</th><th class="num">Trip Exp</th><th class="num">Monthly Exp</th><th class="num">Net Profit</th><th class="num">${esc(p1N)}</th><th class="num">${esc(p2N)}</th></tr>
      ${months.map(([k, m]) => `<tr><td>${monthName(k)}</td><td class="num">${m.trips}</td>
        <td class="num">${fmt(m.income)}</td><td class="num">${fmt(m.tripExp)}</td><td class="num">${fmt(m.genExp)}</td>
        <td class="num ${cls(net(m))}"><b>${fmt(net(m))}</b></td>
        <td class="num ${cls(m.p1)}">${fmt(Math.round(m.p1))}</td>
        <td class="num ${cls(m.p2)}">${fmt(Math.round(m.p2))}</td></tr>`).join('')}
      ${months.length > 1 ? `<tr><th>Total</th><th class="num">${tot.trips}</th>
        <th class="num">${fmt(tot.income)}</th><th class="num">${fmt(tot.tripExp)}</th><th class="num">${fmt(tot.genExp)}</th>
        <th class="num ${cls(net(tot))}">${fmt(net(tot))}</th>
        <th class="num ${cls(tot.p1)}">${fmt(Math.round(tot.p1))}</th>
        <th class="num ${cls(tot.p2)}">${fmt(Math.round(tot.p2))}</th></tr>` : ''}
    </table></div>
    <p class="muted">Net Profit = trip income − trip expenses − monthly (running) expenses. Trip profit is split by each trip's own %;
    monthly expenses (EMI, service…) are split by each expense's own share ratio (default ${num(db.settings.defaultP1)}/${num(db.settings.defaultP2)} from Settings). One-time (setup) expenses and vehicle purchase are not included.</p>`
    : `<div class="panel empty-state"><div class="big">💹</div>No trips or monthly expenses yet.</div>`}`;
}

/* =====================================================
   REPORTS
   ===================================================== */
let reportRange = 'thisMonth';

function rangeDates() {
  const t = new Date();
  const y = t.getFullYear(), m = t.getMonth();
  const iso = localISO;
  switch (reportRange) {
    case 'thisMonth': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
    case 'lastMonth': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
    case 'thisYear': return [`${y}-01-01`, `${y}-12-31`];
    default: return ['0000-01-01', '9999-12-31'];
  }
}

function renderReports() {
  const el = $('#view-reports');
  const [from, to] = rangeDates();
  const trips = activeTrips().filter(t => t.startDate >= from && t.startDate <= to);
  const allGenExp = db.expenses.filter(e => e.date >= from && e.date <= to);
  const genExp = allGenExp.filter(e => e.type !== 'onetime'); // only running expenses count in P&L
  const oneExp = allGenExp.filter(e => e.type === 'onetime');

  const income = trips.reduce((s, t) => s + tripIncome(t), 0);
  const tripExp = trips.reduce((s, t) => s + tripExpense(t), 0);
  const genTotal = genExp.reduce((s, e) => s + num(e.amount), 0);
  const oneTotal = oneExp.reduce((s, e) => s + num(e.amount), 0);
  const profit = income - tripExp - genTotal;
  const totalKm = trips.reduce((s, t) => s + tripKm(t), 0);

  const groupTable = (title, keyFn, labelFn) => {
    const groups = {};
    trips.forEach(t => {
      const k = keyFn(t) || '(none)';
      groups[k] = groups[k] || { trips: 0, income: 0, expense: 0 };
      groups[k].trips++;
      groups[k].income += tripIncome(t);
      groups[k].expense += tripExpense(t);
    });
    const rows = Object.entries(groups).sort((a, b) => (b[1].income - b[1].expense) - (a[1].income - a[1].expense));
    if (!rows.length) return '';
    return `<div class="panel"><h3>${title}</h3><div class="table-wrap"><table>
      <tr><th>${title.replace(/-wise.*/, '')}</th><th class="num">Trips</th><th class="num">Income</th><th class="num">Expense</th><th class="num">Profit</th></tr>
      ${rows.map(([k, g]) => `<tr><td>${esc(labelFn ? labelFn(k) : k)}</td><td class="num">${g.trips}</td>
        <td class="num">${fmt(g.income)}</td><td class="num">${fmt(g.expense)}</td>
        <td class="num ${g.income - g.expense >= 0 ? 'pos' : 'neg'}">${fmt(g.income - g.expense)}</td></tr>`).join('')}
    </table></div></div>`;
  };

  // expense category breakdown (trip categories + general)
  const catTotals = {};
  trips.forEach(t => EXPENSE_FIELDS.forEach(f => { if (num(t[f])) catTotals[EXPENSE_LABELS[f]] = (catTotals[EXPENSE_LABELS[f]] || 0) + num(t[f]); }));
  genExp.forEach(e => catTotals[e.category + ' (general)'] = (catTotals[e.category + ' (general)'] || 0) + num(e.amount));
  const catRows = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

  // month-by-month for the range
  const byMonth = {};
  trips.forEach(t => {
    const k = monthKey(t.startDate);
    byMonth[k] = byMonth[k] || { income: 0, expense: 0, trips: 0 };
    byMonth[k].income += tripIncome(t); byMonth[k].expense += tripExpense(t); byMonth[k].trips++;
  });
  genExp.forEach(e => {
    const k = monthKey(e.date);
    byMonth[k] = byMonth[k] || { income: 0, expense: 0, trips: 0 };
    byMonth[k].expense += num(e.amount);
  });
  const monthRows = Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]));

  const RANGE_LABELS = { thisMonth: 'This Month', lastMonth: 'Last Month', thisYear: 'This Year', all: 'All Time' };
  const periodText = reportRange === 'all' ? 'All Time' : `${fmtDate(from)} – ${fmtDate(to)}`;

  el.innerHTML = `
    <div class="print-header">
      <div class="ph-brand">🚐 ${esc(db.settings.businessName || 'Shiv Travels')}</div>
      <div class="ph-title">Business Report — ${RANGE_LABELS[reportRange]}</div>
      <div class="ph-meta">Period: ${periodText} &nbsp;·&nbsp; Generated: ${fmtDate(todayStr())}${db.settings.businessPhone ? ` &nbsp;·&nbsp; 📞 ${esc(db.settings.businessPhone)}` : ''}</div>
    </div>
    <div class="view-header"><h2>Reports</h2>
      <div class="btn-row">
        <select onchange="reportRange=this.value; renderReports()">
          ${Object.entries(RANGE_LABELS)
            .map(([v, l]) => `<option value="${v}" ${reportRange === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn ghost" onclick="exportTripsCSV()">⬇️ Export Excel (CSV)</button>
        <button class="btn ghost" onclick="window.print()">🖨️ Print / PDF</button>
      </div>
    </div>

    <div class="cards">
      <div class="stat-card"><div class="label">Trips</div><div class="value">${trips.length}</div></div>
      <div class="stat-card green"><div class="label">Income</div><div class="value">${fmt(income)}</div></div>
      <div class="stat-card red"><div class="label">Trip Expenses</div><div class="value">${fmt(tripExp)}</div></div>
      <div class="stat-card red"><div class="label">Monthly Expenses</div><div class="value">${fmt(genTotal)}</div><div class="sub">general, running</div></div>
      <div class="stat-card ${profit >= 0 ? 'green' : 'red'}"><div class="label">Net Profit</div><div class="value">${fmt(profit)}</div></div>
      ${oneTotal ? `<div class="stat-card amber"><div class="label">One-time Expenses</div><div class="value">${fmt(oneTotal)}</div><div class="sub">setup — not in profit</div></div>` : ''}
      <div class="stat-card"><div class="label">Total KM</div><div class="value">${totalKm.toLocaleString('en-IN')}</div></div>
    </div>

    ${monthRows.length > 1 ? `<div class="panel"><h3>📅 Month-wise P&L</h3><div class="table-wrap"><table>
      <tr><th>Month</th><th class="num">Trips</th><th class="num">Income</th><th class="num">Expense</th><th class="num">Profit</th></tr>
      ${monthRows.map(([k, g]) => `<tr><td>${new Date(k + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</td>
        <td class="num">${g.trips}</td><td class="num">${fmt(g.income)}</td><td class="num">${fmt(g.expense)}</td>
        <td class="num ${g.income - g.expense >= 0 ? 'pos' : 'neg'}">${fmt(g.income - g.expense)}</td></tr>`).join('')}
    </table></div></div>` : ''}

    ${groupTable('Driver-wise Profit', t => t.driverId, k => k === '(none)' ? '(no driver)' : driverName(k))}
    ${groupTable('Vehicle-wise Profit', t => t.vehicleId, k => k === '(none)' ? '(no vehicle)' : vehicleNo(k))}
    ${groupTable('Client-wise Report', t => t.clientId, k => k === '(none)' ? '(no client)' : clientName(k))}
    ${groupTable('Source-wise Report', t => t.source)}

    ${catRows.length ? `<div class="panel"><h3>💸 Expense Breakdown</h3><div class="table-wrap"><table>
      <tr><th>Category</th><th class="num">Amount</th></tr>
      ${catRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmt(v)}</td></tr>`).join('')}
      <tr><th>Total</th><th class="num">${fmt(tripExp + genTotal)}</th></tr>
    </table></div></div>` : ''}

    ${vehiclePurchasePanel()}

    ${!trips.length && !allGenExp.length ? `<div class="panel empty-state"><div class="big">📈</div>No data in this period.</div>` : ''}`;
}

/* =====================================================
   EXPORTS: CSV, Invoice, WhatsApp
   ===================================================== */
function exportTripsCSV() {
  if (!db.trips.length) return toast('No trips to export');
  const headers = ['Booking ID', 'Booking Date', 'Start Date', 'End Date', 'Days', 'Route', 'Status',
    'Client', 'Client Mobile', 'Pickup', 'Drop', 'Source', 'Driver', 'Driver Advance',
    'Vehicle', 'Start KM', 'End KM', 'Total KM', 'Fuel (L)', 'Avg km/l',
    'Trip Amount', 'Night Charges', 'Extra KM', 'Extra Hours', 'Misc Income', 'Total Income',
    ...EXPENSE_FIELDS.map(f => EXPENSE_LABELS[f]), 'Total Expense', 'Net Profit',
    'Your %', 'Partner %', 'Your Share', 'Partner Share', 'Settlement',
    'Advance', 'Balance', 'Payment Method', 'Payment Status', 'Notes'];
  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = db.trips.map(t => {
    const km = tripKm(t), inc = tripIncome(t), exp = tripExpense(t), pf = inc - exp;
    const c = clientById(t.clientId) || {};
    return [t.bookingId, t.bookingDate, t.startDate, t.endDate, t.days, t.route, t.status,
      c.name || '', c.mobile || '', t.pickup, t.drop, t.source, driverName(t.driverId), t.driverAdvance,
      vehicleNo(t.vehicleId), t.startKm, t.endKm, km, t.fuelLitres, km && num(t.fuelLitres) ? (km / num(t.fuelLitres)).toFixed(1) : '',
      t.tripAmount, t.nightCharges, t.extraKm, t.extraHours, t.miscIncome, inc,
      ...EXPENSE_FIELDS.map(f => t[f]), exp, pf,
      t.p1Pct, t.p2Pct, Math.round(pf * num(t.p1Pct) / 100), Math.round(pf * num(t.p2Pct) / 100), t.settlementStatus,
      t.advance, tripBalance(t), t.paymentMethod, t.paymentStatus, t.notes].map(q).join(',');
  });
  downloadFile(`shiv-travels-trips-${todayStr()}.csv`, '﻿' + [headers.map(q).join(','), ...rows].join('\r\n'), 'text/csv');
  toast('Excel (CSV) downloaded ✔');
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function amountInWords(n) {
  n = Math.round(num(n));
  if (n <= 0) return '';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = x => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? ' ' + ones[x % 10] : '');
  const three = x => (x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
  let out = '';
  for (const [d, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) {
    const q = Math.floor(n / d);
    if (q) { out += two(q) + ' ' + name + ' '; n %= d; }
  }
  if (n) out += three(n);
  return out.trim() + ' Rupees Only';
}

function printInvoice(id) {
  const t = db.trips.find(x => x.id === id);
  const s = db.settings;
  const c = clientById(t.clientId) || {};
  const inc = tripIncome(t), adv = num(t.advance), bal = tripBalance(t);
  const paid = t.paymentStatus === 'Completed' || bal === 0;
  const line = (label, val) => num(val) ? `<tr><td>${label}</td><td class="amt">${fmt(val)}</td></tr>` : '';
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Invoice ${esc(t.bookingId)}</title>
  <style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; color: #1c2734; margin: 0; background: #eef2f7; }
    .page { max-width: 780px; margin: 20px auto; background: #fff; box-shadow: 0 4px 24px rgba(16,42,67,.15); }
    @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; max-width: none; } @page { margin: 10mm; } }

    .band { background: linear-gradient(135deg, #0f4c81 0%, #1a6db3 100%); color: #fff; padding: 26px 34px;
      display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .logo { font-size: 40px; background: rgba(255,255,255,.15); border-radius: 12px; padding: 6px 10px; }
    .brand h1 { margin: 0; font-size: 26px; letter-spacing: .5px; }
    .brand .tag { font-size: 12px; opacity: .85; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
    .invbox { text-align: right; }
    .invbox .word { font-size: 26px; font-weight: 300; letter-spacing: 6px; }
    .invbox .no { font-size: 15px; font-weight: 700; margin-top: 2px; }

    .strip { background: #e8734a; height: 5px; }
    .meta { display: flex; border-bottom: 1px solid #e2e8f0; }
    .meta > div { flex: 1; padding: 14px 20px; border-right: 1px solid #e2e8f0; }
    .meta > div:last-child { border-right: none; }
    .meta .k { font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; color: #7a8aa0; font-weight: 700; }
    .meta .v { font-size: 14px; font-weight: 600; margin-top: 3px; }

    .body { padding: 24px 34px 30px; position: relative; }
    .parties { display: flex; gap: 16px; margin-bottom: 22px; }
    .card { flex: 1; background: #f4f7fb; border-left: 4px solid #0f4c81; border-radius: 6px; padding: 12px 16px; }
    .card .k { font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; color: #7a8aa0; font-weight: 700; margin-bottom: 5px; }
    .card .name { font-size: 16px; font-weight: 700; }
    .card .sub { font-size: 13px; color: #51637a; margin-top: 2px; line-height: 1.5; }

    table.items { width: 100%; border-collapse: collapse; }
    table.items th { background: #0f4c81; color: #fff; text-align: left; padding: 10px 14px; font-size: 12px;
      text-transform: uppercase; letter-spacing: 1px; }
    table.items th.amt, table.items td.amt { text-align: right; }
    table.items td { padding: 10px 14px; border-bottom: 1px solid #e8edf3; font-size: 14px; }
    table.items tr:nth-child(even) td { background: #f8fafc; }

    .totals { margin-left: auto; width: 320px; margin-top: 6px; }
    .totals .row { display: flex; justify-content: space-between; padding: 7px 14px; font-size: 14px; }
    .totals .grand { background: #0f4c81; color: #fff; font-weight: 700; font-size: 16px; border-radius: 6px; margin-top: 4px; }
    .totals .due { background: ${paid ? '#1e8e5a' : '#e8734a'}; color: #fff; font-weight: 700; font-size: 16px; border-radius: 6px; margin-top: 6px; }

    .words { font-size: 12.5px; color: #51637a; margin-top: 14px; }
    .words b { color: #1c2734; }

    .stamp { position: absolute; right: 60px; top: 130px; transform: rotate(-12deg);
      border: 3px solid ${paid ? '#1e8e5a' : '#e8734a'}; color: ${paid ? '#1e8e5a' : '#e8734a'};
      font-weight: 800; font-size: 22px; letter-spacing: 3px; padding: 6px 18px; border-radius: 8px; opacity: .35; }

    .foot { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 40px;
      padding-top: 16px; border-top: 1px dashed #cbd6e2; }
    .foot .note { font-size: 12.5px; color: #51637a; line-height: 1.7; }
    .sign { text-align: center; font-size: 13px; color: #1c2734; }
    .sign .line { border-top: 1.5px solid #1c2734; margin-top: 46px; padding-top: 6px; font-weight: 600; }
    .thanks { text-align: center; background: #f4f7fb; padding: 10px; font-size: 13px; color: #0f4c81; font-weight: 600; }
  </style></head><body>
  <div class="page">
    <div class="band">
      <div class="brand"><div class="logo">🚐</div>
        <div><h1>${esc(s.businessName)}</h1><div class="tag">Urbania Rental Service</div></div></div>
      <div class="invbox"><div class="word">INVOICE</div><div class="no">${esc(t.bookingId)}</div></div>
    </div>
    <div class="strip"></div>
    <div class="meta">
      <div><div class="k">Invoice Date</div><div class="v">${fmtDate(todayStr())}</div></div>
      <div><div class="k">Trip Dates</div><div class="v">${fmtDate(t.startDate)}${t.endDate && t.endDate !== t.startDate ? ' – ' + fmtDate(t.endDate) : ''} · ${esc(t.days || 1)} day(s)</div></div>
      <div><div class="k">Vehicle</div><div class="v">${esc(vehicleNo(t.vehicleId))}</div></div>
      ${s.businessPhone ? `<div><div class="k">Contact</div><div class="v">${esc(s.businessPhone)}</div></div>` : ''}
    </div>
    <div class="body">
      <div class="stamp">${paid ? 'PAID ✓' : 'BALANCE DUE'}</div>
      <div class="parties">
        <div class="card"><div class="k">Billed To</div>
          <div class="name">${esc(c.name || '—')}</div>
          <div class="sub">${esc(c.mobile || '')}</div></div>
        <div class="card"><div class="k">Trip Route</div>
          <div class="name">${esc(t.route)}</div>
          <div class="sub">${esc(t.pickup || '')}${t.pickup && t.drop ? ' → ' : ''}${esc(t.drop || '')}</div></div>
      </div>

      <table class="items">
        <tr><th>Description</th><th class="amt">Amount</th></tr>
        ${line('Trip Charges — ' + esc(t.route), t.tripAmount)}
        ${line('Night Charges', t.nightCharges)}
        ${line('Extra KM Charges', t.extraKm)}
        ${line('Extra Hours Charges', t.extraHours)}
        ${line('Other Charges', t.miscIncome)}
      </table>

      <div class="totals">
        <div class="row grand"><span>Grand Total</span><span>${fmt(inc)}</span></div>
        ${adv ? `<div class="row"><span>Advance Received</span><span>− ${fmt(adv)}</span></div>` : ''}
        <div class="row due"><span>Balance Due</span><span>${fmt(bal)}</span></div>
      </div>

      <div class="words">Amount in words: <b>${amountInWords(inc)}</b></div>

      <div class="foot">
        <div class="note">
          Payment Status: <b>${esc(t.paymentStatus || 'Pending')}</b>${t.paymentMethod ? ' · via ' + esc(t.paymentMethod) : ''}<br>
          ${s.gstin ? 'GSTIN: ' + esc(s.gstin) + '<br>' : ''}
          ${s.businessAddress ? esc(s.businessAddress) + '<br>' : ''}
          This is a computer-generated invoice.
        </div>
        <div class="sign">For <b>${esc(s.businessName)}</b><div class="line">Authorised Signatory</div></div>
      </div>
    </div>
    <div class="thanks">🙏 Thank you for travelling with ${esc(s.businessName)} — we look forward to your next journey!</div>
  </div>
  <script>window.print()<\/script></body></html>`);
  w.document.close();
}

function whatsappTrip(id) {
  const t = db.trips.find(x => x.id === id);
  const c = clientById(t.clientId) || {};
  const s = db.settings;
  const msg = [
    `*${s.businessName} — Trip Summary*`,
    `Booking: ${t.bookingId}`,
    `Route: ${t.route}`,
    `Date: ${fmtDate(t.startDate)}${t.endDate && t.endDate !== t.startDate ? ' to ' + fmtDate(t.endDate) : ''}`,
    `Vehicle: ${vehicleNo(t.vehicleId)}`,
    `Total Amount: ${fmt(tripIncome(t))}`,
    num(t.advance) ? `Advance Paid: ${fmt(t.advance)}` : '',
    tripBalance(t) > 0 && t.paymentStatus !== 'Completed' ? `Balance Due: ${fmt(tripBalance(t))}` : '',
    ``, `Thank you for choosing ${s.businessName}! 🚐`,
  ].filter(x => x !== '').join('\n');
  const phone = (c.mobile || '').replace(/\D/g, '');
  const url = `https://wa.me/${phone ? (phone.length === 10 ? '91' + phone : phone) : ''}?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

/* =====================================================
   SETTINGS
   ===================================================== */
function renderSettings() {
  const el = $('#view-settings');
  const s = db.settings;
  el.innerHTML = `
    <div class="view-header"><h2>Settings</h2></div>

    <div class="panel">
      <h3>🏢 Business Details <span class="muted">(used on invoices)</span></h3>
      <form onsubmit="saveSettings(event)">
        <div class="form-grid">
          <div class="field"><label>Business Name</label><input name="businessName" value="${esc(s.businessName)}"></div>
          <div class="field"><label>Phone</label><input name="businessPhone" value="${esc(s.businessPhone)}"></div>
          <div class="field"><label>GSTIN (optional)</label><input name="gstin" value="${esc(s.gstin)}"></div>
          <div class="field full"><label>Address</label><input name="businessAddress" value="${esc(s.businessAddress)}"></div>
          <div class="field"><label>Your Name (Partner 1)</label><input name="partner1Name" value="${esc(s.partner1Name)}"></div>
          <div class="field"><label>Partner Name (Partner 2)</label><input name="partner2Name" value="${esc(s.partner2Name)}"></div>
          <div class="field"><label>Default Your Share %</label><input type="number" name="defaultP1" min="0" max="100" value="${s.defaultP1}"></div>
          <div class="field"><label>Default Partner Share %</label><input type="number" name="defaultP2" min="0" max="100" value="${s.defaultP2}"></div>
        </div><br>
        <button class="btn primary">💾 Save Settings</button>
      </form>
    </div>

    ${window.Sync && Sync.configured ? `
    <div class="panel">
      <h3>☁️ Cloud Sync</h3>
      <p class="muted">
        Dataset: <b>${Sync.mirror ? 'Local mirror of production (cloud is read-only from here)' : 'Live production'}</b> ·
        Status: <b>${esc(Sync.status)}</b>${Sync.error ? ` · <span class="neg">${esc(Sync.error)}</span>` : ''}<br>
        Signed in as <b>${esc(currentUser ? currentUser.username : '—')}</b> with
        <b>${canEdit() ? 'full access' : 'view-only access'}</b>.
      </p>
      <p class="muted">Records loaded right now: ${['trips','drivers','clients','vehicles','expenses','investments'].map(c => `${(db[c] || []).length} ${c}`).join(' · ')}</p>
      ${Sync.mirror ? `
      <p class="muted">🛡️ This is a live <b>mirror</b> of production. You can add, edit and delete anything here to test — none of it is ever sent to the cloud, and your live business data stays safe. Reload the page to pull a fresh copy of production.</p>
      ` : `
      <div class="btn-row">
        <button class="btn primary" onclick="pushDeviceDataToCloud()">⬆️ Upload This Device's Data to Cloud</button>
      </div>
      <p class="muted">Use this if the cloud is empty but this browser still holds your records. It adds and updates — it never deletes anything already in the cloud.</p>
      `}
    </div>` : ''}

    <div class="panel">
      <h3>💾 Backup & Restore</h3>
      <p class="muted">Your data lives only in this browser. Take a backup regularly — you can restore it on any device (e.g. your phone).</p>
      <div class="btn-row">
        <button class="btn primary" onclick="backupData()">⬇️ Download Backup (JSON)</button>
        <label class="btn ghost" style="cursor:pointer">⬆️ Restore Backup<input type="file" accept=".json" class="hidden" onchange="restoreData(this)"></label>
      </div>
    </div>

    <div class="panel">
      <h3>🔐 Login & Access</h3>
      <p class="muted">Signed in as <b>${esc(currentUser ? currentUser.name : '—')}</b> — ${canEdit() ? 'full access (add, edit, delete)' : 'view only'}.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Username</th><th>Access</th></tr></thead>
          <tbody>${users.map(u => `<tr><td>${esc(u.username)}</td>
            <td>${u.role === 'admin' ? 'Full rights — everything' : 'View rights — read only'}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" onclick="openPasswordForm()">🔑 Change Password</button>
        <button class="btn ghost" onclick="resetLogins()">↩️ Reset Logins to Default</button>
      </div>
    </div>

    <div class="panel">
      <h3>🧪 Demo & Reset</h3>
      <div class="btn-row">
        <button class="btn ghost" onclick="loadSampleData()">Load Sample Data (demo)</button>
        <button class="btn danger" onclick="clearAllData()">🗑️ Clear ALL Data</button>
      </div>
    </div>

    <p class="muted">Shiv Travels · Urbania Partner Manager · works offline · data stored on this device</p>`;
}

function saveSettings(e) {
  if (e) e.preventDefault();
  if (!requireEdit()) return;
  e.preventDefault();
  const f = e.target;
  Object.assign(db.settings, {
    businessName: f.businessName.value.trim() || 'Shiv Travels',
    businessPhone: f.businessPhone.value.trim(),
    gstin: f.gstin.value.trim(),
    businessAddress: f.businessAddress.value.trim(),
    partner1Name: f.partner1Name.value.trim() || 'Me',
    partner2Name: f.partner2Name.value.trim() || 'Partner',
    defaultP1: num(f.defaultP1.value),
    defaultP2: num(f.defaultP2.value),
  });
  saveDB(); toast('Settings saved ✔');
}

/* Manual "get this device's records into the cloud". Prefers the pre-sync copy,
   because signing in against an empty cloud legitimately blanks the live one. */
async function pushDeviceDataToCloud() {
  if (!requireEdit()) return;
  if (window.Sync && Sync.mirror) { alert('This is the local mirror of production — uploads are turned off so nothing here can ever change your live data.'); return; }
  if (!(window.Sync && Sync.configured && Sync.active)) { alert('Not connected to the cloud yet.'); return; }

  const source = Sync.preSyncData() || db;
  const counts = ['trips', 'drivers', 'clients', 'vehicles', 'expenses', 'investments']
    .map(c => [(source[c] || []).length, c]).filter(([n]) => n);
  const total = counts.reduce((n, [c]) => n + c, 0);
  if (!total) { alert('This device has no records to upload.'); return; }

  if (!confirm(`Upload to the ${Sync.env === 'dev' ? 'TEST' : 'live'} cloud:\n\n`
    + counts.map(([n, c]) => `  ${n} ${c}`).join('\n')
    + '\n\nExisting cloud records with the same id are updated. Nothing is deleted.')) return;

  try {
    await Sync.uploadLocalData(source);
    toast(`Uploaded ${total} records ✔`);
  } catch (ex) {
    alert('Upload failed: ' + (ex.code === 'permission-denied'
      ? 'this account does not have write access.' : ex.message));
  }
}

function backupData() {
  downloadFile(`shiv-travels-backup-${todayStr()}.json`, JSON.stringify(db, null, 2), 'application/json');
  toast('Backup downloaded ✔');
}
function restoreData(input) {
  if (!requireEdit()) return;
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.trips || !data.settings) throw new Error('Not a valid backup file');
      if (!confirm(`Restore backup with ${data.trips.length} trips? This replaces current data.`)) return;
      db = Object.assign(defaultDB(), data);
      saveDB(); applyTheme(); render(); toast('Backup restored ✔');
    } catch (err) { alert('Could not restore: ' + err.message); }
  };
  reader.readAsText(file);
}
function clearAllData() {
  if (!requireEdit()) return;
  if (!confirm('Delete ALL trips, drivers, clients, vehicles, expenses and investments? This cannot be undone!')) return;
  if (!confirm('Are you really sure? Consider downloading a backup first.')) return;
  db = defaultDB(); saveDB(); applyTheme(); render(); toast('All data cleared');
}

/* =====================================================
   SAMPLE DATA (demo)
   ===================================================== */
function loadSampleData() {
  if (!requireEdit()) return;
  if (db.trips.length && !confirm('This adds demo records on top of existing data. Continue?')) return;
  const t = todayStr();
  const d1 = { id: uid(), name: 'Ramesh Pawar', mobile: '9822011111', license: 'MH1220220001111', licenseExpiry: addDays(t, 200), notes: '' };
  const d2 = { id: uid(), name: 'Suresh Jadhav', mobile: '9822022222', license: 'MH1220210002222', licenseExpiry: addDays(t, 20), notes: '' };
  db.drivers.push(d1, d2);

  const c1 = { id: uid(), name: 'Amit Sharma', mobile: '9900011111', altMobile: '', source: 'Instagram', notes: '' };
  const c2 = { id: uid(), name: 'Priya Kulkarni', mobile: '9900022222', altMobile: '', source: 'Reference', notes: '' };
  const c3 = { id: uid(), name: 'Deshmukh Travels (Agent)', mobile: '9900033333', altMobile: '', source: 'Travel Agent', notes: 'Agent — pays monthly' };
  db.clients.push(c1, c2, c3);

  const v1 = {
    id: uid(), number: 'MH 12 UB 4455', model: 'Force Urbania 17-Seater',
    insuranceExpiry: addDays(t, 25), permitExpiry: addDays(t, 320),
    fitnessExpiry: addDays(t, 400), pucExpiry: addDays(t, -5),
    nextServiceDate: addDays(t, 45), notes: 'FASTag linked to HDFC',
  };
  db.vehicles.push(v1);

  const mkTrip = (o) => Object.assign({
    id: uid(), bookingId: nextBookingId(), bookingDate: addDays(o.startDate, -5),
    days: Math.max(1, daysBetween(o.startDate, o.endDate || o.startDate) + 1),
    clientId: c1.id, driverId: d1.id, vehicleId: v1.id, pickup: 'Pune', drop: 'Pune',
    source: 'Instagram', driverAdvance: 0, startKm: 0, endKm: 0, fuelLitres: 0,
    tripAmount: 0, nightCharges: 0, extraKm: 0, extraHours: 0, miscIncome: 0,
    diesel: 0, toll: 0, parking: 0, driverExpense: 0, food: 0, hotel: 0, cleaning: 0,
    maintenance: 0, policeFine: 0, otherExpense: 0,
    p1Pct: db.settings.defaultP1, p2Pct: db.settings.defaultP2,
    settlementStatus: 'Pending', settlementDate: '', advance: 0,
    paymentMethod: 'UPI', paymentStatus: 'Pending', status: 'Completed', notes: '',
  }, o);

  db.trips.push(
    mkTrip({ startDate: addDays(t, -40), endDate: addDays(t, -38), route: 'Pune → Shirdi → Pune', clientId: c1.id, driverId: d1.id, startKm: 42000, endKm: 42520, fuelLitres: 52, tripAmount: 28000, nightCharges: 1000, diesel: 4900, toll: 1250, parking: 200, driverExpense: 2700, food: 600, advance: 28000 + 1000, paymentStatus: 'Completed', settlementStatus: 'Settled', settlementDate: addDays(t, -30) }),
    mkTrip({ startDate: addDays(t, -22), endDate: addDays(t, -20), route: 'Pune → Mahabaleshwar → Pune', clientId: c2.id, driverId: d2.id, source: 'Reference', startKm: 42520, endKm: 42980, fuelLitres: 48, tripAmount: 26000, extraKm: 1500, diesel: 4500, toll: 800, parking: 300, driverExpense: 1600, food: 500, advance: 15000, paymentStatus: 'Partial' }),
    mkTrip({ startDate: addDays(t, -8), endDate: addDays(t, -6), route: 'Pune → Goa → Pune', clientId: c3.id, driverId: d1.id, source: 'Travel Agent', startKm: 42980, endKm: 43890, fuelLitres: 95, tripAmount: 52000, nightCharges: 2000, diesel: 8900, toll: 2100, parking: 350, driverExpense: 4500, food: 900, hotel: 1200, advance: 20000, paymentStatus: 'Partial' }),
    mkTrip({ startDate: addDays(t, -2), endDate: addDays(t, 0), route: 'Pune → Ashtavinayak Darshan', clientId: c1.id, driverId: d2.id, source: 'Repeat Customer', startKm: 43890, endKm: 44300, fuelLitres: 42, tripAmount: 30000, diesel: 3950, toll: 950, driverExpense: 1800, food: 500, advance: 30000, paymentStatus: 'Completed', status: 'Started' }),
    mkTrip({ startDate: addDays(t, 4), endDate: addDays(t, 6), route: 'Pune → Nashik → Pune', clientId: c2.id, driverId: d1.id, source: 'WhatsApp', tripAmount: 27000, advance: 5000, status: 'Booked' }),
  );

  db.expenses.push(
    { id: uid(), date: addDays(t, -15), category: 'Service', vehicleId: v1.id, amount: 8500, notes: '40k km service' },
    { id: uid(), date: addDays(t, -10), category: 'FASTag Recharge', vehicleId: v1.id, amount: 3000, notes: '' },
    { id: uid(), date: addDays(t, -3), category: 'Cleaning', vehicleId: v1.id, amount: 500, notes: 'Interior deep clean' },
  );

  saveDB(); render(); toast('Sample data loaded ✔');
}

/* =====================================================
   SYNC STATUS
   A one-glance answer to "is my phone actually up to date?"
   ===================================================== */
function updateSyncBadge() {
  const el = $('#syncBadge');
  if (!el) return;
  const s = window.Sync || { status: 'local', env: 'prod' };
  const look = {
    local:        ['💾', 'This device only — cloud sync not set up', 'local'],
    connecting:   ['🔄', 'Connecting to cloud…', 'busy'],
    saving:       ['🔄', 'Saving…', 'busy'],
    synced:       ['☁️', 'Synced — all devices up to date', 'ok'],
    'signed-out': ['', '', 'ok'],
    error:        ['⚠️', 'Sync problem: ' + (s.error || 'unknown'), 'bad'],
  }[s.status] || ['', '', 'ok'];

  el.textContent = look[0] + (s.mirror && s.status !== 'local' ? ' MIRROR' : '');
  el.title = look[1] + (s.mirror ? ' · Local mirror — reads live production, your edits stay on this device and never reach production' : '');
  el.className = 'sync-badge ' + look[2];
  el.classList.toggle('hidden', !look[0]);
}

/* ---------- Init ----------
   Called by sync.js once it knows whether a cloud is configured, so the app
   never paints a signed-in screen before the account is settled. */
function startApp() {
  applyTheme();
  updateSyncBadge();
  // reopen on the tab that was active before the refresh
  const savedView = localStorage.getItem(VIEW_KEY);
  showView(savedView && $(`#mainTabs .tab[data-view="${savedView}"]`) ? savedView : 'dashboard');
  initAuth();
}
