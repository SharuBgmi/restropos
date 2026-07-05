require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { createClient } = require('@libsql/client');

const {
  WHATSAPP_TOKEN, PHONE_NUMBER_ID, OWNER_WHATSAPP_NUMBER, GRAPH_API_VERSION = 'v20.0',
  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, PORT = 4000,
} = process.env;

const GRAPH_URL = PHONE_NUMBER_ID ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}` : null;
const ownerPhoneClean = OWNER_WHATSAPP_NUMBER ? OWNER_WHATSAPP_NUMBER.replace(/\D/g, '') : null;

async function sendWhatsAppText(message, to = OWNER_WHATSAPP_NUMBER) {
  if (!GRAPH_URL || !WHATSAPP_TOKEN || !to) {
    console.warn('[whatsapp] Not configured — skipped sending:', message.split('\n')[0]);
    return { skipped: true };
  }
  try {
    const res = await axios.post(
      `${GRAPH_URL}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    return res.data;
  } catch (err) {
    console.error('[whatsapp] send failed:', err.response?.data || err.message);
    return { error: true };
  }
}

// Sends an OTP via plain SMS using Fast2SMS's OTP route (no DLT template needed in India).
const { FAST2SMS_API_KEY } = process.env;
async function sendOtpSms(otp, phone) {
  if (!FAST2SMS_API_KEY) {
    console.warn(`[sms] FAST2SMS_API_KEY not set — OTP for ${phone} is: ${otp}`);
    return { skipped: true };
  }
  // Fast2SMS's OTP route expects a plain 10-digit Indian number, no country code.
  const tenDigit = phone.replace(/\D/g, '').slice(-10);
  try {
    const res = await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: { authorization: FAST2SMS_API_KEY, route: 'otp', variables_values: otp, flash: 0, numbers: tenDigit },
    });
    console.log('[sms] Fast2SMS response:', JSON.stringify(res.data));
    if (res.data && res.data.return === false) {
      console.error('[sms] Fast2SMS rejected the request:', res.data.message);
      return { error: true, detail: res.data.message };
    }
    return res.data;
  } catch (err) {
    console.error('[sms] send failed:', err.response?.data || err.message);
    return { error: true, detail: err.response?.data };
  }
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---------- DATABASE ----------
// If TURSO_DATABASE_URL is set, data persists in the cloud (survives every Render
// redeploy/restart). Without it, falls back to a local file — fine for local testing,
// but will still reset on Render's free tier since that disk isn't persistent.
require('fs').mkdirSync(path.join(__dirname, 'db'), { recursive: true });
const client = createClient(
  TURSO_DATABASE_URL
    ? { url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN, intMode: 'number' }
    : { url: `file:${path.join(__dirname, 'db', 'restropos.db')}`, intMode: 'number' }
);
if (!TURSO_DATABASE_URL) {
  console.warn('[db] TURSO_DATABASE_URL not set — using local file. Data will NOT survive a Render redeploy.');
}

async function run(sql, args = []) { return client.execute({ sql, args }); }
async function get(sql, args = []) { const r = await client.execute({ sql, args }); return r.rows[0] || null; }
async function all(sql, args = []) { const r = await client.execute({ sql, args }); return r.rows; }

