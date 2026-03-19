const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const NAME_STORAGE_KEY = "hu-pai-name";

const state = {
  room: null,
  selectedCards: new Set(),
  countdownTimer: null,
  seenEventIds: new Set(),
  eventQueue: [],
  activeEventTimer: null,
  activeEventId: null,
  dismissedResultKey: null,
  activeResultKey: null,
};

const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

const elements = {
  lobbyView: document.getElementById("lobbyView"),
  roomView: document.getElementById("roomView"),
  createForm: document.getElementById("createForm"),
  joinForm: document.getElementById("joinForm"),
  createName: document.getElementById("createName"),
  joinName: document.getElementById("joinName"),
  maxPlayers: document.getElementById("maxPlayers"),
  roomCode: document.getElementById("roomCode"),
  roomTitle: document.getElementById("roomTitle"),
  maxPlayersLabel: document.getElementById("maxPlayersLabel"),
  tableCount: document.getElementById("tableCount"),
  currentRank: document.getElementById("currentRank"),
  playersList: document.getElementById("playersList"),
  lastActionText: document.getElementById("lastActionText"),
  resolutionText: document.getElementById("resolutionText"),
  turnText: document.getElementById("turnText"),
  pileCards: document.getElementById("pileCards"),
  leaveRoomBtn: document.getElementById("leaveRoomBtn"),
  surrenderBtn: document.getElementById("surrenderBtn"),
  challengeBtn: document.getElementById("challengeBtn"),
  passBtn: document.getElementById("passBtn"),
  playForm: document.getElementById("playForm"),
  declaredRank: document.getElementById("declaredRank"),
  handCount: document.getElementById("handCount"),
  handCards: document.getElementById("handCards"),
  selectedInfo: document.getElementById("selectedInfo"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  startGameBtn: document.getElementById("startGameBtn"),
  renameForm: document.getElementById("renameForm"),
  renameName: document.getElementById("renameName"),
  renameHint: document.getElementById("renameHint"),
  renameBtn: document.getElementById("renameBtn"),
  eventOverlay: document.getElementById("eventOverlay"),
  eventCard: document.getElementById("eventCard"),
  resultModal: document.getElementById("resultModal"),
  resultTitle: document.getElementById("resultTitle"),
  resultRankings: document.getElementById("resultRankings"),
  toast: document.getElementById("toast"),
};

for (const rank of ranks) {
  const option = document.createElement("option");
  option.value = rank;
  option.textContent = rank;
  elements.declaredRank.appendChild(option);
}

function normalizeName(value) {
  return String(value || "").trim().slice(0, 16);
}

function saveName(name) {
  if (name) {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  }
}

function syncNameInputs(name, source) {
  if (source !== "create") {
    elements.createName.value = name;
  }
  if (source !== "join") {
    elements.joinName.value = name;
  }
  if (source !== "rename" && elements.renameName) {
    elements.renameName.value = name;
  }
}

function bootstrapStoredName() {
  const savedName = normalizeName(localStorage.getItem(NAME_STORAGE_KEY));
  if (savedName) {
    syncNameInputs(savedName);
  }
}

function send(message) {
  if (socket.readyState !== WebSocket.OPEN) {
    showToast("连接尚未就绪");
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2400);
}

function resetTransientUiState() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  clearTimeout(state.activeEventTimer);
  state.activeEventTimer = null;
  state.activeEventId = null;
  state.selectedCards.clear();
  state.seenEventIds = new Set();
  state.eventQueue = [];
  state.dismissedResultKey = null;
  state.activeResultKey = null;
  elements.eventOverlay.classList.add("hidden");
  elements.resultModal.classList.add("hidden");
  setSelectionInfo();
}

function showLobby() {
  state.room = null;
  resetTransientUiState();
  elements.roomView.classList.add("hidden");
  elements.lobbyView.classList.remove("hidden");
}

function trimSeenEvents() {
  const ids = [...state.seenEventIds];
  if (ids.length <= 64) {
    return;
  }
  state.seenEventIds = new Set(ids.slice(-32));
}

function flushEventQueue() {
  if (state.activeEventTimer || !state.eventQueue.length) {
    return;
  }

  const nextEvent = state.eventQueue.shift();
  state.activeEventId = nextEvent.id;
  elements.eventCard.textContent = nextEvent.message;
  elements.eventCard.className = `event-card ${nextEvent.tone || "play"}`;
  elements.eventOverlay.classList.remove("hidden");

  state.activeEventTimer = setTimeout(() => {
    elements.eventOverlay.classList.add("hidden");
    elements.eventCard.className = "event-card";
    state.activeEventTimer = null;
    state.activeEventId = null;
    flushEventQueue();
  }, nextEvent.durationMs || 1000);
}

