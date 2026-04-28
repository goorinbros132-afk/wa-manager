const express = require('express');
const cors = require('cors');
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
  const { state, saveCreds } = await useMultiFileAuthState('sessions/' + accountId);
  const { version } = await fetchLatestBaileysVersion();
  const qrEmitter = new EventEmitter();
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['WA Manager', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', function(update) {
    const connection = update.connection;
    const lastDisconnect = update.lastDisconnect;
    const qr = update.qr;
    if (qr) qrEmitter.emit('qr', qr);
    if (connection === 'open') qrEmitter.emit('connected');
    if (connection === 'close') {
      qrEmitter.emit('disconnected');
      const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(function() { createWAAccount(accountId, onMessage); }, 5000);
    }
  });
  sock.ev.on('messages.upsert', async function(data) {
    if (data.type !== 'notify') return;
    for (const msg of data.messages) {
      if (msg.key.fromMe) continue;
      const text = (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) || '';
      if (!text) continue;
      await onMessage({ from: msg.key.remoteJid, pushName: msg.pushName, text: text });
    }
  });
  return { sock: sock, qrEmitter: qrEmitter };
}
async function askAI(userMessage, accountName) {
  const instructions = process.env.AI_INSTRUCTIONS || 'Sos asistente de atencion al cliente de una empresa de venta de productos. Responde amable y brevemente en español.';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model: 'llama3-8b-8192', max_tokens: 200, messages: [{ role: 'system', content: instructions + ' Cuenta: ' + accountName }, { role: 'user', content: userMessage }] })
  });
  const d = await res.json();
  return d.choices[0].message.content;
}
function classifyPriority(text) {
  text = text || '';
  const t = text.toLowerCase();
  if (/urgente|problema|rapido|error/.test(t)) return 'high';
  if (/precio|comprar|stock|quiero|cuotas/.test(t)) return 'high';
  if (/consulta|info|envio|como|cuando/.test(t)) return 'medium';
  return 'low';
}
async function initAccount(id) {
  const result = await createWAAccount(id, async function(msg) {
    accounts[id].messages.unshift({ id: Date.now(), from: msg.from, name: msg.pushName || msg.from, text: msg.text, time: new Date().toISOString(), direction: 'in', priority: classifyPriority(msg.text) });
    if (accounts[id].messages.length > 100) accounts[id].messages.pop();
    if (process.env.AI_AUTO_REPLY === 'true') {
      try {
        const reply = await askAI(msg.text, accounts[id].name);
        await result.sock.sendMessage(msg.from, { text: reply });
        accounts[id].messages.unshift({ id: Date.now() + 1, from: 'me', name: 'IA', text: reply, time: new Date().toISOString(), direction: 'out', aiGenerated: true });
      } catch(e) { console.error('[AI]', e.message); }
    }
  });
  accounts[id].sock = result.sock;
  result.qrEmitter.on('qr', function(qr) { accounts[id].qr = qr; accounts[id].status = 'qr_pending'; });
  result.qrEmitter.on('connected', function() { accounts[id].status = 'connected'; accounts[id].qr = null; });
  result.qrEmitter.on('disconnected', function() { accounts[id].status = 'disconnected'; });
}
app.get('/api/status', function(req, res) {
  const r = {};
  for (const id in accounts) { r[id] = { name: accounts[id].name, status: accounts[id].status, hasQR: !!accounts[id].qr, messageCount: accounts[id].messages.length }; }
  res.json(r);
});
app.get('/api/qr/:id', function(req, res) {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'No encontrada' });
  res.json({ qr: acc.qr, status: acc.status