async function initSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'staff'
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS otps (
      purpose TEXT NOT NULL,
      otp_key TEXT NOT NULL,
      otp TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (purpose, otp_key)
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER,
      price REAL NOT NULL,
      tax_rate REAL NOT NULL DEFAULT 5,
      station TEXT NOT NULL DEFAULT 'kitchen',
      unit TEXT DEFAULT 'plate',
      track_inventory INTEGER DEFAULT 0,
      stock_qty REAL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 5,
      active INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT DEFAULT 'Main',
      status TEXT NOT NULL DEFAULT 'free'
    )`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id INTEGER,
      order_type TEXT NOT NULL DEFAULT 'dine-in',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL,
      tax_rate REAL NOT NULL,
      qty REAL NOT NULL,
      notes TEXT,
      station TEXT NOT NULL DEFAULT 'kitchen',
      kot_sent INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS kots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      kot_number TEXT NOT NULL,
      station TEXT NOT NULL,
      items_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      bill_number TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount REAL NOT NULL DEFAULT 0,
      cgst REAL NOT NULL,
      sgst REAL NOT NULL,
      total REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'cash',
      price_mode TEXT NOT NULL DEFAULT 'old',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      change_qty REAL NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      restaurant_name TEXT NOT NULL DEFAULT 'My Restaurant',
      address TEXT DEFAULT '',
      gstin TEXT DEFAULT '',
      phone TEXT DEFAULT ''
    )`,
  ];
  for (const stmt of statements) await client.execute(stmt);

  const settingsCount = (await get('SELECT COUNT(*) c FROM settings')).c;
  if (settingsCount === 0) await run('INSERT INTO settings (id, restaurant_name) VALUES (1, ?)', ['My Restaurant']);

  const tableCount = (await get('SELECT COUNT(*) c FROM tables')).c;
  if (tableCount === 0) {
    for (const t of ['T1', 'T2', 'T3', 'T4']) await run('INSERT INTO tables (name, area) VALUES (?, ?)', [t, 'Main']);
  }

  // Seed the owner account from OWNER_WHATSAPP_NUMBER so that number logs in as owner
  if (ownerPhoneClean) {
    const existing = await get('SELECT * FROM users WHERE phone = ?', [ownerPhoneClean]);
    if (!existing) await run('INSERT INTO users (phone, name, role) VALUES (?, ?, ?)', [ownerPhoneClean, 'Owner', 'owner']);
  }
}

// ---------- APP ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// wraps async route handlers so thrown errors become clean 500s instead of crashing the process
const ah = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

async function requireAuth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const session = await get(
      'SELECT u.id, u.name, u.role, u.phone FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
      [token]
    );
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    req.user = session;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  next();
}

// ---------- AUTH: phone + SMS OTP ----------
app.post('/api/auth/request-otp', ah(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (phone.length < 8) return res.status(400).json({ error: 'Enter a valid phone number' });

  const otp = generateOtp();
  const expires_at = Date.now() + 5 * 60 * 1000;
  await run(
    `INSERT INTO otps (purpose, otp_key, otp, expires_at) VALUES ('login', ?, ?, ?)
     ON CONFLICT(purpose, otp_key) DO UPDATE SET otp = excluded.otp, expires_at = excluded.expires_at`,
    [phone, otp, expires_at]
  );
  const result = await sendWhatsAppText(`🔐 Your RestroPOS login code: ${otp}\nValid for 5 minutes.`, phone);
  res.json({ sent: !result.error, whatsapp_configured: !result.skipped });
}));

app.post('/api/auth/verify-otp', ah(async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  const otp = String(req.body.otp || '');
  const name = req.body.name;

  const record = await get('SELECT * FROM otps WHERE purpose = ? AND otp_key = ?', ['login', phone]);
  if (!record) return res.status(400).json({ error: 'Request an OTP first' });
  if (Date.now() > record.expires_at) {
    await run('DELETE FROM otps WHERE purpose = ? AND otp_key = ?', ['login', phone]);
    return res.status(400).json({ error: 'OTP expired, request a new one' });
  }
  if (record.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP' });
  await run('DELETE FROM otps WHERE purpose = ? AND otp_key = ?', ['login', phone]);

  let user = await get('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) {
    const role = ownerPhoneClean && phone === ownerPhoneClean ? 'owner' : 'staff';
    const info = await run('INSERT INTO users (phone, name, role) VALUES (?, ?, ?)', [phone, name || phone, role]);
    user = { id: info.lastInsertRowid, phone, name: name || phone, role };
  }

  const token = crypto.randomBytes(24).toString('hex');
  await run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', [token, user.id]);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, phone: user.phone } });
}));

app.post('/api/auth/logout', ah(async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) await run('DELETE FROM sessions WHERE token = ?', [token]);
  res.json({ success: true });
}));

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// ---------- SETTINGS ----------
app.get('/api/settings', ah(async (req, res) => {
  res.json(await get('SELECT * FROM settings WHERE id = 1'));
}));
app.put('/api/settings', requireOwner, ah(async (req, res) => {
  const { restaurant_name, address = '', gstin = '', phone = '' } = req.body;
  await run('UPDATE settings SET restaurant_name = ?, address = ?, gstin = ?, phone = ? WHERE id = 1', [restaurant_name, address, gstin, phone]);
  res.json({ success: true });
}));

