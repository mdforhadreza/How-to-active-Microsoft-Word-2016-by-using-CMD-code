'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 96 * 1024;
const MAX_MESSAGES_PER_PAIR = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LONG_POLL_MS = 25000;

const channels = new Map();
let counter = 0;

function headers() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...headers(), 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function validPairId(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validPayload(value) {
  return typeof value === 'string' && value.length > 20 && value.length <= 90000 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function getChannel(pairId) {
  let channel = channels.get(pairId);
  if (!channel) {
    channel = { messages: [], waiters: new Set() };
    channels.set(pairId, channel);
  }
  return channel;
}

function cleanupChannel(channel) {
  const cutoff = Date.now() - MAX_AGE_MS;
  channel.messages = channel.messages.filter(m => m.createdAt >= cutoff);
  if (channel.messages.length > MAX_MESSAGES_PER_PAIR) {
    channel.messages.splice(0, channel.messages.length - MAX_MESSAGES_PER_PAIR);
  }
}

function messagesAfter(channel, after) {
  cleanupChannel(channel);
  return channel.messages.filter(m => m.id > after).map(({ id, payload }) => ({ id, payload }));
}

function notifyWaiters(channel) {
  for (const waiter of Array.from(channel.waiters)) {
    const items = messagesAfter(channel, waiter.after);
    if (items.length > 0) {
      clearTimeout(waiter.timer);
      channel.waiters.delete(waiter);
      if (!waiter.res.writableEnded) send(waiter.res, 200, { messages: items });
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'my-love-relay' });
  }

  if (req.method === 'POST' && url.pathname === '/api/push') {
    try {
      const body = await readJson(req);
      if (!validPairId(body.pairId) || !validPayload(body.payload)) {
        return send(res, 400, { error: 'invalid request' });
      }
      const channel = getChannel(body.pairId);
      const id = Date.now() * 1000 + (counter++ % 1000);
      channel.messages.push({ id, payload: body.payload, createdAt: Date.now() });
      cleanupChannel(channel);
      notifyWaiters(channel);
      return send(res, 202, { accepted: true, id });
    } catch (e) {
      return send(res, 400, { error: 'invalid request' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/pull') {
    const pairId = url.searchParams.get('pairId') || '';
    const afterRaw = url.searchParams.get('after') || '0';
    const after = Number(afterRaw);
    if (!validPairId(pairId) || !Number.isSafeInteger(after) || after < 0) {
      return send(res, 400, { error: 'invalid request' });
    }

    const channel = getChannel(pairId);
    const immediate = messagesAfter(channel, after);
    if (immediate.length > 0) return send(res, 200, { messages: immediate });

    const waiter = { after, res, timer: null };
    waiter.timer = setTimeout(() => {
      channel.waiters.delete(waiter);
      if (!res.writableEnded) send(res, 200, { messages: [] });
    }, LONG_POLL_MS);
    channel.waiters.add(waiter);

    res.on('close', () => {
      clearTimeout(waiter.timer);
      channel.waiters.delete(waiter);
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`My Love relay listening on port ${PORT}`);
});
