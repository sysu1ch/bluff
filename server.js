const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const rooms = new Map();
const clients = new Map();

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["S", "H", "D", "C"];
const SUIT_LABELS = { S: "♠", H: "♥", D: "♦", C: "♣" };
const JOKERS = [
  { id: "JOKER_SMALL", rank: "JOKER", suit: "SMALL", wild: true },
  { id: "JOKER_BIG", rank: "JOKER", suit: "BIG", wild: true },
];
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const MAX_NAME_LENGTH = 16;
const REVEAL_MS = 2000;
const DECISION_MS = 20000;
const MAX_EVENT_LOG = 16;

app.use(express.static(path.join(__dirname, "public")));

function shuffle(items) {
  const deck = [...items];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
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
  deck.push(...JOKERS.map((card) => ({ ...card })));
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

function normalizeName(rawName) {
  const name = String(rawName || "").trim().slice(0, MAX_NAME_LENGTH);
  if (!name) {
    throw new Error("请输入昵称");
  }
  return name;
}

function cardLabel(card) {
  if (card.rank === "JOKER") {
    return card.suit === "BIG" ? "大王" : "小王";
  }
  return `${card.rank}${SUIT_LABELS[card.suit]}`;
}

function sortHand(hand) {
  hand.sort((left, right) => {
    if (left.rank === "JOKER" || right.rank === "JOKER") {
      if (left.rank === right.rank) {
        return left.suit.localeCompare(right.suit);
      }
      return left.rank === "JOKER" ? 1 : -1;
    }
    const rankDiff = RANKS.indexOf(left.rank) - RANKS.indexOf(right.rank);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit);
  });
}

function activePlayers(room) {
  return room.players.filter((player) => player.hand.length > 0).length;
}

function activePlayerEntries(room) {
  return room.players.filter((player) => player.hand.length > 0);
}

function finishedPlayerIds(room) {
  return new Set(room.game.finishOrder);
}

function pendingFinishIds(room) {
  return new Set(room.game.pendingFinishOrder);
}

function nextActivePlayer(room, currentIndex) {
  const total = room.players.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (currentIndex + step) % total;
    if (room.players[index].hand.length > 0) {
      return index;
    }
  }
  return currentIndex;
}

function nextResponderIndex(room, currentIndex) {
  const total = room.players.length;
  const actorId = room.game.lastPlay?.actorId;
  for (let step = 1; step <= total; step += 1) {
    const index = (currentIndex + step) % total;
    const player = room.players[index];
    if (player.id === actorId || player.hand.length > 0) {
      return index;
    }
  }
  return currentIndex;
}

function playerIndex(room, playerId) {
  return room.players.findIndex((player) => player.id === playerId);
}

function currentPlayer(room) {
  return room.players[room.game.currentPlayerIndex] || null;
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
      currentRank: null,
      tableCards: [],
      discardPile: [],
      lastPlay: null,
      revealState: null,
      decisionDeadlineAt: null,
      decisionTimer: null,
      revealTimer: null,
      lastAction: null,
      lastResolution: null,
      winnerId: null,
      finishOrder: [],
      pendingFinishOrder: [],
      surrenderedId: null,
      eventLog: [],
      nextEventId: 1,
    },
  };
  rooms.set(code, room);
  return room;
}

function pushGameEvent(room, event) {
  room.game.eventLog.push({
    id: room.game.nextEventId,
    ...event,
  });
  room.game.nextEventId += 1;
  if (room.game.eventLog.length > MAX_EVENT_LOG) {
    room.game.eventLog.splice(0, room.game.eventLog.length - MAX_EVENT_LOG);
  }
}

