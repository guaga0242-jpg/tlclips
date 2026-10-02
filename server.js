import express from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, list, put } from '@vercel/blob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PIX_KEY = process.env.PIX_KEY || '12664442465';
const MP_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PRODUCTS_FILE = path.join(__dirname, 'data', 'products.json');
const ORDERS_PATH = 'tlclips/orders.json';

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const productCatalog = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));

function cleanText(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function normalizeCustomer(raw = {}) {
  return {
    name: cleanText(raw.name, 100),
    email: cleanText(raw.email, 140).toLowerCase(),
    phone: cleanText(raw.phone, 30),
    cep: cleanText(raw.cep, 12),
    street: cleanText(raw.street, 120),
    number: cleanText(raw.number, 20),
    complement: cleanText(raw.complement, 80),
    district: cleanText(raw.district, 80),
    city: cleanText(raw.city, 80),
    state: cleanText(raw.state, 2).toUpperCase()
  };
}

function validateCustomer(c) {
  if (!c.name || c.name.length < 2) return 'Informe seu nome.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) return 'Informe um e-mail válido.';
  if (!c.phone || c.phone.length < 8) return 'Informe um telefone/WhatsApp.';
  if (!c.cep || !c.street || !c.number || !c.city || !c.state) return 'Preencha o endereço de entrega.';
  return null;
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

function newOrderId() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `TLC-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function calculateCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('Carrinho vazio.');
  const result = [];
  let subtotal = 0;

  for (const raw of rawItems.slice(0, 30)) {
    const id = cleanText(raw.id, 80);
    const qty = Math.max(1, Math.min(10, Number.parseInt(raw.qty, 10) || 1));
    const product = productCatalog.find(p => p.id === id);
    if (!product) throw new Error(`Produto inválido: ${id}`);
    if (qty > product.stock) throw new Error(`Estoque insuficiente para ${product.name}.`);
    const lineTotal = money(product.price * qty);
    subtotal = money(subtotal + lineTotal);
    result.push({ id: product.id, name: product.name, unitPrice: product.price, qty, lineTotal });
  }

  const shipping = subtotal >= 299 ? 0 : 19.90;
  return { items: result, subtotal, shipping, total: money(subtotal + shipping) };
}

function hasBlobStore() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.VERCEL_OIDC_TOKEN);
}

async function readOrders() {
  if (!hasBlobStore()) return [];
  const { blobs } = await list({ prefix: ORDERS_PATH, limit: 20 });
  const blob = blobs.find(b => b.pathname === ORDERS_PATH);
  if (!blob) return [];
  const result = await get(blob.url, { access: 'private' });
  if (!result) return [];
  const text = await new Response(result.stream).text();
  try { return JSON.parse(text); } catch { return []; }
}

async function saveOrders(orders) {
  if (!hasBlobStore()) throw new Error('Armazenamento de pedidos ainda não está conectado.');
  await put(ORDERS_PATH, JSON.stringify(orders, null, 2), {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json'
  });
}

async function createOrder({ cart, customer, paymentMethod }) {
  const all = await readOrders();
  const now = new Date().toISOString();
  const order = {
    id: newOrderId(),
    createdAt: now,
    updatedAt: now,
    status: paymentMethod === 'pix_manual' ? 'awaiting_pix' : 'awaiting_payment',
    paymentMethod,
    paymentStatus: 'pending',
    customer,
    ...cart
  };
  all.unshift(order);
  await saveOrders(all);
  return order;
}

async function patchOrder(id, patch) {
  const all = await readOrders();
  const index = all.findIndex(o => o.id === id);
  if (index < 0) return null;
  all[index] = { ...all[index], ...patch, updatedAt: new Date().toISOString() };
  await saveOrders(all);
  return all[index];
}

function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    items: order.items,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    customer: { name: order.customer?.name || '', city: order.customer?.city || '', state: order.customer?.state || '' }
  };
}

function adminGuard(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Painel administrativo ainda não foi ativado. Configure ADMIN_KEY no Vercel.' });
  const key = req.get('x-admin-key') || '';
  const a = Buffer.from(key);
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Chave de administrador inválida.' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, store: 'TLClips', storage: hasBlobStore() ? 'connected' : 'missing' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, store: 'TLClips', storage: hasBlobStore() ? 'connected' : 'missing' }));

app.get('/api/products', (_req, res) => {
  res.json(productCatalog.map(p => ({ ...p })));
});

app.post('/api/orders/pix', async (req, res) => {
  try {
    if (!hasBlobStore()) return res.status(503).json({ error: 'A loja ainda está finalizando a configuração do armazenamento de pedidos.' });
    const customer = normalizeCustomer(req.body.customer);
    const error = validateCustomer(customer);
    if (error) return res.status(400).json({ error });
    const cart = calculateCart(req.body.items);
    const order = await createOrder({ cart, customer, paymentMethod: 'pix_manual' });
    res.status(201).json({
      order: publicOrder(order),
      pix: { key: PIX_KEY, amount: order.total, instructions: 'Faça o Pix no valor exato e guarde o comprovante.' }
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Não foi possível criar o pedido.' });
  }
});

app.post('/api/checkout/mercadopago', async (req, res) => {
  let order;
  try {
    if (!MP_TOKEN) return res.status(503).json({ error: 'Mercado Pago ainda não está ativado. Use Pix ou configure a integração.' });
    if (!hasBlobStore()) return res.status(503).json({ error: 'Armazenamento de pedidos ainda não está conectado.' });
    const customer = normalizeCustomer(req.body.customer);
    const error = validateCustomer(customer);
    if (error) return res.status(400).json({ error });
    const cart = calculateCart(req.body.items);
    order = await createOrder({ cart, customer, paymentMethod: 'mercadopago' });

    const items = cart.items.map(item => ({ id: item.id, title: item.name, quantity: item.qty, currency_id: 'BRL', unit_price: item.unitPrice }));
    if (cart.shipping > 0) items.push({ id: 'shipping', title: 'Frete', quantity: 1, currency_id: 'BRL', unit_price: cart.shipping });
    const base = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
    const preference = {
      items,
      payer: { name: customer.name, email: customer.email },
      external_reference: order.id,
      back_urls: {
        success: `${base}/pedido.html?id=${encodeURIComponent(order.id)}&return=success`,
        pending: `${base}/pedido.html?id=${encodeURIComponent(order.id)}&return=pending`,
        failure: `${base}/pedido.html?id=${encodeURIComponent(order.id)}&return=failure`
      },
      auto_return: 'approved',
      notification_url: `${base}/api/webhooks/mercadopago`,
      metadata: { order_id: order.id }
    };

    const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(preference)
    });
    const data = await mp.json();
    if (!mp.ok || !data.init_point) {
      await patchOrder(order.id, { status: 'checkout_error', paymentStatus: 'error' });
      return res.status(502).json({ error: 'O Mercado Pago não conseguiu criar o checkout.' });
    }
    await patchOrder(order.id, { status: 'checkout_created', mercadoPagoPreferenceId: data.id });
    res.status(201).json({ orderId: order.id, checkoutUrl: data.init_point });
  } catch (e) {
    if (order?.id) await patchOrder(order.id, { status: 'checkout_error', paymentStatus: 'error' });
    res.status(500).json({ error: 'Erro ao criar checkout.', details: e.message });
  }
});

app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200);
  try {
    if (!MP_TOKEN || !hasBlobStore()) return;
    const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;
    if (!paymentId) return;
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
    if (!response.ok) return;
    const payment = await response.json();
    const orderId = payment.external_reference || payment.metadata?.order_id;
    if (!orderId) return;
    const statusMap = { approved: 'paid', pending: 'awaiting_payment', in_process: 'awaiting_payment', rejected: 'payment_rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'charged_back' };
    await patchOrder(orderId, {
      status: statusMap[payment.status] || 'awaiting_payment',
      paymentStatus: payment.status || 'unknown',
      mercadoPagoPaymentId: String(payment.id || paymentId),
      ...(payment.status === 'approved' ? { paidAt: new Date().toISOString() } : {})
    });
  } catch (e) {
    console.error('Webhook Mercado Pago:', e.message);
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = (await readOrders()).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(publicOrder(order));
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível consultar o pedido.' });
  }
});

app.get('/api/admin/orders', adminGuard, async (_req, res) => {
  try { res.json(await readOrders()); }
  catch { res.status(500).json({ error: 'Não foi possível carregar os pedidos.' }); }
});

app.post('/api/admin/orders/:id/mark-paid', adminGuard, async (req, res) => {
  try {
    const order = (await readOrders()).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (order.paymentMethod !== 'pix_manual') return res.status(400).json({ error: 'Confirmação manual disponível apenas para Pix manual.' });
    res.json(await patchOrder(order.id, { status: 'paid', paymentStatus: 'approved_manual', paidAt: new Date().toISOString() }));
  } catch { res.status(500).json({ error: 'Não foi possível confirmar o pedido.' }); }
});

app.post('/api/admin/orders/:id/cancel', adminGuard, async (req, res) => {
  try {
    const order = (await readOrders()).find(o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(await patchOrder(order.id, { status: 'cancelled', paymentStatus: order.paymentStatus === 'approved' ? order.paymentStatus : 'cancelled' }));
  } catch { res.status(500).json({ error: 'Não foi possível cancelar o pedido.' }); }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Rota não encontrada.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => console.log(`TLClips rodando em http://localhost:${PORT}`));
}

export default app;