// ---------- CATEGORIES ----------
app.get('/api/categories', ah(async (req, res) => {
  res.json(await all('SELECT * FROM categories ORDER BY sort_order, name'));
}));
app.post('/api/categories', ah(async (req, res) => {
  const { name, sort_order = 0 } = req.body;
  const info = await run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, sort_order]);
  res.json({ id: info.lastInsertRowid });
}));
app.delete('/api/categories/:id', ah(async (req, res) => {
  await run('DELETE FROM categories WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

// ---------- ITEMS ----------
app.get('/api/items', ah(async (req, res) => {
  res.json(await all('SELECT * FROM items WHERE active = 1 ORDER BY category_id, name'));
}));
app.post('/api/items', ah(async (req, res) => {
  const { name, category_id, price, tax_rate = 5, station = 'kitchen', unit = 'plate', track_inventory = 0, stock_qty = 0, low_stock_threshold = 5 } = req.body;
  const info = await run(
    `INSERT INTO items (name, category_id, price, tax_rate, station, unit, track_inventory, stock_qty, low_stock_threshold)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [name, category_id, price, tax_rate, station, unit, track_inventory ? 1 : 0, stock_qty, low_stock_threshold]
  );
  res.json({ id: info.lastInsertRowid });
}));
app.put('/api/items/:id', ah(async (req, res) => {
  const f = req.body;
  await run(
    `UPDATE items SET name=?, category_id=?, price=?, tax_rate=?, station=?, unit=?, track_inventory=?, stock_qty=?, low_stock_threshold=? WHERE id=?`,
    [f.name, f.category_id, f.price, f.tax_rate, f.station, f.unit, f.track_inventory ? 1 : 0, f.stock_qty, f.low_stock_threshold, req.params.id]
  );
  res.json({ success: true });
}));
app.delete('/api/items/:id', ah(async (req, res) => {
  await run('UPDATE items SET active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
}));

// ---------- TABLES ----------
app.get('/api/tables', ah(async (req, res) => {
  res.json(await all('SELECT * FROM tables ORDER BY area, name'));
}));
app.post('/api/tables', ah(async (req, res) => {
  const { name, area = 'Main' } = req.body;
  const info = await run('INSERT INTO tables (name, area) VALUES (?, ?)', [name, area]);
  res.json({ id: info.lastInsertRowid });
}));

// ---------- ORDERS ----------
app.get('/api/orders', ah(async (req, res) => {
  const status = req.query.status;
  const rows = status
    ? await all('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC', [status])
    : await all('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(rows);
}));

app.post('/api/orders', ah(async (req, res) => {
  const { table_id, order_type = 'dine-in' } = req.body;
  const info = await run('INSERT INTO orders (table_id, order_type) VALUES (?, ?)', [table_id || null, order_type]);
  if (table_id) await run("UPDATE tables SET status = 'occupied' WHERE id = ?", [table_id]);
  res.json({ id: info.lastInsertRowid });
}));

app.get('/api/orders/:id', ah(async (req, res) => {
  const order = await get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.items = await all('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
  res.json(order);
}));

app.post('/api/orders/:id/items', ah(async (req, res) => {
  const { item_id, qty, notes = '' } = req.body;
  const item = await get('SELECT * FROM items WHERE id = ?', [item_id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const info = await run(
    `INSERT INTO order_items (order_id, item_id, name, price, tax_rate, qty, notes, station) VALUES (?,?,?,?,?,?,?,?)`,
    [req.params.id, item_id, item.name, item.price, item.tax_rate, qty, notes, item.station]
  );
  res.json({ id: info.lastInsertRowid });
}));

app.delete('/api/orders/:orderId/items/:rowId', ah(async (req, res) => {
  await run('DELETE FROM order_items WHERE id = ? AND order_id = ? AND kot_sent = 0', [req.params.rowId, req.params.orderId]);
  res.json({ success: true });
}));

app.post('/api/orders/:id/kot', ah(async (req, res) => {
  const orderId = req.params.id;
  const pending = await all('SELECT * FROM order_items WHERE order_id = ? AND kot_sent = 0', [orderId]);
  if (pending.length === 0) return res.status(400).json({ error: 'Nothing new to send to kitchen' });

  const byStation = {};
  pending.forEach((oi) => {
    byStation[oi.station] = byStation[oi.station] || [];
    byStation[oi.station].push({ name: oi.name, qty: oi.qty, notes: oi.notes });
  });

  const tickets = [];
  const kotSeq = (await get('SELECT COUNT(*) c FROM kots')).c + 1;
  let idx = 0;
  for (const [station, stationItems] of Object.entries(byStation)) {
    const kotNumber = `KOT-${String(kotSeq + idx).padStart(4, '0')}`;
    await run('INSERT INTO kots (order_id, kot_number, station, items_json) VALUES (?,?,?,?)', [orderId, kotNumber, station, JSON.stringify(stationItems)]);
    tickets.push({ kot_number: kotNumber, station, items: stationItems });
    idx++;
  }

  for (const oi of pending) {
    await run('UPDATE order_items SET kot_sent = 1 WHERE id = ?', [oi.id]);
    const item = await get('SELECT * FROM items WHERE id = ?', [oi.item_id]);
    if (item && item.track_inventory) {
      await run('UPDATE items SET stock_qty = stock_qty - ? WHERE id = ?', [oi.qty, item.id]);
      await run('INSERT INTO inventory_log (item_id, change_qty, reason) VALUES (?, ?, ?)', [item.id, -oi.qty, `KOT for order #${orderId}`]);
    }
  }

  res.json({ tickets });
}));

// Generate the final bill: GST split CGST/SGST, discount, payment mode, old/new price
app.post('/api/orders/:id/bill', ah(async (req, res) => {
  const orderId = req.params.id;
  const { discount = 0, payment_mode = 'cash', price_mode = 'old' } = req.body;
  const order = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const rawItems = await all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  if (rawItems.length === 0) return res.status(400).json({ error: 'Order has no items' });

  const priceMultiplier = price_mode === 'new' ? 1.1 : 1;
  const items = rawItems.map((i) => ({ ...i, billed_price: +(i.price * priceMultiplier).toFixed(2) }));

  const subtotal = items.reduce((s, i) => s + i.billed_price * i.qty, 0);
  const taxTotal = items.reduce((s, i) => s + (i.billed_price * i.qty * i.tax_rate) / 100, 0);
  const cgst = +(taxTotal / 2).toFixed(2);
  const sgst = +(taxTotal / 2).toFixed(2);
  const total = +(subtotal - discount + cgst + sgst).toFixed(2);

  const billSeq = (await get('SELECT COUNT(*) c FROM bills')).c + 1;
  const billNumber = `BILL-${String(billSeq).padStart(4, '0')}`;

  const info = await run(
    `INSERT INTO bills (order_id, bill_number, subtotal, discount, cgst, sgst, total, payment_mode, price_mode) VALUES (?,?,?,?,?,?,?,?,?)`,
    [orderId, billNumber, subtotal, discount, cgst, sgst, total, payment_mode, price_mode]
  );

  await run("UPDATE orders SET status = 'billed', closed_at = CURRENT_TIMESTAMP WHERE id = ?", [orderId]);
  if (order.table_id) await run("UPDATE tables SET status = 'free' WHERE id = ?", [order.table_id]);

  const settings = await get('SELECT * FROM settings WHERE id = 1');

  const lines = items.map((i) => `${i.name} x${i.qty} — ₹${(i.billed_price * i.qty).toFixed(2)}`).join('\n');
  const header = `🧾 *${settings.restaurant_name}*${settings.gstin ? `\nGSTIN: ${settings.gstin}` : ''}${settings.address ? `\n${settings.address}` : ''}`;
  const rateNote = price_mode === 'new' ? '\n_(New rate applied: +10% on menu price)_' : '';
  const message = `${header}\n\n*${billNumber}*${rateNote}\n${new Date().toLocaleString('en-IN')}\n\n${lines}\n\nSubtotal: ₹${subtotal.toFixed(2)}\nDiscount: ₹${discount.toFixed(2)}\nCGST: ₹${cgst.toFixed(2)}\nSGST: ₹${sgst.toFixed(2)}\n*Total: ₹${total.toFixed(2)}*\nPayment: ${payment_mode}`;
  sendWhatsAppText(message);

  res.json({
    id: info.lastInsertRowid, bill_number: billNumber, subtotal, discount, cgst, sgst, total, payment_mode, price_mode,
    items: items.map((i) => ({ ...i, price: i.billed_price })),
    restaurant_name: settings.restaurant_name, address: settings.address, gstin: settings.gstin, phone: settings.phone,
  });
}));

app.get('/api/orders/:id/bill', ah(async (req, res) => {
  const bill = await get('SELECT * FROM bills WHERE order_id = ?', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'No bill for this order' });
  bill.items = await all('SELECT * FROM order_items WHERE order_id = ?', [req.params.id]);
  res.json(bill);
}));

// ---------- BILLS (list + OTP-protected delete) ----------
app.get('/api/bills', ah(async (req, res) => {
  res.json(await all('SELECT * FROM bills ORDER BY created_at DESC LIMIT 200'));
}));

app.post('/api/bills/:id/request-delete-otp', requireOwner, ah(async (req, res) => {
  const bill = await get('SELECT * FROM bills WHERE id = ?', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const otp = generateOtp();
  const expires_at = Date.now() + 5 * 60 * 1000;
  await run(
    `INSERT INTO otps (purpose, otp_key, otp, expires_at) VALUES ('delete_bill', ?, ?, ?)
     ON CONFLICT(purpose, otp_key) DO UPDATE SET otp = excluded.otp, expires_at = excluded.expires_at`,
    [String(bill.id), otp, expires_at]
  );
  const result = await sendWhatsAppText(`🔐 OTP to delete ${bill.bill_number}: ${otp}\nValid for 5 minutes. Do not share this code.`);
  res.json({ sent: !result.error, whatsapp_configured: !result.skipped });
}));

app.post('/api/bills/:id/verify-delete', requireOwner, ah(async (req, res) => {
  const { otp } = req.body;
  const record = await get('SELECT * FROM otps WHERE purpose = ? AND otp_key = ?', ['delete_bill', req.params.id]);
  if (!record) return res.status(400).json({ error: 'No OTP requested for this bill, or it already expired' });
  if (Date.now() > record.expires_at) {
    await run('DELETE FROM otps WHERE purpose = ? AND otp_key = ?', ['delete_bill', req.params.id]);
    return res.status(400).json({ error: 'OTP expired, request a new one' });
  }
  if (record.otp !== otp) return res.status(400).json({ error: 'Incorrect OTP' });

  const bill = await get('SELECT * FROM bills WHERE id = ?', [req.params.id]);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  await run('DELETE FROM bills WHERE id = ?', [req.params.id]);
  await run("UPDATE orders SET status = 'open', closed_at = NULL WHERE id = ?", [bill.order_id]);
  const order = await get('SELECT * FROM orders WHERE id = ?', [bill.order_id]);
  if (order?.table_id) await run("UPDATE tables SET status = 'occupied' WHERE id = ?", [order.table_id]);

  await run('DELETE FROM otps WHERE purpose = ? AND otp_key = ?', ['delete_bill', req.params.id]);
  res.json({ success: true });
}));

// ---------- REPORTS ----------
app.get('/api/reports/sales', ah(async (req, res) => {
  const { from, to } = req.query;
  const rows = await all(
    `SELECT date(created_at) as day, payment_mode, COUNT(*) as bill_count, SUM(total) as revenue
     FROM bills WHERE date(created_at) BETWEEN date(?) AND date(?)
     GROUP BY day, payment_mode ORDER BY day DESC`,
    [from || '2000-01-01', to || '2100-01-01']
  );
  res.json(rows);
}));

app.get('/api/reports/items', ah(async (req, res) => {
  const { from, to } = req.query;
  const rows = await all(
    `SELECT oi.name, SUM(oi.qty) as qty_sold, SUM(oi.price * oi.qty) as revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'billed' AND date(o.closed_at) BETWEEN date(?) AND date(?)
     GROUP BY oi.name ORDER BY revenue DESC`,
    [from || '2000-01-01', to || '2100-01-01']
  );
  res.json(rows);
}));

app.get('/api/inventory/low-stock', ah(async (req, res) => {
  res.json(await all('SELECT * FROM items WHERE track_inventory = 1 AND stock_qty <= low_stock_threshold AND active = 1'));
}));
app.get('/api/inventory/log', ah(async (req, res) => {
  res.json(await all(`SELECT il.*, i.name as item_name FROM inventory_log il JOIN items i ON i.id = il.item_id ORDER BY il.created_at DESC LIMIT 200`));
}));
app.post('/api/inventory/adjust', ah(async (req, res) => {
  const { item_id, change_qty, reason = 'Manual adjustment' } = req.body;
  await run('UPDATE items SET stock_qty = stock_qty + ? WHERE id = ?', [change_qty, item_id]);
  await run('INSERT INTO inventory_log (item_id, change_qty, reason) VALUES (?,?,?)', [item_id, change_qty, reason]);
  res.json({ success: true });
}));

initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`RestroPOS running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
