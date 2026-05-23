// Least Score - online multiplayer card game server.
// All game logic lives here. Clients only send actions and render what the
// server tells them. Per-player views are filtered so no player ever sees
// another player's hand.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Least Score listening on :${PORT}`));

// ---------- Game state shape ----------
// games[gameId] = {
//   id, hostPlayerId, createdAt,
//   state: 'lobby' | 'awaitingMove' | 'roundEnd' | 'gameEnd',
//   numDecks,
//   settings: { eliminateAt, turnTimerEnabled },
//   players: [{ playerId, socketId, name, hand, cumulativeScore, eliminated, connected, disconnectedAt }],
//   deck, discardPile (array of groups, last = top),
//   currentTurnIdx, round, roundStarterIdx,
//   turnsTakenThisRound,        // for unlocking declare after the first pass of turns
//   turnDeadline, turnTimerId,
//   roundHistory: [ { round, declarerId, correct, perPlayer: { playerId: pointsAdded } } ],
//   lastRoundResult,
// }
const games = {};
const TURN_DURATION_MS = 60_000;

// ---------- Card helpers ----------
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function buildDeck(numDecks) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  }
  return shuffle(deck);
}

// Fisher-Yates with crypto.randomInt for fair shuffling.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardValue(card) {
  if (card.rank === 'A') return 1;
  if (['J', 'Q', 'K'].includes(card.rank)) return 10;
  return parseInt(card.rank, 10);
}

function handTotal(hand) {
  return hand.reduce((s, c) => s + cardValue(c), 0);
}

const RANK_PRIMARY = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 };

// ---------- Discard validation ----------
// Valid:
//   - single card
//   - pair (2 of same rank)
//   - four-of-a-kind
//   - sequence of exactly 3 or 5 consecutive ranks (any suits, ace low OR high, no wrap)
//   - 5-card flush (same suit)
// Three-of-a-kind is NOT valid.
function validateDiscard(cards) {
  const n = cards.length;
  if (n < 1) return false;
  if (n === 1) return true;
  if (n === 2) return cards[0].rank === cards[1].rank;
  if (n === 4) return cards.every(c => c.rank === cards[0].rank);
  if (n === 3) return isSequence(cards);
  if (n === 5) return isSequence(cards) || isFlush(cards);
  return false;
}

function isFlush(cards) {
  return cards.every(c => c.suit === cards[0].suit);
}

function isSequence(cards) {
  const aces = cards.filter(c => c.rank === 'A').length;
  const nonAceVals = cards.filter(c => c.rank !== 'A').map(c => RANK_PRIMARY[c.rank]);
  if (new Set(nonAceVals).size !== nonAceVals.length) return false;

  for (let lowAces = 0; lowAces <= aces; lowAces++) {
    const highAces = aces - lowAces;
    const vals = [...nonAceVals];
    for (let i = 0; i < lowAces; i++) vals.push(1);
    for (let i = 0; i < highAces; i++) vals.push(14);
    if (new Set(vals).size !== vals.length) continue;
    vals.sort((a, b) => a - b);
    let ok = true;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] !== vals[i - 1] + 1) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// ---------- Game id ----------
function newGameId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) id += alphabet[crypto.randomInt(0, alphabet.length)];
  } while (games[id]);
  return id;
}

function newPlayerId() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------- Round / deal ----------
function startRound(game, starterIdx) {
  clearTurnTimer(game);
  const activePlayers = game.players.filter(p => !p.eliminated);
  game.numDecks = activePlayers.length >= 5 ? 2 : 1;
  game.deck = buildDeck(game.numDecks);
  for (const p of game.players) {
    p.hand = p.eliminated ? [] : game.deck.splice(0, 5);
  }
  // Place the round's initial face-up card so the first player has a
  // pick-from-discard option, just like every subsequent player.
  const faceUp = game.deck.shift();
  game.discardPile = faceUp ? [[faceUp]] : [];

  game.currentTurnIdx = starterIdx;
  while (game.players[game.currentTurnIdx].eliminated) {
    game.currentTurnIdx = (game.currentTurnIdx + 1) % game.players.length;
  }
  game.roundStarterIdx = game.currentTurnIdx;
  game.turnsTakenThisRound = 0;
  game.state = 'awaitingMove';
  game.lastRoundResult = null;
  startTurnTimer(game);
}

function advanceTurn(game) {
  do {
    game.currentTurnIdx = (game.currentTurnIdx + 1) % game.players.length;
  } while (game.players[game.currentTurnIdx].eliminated);
}

