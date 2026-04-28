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
  sock.ev.on('connection.update', function(u) {
    if (u.qr) qrEmitter.emit('qr', u.qr);
    if (u.connection === 'open') qrEmitter.emit('connected');
    if (u.connection === 'close') {
      qrEmitter.emit('disconnected');
      var code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(function() { createWAAccount(accountId, onMessage); }, 5000);
    }
  });
  sock.ev.on('messages.upsert', async function(data) {
    if (data.type !== 'notify') return;
    for (var i = 0; i < data.messages.length; i++) {
      var msg = data.messages[i];
      if (msg.key.fromMe) continue;
      var text = (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) || '';
      if (!text) continue;
      await onMessage({ from: msg.key.remoteJid, pushName: msg.pushName, text: text });
    }
  });
  return { sock: sock, qrEmitter: qrEmitter };
}
async function askAI(msg, acct) {
  var inst = process.env.AI_INSTRUCTIONS || 'Sos asistente de atencion al cliente. Responde amable y brevemente en español.';
  var res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({ model: 'llama3-8b-8192', max_tokens: 200, messages: [{ role: 'system', content: inst + ' Cuenta: ' + acct }, { role: 'user', content: msg }] })
  });
  var d = await res.json();
  return d.choices[0].message.content;
}
function priority(text) {
  var t = (text || '').toLowerCase();
  if (/urgente|problema|error/.test(t)) return 'high';
  if (/precio|comprar|stock|quiero/.test(t)) return 'high';
  if (/consulta|envio|como|cuando/.test(t)) return 'medium';
  return 'low';
}
async function initAccount(id) {
  var wa = await createWAAccount(id, async function(msg) {
    accounts[id].messages.unshift({ id: Date.now(), from: msg.from, name: msg.pushName || msg.from, text: msg.text, time: new Date().toISOString(), direction: 'in', priority: priority(msg.text) });
    if (accounts[id].messages.length > 100) accounts[id].messages.pop();
    if (process.env.AI_AUTO_REPLY === 'true') {
      try {
        var reply = await askAI(msg.text, accounts[id].name);
        await wa.sock.sendMessage(msg.from, { text: reply });
        accounts[id].messages.unshift({ id: Date.now() + 1, from: 'me', name: 'IA', text: reply, time: new Date().toISOString(), direction: 'out', aiGenerated: true });
      } catch(e) { console.error('[AI]', e.message); }
    }
  });
  accounts[id].sock = wa.sock;
  wa.qrEmitter.on('qr', function(qr) { accounts[id].qr = qr; accounts[id].status = 'qr_pending'; });
  wa.qrEmitter.on('connected', function() { accounts[id].status = 'connected'; accounts[id].qr = null; });
  wa.qrEmitter.on('disconnected', function() { accounts[id].status = 'disconnected'; });
}
app.get('/api/status', function(req, res) {
  var r = {};
  for (var id in accounts) r[id] = { name: accounts[id].name, status: accounts[id].status, hasQR: !!accounts[id].qr, messageCount: accounts[id].messages.length };
  res.json(r);
});
app.get('/api/qr/:id', function(req, res) {
  var acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'No encontrada' });
  res.json({ qr: acc.qr, status: acc.status });
});
app.get('/api/messages/:id', function(req, res) {
  var acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'No encontrada' });
  res.json(acc.messages);
});
app.post('/api/send', async function(req, res) {
  var acc = accounts[req.body.accountId];
  if (!acc || !acc.sock) return res.status(400).json({ error: 'No conectada' });
  try {
    var jid = req.body.to.includes('@') ? req.body.to : req.body.to + '@s.whatsapp.net';
    await acc.sock.sendMessage(jid, { text: req.body.message });
    acc.messages.unshift({ id: Date.now(), from: 'me', name: 'Vos', text: req.body.message, time: new Date().toISOString(), direction: 'out' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai/draft', async function(req, res) {
  try { res.json({ draft: await askAI(req.body.message, req.body.accountName) }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/broadcast', async function(req, res) {
  var acc = accounts[req.body.accountId] || Object.values(accounts)[0];
  if (!acc || !acc.sock) return res.status(400).json({ error: 'No conectada' });
  var sent = 0; var errors = [];
  for (var i = 0; i < req.body.contacts.length; i++) {
    try {
      var jid = req.body.contacts[i].includes('@') ? req.body.contacts[i] : req.body.contacts[i] + '@s.whatsapp.net';
      await acc.sock.sendMessage(jid, { text: req.body.message });
      sent++;
      await new Promise(function(r) { setTimeout(r, 1500); });
    } catch(e) { errors.push(e.message); }
  }
  res.json({ sent: sent, errors: errors, total: req.body.contacts.length });
});
app.post('/api/config', function(req, res) {
  if (req.body.aiAutoReply !== undefined) process.env.AI_AUTO_REPLY = String(req.body.aiAutoReply);
  if (req.body.instructions) process.env.AI_INSTRUCTIONS = req.body.instructions;
  res.json({ ok: true });
});
async function main() {
  for (var id in accounts) {
    await initAccount(id);
    await new Promise(function(r) { setTimeout(r, 2000); });
  }
  var PORT = process.env.PORT || 3000;
  app.listen(PORT, function() { console.log('WA Manager en puerto ' + PORT); });
}
main();
