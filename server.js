const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const rooms = new Map();

function now() {
  return Date.now();
}

function getRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      users: new Map(),
      events: [],
      nextEventId: 1,
    });
  }
  return rooms.get(roomName);
}

function addEvent(room, text) {
  room.events.push({
    id: room.nextEventId++,
    text,
    timestamp: now(),
  });

  if (room.events.length > 600) {
    room.events.splice(0, room.events.length - 600);
  }
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';

    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
      }
    });

    req.on('end', () => {
      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });

    req.on('error', reject);
  });
}

function cleanupInactiveUsers() {
  const expireMs = 90000;
  const current = now();

  for (const [roomName, room] of rooms.entries()) {
    for (const [token, user] of room.users.entries()) {
      if (current - user.lastSeen > expireMs) {
        room.users.delete(token);
        addEvent(room, `系统：${user.nickname} 因超时离线`);
      }
    }

    if (room.users.size === 0 && room.events.length === 0) {
      rooms.delete(roomName);
    }
  }
}

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await parseBody(req);
    const nickname = String(body.nickname || '').trim();
    const roomName = String(body.room || '').trim();

    if (!nickname || !roomName) {
      json(res, 400, { error: '昵称和房间号不能为空' });
      return;
    }

    const room = getRoom(roomName);
    const token = randomUUID();

    room.users.set(token, { nickname, lastSeen: now() });
    addEvent(room, `系统：${nickname} 加入了房间`);

    json(res, 200, { token });
    return;
  }

  if (pathname === '/api/leave' && req.method === 'POST') {
    const body = await parseBody(req);
    const roomName = String(body.room || '').trim();
    const token = String(body.token || '').trim();
    const room = rooms.get(roomName);

    if (room && token && room.users.has(token)) {
      const nickname = room.users.get(token).nickname;
      room.users.delete(token);
      addEvent(room, `系统：${nickname} 离开了房间`);
    }

    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/ping' && req.method === 'POST') {
    const body = await parseBody(req);
    const roomName = String(body.room || '').trim();
    const token = String(body.token || '').trim();
    const room = rooms.get(roomName);

    if (!room || !room.users.has(token)) {
      json(res, 404, { error: '会话不存在' });
      return;
    }

    room.users.get(token).lastSeen = now();
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/message' && req.method === 'POST') {
    const body = await parseBody(req);
    const roomName = String(body.room || '').trim();
    const token = String(body.token || '').trim();
    const text = String(body.text || '').trim();
    const room = rooms.get(roomName);

    if (!room || !room.users.has(token)) {
      json(res, 404, { error: '会话不存在' });
      return;
    }

    if (!text) {
      json(res, 400, { error: '消息不能为空' });
      return;
    }

    const nickname = room.users.get(token).nickname;
    room.users.get(token).lastSeen = now();
    addEvent(room, `${nickname}：${text.slice(0, 120)}`);

    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    const roomName = String(searchParams.get('room') || '').trim();
    const since = Number(searchParams.get('since') || 0);
    const room = rooms.get(roomName);

    if (!room) {
      json(res, 200, { members: [], events: [], lastEventId: since || 0 });
      return;
    }

    const events = room.events.filter((event) => event.id > since);
    const members = Array.from(room.users.values()).map((item) => item.nickname);

    json(res, 200, {
      members,
      events,
      lastEventId: room.nextEventId - 1,
    });
    return;
  }

  json(res, 404, { error: 'API 不存在' });
}

function safeFilePath(pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;

  if (filePath.includes('..')) {
    return '';
  }

  return path.join(ROOT, filePath);
}

function serveStatic(res, pathname) {
  const filePath = safeFilePath(pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const ext = path.extname(filePath);
    const type = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  cleanupInactiveUsers();

  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url, `http://${host}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url.pathname, url.searchParams);
      return;
    }

    serveStatic(res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message || '服务器错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`局域网联机服务已启动: http://0.0.0.0:${PORT}`);
});