function syncRoomEvents() {
  const events = state.room?.events || [];
  for (const event of events) {
    if (state.seenEventIds.has(event.id) || state.activeEventId === event.id) {
      continue;
    }
    if (state.eventQueue.some((queued) => queued.id === event.id)) {
      continue;
    }
    state.seenEventIds.add(event.id);
    state.eventQueue.push(event);
  }
  trimSeenEvents();
  flushEventQueue();
}

function currentViewer() {
  return state.room?.players.find((player) => player.isViewer);
}

function readRequiredName(input, source) {
  const name = normalizeName(input.value);
  input.value = name;
  if (!name) {
    showToast("加入房间前请先输入昵称");
    input.focus();
    return null;
  }
  saveName(name);
  syncNameInputs(name, source);
  return name;
}

function setSelectionInfo() {
  elements.selectedInfo.textContent = `已选 ${state.selectedCards.size} 张`;
}

function clearSelection() {
  state.selectedCards.clear();
  setSelectionInfo();
  renderHand();
}

function renderPlayers() {
  elements.playersList.innerHTML = "";
  for (const player of state.room.players) {
    const node = document.createElement("div");
    node.className = "player-item";
    if (player.isTurn) {
      node.classList.add("active");
    }
    if (player.finished) {
      node.classList.add("finished");
    }

    const badges = [
      player.isHost ? "房主" : "",
      player.isViewer ? "你" : "",
      player.finished ? "出完" : "",
      !player.connected ? "离线" : "",
    ].filter(Boolean);

    node.innerHTML = `
      <div class="player-name">
        <span>${player.name}</span>
        <span>${player.handCount} 张</span>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
        ${badges.map((badge) => `<span class="pill">${badge}</span>`).join("")}
      </div>
    `;
    elements.playersList.appendChild(node);
  }
}

function renderPile() {
  elements.pileCards.innerHTML = "";
  const currentPlay = state.room.currentPlay;
  if (!currentPlay) {
    elements.pileCards.innerHTML = '<div class="mini-card stack-hidden">当前没有待质疑的上一手</div>';
    return;
  }

  if (currentPlay.status === "hidden") {
    for (let index = 0; index < currentPlay.declaredCount; index += 1) {
      const node = document.createElement("div");
      node.className = "mini-card back";
      node.textContent = "牌背";
      elements.pileCards.appendChild(node);
    }
    return;
  }

  for (const label of currentPlay.cards) {
    const node = document.createElement("div");
    node.className = "mini-card";
    node.textContent = label;
    elements.pileCards.appendChild(node);
  }
}

function renderHand() {
  elements.handCards.innerHTML = "";
  const hand = state.room.hand || [];
  elements.handCount.textContent = `${hand.length} 张手牌`;

  for (const card of hand) {
    const cardNode = document.createElement("label");
    cardNode.className = "card-chip";
    if (state.selectedCards.has(card.id)) {
      cardNode.classList.add("selected");
    }

    cardNode.innerHTML = `
      <input type="checkbox" ${state.selectedCards.has(card.id) ? "checked" : ""} />
      <strong>${card.label}</strong>
    `;

    cardNode.addEventListener("click", (event) => {
      event.preventDefault();
      if (!state.room?.canPlay || state.room.currentPlay?.status === "revealed") {
        return;
      }
      if (state.selectedCards.has(card.id)) {
        state.selectedCards.delete(card.id);
      } else {
        if (false && state.selectedCards.size >= 4) {
          showToast("单次最多选 4 张");
          return;
        }
        state.selectedCards.add(card.id);
      }
      setSelectionInfo();
      renderHand();
    });

    elements.handCards.appendChild(cardNode);
  }
}

function renderRenameSection() {
  const viewer = currentViewer();
  const viewerName = viewer?.name || "";
  const canRename = Boolean(state.room?.canRename);

  elements.renameForm.classList.toggle("hidden", !state.room);
  elements.renameName.value = viewerName;
  elements.renameName.disabled = !canRename;
  elements.renameBtn.disabled = !canRename;
  elements.renameHint.textContent = canRename
    ? "大厅期可修改昵称，开局后会锁定。"
    : "游戏开始后昵称锁定。";
}

