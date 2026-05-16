/**
 * Ambio Innkjøp og varer — Express backend
 * Proxies PowerOffice Go API calls to avoid browser CORS restrictions.
 * Caches the OAuth token in memory (refreshed every ~19 min).
 *
 * Start: node server.js
 * Default port: 3000  →  http://localhost:3000
 */

import express from 'express';
import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import session from 'express-session';
import {
  initDb, getAllOrders, getOrder, createOrder, updateOrderStatus,
  saveReceivedLines, savePogoManualSteps, getHistory, addHistory, getDbStats,
  getUsers, getUser, upsertUser, removeUser,
  getAllStocktakes, getStocktake, createStocktake, updateStocktake,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── Session middleware ────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ── Azure AD / Microsoft 365 OAuth2 config ───────────────────────────────────
const AZURE = {
  tenantId:     process.env.AZURE_TENANT_ID     || 'ambioas.onmicrosoft.com',
  clientId:     process.env.AZURE_CLIENT_ID     || '',  // Set in Fly.io secrets
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',  // Set in Fly.io secrets
  redirectUri:  process.env.AZURE_REDIRECT_URI  || 'http://localhost:3000/auth/callback',
  scopes: ['openid', 'profile', 'email', 'User.Read'],
};

function isAzureConfigured() { return !!(AZURE.clientId && AZURE.clientSecret); }

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Ikke innlogget', loginUrl: '/auth/login' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Ikke innlogget', loginUrl: '/auth/login' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: `Krever rolle: ${roles.join(' eller ')}. Du har: ${req.session.user.role}` });
    }
    next();
  };
}

// ── Initialize database ────────────────────────────────────────────────────── ───────────────────────────────────────────────────────
initDb();

// ── Config (Ambio AS demo credentials) ───────────────────────────────────────
const CONFIG = {
  appKey:          'a44b5774-ec58-425d-ae85-e268701b9720',
  clientKey:       '14873219-fa02-746b-23de-3a383de36115',
  clientId:        'c0be4bb8-3960-40ba-97cc-4c32ef03977c',
  subscriptionKey: '2abbd71d945a41d2b100e4505324d730',  // primary
  // subscriptionKey: 'e403a293bc244baa81f2590f616f44f1', // secondary (fallback)
  useDemo: true,
};

const AUTH_URL  = CONFIG.useDemo
  ? 'https://goapi.poweroffice.net/Demo/OAuth/Token'
  : 'https://goapi.poweroffice.net/OAuth/Token';
const BASE_URL  = CONFIG.useDemo
  ? 'https://goapi.poweroffice.net/Demo/v2'
  : 'https://goapi.poweroffice.net/v2';

// ── Token cache ───────────────────────────────────────────────────────────────
let tokenCache = { accessToken: null, expiry: 0 };

async function getToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiry - 60_000) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${CONFIG.appKey}:${CONFIG.clientKey}`).toString('base64');
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Ocp-Apim-Subscription-Key': CONFIG.subscriptionKey,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PowerOffice Auth failed ${res.status}: ${text}`);
  }

  const data = await res.json();
  tokenCache = {
    accessToken: data.access_token,
    expiry: Date.now() + (data.expires_in || 1200) * 1000,
  };
  console.log('[Auth] Token refreshed, expires in', data.expires_in, 'seconds');
  return tokenCache.accessToken;
}