function refillDeckIfNeeded(game) {
  if (game.deck.length > 0) return;
  if (game.discardPile.length <= 1) return;
  const top = game.discardPile[game.discardPile.length - 1];
  const rest = game.discardPile.slice(0, -1).flat();
  game.deck = shuffle(rest);
  game.discardPile = [top];
}

// ---------- Turn timer ----------
function clearTurnTimer(game) {
  if (game.turnTimerId) {
    clearTimeout(game.turnTimerId);
    game.turnTimerId = null;
  }
  game.turnDeadline = null;
}

function startTurnTimer(game) {
  clearTurnTimer(game);
  if (!game.settings.turnTimerEnabled) return;
  if (game.state !== 'awaitingMove') return;
  game.turnDeadline = Date.now() + TURN_DURATION_MS;
  game.turnTimerId = setTimeout(() => autoPlayCurrentTurn(game), TURN_DURATION_MS);
}

// Auto-action when the turn timer fires: discard one random card and draw
// from the deck (hidden), then advance.
function autoPlayCurrentTurn(game) {
  const player = game.players[game.currentTurnIdx];
  if (!player || player.eliminated || game.state !== 'awaitingMove') return;

  if (player.hand.length === 0) {
    advanceTurn(game);
    startTurnTimer(game);
    broadcastState(game);
    return;
  }

  const i = crypto.randomInt(0, player.hand.length);
  const card = player.hand.splice(i, 1)[0];

  refillDeckIfNeeded(game);
  if (game.deck.length > 0) player.hand.push(game.deck.shift());

  game.discardPile.push([card]);
  game.turnsTakenThisRound += 1;
  advanceTurn(game);
  startTurnTimer(game);
  broadcastState(game);
}

// ---------- Per-player view ----------
function viewFor(game, playerId) {
  const me = game.players.find(p => p.playerId === playerId);
  const myHand = me ? me.hand : [];
  const activeCount = game.players.filter(p => !p.eliminated).length;
  // Declare is blocked only during the opening phase of round 1, until every
  // active player has completed their first turn. After that it's available.
  const canDeclare = game.round > 1 || (game.turnsTakenThisRound || 0) >= activeCount;
  return {
    id: game.id,
    state: game.state,
    round: game.round,
    numDecks: game.numDecks,
    hostPlayerId: game.hostPlayerId,
    settings: game.settings,
    currentPlayerId: game.players[game.currentTurnIdx]?.playerId ?? null,
    deckCount: game.deck.length,
    discardTop: game.discardPile.length ? game.discardPile[game.discardPile.length - 1] : [],
    turnDeadline: game.turnDeadline,
    canDeclare,
    turnsTakenThisRound: game.turnsTakenThisRound || 0,
    activeCount,
    players: game.players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      score: p.cumulativeScore,
      cardCount: p.hand.length,
      eliminated: p.eliminated,
      connected: p.connected,
      isHost: p.playerId === game.hostPlayerId,
    })),
    you: me ? {
      playerId: me.playerId,
      name: me.name,
      hand: myHand,
      handTotal: handTotal(myHand),
      score: me.cumulativeScore,
      eliminated: me.eliminated,
      isHost: me.playerId === game.hostPlayerId,
      isYourTurn: game.players[game.currentTurnIdx]?.playerId === me.playerId && !me.eliminated,
    } : null,
    lastRoundResult: game.lastRoundResult,
    roundHistory: game.roundHistory,
  };
}

function broadcastState(game) {
  for (const p of game.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('state', viewFor(game, p.playerId));
    }
  }
}