function countdownText() {
  const deadline = state.room?.pendingChallenge?.responseDeadlineAt;
  if (!deadline) {
    return "";
  }
  const remainingMs = Math.max(0, deadline - Date.now());
  return Math.ceil(remainingMs / 1000);
}

function currentRankLabel() {
  return state.room.currentRank || "待选";
}

function renderStatus() {
  const currentPlay = state.room.currentPlay;
  const pending = state.room.pendingChallenge;
  const turnPlayer = state.room.players.find((player) => player.isTurn);
  const viewer = currentViewer();
  const showSurrender = state.room.status === "playing" && state.room.activePlayerCount === 2 && viewer?.handCount > 0;

  elements.roomTitle.textContent = state.room.roomCode;
  elements.maxPlayersLabel.textContent = state.room.maxPlayers;
  elements.tableCount.textContent = state.room.tableCount;
  elements.currentRank.textContent = currentRankLabel();

  if (state.room.lastAction) {
    const { actorName, declaredRank, declaredCount } = state.room.lastAction;
    elements.lastActionText.textContent = `${actorName} 声称出了 ${declaredCount} 张 ${declaredRank}`;
  } else {
    elements.lastActionText.textContent = "等待玩家加入。";
  }

  elements.resolutionText.textContent = state.room.lastResolution || "暂无。";

  if (state.room.winner) {
    const winner = state.room.players.find((player) => player.id === state.room.winner);
    elements.turnText.textContent = `${winner?.name || "有玩家"} 已出完手牌，游戏结束。`;
  } else if (currentPlay?.status === "revealed") {
    elements.turnText.textContent = `${currentPlay.actorName} 的上一手已公开，正在等待质疑结算。`;
  } else if (pending && turnPlayer) {
    elements.turnText.textContent =
      `轮到 ${turnPlayer.name} 选择跟牌、不出或质疑上一手，还剩 ${countdownText()} 秒。` +
      ` 本轮牌面为 ${state.room.currentRank}。`;
  } else if (turnPlayer && !state.room.currentRank) {
    elements.turnText.textContent = `轮到 ${turnPlayer.name} 先出牌，并决定本轮牌面。`;
  } else if (turnPlayer) {
    elements.turnText.textContent = `轮到 ${turnPlayer.name} 决定是否跟上出牌。`;
  } else {
    elements.turnText.textContent = "等待开始。";
  }

  elements.challengeBtn.disabled = !state.room.canChallenge;
  elements.passBtn.disabled = !state.room.canPass;
  elements.passBtn.textContent = state.room.canPass ? `不出 (${countdownText()}s)` : "不出";
  elements.startGameBtn.disabled = !state.room.canStart;
  elements.surrenderBtn.classList.toggle("hidden", !showSurrender);
  elements.surrenderBtn.disabled = !state.room.canSurrender;

  const disablePlay = !state.room.canPlay || currentPlay?.status === "revealed";
  elements.declaredRank.disabled = disablePlay || Boolean(state.room.currentRank);
  elements.playForm.querySelector("button").disabled = disablePlay;

  if (state.room.currentRank) {
    elements.declaredRank.value = state.room.currentRank;
  }
}

function resultKey() {
  if (!state.room?.winner) {
    return null;
  }
  const rankings = state.room.rankings || [];
  return `${state.room.roomCode}:${rankings.map((entry) => `${entry.rank}-${entry.id}-${entry.handCount}`).join("|")}`;
}

function renderResultModal() {
  const modalKey = resultKey();
  if (!modalKey || state.dismissedResultKey === modalKey) {
    elements.resultModal.classList.add("hidden");
    state.activeResultKey = null;
    return;
  }

  const rankings = state.room.rankings || [];
  const winner = rankings[0];
  elements.resultTitle.textContent = `${winner?.isViewer ? "你" : winner?.name || "有玩家"} 获胜`;
  elements.resultRankings.innerHTML = rankings
    .map((entry) => {
      const suffix = entry.handCount === 0 ? "已出完" : `剩 ${entry.handCount} 张`;
      const name = entry.isViewer ? "你" : entry.name;
      return `
        <div class="result-rank-row ${entry.rank === 1 ? "top" : ""}">
          <span>#${entry.rank}</span>
          <strong>${name}</strong>
          <span>${suffix}</span>
        </div>
      `;
    })
    .join("");
  elements.resultModal.classList.remove("hidden");
  state.activeResultKey = modalKey;
}