function viewerEventFor(event, viewerId) {
  if (event.kind === "play") {
    const actorLabel = event.actorId === viewerId ? "\u4f60" : event.actorName;
    return {
      id: event.id,
      tone: "play",
      message: `${actorLabel}\u51fa\u4e86 ${event.declaredCount} \u5f20\uff0c\u58f0\u660e ${event.declaredRank}`,
    };
  }

  if (event.kind === "challenge-resolution") {
    const viewerIsChallenger = event.challengerId === viewerId;
    const viewerIsActor = event.actorId === viewerId;

    if (viewerIsChallenger) {
      return {
        id: event.id,
        tone: event.truthful ? "fail" : "success",
        message: event.truthful
          ? `\u88ab ${event.actorName} \u9a97\u4e86`
          : `\u8bc6\u7834\u4e86 ${event.actorName}`,
        durationMs: 1500,
      };
    }

    if (viewerIsActor) {
      return {
        id: event.id,
        tone: event.truthful ? "success" : "fail",
        message: event.truthful
          ? `\u9a97\u5230 ${event.challengerName} \u4e86\uff01`
          : `\u88ab ${event.challengerName} \u8bc6\u7834\u4e86\uff01`,
        durationMs: 1500,
      };
    }

    return {
      id: event.id,
      tone: event.truthful ? "fail" : "success",
      message: event.truthful
        ? `${event.challengerName}\u8d28\u7591\u5931\u8d25`
        : `${event.challengerName}\u8d28\u7591\u6210\u529f`,
      durationMs: 1500,
    };
  }

  if (event.kind === "collect") {
    const collectorLabel = event.collectorId === viewerId ? "\u4f60" : event.collectorName;
    return {
      id: event.id,
      tone: "collect",
      message: `${collectorLabel}\u6536\u4e0b ${event.cardCount} \u5f20\u724c`,
    };
  }

  return null;
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
  if (room.game.pendingFinishOrder.length > 0) {
    room.game.winnerId = null;
    return;
  }

  if (activePlayers(room) <= 1) {
    room.game.started = false;
    room.game.winnerId = room.game.finishOrder[0] || null;
  } else {
    room.game.winnerId = null;
  }
}

function rankingsFor(room) {
  const finishedIds = finishedPlayerIds(room);
  const pendingIds = pendingFinishIds(room);
  const surrenderedId = room.game.surrenderedId;
  const finishedPlayers = room.game.finishOrder
    .map((playerId) => room.players.find((player) => player.id === playerId))
    .filter(Boolean);
  const surrenderedPlayer = surrenderedId
    ? room.players.find((player) => player.id === surrenderedId)
    : null;
  const unfinishedPlayers = room.players
    .filter((player) => !finishedIds.has(player.id) && player.id !== surrenderedId)
    .sort((left, right) => {
      if (left.hand.length !== right.hand.length) {
        return left.hand.length - right.hand.length;
      }
      return left.name.localeCompare(right.name);
    });

  return [...finishedPlayers, ...unfinishedPlayers, ...(surrenderedPlayer ? [surrenderedPlayer] : [])].map((player, index) => ({
    rank: index + 1,
    id: player.id,
    name: player.name,
    handCount: player.hand.length,
    finished: finishedIds.has(player.id),
    pendingFinish: pendingIds.has(player.id),
    isViewer: false,
  }));
}

function clearDecisionTimer(room) {
  if (room.game.decisionTimer) {
    clearTimeout(room.game.decisionTimer);
    room.game.decisionTimer = null;
  }
  room.game.decisionDeadlineAt = null;
}

function clearRevealTimer(room) {
  if (room.game.revealTimer) {
    clearTimeout(room.game.revealTimer);
    room.game.revealTimer = null;
  }
}

function clearRoundState(room) {
  clearDecisionTimer(room);
  clearRevealTimer(room);
  room.game.currentRank = null;
  room.game.tableCards = [];
  room.game.lastPlay = null;
  room.game.revealState = null;
}

function startGame(room) {
  dealCards(room);
  room.game.started = true;
  room.game.currentPlayerIndex = 0;
  clearRoundState(room);
  room.game.discardPile = [];
  room.game.lastAction = null;
  room.game.lastResolution = null;
  room.game.winnerId = null;
  room.game.finishOrder = [];
  room.game.pendingFinishOrder = [];
  room.game.surrenderedId = null;
}

function markPendingFinish(room, playerId) {
  if (room.game.finishOrder.includes(playerId) || room.game.pendingFinishOrder.includes(playerId)) {
    return;
  }
  const player = room.players.find((entry) => entry.id === playerId);
  if (player?.hand.length === 0) {
    room.game.pendingFinishOrder.push(playerId);
  }
}

