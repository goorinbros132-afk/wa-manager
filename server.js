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
  const instructions = process.env.AI_INSTRUCTIONS || 'Sos un asistente de atención al cliente de una empresa de venta de productos. Respondé de forma amable y profesional en español argentino. Máximo 3 oraciones.';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 300,
      messages: [
        { role: 'system', content: `${instructions} Cuenta: ${accountName}.` },
        { role: 'user', content: userMessage }
      ]
    })
  });
  const d = await res.json();
  return d.choices[0].message.content;
}

function classifyPriority(text = '') {
  const t = text.toLowerCase();
  if (/urgente|problema|rapido|error/.test(t)) return 'high';
  if (/precio|comprar|stock|quiero|cuotas/.test(t)) return 'high';
  if (/consulta|info|envio|como|cuando/.test(t)) return 'medium';
  return 'low';
}

async function initAccount(id) {
