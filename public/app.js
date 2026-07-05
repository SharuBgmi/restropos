const state = {
  token: localStorage.getItem('rp_token') || null,
  user: JSON.parse(localStorage.getItem('rp_user') || 'null'),
  categories: [],
  items: [],
  tables: [],
  activeCategory: null,
  currentOrder: null,
  priceMode: 'old',
  pendingPhone: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(false); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------------- LOGIN: phone + WhatsApp OTP ----------------
function setupLogin() {
  $('#send-otp-btn').addEventListener('click', async () => {
    const phone = $('#phone-input').value.trim();
    if (phone.length < 8) { $('#login-error').textContent = 'Enter a valid phone number'; return; }
    $('#send-otp-btn').textContent = 'Sending...';
    try {
      const res = await api('/auth/request-otp', { method: 'POST', body: { phone } });
      state.pendingPhone = phone;
      $('#otp-phone-display').textContent = phone;
      $('#otp-sub').textContent = res.whatsapp_configured
        ? `OTP sent on WhatsApp to ${phone}`
        : 'WhatsApp not configured on the server — check server logs for the OTP';
      $('#phone-step').classList.add('hidden');
      $('#otp-step').classList.remove('hidden');
      $('#login-error').textContent = '';
    } catch (e) {
      $('#login-error').textContent = e.message;
    } finally {
      $('#send-otp-btn').textContent = 'Send OTP';
    }
  });

  $('#verify-otp-btn').addEventListener('click', async () => {
    const otp = $('#otp-code-input').value.trim();
    const name = $('#name-input').value.trim();
    if (otp.length !== 6) { $('#login-error').textContent = 'Enter the 6-digit code'; return; }
    try {
      const data = await api('/auth/verify-otp', { method: 'POST', body: { phone: state.pendingPhone, otp, name } });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('rp_token', state.token);
      localStorage.setItem('rp_user', JSON.stringify(state.user));
      $('#login-error').textContent = '';
      boot();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  });

  $('#change-number-btn').addEventListener('click', () => {
    $('#otp-step').classList.add('hidden');
    $('#phone-step').classList.remove('hidden');
    $('#otp-code-input').value = '';
    $('#login-error').textContent = '';
  });
}

async function logout(callServer = true) {
  if (callServer && state.token) {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  }
  state.token = null; state.user = null;
  localStorage.removeItem('rp_token'); localStorage.removeItem('rp_user');
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#phone-step').classList.remove('hidden');
  $('#otp-step').classList.add('hidden');
  $('#phone-input').value = '';
  $('#otp-code-input').value = '';
}

// ---------------- NAV ----------------
function setupNav() {
  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.nav-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.view').forEach((v) => v.classList.remove('active'));
      $(`#view-${btn.dataset.view}`).classList.add('active');
      if (btn.dataset.view === 'tables') loadTables();
      if (btn.dataset.view === 'menu') loadMenuTable();
      if (btn.dataset.view === 'inventory') loadInventory();
      if (btn.dataset.view === 'kot') loadKotLog();
      if (btn.dataset.view === 'bills') loadBills();
      if (btn.dataset.view === 'settings') loadSettings();
    });
  });
  $('#logout-btn').addEventListener('click', () => logout(true));
}

// ---------------- BILLING ----------------
async function loadCatalog() {
  state.categories = await api('/categories');
  state.items = await api('/items');
  renderCategoryTabs();
  renderItemGrid();
}
function renderCategoryTabs() {
  const wrap = $('#category-tabs');
  wrap.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.textContent = 'All'; allBtn.className = state.activeCategory === null ? 'active' : '';
  allBtn.onclick = () => { state.activeCategory = null; renderCategoryTabs(); renderItemGrid(); };
  wrap.appendChild(allBtn);
  state.categories.forEach((c) => {
    const b = document.createElement('button');
    b.textContent = c.name; b.className = state.activeCategory === c.id ? 'active' : '';
    b.onclick = () => { state.activeCategory = c.id; renderCategoryTabs(); renderItemGrid(); };
    wrap.appendChild(b);
  });
}
function renderItemGrid() {
  const grid = $('#item-grid');
  grid.innerHTML = '';
  const list = state.items.filter((i) => state.activeCategory === null || i.category_id === state.activeCategory);
  list.forEach((item) => {
    const card = document.createElement('button');
    card.className = 'item-card';
    card.innerHTML = `<span class="name">${item.name}</span><span class="price">₹${item.price.toFixed(2)}</span>`;
    card.onclick = () => addItemToOrder(item);
    grid.appendChild(card);
  });
}