function settlePendingFinishes(room) {
  if (!room.game.pendingFinishOrder.length) {
    return;
  }

  const nextPendingOrder = [];
  for (const playerId of room.game.pendingFinishOrder) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      continue;
    }
    if (player.hand.length === 0) {
      if (!room.game.finishOrder.includes(playerId)) {
        room.game.finishOrder.push(playerId);
      }
      continue;
    }
    nextPendingOrder.push(playerId);
  }
  room.game.pendingFinishOrder = nextPendingOrder;
}

function roundLeaderIndex(room, leaderId) {
  const leaderIndex = playerIndex(room, leaderId);
  if (leaderIndex === -1) {
    return -1;
  }
  if (room.players[leaderIndex].hand.length > 0 || activePlayers(room) < 1) {
    return leaderIndex;
  }
  return nextActivePlayer(room, leaderIndex);
}

function currentPlayFor(room) {
  if (room.game.revealState) {
    return {
      status: "revealed",
      actorName: room.game.revealState.actorName,
      declaredRank: room.game.revealState.declaredRank,
      declaredCount: room.game.revealState.declaredCount,
      cards: room.game.revealState.cards.map(cardLabel),
    };
  }

  if (room.game.lastPlay) {
    return {
      status: "hidden",
      actorName: room.game.lastPlay.actorName,
      declaredRank: room.game.lastPlay.declaredRank,
      declaredCount: room.game.lastPlay.declaredCount,
      cards: [],
    };
  }

  return null;
}

function roomStateFor(room, viewerId) {
  const viewer = room.players.find((player) => player.id === viewerId);
  const actorId = room.game.lastPlay?.actorId || null;
  const currentPlayerEntry = currentPlayer(room);
  const activePlayerCount = activePlayers(room);
  const canAct = room.game.started && currentPlayerEntry?.id === viewerId && !room.game.revealState;
  const canChallenge = canAct && Boolean(room.game.lastPlay) && actorId !== viewerId;
  const canPass = canAct && Boolean(room.game.lastPlay) && actorId !== viewerId;
  const canPlay = canAct;
  const canSurrender =
    room.game.started &&
    !room.game.revealState &&
    activePlayerCount === 2 &&
    Boolean(viewer) &&
    viewer.hand.length > 0;
  const pendingChallenge = room.game.lastPlay
    ? {
        actorId: room.game.lastPlay.actorId,
        actorName: room.game.lastPlay.actorName,
        declaredRank: room.game.lastPlay.declaredRank,
        declaredCount: room.game.lastPlay.declaredCount,
        responseDeadlineAt: room.game.decisionDeadlineAt,
      }
    : null;
  const events = room.game.eventLog.map((event) => viewerEventFor(event, viewerId)).filter(Boolean);
  const rankings = rankingsFor(room).map((entry) => ({
    ...entry,
    isViewer: entry.id === viewerId,
  }));
  const finishedIds = finishedPlayerIds(room);
  const pendingIds = pendingFinishIds(room);

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
      finished: finishedIds.has(player.id),
      pendingFinish: pendingIds.has(player.id),
    })),
    hand: (viewer?.hand || []).map((card) => ({ ...card, label: cardLabel(card) })),
    tableCount: room.game.tableCards.length + (room.game.lastPlay?.cards.length || 0),
    currentPlay: currentPlayFor(room),
    currentRank: room.game.currentRank,
    currentPlayerId: currentPlayerEntry?.id || null,
    activePlayerCount,
    pendingChallenge,
    canStart:
      viewerId === room.hostId &&
      !room.game.started &&
      room.players.length >= MIN_PLAYERS &&
      room.players.length <= room.maxPlayers,
    canRename: Boolean(viewer) && !room.game.started,
    canPlay,
    canChallenge,
    canPass,
    canSurrender,
    lastAction: room.game.lastAction
      ? {
          actorName: room.game.lastAction.actorName,
          declaredRank: room.game.lastAction.declaredRank,
          declaredCount: room.game.lastAction.declaredCount,
        }
      : null,
    lastResolution: room.game.lastResolution,
    events,
    winner: room.game.winnerId,
    rankings,
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

function scheduleDecision(room) {
  clearDecisionTimer(room);
  if (!room.game.lastPlay || room.game.revealState) {
    return;
  }
  room.game.decisionDeadlineAt = Date.now() + DECISION_MS;
  room.game.decisionTimer = setTimeout(() => {
    autoPassTurn(room);
  }, DECISION_MS);
}