function sendError(socket, message) {
  socket.emit('errorMsg', { message });
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {
  socket.on('createGame', ({ name }) => {
    name = sanitizeName(name);
    if (!name) return sendError(socket, 'Please enter a name.');
    const gameId = newGameId();
    const playerId = newPlayerId();
    const game = {
      id: gameId,
      hostPlayerId: playerId,
      createdAt: Date.now(),
      state: 'lobby',
      numDecks: 1,
      settings: { eliminateAt: 100, turnTimerEnabled: false },
      players: [{
        playerId, socketId: socket.id, name,
        hand: [], cumulativeScore: 0, eliminated: false,
        connected: true, disconnectedAt: null,
      }],
      deck: [], discardPile: [],
      currentTurnIdx: 0, round: 0, roundStarterIdx: 0,
      turnsTakenThisRound: 0,
      turnDeadline: null, turnTimerId: null,
      roundHistory: [], lastRoundResult: null,
    };
    games[gameId] = game;
    socket.data.gameId = gameId;
    socket.data.playerId = playerId;
    socket.join(gameId);
    socket.emit('joined', { gameId, playerId });
    broadcastState(game);
  });

  socket.on('joinGame', ({ gameId, name }) => {
    gameId = (gameId || '').toUpperCase().trim();
    name = sanitizeName(name);
    if (!name) return sendError(socket, 'Please enter a name.');
    const game = games[gameId];
    if (!game) return sendError(socket, 'Game not found.');

    // Reconnect path: same name re-attaches to the existing seat.
    const existing = game.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.connected && existing.socketId && existing.socketId !== socket.id) {
        return sendError(socket, 'A player with that name is already connected.');
      }
      existing.socketId = socket.id;
      existing.connected = true;
      existing.disconnectedAt = null;
      socket.data.gameId = gameId;
      socket.data.playerId = existing.playerId;
      socket.join(gameId);
      socket.emit('joined', { gameId, playerId: existing.playerId });
      broadcastState(game);
      return;
    }

    if (game.state !== 'lobby') return sendError(socket, 'Game already started — only existing players can rejoin.');
    if (game.players.length >= 6) return sendError(socket, 'Game is full (max 6 players).');

    const playerId = newPlayerId();
    game.players.push({
      playerId, socketId: socket.id, name,
      hand: [], cumulativeScore: 0, eliminated: false,
      connected: true, disconnectedAt: null,
    });
    socket.data.gameId = gameId;
    socket.data.playerId = playerId;
    socket.join(gameId);
    socket.emit('joined', { gameId, playerId });
    broadcastState(game);
  });

  socket.on('updateSettings', ({ eliminateAt, turnTimerEnabled }) => {
    const game = games[socket.data.gameId];
    if (!game) return;
    if (socket.data.playerId !== game.hostPlayerId) return;
    if (game.state !== 'lobby') return;
    if (eliminateAt !== undefined) {
      const v = Number(eliminateAt);
      if ([50, 75, 100, 150, 200].includes(v)) game.settings.eliminateAt = v;
    }
    if (turnTimerEnabled !== undefined) {
      game.settings.turnTimerEnabled = !!turnTimerEnabled;
    }
    broadcastState(game);
  });

  socket.on('startGame', () => {
    const game = games[socket.data.gameId];
    if (!game) return;
    if (socket.data.playerId !== game.hostPlayerId) return sendError(socket, 'Only the host can start.');
    if (game.state !== 'lobby') return;
    if (game.players.length < 2) return sendError(socket, 'Need at least 2 players.');
    game.round = 1;
    game.roundHistory = [];
    for (const p of game.players) p.cumulativeScore = 0;
    startRound(game, 0);
    broadcastState(game);
  });

  // Single-step "move": discard a valid combo AND pick one card, all in
  // one action. pickSource is 'deck' or 'discard'; pickCardIdx is required
  // when pickSource is 'discard'.
  socket.on('move', ({ cardIndices, pickSource, pickCardIdx }) => {
    const game = games[socket.data.gameId];
    if (!game || game.state !== 'awaitingMove') return;
    const player = game.players[game.currentTurnIdx];
    if (player.playerId !== socket.data.playerId) return;

    if (!Array.isArray(cardIndices) || cardIndices.length === 0) {
      return sendError(socket, 'Select at least one card to discard.');
    }
    const unique = [...new Set(cardIndices.map(Number))].sort((a, b) => b - a);
    if (unique.some(i => !Number.isInteger(i) || i < 0 || i >= player.hand.length)) {
      return sendError(socket, 'Invalid card selection.');
    }
    const selected = unique.map(i => player.hand[i]);
    if (!validateDiscard(selected)) {
      return sendError(socket, 'Invalid discard combination.');
    }

    // Pre-validate pick (no mutation yet)
    let pickIdx = -1;
    if (pickSource === 'discard') {
      const top = game.discardPile[game.discardPile.length - 1];
      if (!top || top.length === 0) return sendError(socket, 'No card available in discard.');
      pickIdx = Number(pickCardIdx);
      if (!Number.isInteger(pickIdx) || pickIdx < 0 || pickIdx >= top.length) {
        return sendError(socket, 'Invalid discard pick.');
      }
    } else if (pickSource !== 'deck') {
      return sendError(socket, 'Pick source must be deck or discard.');
    }

    // Mutate: remove discard cards from hand
    for (const i of unique) player.hand.splice(i, 1);

    // Perform pick
    if (pickSource === 'deck') {
      refillDeckIfNeeded(game);
      if (game.deck.length > 0) player.hand.push(game.deck.shift());
    } else {
      const top = game.discardPile[game.discardPile.length - 1];
      player.hand.push(top.splice(pickIdx, 1)[0]);
      if (top.length === 0) game.discardPile.pop();
    }

    // Commit the discarded group as the new top
    game.discardPile.push(selected);
    game.turnsTakenThisRound += 1;
    advanceTurn(game);
    startTurnTimer(game);
    broadcastState(game);
  });

  socket.on('declare', () => {
    const game = games[socket.data.gameId];
    if (!game || game.state !== 'awaitingMove') return;
    const activeCount = game.players.filter(p => !p.eliminated).length;
    if (game.round <= 1 && (game.turnsTakenThisRound || 0) < activeCount) {
      return sendError(socket, 'Declare unlocks after everyone has played their first turn.');
    }
    const player = game.players[game.currentTurnIdx];
    if (player.playerId !== socket.data.playerId) return;
    clearTurnTimer(game);
    resolveDeclare(game, player);
    broadcastState(game);
  });

  socket.on('nextRound', () => {
    const game = games[socket.data.gameId];
    if (!game) return;
    if (socket.data.playerId !== game.hostPlayerId) return;
    if (game.state !== 'roundEnd') return;
    let idx = (game.roundStarterIdx + 1) % game.players.length;
    while (game.players[idx].eliminated) idx = (idx + 1) % game.players.length;
    game.round += 1;
    startRound(game, idx);
    broadcastState(game);
  });

  socket.on('disconnect', () => {
    const gameId = socket.data.gameId;
    if (!gameId) return;
    const game = games[gameId];
    if (!game) return;
    const player = game.players.find(p => p.socketId === socket.id);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    if (game.state === 'lobby') {
      // In the lobby, drop the player from the seat list.
      game.players = game.players.filter(p => p.playerId !== player.playerId);
      if (game.players.length === 0) {
        clearTurnTimer(game);
        delete games[gameId];
        return;
      }
      if (game.hostPlayerId === player.playerId) {
        game.hostPlayerId = game.players[0].playerId;
      }
    }
    // In an active game, keep the seat: the player may rejoin at any time
    // with the same name + game ID. If the turn timer is enabled, their
    // turn will auto-play on timeout.
    broadcastState(game);
  });
});