async function ensureOrder() {
  if (state.currentOrder) return state.currentOrder;
  const { id } = await api('/orders', { method: 'POST', body: { order_type: 'takeaway' } });
  state.currentOrder = { id, items: [] };
  $('#cart-title').textContent = `Order #${id}`;
  return state.currentOrder;
}

async function addItemToOrder(item) {
  const order = await ensureOrder();
  await api(`/orders/${order.id}/items`, { method: 'POST', body: { item_id: item.id, qty: 1 } });
  await refreshCart();
}

async function refreshCart() {
  if (!state.currentOrder) return;
  const order = await api(`/orders/${state.currentOrder.id}`);
  state.currentOrder.items = order.items;
  renderCart();
}

function renderCart() {
  const wrap = $('#cart-items');
  wrap.innerHTML = '';
  const multiplier = state.priceMode === 'new' ? 1.1 : 1;
  let subtotal = 0, tax = 0;
  (state.currentOrder?.items || []).forEach((oi) => {
    const billedPrice = +(oi.price * multiplier).toFixed(2);
    subtotal += billedPrice * oi.qty;
    tax += (billedPrice * oi.qty * oi.tax_rate) / 100;
    const row = document.createElement('div');
    row.className = 'cart-row';
    row.innerHTML = `
      <span>${oi.name} ${oi.kot_sent ? '<span class="muted">(sent)</span>' : ''}</span>
      <span class="qty-controls">
        <span>x${oi.qty} · ₹${billedPrice.toFixed(2)}</span>
        ${!oi.kot_sent ? `<button data-remove="${oi.id}">✕</button>` : ''}
      </span>`;
    wrap.appendChild(row);
  });
  $$('#cart-items [data-remove]').forEach((btn) => {
    btn.onclick = async () => {
      await api(`/orders/${state.currentOrder.id}/items/${btn.dataset.remove}`, { method: 'DELETE' });
      refreshCart();
    };
  });
  const discount = +($('#discount-input').value || 0);
  const total = subtotal - discount + tax;
  $('#cart-subtotal').textContent = `₹${subtotal.toFixed(2)}`;
  $('#cart-tax').textContent = `₹${tax.toFixed(2)}`;
  $('#cart-total').textContent = `₹${total.toFixed(2)}`;
}

function setupBillingActions() {
  $('#discount-input').addEventListener('input', renderCart);
  $$('#price-mode-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.priceMode = btn.dataset.mode;
      $$('#price-mode-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
      renderCart();
    });
  });
  $('#kot-btn').addEventListener('click', async () => {
    if (!state.currentOrder) return;
    try {
      const { tickets } = await api(`/orders/${state.currentOrder.id}/kot`, { method: 'POST' });
      alert(`Sent to kitchen:\n${tickets.map((t) => `${t.kot_number} (${t.station})`).join('\n')}`);
      refreshCart();
    } catch (e) { alert(e.message); }
  });
  $('#bill-btn').addEventListener('click', async () => {
    if (!state.currentOrder) return;
    const discount = +($('#discount-input').value || 0);
    try {
      const bill = await api(`/orders/${state.currentOrder.id}/bill`, { method: 'POST', body: { discount, payment_mode: 'cash', price_mode: state.priceMode } });
      showReceipt(bill);
      state.currentOrder = null;
      state.priceMode = 'old';
      $$('#price-mode-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.mode === 'old'));
      $('#cart-title').textContent = 'Select a table';
      $('#discount-input').value = 0;
      renderCart();
      loadTables();
    } catch (e) { alert(e.message); }
  });
}

function showReceipt(bill) {
  const card = $('#receipt-card');
  card.innerHTML = `
    <div class="r-title">${bill.restaurant_name || 'Restaurant'}</div>
    ${bill.address ? `<div class="r-sub">${bill.address}</div>` : ''}
    ${bill.gstin ? `<div class="r-sub">GSTIN: ${bill.gstin}</div>` : ''}
    ${bill.phone ? `<div class="r-sub">${bill.phone}</div>` : ''}
    <div class="r-sub">${bill.bill_number} · ${new Date().toLocaleString('en-IN')}</div>
    ${bill.price_mode === 'new' ? '<div class="r-sub" style="color:#b25c00">New rate applied (+10%)</div>' : ''}
    <hr />
    ${bill.items.map((i) => `<div class="r-row"><span>${i.name} x${i.qty}</span><span>₹${(i.price * i.qty).toFixed(2)}</span></div>`).join('')}
    <hr />
    <div class="r-row"><span>Subtotal</span><span>₹${bill.subtotal.toFixed(2)}</span></div>
    <div class="r-row"><span>Discount</span><span>-₹${bill.discount.toFixed(2)}</span></div>
    <div class="r-row"><span>CGST</span><span>₹${bill.cgst.toFixed(2)}</span></div>
    <div class="r-row"><span>SGST</span><span>₹${bill.sgst.toFixed(2)}</span></div>
    <hr />
    <div class="r-row" style="font-weight:600"><span>TOTAL</span><span>₹${bill.total.toFixed(2)}</span></div>
  `;
  $('#bill-modal').classList.remove('hidden');
}
function setupModal() {
  $('#close-bill-btn').addEventListener('click', () => $('#bill-modal').classList.add('hidden'));
  $('#print-bill-btn').addEventListener('click', () => window.print());
}