function ensureCanPlay(room, playerId) {
  if (!room.game.started) {
    throw new Error("游戏尚未开始");
  }
  if (room.game.revealState) {
    throw new Error("当前正在公开牌面");
  }
  if (currentPlayer(room)?.id !== playerId) {
    throw new Error("还没轮到你");
  }
}

function moveAllTableCardsToDiscard(room) {
  room.game.discardPile.push(...room.game.tableCards);
  if (room.game.lastPlay) {
    room.game.discardPile.push(...room.game.lastPlay.cards);
  }
}

function collectAllTableCards(room, playerId) {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return;
  }
  player.hand.push(...room.game.tableCards);
  if (room.game.lastPlay) {
    player.hand.push(...room.game.lastPlay.cards);
  }
  sortHand(player.hand);
}

function beginNextRound(room, leaderId, resolutionText) {
  settlePendingFinishes(room);
  updateWinner(room);

  const leaderIndex = roundLeaderIndex(room, leaderId);
  if (leaderIndex === -1) {
    return;
  }
  clearRoundState(room);
  room.game.currentPlayerIndex = leaderIndex;
  room.game.lastResolution = resolutionText;
  broadcastRoom(room);
}

function clearTableForRoundWinner(room, leaderId) {
  moveAllTableCardsToDiscard(room);
  beginNextRound(room, leaderId, "其他玩家都选择不出，牌桌上的牌已进入弃牌堆。");
}

function advanceAfterPass(room) {
  const nextIndex = nextResponderIndex(room, room.game.currentPlayerIndex);
  const nextPlayerId = room.players[nextIndex]?.id;
  if (nextPlayerId && nextPlayerId === room.game.lastPlay?.actorId) {
    clearTableForRoundWinner(room, nextPlayerId);
    return;
  }
  room.game.currentPlayerIndex = nextIndex;
  room.game.lastResolution = "有玩家选择不出。";
  scheduleDecision(room);
  broadcastRoom(room);
}

function autoPassTurn(room) {
  if (!room.game.started || room.game.revealState || !room.game.lastPlay) {
    return;
  }
  if (currentPlayer(room)?.id === room.game.lastPlay.actorId) {
    return;
  }
  advanceAfterPass(room);
}

function finishChallengeResolution(room, challengerId) {
  const lastPlay = room.game.lastPlay;
  if (!lastPlay) {
    return;
  }

  const challenger = room.players.find((player) => player.id === challengerId);
  const challengerName = challenger?.name || "有玩家";
  const truthful = lastPlay.cards.every((card) => card.rank === lastPlay.declaredRank || card.rank === "JOKER");
  const collectorId = truthful ? challengerId : lastPlay.actorId;
  const nextLeaderId = truthful ? lastPlay.actorId : challengerId;

  const collectorName = truthful ? challengerName : lastPlay.actorName;
  const cardCount = room.game.tableCards.length + lastPlay.cards.length;
  const resolutionText = truthful
    ? `${challengerName} \u8d28\u7591\u5931\u8d25\uff0c\u6536\u8d70\u724c\u684c\u4e0a\u7684\u6240\u6709\u724c\u3002`
    : `${challengerName} \u8d28\u7591\u6210\u529f\uff0c${lastPlay.actorName} \u6536\u8d70\u724c\u684c\u4e0a\u7684\u6240\u6709\u724c\u3002`;

  pushGameEvent(room, {
    kind: "challenge-resolution",
    truthful,
    challengerId,
    challengerName,
    actorId: lastPlay.actorId,
    actorName: lastPlay.actorName,
  });
  pushGameEvent(room, {
    kind: "collect",
    collectorId,
    collectorName,
    cardCount,
  });

  collectAllTableCards(room, collectorId);
  beginNextRound(room, nextLeaderId, resolutionText);
  return;
}