// ── Database API: Orders ─────────────────────────────────────────────────────
app.get('/api/orders', requireAuth, (req, res) => {
  try { res.json(getAllOrders()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/:id', (req, res) => {
  try {
    const order = getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders', requireRole('bestiller','godkjenner','administrator'), (req, res) => {
  try {
    const order = createOrder(req.body);
    addHistory('po_created', `Innkjøpsordre opprettet — ${order.id} (${order.supplierName})`, req.body.user || 'Deg');
    res.status(201).json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/orders/:id', requireAuth, (req, res) => {
  try {
    const { historyEntry, receivedLines, pogoManualSteps, ...fields } = req.body;
    const order = updateOrderStatus(req.params.id, fields);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (receivedLines?.length) saveReceivedLines(req.params.id, receivedLines);
    if (pogoManualSteps?.length) savePogoManualSteps(req.params.id, pogoManualSteps);
    if (historyEntry) addHistory(historyEntry.type, historyEntry.text, historyEntry.user || 'System');

    res.json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Database API: History ─────────────────────────────────────────────────────
app.get('/api/history', requireAuth, (req, res) => {
  try { res.json(getHistory(300)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/history', requireAuth, (req, res) => {
  try {
    const { type, text, user, ts } = req.body;
    const entry = addHistory(type, text, user, ts);
    res.status(201).json(entry);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: Microsoft 365 / Azure AD ───────────────────────────────────────────

// GET /auth/login — redirect to Microsoft login
app.get('/auth/login', (req, res) => {
  // MIDLERTIDIG: Microsoft-innlogging deaktivert — direkte testinnlogging
  if (process.env.AUTH_BYPASS === 'true' || !isAzureConfigured()) {
    req.session.user = { email: 'dev@ambio.no', displayName: 'Dev Admin (test)', role: 'administrator', devMode: true };
    return res.redirect('/');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id:     AZURE.clientId,
    response_type: 'code',
    redirect_uri:  AZURE.redirectUri,
    scope:         'openid profile email User.Read',
    state,
    response_mode: 'query',
  });
  res.redirect(`https://login.microsoftonline.com/${AZURE.tenantId}/oauth2/v2.0/authorize?${params}`);
});

// GET /auth/callback — handle Microsoft redirect
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  if (state !== req.session.oauthState) return res.redirect('/?auth_error=invalid_state');

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(`https://login.microsoftonline.com/${AZURE.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     AZURE.clientId,
        client_secret: AZURE.clientSecret,
        code,
        redirect_uri:  AZURE.redirectUri,
        grant_type:    'authorization_code',
        scope:         'openid profile email User.Read',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || 'Token exchange failed');

    // Get user profile from Microsoft Graph
    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await graphRes.json();
    const email = (profile.mail || profile.userPrincipalName || '').toLowerCase();
    const displayName = profile.displayName || email;

    // Look up role in our database
    let dbUser = getUser(email);
    if (!dbUser) {
      // First user ever = administrator, others = no access until assigned
      const users = getUsers();
      const role = users.length === 0 ? 'administrator' : null;
      if (role) {
        dbUser = upsertUser(email, displayName, role, 'System (første bruker)');
        addHistory('sync', `Første bruker opprettet som administrator: ${email}`, 'System');
      }
    } else {
      // Update display name if changed
      if (dbUser.displayName !== displayName) upsertUser(email, displayName, dbUser.role, dbUser.addedBy);
    }

    if (!dbUser?.role) {
      // User authenticated but has no role assigned
      req.session.user = null;
      return res.redirect('/?auth_error=no_role&email=' + encodeURIComponent(email));
    }

    req.session.user = { email, displayName, role: dbUser.role, accessToken: tokens.access_token };
    console.log(`[Auth] Innlogget: ${displayName} (${email}) — rolle: ${dbUser.role}`);
    addHistory('sync', `${displayName} logget inn (${dbUser.role})`, displayName);
    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Callback feil:', err.message);
    res.redirect('/?auth_error=' + encodeURIComponent(err.message));
  }
});

// GET /auth/me — return current user info
app.get('/auth/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ loggedIn: false, loginUrl: '/auth/login', azureConfigured: isAzureConfigured() });
  const { accessToken, ...safeUser } = req.session.user;
  res.json({ loggedIn: true, ...safeUser, azureConfigured: isAzureConfigured() });
});

// POST /auth/logout
app.post('/auth/logout', (req, res) => {
  const user = req.session.user;
  req.session.destroy(() => {
    if (user) addHistory('sync', `${user.displayName} logget ut`, user.displayName);
    res.json({ ok: true });
  });
});

// ── User management (admin only) ──────────────────────────────────────────────
app.get('/api/users', requireRole('administrator'), (req, res) => {
  res.json(getUsers());
});

app.post('/api/users', requireRole('administrator'), (req, res) => {
  const { email, displayName, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email og role påkrevd' });
  if (!['administrator','godkjenner','bestiller'].includes(role))
    return res.status(400).json({ error: 'Ugyldig rolle. Gyldige: administrator, godkjenner, bestiller' });
  const user = upsertUser(email.toLowerCase(), displayName || email, role, req.session.user.email);
  addHistory('sync', `Bruker ${email} tildelt rolle: ${role}`, req.session.user.displayName);
  res.json(user);
});

app.delete('/api/users/:email', requireRole('administrator'), (req, res) => {
  const email = decodeURIComponent(req.params.email);
  if (email === req.session.user.email) return res.status(400).json({ error: 'Kan ikke fjerne deg selv' });
  removeUser(email);
  addHistory('sync', `Bruker ${email} fjernet`, req.session.user.displayName);
  res.json({ ok: true });
});

// ── Lagertelling (Stocktake) ─────────────────────────────────────────────────

app.get('/api/stocktakes', requireAuth, (req, res) => {
  res.json(getAllStocktakes());
});

app.post('/api/stocktakes', requireAuth, (req, res) => {
  const st = createStocktake(req.body);
  addHistory('stock_update', `Lagertelling opprettet: ${st.id}`, req.session?.user?.displayName || 'System');
  res.status(201).json(st);
});

app.get('/api/stocktakes/:id', requireAuth, (req, res) => {
  const st = getStocktake(req.params.id);
  if (!st) return res.status(404).json({ error: 'Ikke funnet' });
  res.json(st);
});

app.patch('/api/stocktakes/:id', requireAuth, (req, res) => {
  const { historyNote, ...fields } = req.body;
  const st = updateStocktake(req.params.id, fields);
  if (!st) return res.status(404).json({ error: 'Ikke funnet' });
  if (historyNote) addHistory('stock_update', historyNote, req.session?.user?.displayName || 'System');
  res.json(st);
});

// ── PowerOffice Go API proxy ──────────────────────────────────────────────────
// All requests to /api/pogo/* are forwarded to BASE_URL/*
app.all('/api/pogo/*', async (req, res) => {
  try {
    const token = await getToken();
    const pogPath = req.path.replace('/api/pogo', '');
    const url = `${BASE_URL}${pogPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;

    console.log(`[Proxy] ${req.method} ${url}`);

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': CONFIG.subscriptionKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const options = { method: req.method, headers };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const pogoRes = await fetch(url, options);
    const text = await pogoRes.text();

    res.status(pogoRes.status);
    res.set('Content-Type', pogoRes.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    console.error('[Proxy Error]', err.message);
    res.status(502).json({ error: err.message });
  }
});


// ── Statistics: Fetch invoices + lines, aggregate server-side ────────────────
// GET /api/stats/sales?from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/stats/sales', requireAuth, async (req, res) => {
  try {
    const token = await getToken();
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from og to påkrevd (YYYY-MM-DD)' });

    console.log(`[Stats] Henter fakturaer ${from} → ${to}`);

    // Helper: safe fetch that always returns parsed JSON or null
    async function pogGet(path) {
      const url = `${BASE_URL}${path}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Ocp-Apim-Subscription-Key': CONFIG.subscriptionKey,
          Accept: 'application/json',
        },
      });
      const text = await r.text();
      console.log(`[Stats] ${r.status} ${path} → ${text.slice(0, 120)}`);
      if (!r.ok || !text.trim()) return null;
      try { return JSON.parse(text); } catch { return null; }
    }

    // 1. Try OutgoingInvoices with date filter
    let data = await pogGet(`/OutgoingInvoices?fromDate=${from}&toDate=${to}`);

    // Normalize: POGO returns {data:[]} or [] directly
    let invoices = [];
    if (Array.isArray(data)) invoices = data;
    else if (data && Array.isArray(data.data)) invoices = data.data;
    else if (data === null) {
      // Maybe endpoint needs different param name – try without filter to see what exists
      const probe = await pogGet('/OutgoingInvoices');
      console.log('[Stats] Probe (no filter):', JSON.stringify(probe)?.slice(0, 200));
      invoices = [];
    }

    console.log(`[Stats] ${invoices.length} fakturaer funnet`);
    if (invoices.length > 0) {
      console.log('[Stats] Invoice felt:', Object.keys(invoices[0]).join(', '));
      console.log('[Stats] Første faktura (forkortet):', JSON.stringify(invoices[0]).slice(0, 400));
    }

    // 2. Fetch lines for each invoice (batches of 10)
    const enriched = [];
    for (let i = 0; i < invoices.length; i += 10) {
      const batch = invoices.slice(i, i + 10);
      const results = await Promise.all(batch.map(async (inv) => {
        const invId = inv.Id ?? inv.id;  // POGO returns Id with capital I
        if (!invId) { console.warn('[Stats] Invoice missing Id:', JSON.stringify(inv).slice(0,100)); return { ...inv, lines: [] }; }
        const lData = await pogGet(`/OutgoingInvoices/${invId}/Lines`);
        let lines = [];
        if (Array.isArray(lData)) lines = lData;
        else if (lData && Array.isArray(lData.data)) lines = lData.data;
        if (lines.length > 0 && enriched.length === 0) {
          console.log('[Stats] Fakturalinje-felt:', Object.keys(lines[0]).join(', '));
          console.log('[Stats] Første linje RAW:', JSON.stringify(lines[0]));
        }
        return { ...inv, lines };
      }));
      enriched.push(...results);
    }

    // 3. Fetch customer names — try Contacts endpoint (POGO stores customers as contacts)
    const customerIds = [...new Set(enriched.map(inv => inv.CustomerId).filter(Boolean))];
    const customerNames = {};

    // First try: GET /Contacts?customerGroupId=... or individual lookups
    for (const cid of customerIds) {
      try {
        // Try /Contacts/{id} first
        let cr = await pogGet(`/Contacts/${cid}`);
        if (!cr || (!cr.Name && !cr.LegalName)) {
          // Try /Customers endpoint
          cr = await pogGet(`/Customers/${cid}`);
        }
        if (cr) {
          const name = cr.Name || cr.LegalName || cr.FirstName && cr.LastName
            ? `${cr.FirstName||''} ${cr.LastName||''}`.trim()
            : null;
          customerNames[cid] = name || `Kunde ${cid}`;
          console.log(`[Stats] Kunde ${cid} → ${customerNames[cid]} (felt: ${Object.keys(cr).join(',')})`);
        } else {
          customerNames[cid] = `Kunde ${cid}`;
        }
      } catch(e) {
        console.log(`[Stats] Kunde ${cid} lookup feilet: ${e.message}`);
        customerNames[cid] = `Kunde ${cid}`;
      }
    }
    console.log('[Stats] Kundenavn:', JSON.stringify(customerNames));

    // 4. Aggregate with confirmed POGO field names
    const byProduct = {}, byCustomer = {}, byMonth = {}, byYear = {};
    const invoiceList = [];

    const monthLabel = (key) => {
      if (!key || key === 'ukjent') return 'Ukjent';
      const [y, m] = key.split('-');
      return ['Jan','Feb','Mar','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Des'][+m - 1] + ' ' + y;
    };

    for (const inv of enriched) {
      // Confirmed POGO field names from debug log:
      const dateStr  = inv.VoucherDate || inv.OrderDate || inv.InvoiceDate || '';
      const date     = dateStr ? new Date(dateStr) : null;
      const monthKey = date && !isNaN(date)
        ? `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`
        : 'ukjent';
      const yearKey  = date && !isNaN(date) ? String(date.getFullYear()) : 'ukjent';

      // CustomerId is a number — look up name from pre-fetched map
      const custId   = String(inv.CustomerId || inv.CustomerAccountId || 'ukjent');
      const custName = customerNames[inv.CustomerId] || inv.CustomerName || `Kunde ${custId}`;

      if (!byCustomer[custId]) byCustomer[custId] = { id:custId, name:custName, revenue:0, qty:0, invoiceCount:0, products:new Set() };
      if (!byMonth[monthKey])  byMonth[monthKey]  = { key:monthKey, label:monthLabel(monthKey), revenue:0, qty:0, invoiceCount:0 };
      if (!byYear[yearKey])    byYear[yearKey]     = { key:yearKey, label:yearKey, revenue:0, qty:0, invoiceCount:0 };
      byCustomer[custId].invoiceCount++;
      byMonth[monthKey].invoiceCount++;
      byYear[yearKey].invoiceCount++;

      let invRevenue = 0;

      for (const line of (inv.lines || [])) {
        // Confirmed line field names from debug log:
        // Description = product name, ProductCode = code, Quantity = qty
        // NetAmount = line total (ex VAT), TotalAmount = incl VAT
        const productCode = line.ProductCode || line.productCode || '';
        const productName = (line.Description || line.productName || 'Ukjent produkt')
          .split('\n')[0].trim(); // Description may have newlines — take first line
        const qty       = Number(line.Quantity || line.quantity || 0);
        const lineTotal = Number(line.NetAmount || line.TotalAmount || 0); // use NetAmount (ex VAT)
        const prodKey   = productCode || productName;

        if (!byProduct[prodKey]) byProduct[prodKey] = { code:productCode, name:productName, qty:0, revenue:0, customers:new Set(), invoiceCount:0 };
        byProduct[prodKey].qty      += qty;
        byProduct[prodKey].revenue  += lineTotal;
        byProduct[prodKey].customers.add(custId);
        byProduct[prodKey].invoiceCount++;

        byCustomer[custId].qty      += qty;
        byCustomer[custId].revenue  += lineTotal;
        byCustomer[custId].products.add(prodKey);
        byMonth[monthKey].revenue   += lineTotal;
        byMonth[monthKey].qty       += qty;
        byYear[yearKey].revenue     += lineTotal;
        byYear[yearKey].qty         += qty;
        invRevenue += lineTotal;
      }

      // Fallback: use invoice-level NetAmount if no lines processed
      if (invRevenue === 0) {
        invRevenue = Number(inv.NetAmount || inv.TotalAmount || 0);
        byCustomer[custId].revenue += invRevenue;
        byMonth[monthKey].revenue  += invRevenue;
        byYear[yearKey].revenue    += invRevenue;
      }

      invoiceList.push({
        id:           inv.Id,
        invoiceNo:    inv.InvoiceNo || inv.VoucherNo || inv.OrderNo || String(inv.Id||''),
        date:         dateStr,
        customerName: custName,
        customerId:   custId,
        totalAmount:  invRevenue,
        lineCount:    (inv.lines||[]).length,
        status:       inv.Status || '',
      });
    }

    res.json({
      from, to,
      invoiceCount:  enriched.length,
      totalRevenue:  Object.values(byProduct).reduce((s,p)=>s+p.revenue, 0) ||
                     invoiceList.reduce((s,i)=>s+i.totalAmount, 0),
      totalQty:      Object.values(byProduct).reduce((s,p)=>s+p.qty, 0),
      byProduct:  Object.values(byProduct).map(v=>({...v, customerCount:v.customers.size, customers:[...v.customers]})).sort((a,b)=>b.revenue-a.revenue),
      byCustomer: Object.values(byCustomer).map(v=>({...v, productCount:v.products.size, products:[...v.products]})).sort((a,b)=>b.revenue-a.revenue),
      byMonth:    Object.values(byMonth).sort((a,b)=>a.key.localeCompare(b.key)),
      byYear:     Object.values(byYear).sort((a,b)=>a.key.localeCompare(b.key)),
      invoices:   invoiceList.sort((a,b)=>(b.date||'').localeCompare(a.date||'')),
      // Debug info (helps diagnose missing data)
      _debug: { rawInvoiceCount: enriched.length, sampleKeys: enriched[0] ? Object.keys(enriched[0]) : [] },
    });

  } catch (err) {
    console.error('[Stats Error]', err.message, err.stack?.split('\n')[1]);
    res.status(502).json({ error: err.message });
  }
});

// ── Stock: Adjust product stock ─────────────────────────────────────────────
// POST /api/stock/adjust  { productId, delta, reason }
//
// Reality of POGO v2 stock management:
//   - StockOnHand is a READ-ONLY calculated field — cannot be set via PATCH
//   - Stock changes only happen through posted vouchers/transactions in POGO
//   - ManualJournalEntryVouchers requires production privileges not available in demo
//   - PATCH /Products uses JSON Patch RFC 6902 format AND StockOnHand is immutable
//
// Our approach:
//   1. Always update local app state immediately (reliable)
//   2. Try to post a ManualJournalEntryVoucher (works in production with privileges)
//   3. Log clearly what happened so user knows state of POGO
//   4. Return clear instructions for manual POGO update if auto-sync not possible
//
app.post('/api/stock/adjust', requireRole('godkjenner','administrator'), async (req, res) => {
  const { productId, delta, reason } = req.body;
  if (!productId || delta === undefined) {
    return res.status(400).json({ error: 'productId and delta required' });
  }

  try {
    const token = await getToken();
    const hdrs = {
      Authorization: `Bearer ${token}`,
      'Ocp-Apim-Subscription-Key': CONFIG.subscriptionKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // 1. Read current product from POGO
    const getRes = await fetch(`${BASE_URL}/Products/${productId}`, { headers: hdrs });
    if (!getRes.ok) throw new Error(`GET Product ${productId}: ${getRes.status}`);
    const product = await getRes.json();

    const currentStock = product.StockOnHand ?? 0;
    const newStock     = Math.max(0, currentStock + Number(delta));
    const d            = Number(delta);
    console.log(`[Stock] ${product.Name}: ${currentStock} + ${d} = ${newStock} (${reason || ''})`);

    let pogoSuccess = false;
    let pogoMethod  = 'local';
    let pogoNote    = '';

    // 2. Try ManualJournalEntryVoucher (only works in production with privileges)
    const unitCost = product.UnitCost ?? 0;
    const amount   = Math.abs(d) * unitCost;

    if (amount > 0) {
      const body = {
        VoucherDate: new Date().toISOString().split('T')[0],
        Description: reason || `Varemottak: ${product.Name} +${Math.abs(d)} stk`,
        Lines: [
          { AccountNumber: 1460, Amount:  d > 0 ?  amount : -amount, Description: product.Name },
          { AccountNumber: product.StandardSalesAccount || 4300, Amount: d > 0 ? -amount : amount, Description: product.Name },
        ],
      };
      console.log(`[Stock] Trying ManualJournalEntryVouchers (amount: ${amount})...`);
      const vRes  = await fetch(`${BASE_URL}/Vouchers/ManualJournalEntryVouchers`, {
        method: 'POST', headers: hdrs, body: JSON.stringify(body),
      });
      const vText = await vRes.text();
      console.log(`[Stock] Voucher ${vRes.status}: ${vText.slice(0,120)}`);
      if (vRes.ok) {
        pogoSuccess = true;
        pogoMethod  = 'voucher';
        pogoNote    = `Lagerbilag bokført i PowerOffice Go (konto 1460 ↔ ${product.StandardSalesAccount || 4300})`;
        console.log(`[Stock] ✓ Voucher OK for ${product.Name}`);
      } else {
        // 404 = endpoint not available (demo/missing privilege), 403 = no access
        const isDemo = vText.includes('not found') || vRes.status === 404;
        pogoNote = isDemo
          ? `Demo-miljøet støtter ikke bilagsoppdatering. I produksjon: aktiver "ManualJournalEntry"-rettighet via go-api@poweroffice.no`
          : `Bilag feilet (${vRes.status}) — lager oppdatert lokalt`;
        console.log(`[Stock] Voucher failed: ${pogoNote}`);
      }
    } else if (unitCost === 0) {
      pogoNote = `Produktet mangler kostpris (UnitCost = 0) — sett kostpris i POGO for automatisk bilagsføring`;
    }

    // 3. Re-fetch to confirm POGO's actual stock (matters if voucher worked)
    let finalStock = newStock;
    if (pogoSuccess) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const reRes = await fetch(`${BASE_URL}/Products/${productId}`, { headers: hdrs });
        if (reRes.ok) {
          const reProd = await reRes.json();
          finalStock = reProd.StockOnHand ?? newStock;
          console.log(`[Stock] Re-fetched ${product.Name}: StockOnHand = ${finalStock}`);
        }
      } catch { /* use newStock */ }
    }

    res.json({
      success:      pogoSuccess,
      method:       pogoMethod,
      note:         pogoNote || null,
      productId,
      productName:  product.Name,
      currentStock,
      newStock:     finalStock,
      delta:        d,
      // Instructions for manual POGO update if auto-sync didn't work
      manualSteps: !pogoSuccess ? [
        `Logg inn i PowerOffice Go`,
        `Gå til Lager → Lagertelling`,
        `Finn "${product.Name}" og sett antall til ${finalStock}`,
        `Alternativt: opprett manuelt bilag i Journal med konto 1460 (Varelager)`,
      ] : null,
      product: normalizeForClient({ ...product, StockOnHand: finalStock, StockAvailable: finalStock }),
    });

  } catch (err) {
    console.error('[Stock Error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Stock: Fetch latest stock for one or all products from POGO ──────────────
// GET /api/stock/sync?productId=123  (or omit for all)
app.get('/api/stock/sync', requireAuth, async (req, res) => {
  try {
    const token = await getToken();
    const hdrs = { Authorization: `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': CONFIG.subscriptionKey, Accept: 'application/json' };
    const { productId } = req.query;
    const url = productId ? `${BASE_URL}/Products/${productId}` : `${BASE_URL}/Products`;
    const r = await fetch(url, { headers: hdrs });
    const text = await r.text();
    if (!r.ok) throw new Error(`POGO ${r.status}: ${text.slice(0,200)}`);
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : (data?.data || [data]);
    res.json({ products: list.map(normalizeForClient) });
  } catch (err) {
    console.error('[Sync Error]', err.message);
    res.status(502).json({ error: err.message });
  }
});

function normalizeForClient(p) {
  const addr = p.MailAddress || {};
  return {
    ...p,
    id:                p.Id ?? p.id,
    name:              p.Name || p.name || '',
    code:              p.Code || p.code || '',
    description:       p.Description || p.description || '',
    productGroupName:  p.ProductGroupCode || p.ProductGroupName || '',
    costPrice:         p.UnitCost ?? p.CostPrice ?? null,
    salesPrice:        p.UnitPrice ?? p.SalesPrice ?? null,
    stockOnHand:       p.StockOnHand ?? p.stockOnHand ?? null,
    availableQuantity: p.StockAvailable ?? p.AvailableQuantity ?? null,
    unitOfMeasureType: p.UnitOfMeasureCode || p.UnitOfMeasureType || 'stk',
    isArchived:        p.IsArchived ?? false,
  };
}

// ── SharePoint: Godkjente leverandører ───────────────────────────────────────
// GET /api/sharepoint/approved-suppliers
//
// Henter listen med godkjente leverandører fra SharePoint via Microsoft Graph API.
// Konfigurasjon: sett SHAREPOINT_* variabler i server-konfig nedenfor.
//
// Microsoft Graph krever et Azure AD access token.
// Bruk app-registrasjon i Azure Portal med Site.Read.All eller Lists.Read tillatelse,
// eller bruk delegert token fra bruker-innlogging (MSAL).
//
// Quick setup uten Azure-app: bruk Power Automate HTTP-trigger som proxy
// (se kommentar i konfigurasjonen under).

const SP_CONFIG = {
  // Ambio AS SharePoint — https://ambioas.sharepoint.com/sites/Ambiokvalitetssystem
  tenantId:   process.env.SP_TENANT_ID   || 'ambioas.onmicrosoft.com',
  clientId:   process.env.SP_CLIENT_ID   || '',
  clientSecret: process.env.SP_CLIENT_SECRET || '',
  // Full site URL — serveren løser opp til site ID automatisk via Graph API
  siteId:     process.env.SP_SITE_ID     || 'https://ambioas.sharepoint.com/sites/Ambiokvalitetssystem',
  // Liste: intern URL-del er 'Leverandrer' men visningsnavnet er 'Leverandører'
  // Graph API bruker visningsnavnet eller intern ID
  listName:   process.env.SP_LIST_NAME   || 'Leverandører',
  // Exact internal column names from Power Automate debug log:
  // Status column is 'Godkjent' (Choice, returns {Value:'Godkjent'})
  statusColumn: process.env.SP_STATUS_COL || 'Godkjent',
  // Name column is 'Leverand_x00f8_rnavn' (SharePoint XML encoding of 'Leverandørnavn')
  nameColumn:   process.env.SP_NAME_COL   || 'Leverand_x00f8_rnavn',
  // «Organisasjonsnummer» er av type Tall
  orgNrColumn:  process.env.SP_ORGNR_COL  || 'Organisasjonsnummer',
  // Power Automate HTTP-trigger URL (enklest — lim inn her):
  powerAutomateUrl: process.env.SP_POWER_AUTOMATE_URL || '',
};

let spTokenCache = { token: null, expiry: 0 };

async function getSpToken() {
  if (spTokenCache.token && Date.now() < spTokenCache.expiry - 60000) return spTokenCache.token;
  if (!SP_CONFIG.tenantId || !SP_CONFIG.clientId || !SP_CONFIG.clientSecret) return null;

  const url = `https://login.microsoftonline.com/${SP_CONFIG.tenantId}/oauth2/v2.0/token`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     SP_CONFIG.clientId,
      client_secret: SP_CONFIG.clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    }),
  });
  if (!r.ok) throw new Error(`SP auth feilet: ${r.status}`);
  const d = await r.json();
  spTokenCache = { token: d.access_token, expiry: Date.now() + d.expires_in * 1000 };
  return d.access_token;
}

async function fetchSpList() {
  // Method 1: Power Automate HTTP trigger (enklest — ingen Azure-app nødvendig)
  if (SP_CONFIG.powerAutomateUrl) {
    // Power Automate HTTP triggers require POST (method defined in trigger setup)
    const r = await fetch(SP_CONFIG.powerAutomateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ action: 'getSuppliers' }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Power Automate feilet (${r.status}): ${txt.slice(0, 200)}`);
    }
    const data = await r.json();
    // Log first item to see actual field names from Power Automate
    const list = Array.isArray(data) ? data : (data?.value || data?.items || [data]);
    // Log confirmed field mapping
    console.log(`[SP] ${list.length} rader mottatt. Feltbekreftelse:`);
    list.slice(0, 3).forEach((x, i) => {
      const name = x['Leverand_x00f8_rnavn'] || '?';
      const godkjent = x['Godkjent'];
      const status = godkjent && typeof godkjent === 'object' ? godkjent.Value : godkjent;
      console.log(`[SP] Rad ${i+1}: navn="${name}", Godkjent="${status}"`);
    });
    return list;
  }

  // Method 2: Microsoft Graph API med app-registrasjon
  const token = await getSpToken();
  if (!token) throw new Error('SP_TENANT_ID, SP_CLIENT_ID og SP_CLIENT_SECRET må konfigureres (se README-SP.md)');

  // Resolve site ID if given as URL
  let siteId = SP_CONFIG.siteId;
  if (siteId.includes('sharepoint.com')) {
    const siteUrl = new URL(siteId);
    const siteRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteUrl.hostname}:${siteUrl.pathname}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!siteRes.ok) throw new Error(`Fant ikke SharePoint-nettsted: ${siteId}`);
    const siteData = await siteRes.json();
    siteId = siteData.id;
  }

  // Get list items with selected columns
  // Include extra useful columns for display in the app
  const cols = [
    SP_CONFIG.nameColumn,    // Leverandørnavn
    SP_CONFIG.statusColumn,  // Status
    SP_CONFIG.orgNrColumn,   // Organisasjonsnummer
    'Title',                 // Standard tittel-kolonne
    'Risikoniv_x00e5_',     // Risikonivå (SharePoint internal encoding)
    'Kritikalitet',
    'Tilknyttet_x0020_avdeling', // Tilknyttet avdeling
    'id',
  ].filter(Boolean).join(',');
  const listRes = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${encodeURIComponent(SP_CONFIG.listName)}/items?expand=fields(select=${cols})&$top=999`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!listRes.ok) {
    const t = await listRes.text();
    throw new Error(`SharePoint liste feilet (${listRes.status}): ${t.slice(0, 200)}`);
  }
  const data = await listRes.json();
  return data.value || [];
}

app.get('/api/sharepoint/approved-suppliers', requireAuth, async (req, res) => {
  try {
    const items = await fetchSpList();
    // Normalize to consistent shape regardless of column names
    const suppliers = items.map(item => {
      const f = item.fields || item; // Graph wraps in .fields, Power Automate may not
      // Try various field name formats (SharePoint encodes special chars)
      // Try every possible field name variant (Power Automate strips special chars)
      // Extract raw value — SP sometimes wraps in objects
      const extractStr = (val) => {
        if (!val) return '';
        if (typeof val === 'object') return val.Value || val.value || val.Label || '';
        return String(val);
      };
      // SP_CONFIG.nameColumn = 'Leverand_x00f8_rnavn' (confirmed from PA debug)
      const name = (
        extractStr(f['Leverand_x00f8_rnavn']) ||  // confirmed exact field name
        extractStr(f[SP_CONFIG.nameColumn]) ||     // config fallback
        extractStr(f['Leverandornavn']) ||         // without special chars
        extractStr(f.Title) || ''
      ).trim();

      // Organisasjonsnummer not present in PA response — name matching only
      const orgNr = String(
        f[SP_CONFIG.orgNrColumn] ||
        f['Organisasjonsnummer'] ||
        f['OrgNr'] || ''
      ).replace(/\s/g, '');

      // Status from 'Godkjent' column (Choice type) — returns {Value:'Godkjent'} object
      // confirmed field name: 'Godkjent' from PA debug log
      const rawStatus = f['Godkjent'] || f[SP_CONFIG.statusColumn] || null;
      const status = rawStatus && typeof rawStatus === 'object'
        ? (rawStatus.Value || rawStatus.value || null)
        : (rawStatus || null);
      return {
        id:        item.id || f.id,
        name,
        nameLower: name.toLowerCase().trim(),
        orgNr,
        orgNrClean: orgNr.replace(/\s/g, ''),
        approved:  isApproved(status),
        status,
        riskLevel: extractStr(f.Risikoniv_x00e5_ || f.Risikoniv || f.Risikonivå || null),
        criticality: extractStr(f.Kritikalitet || null),
        department: extractStr(f['Tilknyttet_x0020_avdeling'] || f['Tilknyttet avdeling'] || null),
        raw:       f,
      };
    });
    console.log(`[SP] ${suppliers.length} leverandører hentet fra SharePoint, ${suppliers.filter(s=>s.approved).length} godkjente`);
    res.json({ ok: true, suppliers, listName: SP_CONFIG.listName, configured: isSpConfigured() });
  } catch (err) {
    console.error('[SP Error]', err.message);
    res.status(502).json({ ok: false, error: err.message, configured: isSpConfigured() });
  }
});

// GET /api/sharepoint/config — returns current config status (no secrets)
app.get('/api/sharepoint/config', (req, res) => {
  res.json({
    configured: isSpConfigured(),
    listName:   SP_CONFIG.listName,
    statusColumn: 'Godkjent',                    // locked — PA internal name
    nameColumn:   'Leverand_x00f8_rnavn',        // locked — PA internal name
    orgNrColumn:  SP_CONFIG.orgNrColumn,
    hasPowerAutomateUrl: !!SP_CONFIG.powerAutomateUrl,
    hasTenantId:  !!SP_CONFIG.tenantId,
    hasClientId:  !!SP_CONFIG.clientId,
    _note: 'Kolonnenavn er låst til bekreftet Power Automate interne navn',
  });
});

// POST /api/sharepoint/config — update config at runtime (saves to env-like object)
// Path for persisting SP config
const SP_CONFIG_FILE = process.env.SP_CONFIG_PATH || path.join(__dirname, 'sharepoint-config.json');

function loadSpConfig() {
  try {
    if (fs.existsSync(SP_CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SP_CONFIG_FILE, 'utf8'));
      Object.assign(SP_CONFIG, saved);
      // Always override with confirmed correct field names from PA debug
      // Display name: "Status" — Internal PA name: "Godkjent"
      SP_CONFIG.nameColumn   = 'Leverand_x00f8_rnavn';
      SP_CONFIG.statusColumn = 'Godkjent';
      console.log('[SP] Konfigurasjon lastet — PA feltnavnene bekreftet: Leverand_x00f8_rnavn / Godkjent');
    }
  } catch(e) { console.error('[SP] Kunne ikke laste konfigurasjon:', e.message); }
}

function saveSpConfig() {
  try {
    // Don't save clientSecret to disk for security — keep in memory only
    const toSave = { ...SP_CONFIG, clientSecret: SP_CONFIG.clientSecret ? '***saved***' : '' };
    fs.writeFileSync(SP_CONFIG_FILE, JSON.stringify({
      tenantId: SP_CONFIG.tenantId,
      clientId: SP_CONFIG.clientId,
      siteId: SP_CONFIG.siteId,
      listName: SP_CONFIG.listName,
      statusColumn: SP_CONFIG.statusColumn,
      nameColumn: SP_CONFIG.nameColumn,
      orgNrColumn: SP_CONFIG.orgNrColumn,
      powerAutomateUrl: SP_CONFIG.powerAutomateUrl,
      // clientSecret excluded for security
    }, null, 2), 'utf8');
  } catch(e) { console.error('[SP] Kunne ikke lagre konfigurasjon:', e.message); }
}

// Load saved config on startup
loadSpConfig();

app.post('/api/sharepoint/config', (req, res) => {
  const { tenantId, clientId, clientSecret, siteId, listName, statusColumn, nameColumn, orgNrColumn, powerAutomateUrl } = req.body;
  if (tenantId !== undefined)         SP_CONFIG.tenantId           = tenantId;
  if (clientId !== undefined)         SP_CONFIG.clientId           = clientId;
  if (clientSecret !== undefined)     SP_CONFIG.clientSecret       = clientSecret;
  if (siteId !== undefined)           SP_CONFIG.siteId             = siteId;
  if (listName !== undefined)         SP_CONFIG.listName           = listName;
  if (statusColumn !== undefined)     SP_CONFIG.statusColumn       = statusColumn;
  if (nameColumn !== undefined)       SP_CONFIG.nameColumn         = nameColumn;
  if (orgNrColumn !== undefined)      SP_CONFIG.orgNrColumn        = orgNrColumn;
  if (powerAutomateUrl !== undefined) SP_CONFIG.powerAutomateUrl   = powerAutomateUrl;
  // Always use confirmed PA internal field names — do not allow override
  SP_CONFIG.nameColumn   = 'Leverand_x00f8_rnavn';
  SP_CONFIG.statusColumn = 'Godkjent';
  spTokenCache = { token: null, expiry: 0 };
  saveSpConfig();
  console.log('[SP] Konfigurasjon oppdatert — feltnavnene låst til: Leverand_x00f8_rnavn / Godkjent');
  res.json({ ok: true, configured: isSpConfigured() });
});

function isSpConfigured() {
  return !!(SP_CONFIG.powerAutomateUrl || (SP_CONFIG.tenantId && SP_CONFIG.clientId && SP_CONFIG.clientSecret && SP_CONFIG.siteId));
}

function isApproved(val) {
  if (val === null || val === undefined) return null; // ukjent
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val === 1;
  const s = String(val).toLowerCase().trim();
  // Godkjente verdier
  if (['ja', 'yes', 'godkjent', 'approved', 'true', '1', 'x', 'aktiv', 'active'].includes(s)) return true;
  // Avviste verdier
  if (['nei', 'no', 'ikke godkjent', 'not approved', 'false', '0', 'avvist', 'rejected', 'inaktiv', 'inactive', 'sperret', 'blocked'].includes(s)) return false;
  // Alt annet (f.eks. "Avventer", "Under vurdering") = ukjent
  return null;
}

// ── Health / status endpoint ──────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    await getToken();
    res.json({
      ok: true,
      client: 'Ambio AS',
      environment: CONFIG.useDemo ? 'demo' : 'production',
      clientId: CONFIG.clientId,
      tokenValid: Date.now() < tokenCache.expiry,
      tokenExpiresIn: Math.round((tokenCache.expiry - Date.now()) / 1000) + 's',
      db: getDbStats(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║   Ambio Innkjøp og varer — server         ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');
  console.log(`  → App:    http://localhost:${PORT}`);
  console.log(`  → Status: http://localhost:${PORT}/api/status`);
  console.log(`  → Env:    ${CONFIG.useDemo ? 'Demo (testmiljø)' : 'Produksjon'}`);
  console.log(`  → Client: Ambio AS (${CONFIG.clientId})`);
  console.log('');
});
