const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);

const state = {
  room: null,
  selectedCards: new Set(),
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
  challengeBtn: document.getElementById("challengeBtn"),
  passBtn: document.getElementById("passBtn"),
  playForm: document.getElementById("playForm"),
  declaredRank: document.getElementById("declaredRank"),
  handCount: document.getElementById("handCount"),
  handCards: document.getElementById("handCards"),
  selectedInfo: document.getElementById("selectedInfo"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  startGameBtn: document.getElementById("startGameBtn"),
  toast: document.getElementById("toast"),
};

for (const rank of ranks) {
  const option = document.createElement("option");
  option.value = rank;
  option.textContent = rank;
  elements.declaredRank.appendChild(option);
}

function send(message) {
  if (socket.readyState !== WebSocket.OPEN) {
    showToast("连接尚未就绪");
    return;
  }
  socket.send(JSON.stringify(message));
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2400);
}

function currentViewer() {
  return state.room?.players.find((player) => player.isViewer);
}

function isMyTurn() {
  return Boolean(currentViewer()?.isTurn);
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
  if (!state.room.pilePreview.length) {
    elements.pileCards.innerHTML = '<div class="mini-card">牌堆已隐藏</div>';
    return;
  }

  for (const label of state.room.pilePreview) {
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
      if (!isMyTurn() || state.room.pendingChallenge) {
        return;
      }
      if (state.selectedCards.has(card.id)) {
        state.selectedCards.delete(card.id);
      } else {
        if (state.selectedCards.size >= 4) {
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

function renderStatus() {
  elements.roomTitle.textContent = state.room.roomCode;
  elements.maxPlayersLabel.textContent = state.room.maxPlayers;
  elements.tableCount.textContent = state.room.tableCount;
  elements.currentRank.textContent = state.room.currentRank;

  if (state.room.lastAction) {
    const { actorName, declaredRank, declaredCount } = state.room.lastAction;
    elements.lastActionText.textContent = `${actorName} 声称出了 ${declaredCount} 张 ${declaredRank}`;
  } else {
    elements.lastActionText.textContent = "等待玩家加入。";
  }

  elements.resolutionText.textContent = state.room.lastResolution || "暂无。";

  const turnPlayer = state.room.players.find((player) => player.isTurn);
  if (state.room.winner) {
    const winner = state.room.players.find((player) => player.id === state.room.winner);
    elements.turnText.textContent = `${winner?.name || "有玩家"} 已出完手牌，游戏结束。`;
  } else if (state.room.pendingChallenge) {
    const pending = state.room.pendingChallenge;
    elements.turnText.textContent = `${pending.actorName} 声称出了 ${pending.declaredCount} 张 ${pending.declaredRank}，其他玩家现在可以质疑。`;
  } else if (turnPlayer) {
    elements.turnText.textContent = `轮到 ${turnPlayer.name} 出牌，本轮理论牌面是 ${state.room.currentRank}。`;
  } else {
    elements.turnText.textContent = "等待开始。";
  }

  elements.challengeBtn.disabled = !state.room.canChallenge;
  elements.passBtn.disabled = !(state.room.pendingChallenge && isMyTurn());
  elements.startGameBtn.disabled = !state.room.canStart;

  const disablePlay = state.room.status !== "playing" || !isMyTurn() || Boolean(state.room.pendingChallenge);
  elements.declaredRank.disabled = disablePlay;
  elements.playForm.querySelector("button").disabled = disablePlay;

  if (state.room.status === "playing") {
    elements.declaredRank.value = state.room.currentRank;
  }
}

function renderRoom() {
  elements.lobbyView.classList.add("hidden");
  elements.roomView.classList.remove("hidden");
  renderPlayers();
  renderPile();
  renderHand();
  renderStatus();
  setSelectionInfo();
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

  if (message.type === "state") {
    state.room = message.state;
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
  showToast("连接已断开，请刷新页面");
});

elements.createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "create-room",
    name: elements.createName.value.trim(),
    maxPlayers: Number(elements.maxPlayers.value),
  });
});

elements.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  send({
    type: "join-room",
    name: elements.joinName.value.trim(),
    roomCode: elements.roomCode.value.trim().toUpperCase(),
  });
});

elements.startGameBtn.addEventListener("click", () => {
  send({ type: "start-game" });
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

  send({
    type: "play-cards",
    cardIds: [...state.selectedCards],
    declaredRank: elements.declaredRank.value,
  });
  clearSelection();
});

elements.clearSelectionBtn.addEventListener("click", () => {
  clearSelection();
});
