// End-to-end test of the reconnect / ghost-socket window using real sockets.
// Reproduces the original bug: a client reconnects (new socket) while the
// server still believes the old socket is connected. Before the fix this was
// rejected with "already connected"; now the seat is reclaimed and the old
// ghost socket is booted.
const test = require('node:test');
const assert = require('node:assert');
const { io: ioClient } = require('socket.io-client');
const { server } = require('../server.js');

function listen() {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function connect(port) {
  return ioClient(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
}

// Resolve when `event` fires; reject on timeout so a hung socket fails loudly.
function once(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

test('reconnecting with the same name while the old socket is still connected reclaims the seat', async (t) => {
  const port = await listen();
  const sockets = [];
  t.after(() => {
    for (const s of sockets) s.close();
    return new Promise((r) => server.close(r));
  });

  // Host creates a game.
  const host = connect(port); sockets.push(host);
  await once(host, 'connect');
  host.emit('createGame', { name: 'Host' });
  const { gameId } = await once(host, 'joined');

  // "Alice" joins on her first socket.
  const alice1 = connect(port); sockets.push(alice1);
  await once(alice1, 'connect');
  alice1.emit('joinGame', { gameId, name: 'Alice' });
  await once(alice1, 'joined');

  // Alice's first socket is still fully connected (the ghost window). A second
  // socket reconnects with the same name + game id.
  const alice2 = connect(port); sockets.push(alice2);
  await once(alice2, 'connect');
  const aliceBooted = once(alice1, 'disconnect');
  alice2.emit('joinGame', { gameId, name: 'Alice' });

  const rejoined = await once(alice2, 'joined');
  assert.strictEqual(rejoined.gameId, gameId, 'new socket should be re-seated, not rejected');

  // The old ghost socket should be booted by the server.
  await aliceBooted;
  assert.strictEqual(alice1.connected, false, 'old ghost socket should be disconnected');
});