function playCards(room, playerId, cardIds, declaredRank) {
  ensureCanPlay(room, playerId);

  if (!Array.isArray(cardIds) || cardIds.length < 1) {
    throw new Error("至少选择一张牌");
  }
  if (false && cardIds.length > 4) {
    throw new Error("单次最多出四张牌");
  }
  if (!RANKS.includes(declaredRank)) {
    throw new Error("声明牌面无效");
  }
  if (room.game.currentRank && declaredRank !== room.game.currentRank) {
    throw new Error("跟牌时必须沿用本轮牌面");
  }

  const uniqueIds = [...new Set(cardIds)];
  if (uniqueIds.length !== cardIds.length) {
    throw new Error("出牌包含重复项目");
  }

  const player = room.players[playerIndex(room, playerId)];
  const cards = uniqueIds.map((id) => {
    const card = player.hand.find((entry) => entry.id === id);
    if (!card) {
      throw new Error("存在无效手牌");
    }
    return card;
  });

  player.hand = player.hand.filter((card) => !uniqueIds.includes(card.id));
  markPendingFinish(room, player.id);
  if (room.game.lastPlay) {
    room.game.tableCards.push(...room.game.lastPlay.cards);
  }

  room.game.currentRank = room.game.currentRank || declaredRank;
  room.game.lastPlay = {
    actorId: player.id,
    actorName: player.name,
    declaredRank,
    declaredCount: cards.length,
    cards,
  };
  room.game.lastAction = {
    actorName: player.name,
    declaredRank,
    declaredCount: cards.length,
  };
  pushGameEvent(room, {
    kind: "play",
    actorId: player.id,
    actorName: player.name,
    declaredRank,
    declaredCount: cards.length,
  });
  room.game.lastResolution = null;
  room.game.currentPlayerIndex = nextActivePlayer(room, room.game.currentPlayerIndex);
  scheduleDecision(room);
  updateWinner(room);
  broadcastRoom(room);
}

function challenge(room, challengerId) {
  ensureCanPlay(room, challengerId);
  const lastPlay = room.game.lastPlay;
  if (!lastPlay) {
    throw new Error("当前没有可质疑的上一手");
  }
  if (lastPlay.actorId === challengerId) {
    throw new Error("不能质疑自己");
  }

  clearDecisionTimer(room);
  room.game.revealState = {
    actorName: lastPlay.actorName,
    declaredRank: lastPlay.declaredRank,
    declaredCount: lastPlay.declaredCount,
    cards: lastPlay.cards,
  };
  room.game.lastResolution = "已发起质疑，正在公开上一手牌。";
  broadcastRoom(room);
  clearRevealTimer(room);
  room.game.revealTimer = setTimeout(() => {
    finishChallengeResolution(room, challengerId);
  }, REVEAL_MS);
}

function passTurn(room, playerId) {
  ensureCanPlay(room, playerId);
  if (!room.game.lastPlay) {
    throw new Error("新一轮开始时首家必须先出牌");
  }
  if (room.game.lastPlay.actorId === playerId) {
    throw new Error("当前不能选择不出");
  }
  advanceAfterPass(room);
}

function renamePlayer(room, playerId, name) {
  if (room.game.started) {
    throw new Error("游戏开始后不能修改昵称");
  }
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    throw new Error("玩家不存在");
  }
  player.name = name;
}

function ensureFinished(room, playerId) {
  if (!playerId || room.game.finishOrder.includes(playerId)) {
    return;
  }
  room.game.finishOrder.push(playerId);
}

function removePlayerReferences(room, playerId) {
  room.game.finishOrder = room.game.finishOrder.filter((id) => id !== playerId);
  room.game.pendingFinishOrder = room.game.pendingFinishOrder.filter((id) => id !== playerId);
  if (room.game.surrenderedId === playerId) {
    room.game.surrenderedId = null;
  }
  if (room.game.revealState || room.game.lastPlay?.actorId === playerId) {
    clearRoundState(room);
    room.game.lastAction = null;
  }
}

function normalizeCurrentPlayerIndex(room) {
  if (!room.players.length) {
    room.game.currentPlayerIndex = 0;
    return;
  }
  if (room.game.currentPlayerIndex >= room.players.length) {
    room.game.currentPlayerIndex = room.players.length - 1;
  }
  if (room.game.currentPlayerIndex < 0) {
    room.game.currentPlayerIndex = 0;
  }
}

