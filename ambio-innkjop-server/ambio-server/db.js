/**
 * Ambio Innkjøp og varer — JSON File Database
 *
 * Zero dependencies — uses Node.js built-in fs module only.
 * Data stored in: ./ambio-data.json  (same folder as server.js)
 * Atomic writes: write to .tmp → rename (prevents corruption on crash)
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use env var path if set (Fly.io persistent volume), else local
const DATA_DIR  = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : __dirname;
const DB_FILE   = process.env.DB_PATH  || path.join(__dirname, 'ambio-data.json');
const BAK_FILE  = path.join(DATA_DIR, 'ambio-data.backup.json');
const TMP_FILE  = path.join(DATA_DIR, 'ambio-data.tmp.json');

let store = { orders: [], history: [], _version: 1 };
let _nextHistId = 1;

// ── Init ──────────────────────────────────────────────────────────────────────
export function initDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      store       = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      _nextHistId = store.history?.length
        ? Math.max(...store.history.map(h => Number(h.id) || 0)) + 1
        : 1;
      console.log(`[DB] Lastet: ${store.orders?.length || 0} ordrer, ${store.history?.length || 0} loggoppføringer`);
    } catch (err) {
      console.error('[DB] Korrupt datafil, prøver backup...', err.message);
      if (fs.existsSync(BAK_FILE)) {
        try { store = JSON.parse(fs.readFileSync(BAK_FILE, 'utf8')); console.log('[DB] Backup gjenopprettet'); }
        catch { store = { orders: [], history: [], _version: 1 }; }
      }
    }
  } else {
    console.log(`[DB] Ny database: ${DB_FILE}`);
    _save();
  }
}

function _save() {
  try {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, BAK_FILE);
    fs.writeFileSync(TMP_FILE, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(TMP_FILE, DB_FILE);
  } catch (err) { console.error('[DB] Lagringsfeil:', err.message); }
}

// ── Orders ────────────────────────────────────────────────────────────────────
export function getAllOrders() {
  return (store.orders || []).slice().sort((a, b) => new Date(b.created) - new Date(a.created));
}

export function getOrder(id) {
  return (store.orders || []).find(o => o.id === id) || null;
}

export function createOrder(order) {
  const now = new Date().toISOString();
  const o   = { ...order, created: order.created || now, updated: now, status: order.status || 'draft', lines: order.lines || [], receivedLines: [], pogoManualSteps: [] };
  store.orders = [o, ...(store.orders || [])];
  _save();
  return o;
}

export function updateOrderStatus(id, fields) {
  const idx = (store.orders || []).findIndex(o => o.id === id);
  if (idx === -1) return null;
  const { historyEntry, receivedLines, pogoManualSteps, ...rest } = fields;
  store.orders[idx] = { ...store.orders[idx], ...rest, updated: new Date().toISOString() };
  if (receivedLines?.length) {
    store.orders[idx].receivedLines = [...(store.orders[idx].receivedLines || []), ...receivedLines.map(l => ({ ...l, receivedAt: l.receivedAt || new Date().toISOString() }))];
  }
  if (pogoManualSteps?.length) {
    store.orders[idx].pogoManualSteps = [...(store.orders[idx].pogoManualSteps || []), ...pogoManualSteps];
  }
  if (historyEntry) addHistory(historyEntry.type, historyEntry.text, historyEntry.user || 'System');
  _save();
  return store.orders[idx];
}

export function saveReceivedLines(orderId, lines) { updateOrderStatus(orderId, { receivedLines: lines }); }
export function savePogoManualSteps(orderId, steps) { updateOrderStatus(orderId, { pogoManualSteps: steps }); }

// ── History ───────────────────────────────────────────────────────────────────
export function getHistory(limit = 300) {
  return (store.history || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, limit);
}

export function addHistory(type, text, user = 'System', ts = null) {
  const entry = { id: String(_nextHistId++), type, text, user, ts: ts || new Date().toISOString() };
  store.history = [entry, ...(store.history || [])];
  if (store.history.length > 1000) store.history = store.history.slice(0, 1000);
  _save();
  return entry;
}

export function getDbStats() {
  return {
    orders:     (store.orders || []).length,
    history:    (store.history || []).length,
    filePath:   DB_FILE,
    fileSizeKb: fs.existsSync(DB_FILE) ? Math.round(fs.statSync(DB_FILE).size / 1024) : 0,
  };
}