function resolveDeclare(game, declarer) {
  const active = game.players.filter(p => !p.eliminated);
  const totals = active.map(p => ({ p, total: handTotal(p.hand) }));
  const declarerTotal = totals.find(t => t.p.playerId === declarer.playerId).total;
  const minTotal = Math.min(...totals.map(t => t.total));
  const strictlyLowest = declarerTotal === minTotal && totals.filter(t => t.total === minTotal).length === 1;

  // Scoring: each non-declarer gets the difference between their hand total
  // and the declarer's hand total. On a correct declare this is always ≥ 0;
  // on a wrong declare the player(s) who actually beat the declarer get a
  // negative (i.e. a credit against their cumulative score).
  const perPlayer = {};
  for (const t of totals) perPlayer[t.p.playerId] = 0;
  for (const p of game.players) if (p.eliminated) perPlayer[p.playerId] = 0;

  if (strictlyLowest) {
    for (const t of totals) {
      if (t.p.playerId !== declarer.playerId) {
        const delta = t.total - declarerTotal;
        t.p.cumulativeScore += delta;
        perPlayer[t.p.playerId] = delta;
      }
    }
  } else {
    declarer.cumulativeScore += 40;
    perPlayer[declarer.playerId] = 40;
    for (const t of totals) {
      if (t.p.playerId !== declarer.playerId) {
        const delta = t.total - declarerTotal;
        t.p.cumulativeScore += delta;
        perPlayer[t.p.playerId] = delta;
      }
    }
  }

  game.roundHistory.push({
    round: game.round,
    declarerId: declarer.playerId,
    correct: strictlyLowest,
    perPlayer,
  });

  game.lastRoundResult = {
    declarerId: declarer.playerId,
    correct: strictlyLowest,
    declarerTotal,
    hands: game.players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      hand: [...p.hand],
      total: p.eliminated ? null : handTotal(p.hand),
      eliminated: p.eliminated,
    })),
  };

  const threshold = game.settings.eliminateAt;
  for (const p of game.players) {
    if (!p.eliminated && p.cumulativeScore >= threshold) p.eliminated = true;
  }
  game.state = 'roundEnd';
  checkGameOver(game);
}

function checkGameOver(game) {
  const remaining = game.players.filter(p => !p.eliminated);
  if (remaining.length <= 1) {
    game.state = 'gameEnd';
    clearTurnTimer(game);
  }
}

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.trim().slice(0, 20);
}