function settleGameAfterPlayerExit(room, resolutionText) {
  if (!room.game.started) {
    return;
  }
  clearDecisionTimer(room);
  clearRevealTimer(room);
  room.game.revealState = null;

  const remainingActivePlayers = activePlayerEntries(room);
  if (remainingActivePlayers.length === 1) {
    ensureFinished(room, remainingActivePlayers[0].id);
  }

  room.game.started = false;
  room.game.winnerId = room.game.finishOrder[0] || remainingActivePlayers[0]?.id || null;
  room.game.currentRank = null;
  room.game.tableCards = [];
  room.game.lastPlay = null;
  room.game.lastAction = null;
  room.game.lastResolution = resolutionText;
}

function leaveRoom(room, playerId) {
  const index = playerIndex(room, playerId);
  if (index === -1) {
    return false;
  }

  const wasCurrentPlayer = room.game.started && room.game.currentPlayerIndex === index;
  removePlayerReferences(room, playerId);
  room.players.splice(index, 1);

  if (!room.players.length) {
    clearRoundState(room);
    rooms.delete(room.code);
    return true;
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }

  if (room.game.started) {
    if (index < room.game.currentPlayerIndex) {
      room.game.currentPlayerIndex -= 1;
    }
    normalizeCurrentPlayerIndex(room);

    if (activePlayers(room) <= 1) {
      settleGameAfterPlayerExit(room, "有玩家退出房间，本局已直接结算。");
    } else if (wasCurrentPlayer && !room.game.lastPlay) {
      room.game.currentPlayerIndex %= room.players.length;
      room.game.lastResolution = "当前行动玩家已退出，轮到下一位继续。";
    } else {
      room.game.lastResolution = "有玩家退出了房间。";
    }
  }

  broadcastRoom(room);
  return true;
}

function surrender(room, playerId) {
  if (!room.game.started) {
    throw new Error("游戏尚未开始");
  }
  if (room.game.revealState) {
    throw new Error("当前正在结算公开牌面");
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player || player.hand.length === 0) {
    throw new Error("当前不能投降");
  }

  const remainingActivePlayers = activePlayerEntries(room);
  if (remainingActivePlayers.length !== 2) {
    throw new Error("仅剩两名玩家时才能投降");
  }

  const winner = remainingActivePlayers.find((entry) => entry.id !== playerId);
  if (!winner) {
    throw new Error("无法确定获胜玩家");
  }

  clearDecisionTimer(room);
  clearRevealTimer(room);
  room.game.revealState = null;
  room.game.currentRank = null;
  room.game.tableCards = [];
  room.game.lastPlay = null;
  room.game.lastAction = null;
  room.game.pendingFinishOrder = [];
  ensureFinished(room, winner.id);
  room.game.surrenderedId = playerId;
  room.game.started = false;
  room.game.winnerId = room.game.finishOrder[0] || winner.id;
  room.game.lastResolution = `${player.name} 已投降，${winner.name} 获得残局胜位，本局直接结算。`;
  broadcastRoom(room);
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

  if (room.players.every((entry) => !entry.connected)) {
    clearRoundState(room);
    rooms.delete(room.code);
    return;
  }

  if (room.game.started && !room.game.revealState && currentPlayer(room)?.id === playerId) {
    if (room.game.lastPlay && room.game.lastPlay.actorId !== playerId) {
      advanceAfterPass(room);
      return;
    }
    if (!room.game.lastPlay) {
      room.game.currentPlayerIndex = nextActivePlayer(room, room.game.currentPlayerIndex);
    }
  }

  broadcastRoom(room);
}

function handleAuthedMessage(ws, room, playerId, message) {
  if (message.type === "leave-room") {
    leaveRoom(room, playerId);
    clients.delete(playerId);
    ws.playerId = null;
    send(ws, { type: "left-room" });
    return;
  }

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
    return;
  }

  if (message.type === "challenge") {
    challenge(room, playerId);
    return;
  }

  if (message.type === "pass-window") {
    passTurn(room, playerId);
    return;
  }

  if (message.type === "surrender") {
    surrender(room, playerId);
    return;
  }

  if (message.type === "rename-player") {
    renamePlayer(room, playerId, normalizeName(message.name));
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
      const name = normalizeName(message.name);
      const maxPlayers = Number(message.maxPlayers);
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
      const name = normalizeName(message.name);
      const roomCode = String(message.roomCode || "").trim().toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) {
        throw new Error("房间不存在");
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

server.listen(PORT, HOST, () => {
  console.log(`Hu Pai server running at http://${HOST}:${PORT}`);
});
