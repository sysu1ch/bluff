const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const clients = new Map();

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;

app.use(express.static(path.join(__dirname, "public")));

function shuffle(items) {
  const deck = [...items];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function makeDeck() {
  const deck = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) {
      deck.push({ id: `${rank}${suit}`, rank, suit });
    }
  }
  return shuffle(deck);
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function cardLabel(card) {
  const suitLabel = { S: "♠", H: "♥", D: "♦", C: "♣" };
  return `${card.rank}${suitLabel[card.suit]}`;
}

function sortHand(hand) {
  hand.sort((a, b) => {
    const rankDiff = RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

function activePlayers(room) {
  return room.players.filter((player) => player.hand.length > 0).length;
}

function nextActivePlayer(room, currentIndex) {
  const total = room.players.length;
  for (let step = 1; step <= total; step += 1) {
    const idx = (currentIndex + step) % total;
    if (room.players[idx].hand.length > 0) {
      return idx;
    }
  }
  return currentIndex;
}

function rankAfter(rank) {
  const index = RANKS.indexOf(rank);
  return RANKS[(index + 1) % RANKS.length];
}

function createRoom(playerId, name, maxPlayers) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: playerId,
    maxPlayers,
    players: [{ id: playerId, name, hand: [], connected: true }],
    game: {
      started: false,
      currentPlayerIndex: 0,
      currentRank: "A",
      pile: [],
      pendingChallenge: null,
      lastAction: null,
      lastResolution: null,
      winnerId: null,
    },
  };
  rooms.set(code, room);
  return room;
}

function joinRoom(room, playerId, name) {
  if (room.players.length >= room.maxPlayers) {
    throw new Error("房间已满");
  }
  if (room.game.started) {
    throw new Error("游戏已经开始");
  }
  room.players.push({ id: playerId, name, hand: [], connected: true });
}

function dealCards(room) {
  const deck = makeDeck();
  room.players.forEach((player) => {
    player.hand = [];
  });

  let cursor = 0;
  while (deck.length > 0) {
    room.players[cursor % room.players.length].hand.push(deck.pop());
    cursor += 1;
  }

  room.players.forEach((player) => sortHand(player.hand));
}

function updateWinner(room) {
  if (activePlayers(room) <= 1) {
    room.game.started = false;
    room.game.winnerId = room.players.find((player) => player.hand.length === 0)?.id || null;
  } else {
    room.game.winnerId = null;
  }
}

function startGame(room) {
  dealCards(room);
  room.game.started = true;
  room.game.currentPlayerIndex = 0;
  room.game.currentRank = "A";
  room.game.pile = [];
  room.game.pendingChallenge = null;
  room.game.lastAction = null;
  room.game.lastResolution = null;
  room.game.winnerId = null;
}

function roomStateFor(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId);
  const currentPlayer = room.players[room.game.currentPlayerIndex];
  return {
    roomCode: room.code,
    maxPlayers: room.maxPlayers,
    status: room.game.started ? "playing" : "lobby",
    hostId: room.hostId,
    viewerId,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      handCount: player.hand.length,
      connected: player.connected,
      isHost: player.id === room.hostId,
      isViewer: player.id === viewerId,
      isTurn: room.game.started && index === room.game.currentPlayerIndex,
      finished: room.game.started && player.hand.length === 0,
    })),
    hand: (viewer?.hand || []).map((card) => ({ ...card, label: cardLabel(card) })),
    tableCount: room.game.pile.length,
    pilePreview: room.game.pile.slice(-3).map(cardLabel),
    currentRank: room.game.currentRank,
    currentPlayerId: currentPlayer?.id || null,
    pendingChallenge: room.game.pendingChallenge
      ? {
          actorId: room.game.pendingChallenge.actorId,
          actorName: room.game.pendingChallenge.actorName,
          declaredRank: room.game.pendingChallenge.declaredRank,
          declaredCount: room.game.pendingChallenge.declaredCount,
        }
      : null,
    canStart:
      viewerId === room.hostId &&
      !room.game.started &&
      room.players.length >= MIN_PLAYERS &&
      room.players.length <= room.maxPlayers,
    canChallenge:
      room.game.started &&
      Boolean(room.game.pendingChallenge) &&
      room.game.pendingChallenge.actorId !== viewerId,
    lastAction: room.game.lastAction
      ? {
          actorName: room.game.lastAction.actorName,
          declaredRank: room.game.lastAction.declaredRank,
          declaredCount: room.game.lastAction.declaredCount,
        }
      : null,
    lastResolution: room.game.lastResolution,
    winner: room.game.winnerId,
  };
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, message) {
  send(ws, { type: "error", message });
}

function broadcastRoom(room) {
  for (const player of room.players) {
    const client = clients.get(player.id);
    if (client?.ws) {
      send(client.ws, { type: "state", state: roomStateFor(room, player.id) });
    }
  }
}

function ensurePlayerTurn(room, playerId) {
  if (!room.game.started) {
    throw new Error("游戏尚未开始");
  }
  const currentPlayer = room.players[room.game.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.id !== playerId) {
    throw new Error("还没轮到你");
  }
  if (room.game.pendingChallenge) {
    throw new Error("当前需要先处理质疑");
  }
  return currentPlayer;
}