// ---------------- TABLES ----------------
async function loadTables() {
  state.tables = await api('/tables');
  const grid = $('#tables-grid');
  grid.innerHTML = '';
  state.tables.forEach((t) => {
    const card = document.createElement('button');
    card.className = `table-card ${t.status}`;
    card.innerHTML = `<span class="status-dot"></span><span>${t.name}</span>`;
    card.onclick = () => selectTable(t);
    grid.appendChild(card);
  });
}
async function selectTable(t) {
  const openOrders = await api('/orders?status=open');
  let order = openOrders.find((o) => o.table_id === t.id);
  if (!order) {
    const { id } = await api('/orders', { method: 'POST', body: { table_id: t.id, order_type: 'dine-in' } });
    order = { id };
  }
  state.currentOrder = { id: order.id, items: [] };
  $('#cart-title').textContent = `${t.name} · Order #${order.id}`;
  document.querySelector('[data-view="billing"]').click();
  refreshCart();
}
$('#add-table-btn')?.addEventListener('click', async () => {
  const name = prompt('Table name (e.g. T5)');
  if (!name) return;
  await api('/tables', { method: 'POST', body: { name } });
  loadTables();
});

// ---------------- MENU MANAGEMENT ----------------
async function loadMenuTable() {
  state.items = await api('/items');
  state.categories = await api('/categories');
  const body = $('#menu-table tbody');
  body.innerHTML = '';
  state.items.forEach((item) => {
    const cat = state.categories.find((c) => c.id === item.category_id);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${cat ? cat.name : '—'}</td>
      <td>₹${item.price.toFixed(2)}</td>
      <td>${item.tax_rate}%</td>
      <td>${item.station}</td>
      <td>${item.track_inventory ? `Yes (${item.stock_qty})` : 'No'}</td>
      <td><button class="ghost small" data-del="${item.id}">Delete</button></td>`;
    body.appendChild(tr);
  });
  $$('#menu-table [data-del]').forEach((btn) => {
    btn.onclick = async () => { await api(`/items/${btn.dataset.del}`, { method: 'DELETE' }); loadMenuTable(); };
  });
}
$('#add-item-btn')?.addEventListener('click', async () => {
  const name = prompt('Item name'); if (!name) return;
  const price = +prompt('Price (₹)', '100');
  const tax_rate = +prompt('GST rate %', '5');
  const station = prompt('Station (kitchen / bar / dessert)', 'kitchen') || 'kitchen';
  const track = confirm('Track inventory for this item?');
  const stock_qty = track ? +prompt('Starting stock quantity', '20') : 0;
  let category_id = null;
  const catName = prompt('Category name (existing or new)', 'Mains');
  if (catName) {
    let cat = state.categories.find((c) => c.name.toLowerCase() === catName.toLowerCase());
    if (!cat) { const { id } = await api('/categories', { method: 'POST', body: { name: catName } }); cat = { id }; }
    category_id = cat.id;
  }
  await api('/items', { method: 'POST', body: { name, price, tax_rate, station, category_id, track_inventory: track, stock_qty, low_stock_threshold: 5 } });
  loadMenuTable();
  loadCatalog();
});

// ---------------- INVENTORY ----------------
async function loadInventory() {
  const items = (await api('/items')).filter((i) => i.track_inventory);
  const lowStock = await api('/inventory/low-stock');
  $('#low-stock-banner').innerHTML = lowStock.length
    ? `Low stock: ${lowStock.map((i) => `<span class="chip">${i.name} (${i.stock_qty})</span>`).join('')}`
    : '<span class="muted">All stock levels healthy</span>';
  const body = $('#inventory-table tbody');
  body.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>${item.stock_qty} ${item.unit}</td>
      <td>${item.low_stock_threshold}</td>
      <td>
        <button class="ghost small" data-adj="${item.id}" data-amt="-1">-1</button>
        <button class="ghost small" data-adj="${item.id}" data-amt="1">+1</button>
        <button class="ghost small" data-adj="${item.id}" data-amt="10">+10</button>
      </td>`;
    body.appendChild(tr);
  });
  $$('#inventory-table [data-adj]').forEach((btn) => {
    btn.onclick = async () => {
      await api('/inventory/adjust', { method: 'POST', body: { item_id: btn.dataset.adj, change_qty: +btn.dataset.amt, reason: 'Manual adjustment' } });
      loadInventory();
    };
  });
}