function syncCountdownTimer() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;

  if (!state.room?.pendingChallenge?.responseDeadlineAt || state.room.currentPlay?.status === "revealed") {
    return;
  }

  state.countdownTimer = setInterval(() => {
    if (!state.room?.pendingChallenge) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
      return;
    }
    renderStatus();
  }, 250);
}

function renderRoom() {
  elements.lobbyView.classList.add("hidden");
  elements.roomView.classList.remove("hidden");
  renderPlayers();
  renderPile();
  renderHand();
  renderStatus();
  renderRenameSection();
  syncCountdownTimer();
  setSelectionInfo();

  const viewerName = currentViewer()?.name;
  if (viewerName) {
    saveName(viewerName);
    syncNameInputs(viewerName, "rename");
  }

  syncRoomEvents();
  renderResultModal();
}

socket.addEventListener("open", () => {
  showToast("连接已建立");
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "error") {
    showToast(message.message);
    return;
  }

  if (message.type === "left-room") {
    showLobby();
    showToast("已退出房间");
    return;
  }

  if (message.type === "state") {
    const nextRoom = message.state;
    const isFreshRoom = !state.room || state.room.roomCode !== nextRoom.roomCode;
    if (isFreshRoom) {
      state.seenEventIds = new Set((nextRoom.events || []).map((roomEvent) => roomEvent.id));
      state.eventQueue = [];
      state.activeEventId = null;
      state.dismissedResultKey = null;
      state.activeResultKey = null;
      clearTimeout(state.activeEventTimer);
      state.activeEventTimer = null;
      elements.eventOverlay.classList.add("hidden");
      elements.resultModal.classList.add("hidden");
    }
    state.room = nextRoom;
    const handIds = new Set(state.room.hand.map((card) => card.id));
    for (const id of [...state.selectedCards]) {
      if (!handIds.has(id)) {
        state.selectedCards.delete(id);
      }
    }
    renderRoom();
  }
});

socket.addEventListener("close", () => {
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  clearTimeout(state.activeEventTimer);
  state.activeEventTimer = null;
  state.activeEventId = null;
  state.seenEventIds = new Set();
  state.eventQueue = [];
  state.dismissedResultKey = null;
  state.activeResultKey = null;
  elements.eventOverlay.classList.add("hidden");
  elements.resultModal.classList.add("hidden");
  showToast("连接已断开，请刷新页面");
});

elements.resultModal.addEventListener("click", () => {
  if (!state.activeResultKey) {
    return;
  }
  state.dismissedResultKey = state.activeResultKey;
  elements.resultModal.classList.add("hidden");
});

elements.createName.addEventListener("input", () => {
  syncNameInputs(normalizeName(elements.createName.value), "create");
});

elements.joinName.addEventListener("input", () => {
  syncNameInputs(normalizeName(elements.joinName.value), "join");
});

elements.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = readRequiredName(elements.createName, "create");
  if (!name) {
    return;
  }
  send({
    type: "create-room",
    name,
    maxPlayers: Number(elements.maxPlayers.value),
  });
});

elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = readRequiredName(elements.joinName, "join");
  if (!name) {
    return;
  }
  send({
    type: "join-room",
    name,
    roomCode: elements.roomCode.value.trim().toUpperCase(),
  });
});

elements.renameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.room?.canRename) {
    showToast("游戏开始后昵称锁定");
    return;
  }
  const name = readRequiredName(elements.renameName, "rename");
  if (!name) {
    return;
  }
  if (name === currentViewer()?.name) {
    showToast("昵称未变化");
    return;
  }
  send({
    type: "rename-player",
    name,
  });
});

elements.startGameBtn.addEventListener("click", () => {
  send({ type: "start-game" });
});

elements.leaveRoomBtn.addEventListener("click", () => {
  send({ type: "leave-room" });
});

elements.surrenderBtn.addEventListener("click", () => {
  send({ type: "surrender" });
});

elements.challengeBtn.addEventListener("click", () => {
  send({ type: "challenge" });
});

elements.passBtn.addEventListener("click", () => {
  send({ type: "pass-window" });
});

elements.playForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.selectedCards.size) {
    showToast("先选择要出的牌");
    return;
  }

  if (
    send({
      type: "play-cards",
      cardIds: [...state.selectedCards],
      declaredRank: elements.declaredRank.value,
    })
  ) {
    clearSelection();
  }
});

elements.clearSelectionBtn.addEventListener("click", () => {
  clearSelection();
});

bootstrapStoredName();