function playCards(room, playerId, cardIds, declaredRank) {
  const player = ensurePlayerTurn(room, playerId);

  if (!Array.isArray(cardIds) || cardIds.length < 1) {
    throw new Error("至少选择一张牌");
  }
  if (cardIds.length > 4) {
    throw new Error("单次最多出四张牌");
  }
  if (!RANKS.includes(declaredRank)) {
    throw new Error("声明牌面无效");
  }

  const uniqueIds = [...new Set(cardIds)];
  if (uniqueIds.length !== cardIds.length) {
    throw new Error("出牌包含重复项");
  }

  const cards = uniqueIds.map((id) => {
    const card = player.hand.find((entry) => entry.id === id);
    if (!card) {
      throw new Error("存在无效手牌");
    }
    return card;
  });

  player.hand = player.hand.filter((card) => !uniqueIds.includes(card.id));
  room.game.pile.push(...cards);
  room.game.pendingChallenge = {
    actorId: player.id,
    actorName: player.name,
    declaredRank,
    declaredCount: cards.length,
    cards,
  };
  room.game.lastAction = room.game.pendingChallenge;
  room.game.lastResolution = null;
}

function collectPile(room, playerId) {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return;
  }
  player.hand.push(...room.game.pile);
  sortHand(player.hand);
  room.game.pile = [];
}

function finalizeTurn(room) {
  const currentIndex = room.game.currentPlayerIndex;
  room.game.pendingChallenge = null;
  room.game.currentPlayerIndex = nextActivePlayer(room, currentIndex);
  room.game.currentRank = rankAfter(room.game.currentRank);
  updateWinner(room);
}

function challenge(room, challengerId) {
  const pending = room.game.pendingChallenge;
  if (!pending) {
    throw new Error("当前没有可质疑的出牌");
  }
  if (pending.actorId === challengerId) {
    throw new Error("不能质疑自己");
  }

  const challenger = room.players.find((player) => player.id === challengerId);
  const truthful = pending.cards.every((card) => card.rank === pending.declaredRank);
  const receiverId = truthful ? challengerId : pending.actorId;

  collectPile(room, receiverId);
  room.game.lastResolution = truthful
    ? `${challenger.name} 质疑失败，收走整叠牌。`
    : `${challenger.name} 质疑成功，${pending.actorName} 收走整叠牌。`;
  room.game.pendingChallenge = null;
  room.game.currentPlayerIndex = nextActivePlayer(
    room,
    room.players.findIndex((player) => player.id === receiverId)
  );
  room.game.currentRank = rankAfter(room.game.currentRank);
  updateWinner(room);
}

function passWindow(room, playerId) {
  if (!room.game.pendingChallenge) {
    throw new Error("当前没有待处理的质疑窗口");
  }
  if (room.game.pendingChallenge.actorId !== playerId) {
    throw new Error("只有出牌玩家可以结束质疑窗口");
  }
  finalizeTurn(room);
}

function handleDisconnect(playerId) {
  const client = clients.get(playerId);
  if (!client) {
    return;
  }

  const room = rooms.get(client.roomCode);
  clients.delete(playerId);
  if (!room) {
    return;
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (player) {
    player.connected = false;
  }

  if (room.hostId === playerId) {
    const nextHost = room.players.find((entry) => entry.connected);
    room.hostId = nextHost?.id || room.hostId;
  }

  broadcastRoom(room);

  if (room.players.every((entry) => !entry.connected)) {
    rooms.delete(room.code);
  }
}

function handleAuthedMessage(ws, room, playerId, message) {
  if (message.type === "start-game") {
    if (room.hostId !== playerId) {
      throw new Error("只有房主可以开始游戏");
    }
    if (room.players.length < MIN_PLAYERS) {
      throw new Error("至少需要两名玩家");
    }
    startGame(room);
    broadcastRoom(room);
    return;
  }

  if (message.type === "play-cards") {
    playCards(room, playerId, message.cardIds, message.declaredRank);
    broadcastRoom(room);
    return;
  }

  if (message.type === "challenge") {
    challenge(room, playerId);
    broadcastRoom(room);
    return;
  }

  if (message.type === "pass-window") {
    passWindow(room, playerId);
    broadcastRoom(room);
    return;
  }

  if (message.type === "sync") {
    send(ws, { type: "state", state: roomStateFor(room, playerId) });
    return;
  }

  throw new Error("未知操作");
}

function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    sendError(ws, "消息格式错误");
    return;
  }

  try {
    if (message.type === "create-room") {
      const name = String(message.name || "").trim().slice(0, 16);
      const maxPlayers = Number(message.maxPlayers);
      if (!name) {
        throw new Error("请输入昵称");
      }
      if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
        throw new Error(`人数范围为 ${MIN_PLAYERS}-${MAX_PLAYERS}`);
      }

      const playerId = crypto.randomUUID();
      const room = createRoom(playerId, name, maxPlayers);
      clients.set(playerId, { ws, roomCode: room.code });
      ws.playerId = playerId;
      broadcastRoom(room);
      return;
    }

    if (message.type === "join-room") {
      const name = String(message.name || "").trim().slice(0, 16);
      const roomCode = String(message.roomCode || "").trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) {
        throw new Error("房间不存在");
      }
      if (!name) {
        throw new Error("请输入昵称");
      }

      const playerId = crypto.randomUUID();
      joinRoom(room, playerId, name);
      clients.set(playerId, { ws, roomCode: room.code });
      ws.playerId = playerId;
      broadcastRoom(room);
      return;
    }

    if (!ws.playerId) {
      throw new Error("请先加入房间");
    }

    const client = clients.get(ws.playerId);
    const room = rooms.get(client?.roomCode);
    if (!room) {
      throw new Error("房间不存在");
    }

    handleAuthedMessage(ws, room, ws.playerId, message);
  } catch (error) {
    sendError(ws, error.message || "操作失败");
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => handleMessage(ws, raw));
  ws.on("close", () => {
    if (ws.playerId) {
      handleDisconnect(ws.playerId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hu Pai server running at http://localhost:${PORT}`);
});
