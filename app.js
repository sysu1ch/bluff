const joinForm = document.querySelector('#join-form');
const nicknameInput = document.querySelector('#nickname');
const roomInput = document.querySelector('#room');
const errorMessage = document.querySelector('#error-message');
const joinCard = document.querySelector('#join-card');
const roomCard = document.querySelector('#room-card');
const roomTitle = document.querySelector('#room-title');
const welcomeMessage = document.querySelector('#welcome-message');
const connectionStatus = document.querySelector('#connection-status');
const membersList = document.querySelector('#members');
const messagesBox = document.querySelector('#messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const leaveButton = document.querySelector('#leave-btn');

const state = {
  nickname: '',
  room: '',
  token: '',
  since: 0,
  pollingTimer: null,
  pingTimer: null,
  retryMs: 1200,
  connected: false,
};

function setConnection(ok, text) {
  state.connected = ok;
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle('status-ok', ok);
  connectionStatus.classList.toggle('status-bad', !ok);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderMembers(members) {
  membersList.innerHTML = members.map((name) => `<li>${escapeHtml(name)}</li>`).join('');
}

function appendMessage(event) {
  const container = document.createElement('div');
  container.className = 'msg';
  const time = new Date(event.timestamp).toLocaleTimeString();
  container.innerHTML = `<time>${time}</time>${escapeHtml(event.text)}`;
  messagesBox.appendChild(container);
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

async function poll() {
  if (!state.token) {
    return;
  }

  try {
    const query = new URLSearchParams({ room: state.room, since: String(state.since) });
    const response = await fetch(`/api/events?${query.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || '同步失败');
    }

    setConnection(true, '连接稳定');
    state.retryMs = 1200;
    state.since = data.lastEventId;
    renderMembers(data.members);

    for (const event of data.events) {
      appendMessage(event);
    }
  } catch (error) {
    setConnection(false, `连接波动，${state.retryMs / 1000}s 后重试`);
    state.retryMs = Math.min(state.retryMs * 1.5, 6000);
  } finally {
    state.pollingTimer = window.setTimeout(poll, state.retryMs);
  }
}

async function ping() {
  if (!state.token) {
    return;
  }

  try {
    await postJson('/api/ping', { room: state.room, token: state.token });
  } catch {
    // 交给轮询重试和状态提示
  } finally {
    state.pingTimer = window.setTimeout(ping, 15000);
  }
}

function clearSessionTimers() {
  if (state.pollingTimer) {
    clearTimeout(state.pollingTimer);
    state.pollingTimer = null;
  }
  if (state.pingTimer) {
    clearTimeout(state.pingTimer);
    state.pingTimer = null;
  }
}

async function leaveRoom() {
  clearSessionTimers();

  if (state.token) {
    try {
      await postJson('/api/leave', { room: state.room, token: state.token });
    } catch {
      // 页面切换时忽略离线失败
    }
  }

  state.nickname = '';
  state.room = '';
  state.token = '';
  state.since = 0;
  state.retryMs = 1200;
  setConnection(true, '连接稳定');

  messagesBox.innerHTML = '';
  membersList.innerHTML = '';
  chatInput.value = '';
  joinCard.classList.remove('hidden');
  roomCard.classList.add('hidden');
}

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const nickname = nicknameInput.value.trim();
  const room = roomInput.value.trim();

  if (!nickname || !room) {
    errorMessage.textContent = '请输入昵称和房间号后再进入。';
    return;
  }

  try {
    const result = await postJson('/api/join', { nickname, room });

    errorMessage.textContent = '';
    state.nickname = nickname;
    state.room = room;
    state.token = result.token;
    state.since = 0;

    roomTitle.textContent = `房间：${room}`;
    welcomeMessage.textContent = `你好，${nickname}！你已进入局域网房间。`;

    joinCard.classList.add('hidden');
    roomCard.classList.remove('hidden');

    messagesBox.innerHTML = '';
    poll();
    ping();
  } catch (error) {
    errorMessage.textContent = error.message;
  }
});

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !state.token) {
    return;
  }

  try {
    await postJson('/api/message', { room: state.room, token: state.token, text });
    chatInput.value = '';
    chatInput.focus();
  } catch (error) {
    setConnection(false, '发送失败，正在恢复连接');
  }
});

leaveButton.addEventListener('click', () => {
  leaveRoom();
});

window.addEventListener('beforeunload', () => {
  if (!state.token) {
    return;
  }

  navigator.sendBeacon(
    '/api/leave',
    new Blob([JSON.stringify({ room: state.room, token: state.token })], {
      type: 'application/json',
    })
  );
});
