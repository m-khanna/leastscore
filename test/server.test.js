// Tests for reconnection / seat-reclaim logic and server timing config.
// Run with: npm test  (uses Node's built-in test runner)
const test = require('node:test');
const assert = require('node:assert');
const { resolveJoin, SERVER_OPTIONS } = require('../server.js');

function makePlayer(overrides = {}) {
  return {
    playerId: 'pid-' + (overrides.name || 'x'),
    socketId: 'old-socket',
    name: 'Alice',
    hand: [],
    cumulativeScore: 0,
    eliminated: false,
    connected: true,
    disconnectedAt: null,
    lastAction: null,
    ...overrides,
  };
}

function makeGame(overrides = {}) {
  return {
    id: '123',
    hostPlayerId: 'pid-Alice',
    state: 'awaitingMove',
    players: [makePlayer()],
    ...overrides,
  };
}

test('reconnecting with same name reclaims the seat even while old socket still looks connected', () => {
  const game = makeGame();
  // Old socket is still marked connected (the ghost-socket window).
  assert.strictEqual(game.players[0].connected, true);
  assert.strictEqual(game.players[0].socketId, 'old-socket');

  const res = resolveJoin(game, { name: 'Alice', socketId: 'new-socket' });

  assert.strictEqual(res.type, 'reclaim', 'should reclaim, not reject');
  assert.strictEqual(res.player.socketId, 'new-socket');
  assert.strictEqual(res.player.connected, true);
  assert.strictEqual(res.player.disconnectedAt, null);
  // Caller must boot the displaced ghost socket.
  assert.strictEqual(res.displacedSocketId, 'old-socket');
});

test('reconnecting from the same socket id does not report a displaced socket', () => {
  const game = makeGame();
  const res = resolveJoin(game, { name: 'Alice', socketId: 'old-socket' });
  assert.strictEqual(res.type, 'reclaim');
  assert.strictEqual(res.displacedSocketId, null);
});

test('name match is case-insensitive', () => {
  const game = makeGame();
  const res = resolveJoin(game, { name: 'ALICE', socketId: 'new-socket' });
  assert.strictEqual(res.type, 'reclaim');
});

test('a new name can join a game still in the lobby', () => {
  const game = makeGame({ state: 'lobby' });
  const res = resolveJoin(game, { name: 'Bob', socketId: 's2' });
  assert.strictEqual(res.type, 'new');
  assert.strictEqual(res.player.name, 'Bob');
  assert.strictEqual(game.players.length, 2);
});

test('a new name is rejected once the game has started', () => {
  const game = makeGame({ state: 'awaitingMove' });
  const res = resolveJoin(game, { name: 'Carol', socketId: 's3' });
  assert.strictEqual(res.type, 'error');
});

test('a full lobby rejects a new player', () => {
  const players = [];
  for (let i = 0; i < 6; i++) players.push(makePlayer({ name: 'P' + i, playerId: 'pid-' + i }));
  const game = makeGame({ state: 'lobby', players });
  const res = resolveJoin(game, { name: 'P7', socketId: 's7' });
  assert.strictEqual(res.type, 'error');
});

test('server uses shortened ping interval/timeout for faster disconnect detection', () => {
  assert.ok(SERVER_OPTIONS, 'SERVER_OPTIONS should be exported');
  assert.ok(SERVER_OPTIONS.pingInterval <= 10000, 'pingInterval should be <= 10s');
  assert.ok(SERVER_OPTIONS.pingTimeout <= 10000, 'pingTimeout should be <= 10s');
});
