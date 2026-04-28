const express = require('express');
const cors = require('cors');
const path = require('path');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { EventEmitter } = require('events');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const accounts = {
  cuenta1: { name: 'Ventas Principal', sock: null, qr: null, status: 'disconnected', messages: [] },
  cuenta2: { name: 'Ventas Online', sock: null, qr: null, status: 'disconnected', messages: [] },
  cuenta3: { name: 'Posventa', sock: null, qr: null, status: 'disconnected', messages: [] },
};

async function createWAAccount(accountId, onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(`sessions/${accountId}`);
  const { version } = await fetchLatestBaileysVersion();
  const qrEmitter = new EventEmitter();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['WA Manager', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrEmitter.emit('qr', qr);
    if (connection === 'open') qrEmitter.emit('connected');
    if (connection === 'close') {
      qrEmitter.emit('disconnected');
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut)
        setTimeout(() => createWAAccount(accountId, onMessage), 5000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;
      await onMessage({ from: msg.key.remoteJid, pushName: msg.pushName, text });
    }
  });
  return { sock, qrEmitter };
}

async function askAI(userMessage, accountName) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      system: (process.env.AI_INSTRUCTIONS || 'Sos asistente de atención al cliente de una empresa de venta de productos. Respondé amable y brevemente en español argentino.') + ` Cuenta: ${accountName}.`,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const d = await res.json();
  return d.content[0].text;
}

function classifyPriority(text = '') {
  const t = text.toLowerCase();
  if (/urgente|problema|rapido|error/.test(t)) return 'high';
  if (/precio|comprar|stock|quiero|cuotas/.test(t)) return 'high';
  if (/consulta|info|envio|como|cuando/.test(t)) return 'medium';
  return 'low';
}

async function initAccount(id) {
  const { sock, qrEmitter } = await createWAAccount(id, async (msg) => {
    accounts[id].messages.unshift({ id: Date.now(), from: msg.from, name: msg.pushName || msg.from, text: msg.text, time: new Date().toISOString(), direction: 'in', priority: classifyPriority(msg.text) });
    if (accounts[id].messages.length > 100) accounts[id].messages.pop();
    if (process.env.AI_AUTO_REPLY === 'true') {
      try {
        const reply = await askAI(msg.text, accounts[id].name);
        await sock.sendMessage(msg.from, { text: reply });
        accounts[id].messages.unshift({ id: Date.now()+1, from: 'me', name: 'IA', text: reply, time: new Date().toISOString(), direction: 'out', aiGenerated: true });
      } catch(e) { console.error('[AI]', e.message); }
    }
  });
  accounts[id].sock = sock;
  qrEmitter.on('qr', qr => { accounts[id].qr = qr; accounts[id].status = 'qr_pending'; });
  qrEmitter.on('connected', () => { accounts[id].status = 'connected'; accounts[id].qr = null; });
  qrEmitter.on('disconnected', () => { accounts[id].status = 'disconnected'; });
}

app.get('/api/status', (req, res) => {
  const r = {};
  for (const [id, acc] of Object.entries(accounts)) r[id] = { name: acc.name, status: acc.status, hasQR: !!acc.qr, messageCount: acc.messages.length };
  res.json(r);
});
app.get('/api/qr/:id', (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'No encontrada' });
  res.json({ qr: acc.qr, status: acc.status });
});
app.get('/api/messages/:id', (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'No encontrada' });
  res.json(acc.messages);
});
app.post('/api/send', async (req, res) => {
  const { accountId, to, message } = req.body;
  const acc = accounts[accountId];
  if (!acc?.sock) return res.status(400).json({ error: 'No conectada' });
  try {
    await acc.sock.sendMessage(to.includes('@') ? to : `${to}@s.whatsapp.net`, { text: message });
    acc.messages.unshift({ id: Date.now(), from: 'me', name: 'Vos', text: message, time: new Date().toISOString(), direction: 'out' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai/draft', async (req, res) => {
  try { res.json({ draft: await askAI(req.body.message, req.body.accountName) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/broadcast', async (req, res) => {
  const { accountId, contacts, message } = req.body;
  const acc = accounts[accountId] || Object.values(accounts)[0];
  if (!acc?.sock) return res.status(400).json({ error: 'No conectada' });
  let sent = 0; const errors = [];
  for (const c of contacts) {
    try { await acc.sock.sendMessage(c.includes('@') ? c : `${c}@s.whatsapp.net`, { text: message }); sent++; await new Promise(r=>setTimeout(r,1500)); }
    catch(e) { errors.push({ c, error: e.message }); }
  }
  res.json({ sent, errors, total: contacts.length });
});
app.post('/api/config', (req, res) => {
  if (req.body.aiAutoReply !== undefined) process.env.AI_AUTO_REPLY = String(req.body.aiAutoReply);
  if (req.body.instructions) process.env.AI_INSTRUCTIONS = req.body.instructions;
  res.json({ ok: true });
});

(async () => {
  for (const id of Object.keys(accounts)) { await initAccount(id); await new Promise(r=>setTimeout(r,2000)); }
  app.listen(process.env.PORT || 3000, () => console.log('✅ WA Manager corriendo!'));
})();