// ---------------- KOT LOG ----------------
async function loadKotLog() {
  $('#kot-log').innerHTML = '<div class="muted">Recent KOTs are shown when you send an order to the kitchen from Billing.</div>';
}

// ---------------- BILLS (list + OTP-protected delete) ----------------
let pendingDeleteBillId = null;

async function loadBills() {
  const bills = await api('/bills');
  const body = $('#bills-table tbody');
  body.innerHTML = '';
  bills.forEach((b) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.bill_number}</td>
      <td>${new Date(b.created_at).toLocaleString('en-IN')}</td>
      <td>₹${b.total.toFixed(2)}</td>
      <td>${b.payment_mode}</td>
      <td>${state.user.role === 'owner' ? `<button class="ghost small" data-delbill="${b.id}">Delete</button>` : ''}</td>`;
    body.appendChild(tr);
  });
  $$('#bills-table [data-delbill]').forEach((btn) => {
    btn.onclick = () => startBillDeletion(btn.dataset.delbill);
  });
}

async function startBillDeletion(billId) {
  pendingDeleteBillId = billId;
  try {
    const res = await api(`/bills/${billId}/request-delete-otp`, { method: 'POST' });
    $('#otp-modal-sub').textContent = res.whatsapp_configured
      ? "OTP sent to owner's WhatsApp"
      : 'WhatsApp not configured on the server — check server logs for the OTP';
    $('#otp-input').value = '';
    $('#otp-error').textContent = '';
    $('#otp-modal').classList.remove('hidden');
  } catch (e) {
    alert(e.message);
  }
}

function setupOtpModal() {
  $('#otp-cancel-btn').addEventListener('click', () => {
    $('#otp-modal').classList.add('hidden');
    pendingDeleteBillId = null;
  });
  $('#otp-confirm-btn').addEventListener('click', async () => {
    const otp = $('#otp-input').value.trim();
    try {
      await api(`/bills/${pendingDeleteBillId}/verify-delete`, { method: 'POST', body: { otp } });
      $('#otp-modal').classList.add('hidden');
      pendingDeleteBillId = null;
      loadBills();
      loadTables();
    } catch (e) {
      $('#otp-error').textContent = e.message;
    }
  });
}

// ---------------- SETTINGS ----------------
async function loadSettings() {
  const s = await api('/settings');
  $('#settings-name').value = s.restaurant_name || '';
  $('#settings-address').value = s.address || '';
  $('#settings-gstin').value = s.gstin || '';
  $('#settings-phone').value = s.phone || '';
}
function setupSettings() {
  $('#settings-save-btn')?.addEventListener('click', async () => {
    try {
      await api('/settings', {
        method: 'PUT',
        body: {
          restaurant_name: $('#settings-name').value,
          address: $('#settings-address').value,
          gstin: $('#settings-gstin').value,
          phone: $('#settings-phone').value,
        },
      });
      $('#settings-saved-msg').textContent = 'Saved ✓';
      setTimeout(() => { $('#settings-saved-msg').textContent = ''; }, 2000);
    } catch (e) {
      $('#settings-saved-msg').textContent = e.message;
    }
  });
}

// ---------------- REPORTS ----------------
$('#run-report-btn')?.addEventListener('click', async () => {
  const from = $('#report-from').value, to = $('#report-to').value;
  const sales = await api(`/reports/sales?from=${from}&to=${to}`);
  const items = await api(`/reports/items?from=${from}&to=${to}`);
  $('#report-sales-body').innerHTML = sales.map((r) => `<tr><td>${r.day}</td><td>${r.payment_mode}</td><td>${r.bill_count}</td><td>₹${r.revenue.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No data</td></tr>';
  $('#report-items-body').innerHTML = items.map((r) => `<tr><td>${r.name}</td><td>${r.qty_sold}</td><td>₹${r.revenue.toFixed(2)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No data</td></tr>';
});

// ---------------- BOOT ----------------
async function boot() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = `${state.user.name} · ${state.user.role}`;
  await loadCatalog();
  await loadTables();
}

setupLogin();
setupNav();
setupBillingActions();
setupModal();
setupOtpModal();
setupSettings();

// If a token is already saved on this device, skip login entirely — this is what
// keeps a device logged in across visits without resetting.
if (state.token && state.user) boot();
