const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

function mockModule(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Test the real Socket.IO server and JWT handshake without touching a database.
const trip = { id: 'trip', status: 'COMPLETED', tripUsers: [{ userId: 'rider' }],
  driverTrip: { driverProfile: { userId: 'driver' } } };
let committed = false;
let invalidated = false;
mockModule('../src/prisma/client', {
  trip: { findUnique: async () => trip },
  $transaction: async work => { const result = await work({}); committed = true; return result; },
});
mockModule('../src/utils/cache', {
  invalidateTripCaches: async () => { assert.ok(committed); invalidated = true; },
  invalidateUserRideCaches: async () => {},
});
const { initSocket, getIo } = require('../src/socket/socket');
const { generateAccessToken } = require('../src/utils/jwt');
const { lifecycleTransaction } = require('../src/socket/lifecycle');

test('real transport authenticates JWTs and delivers committed events only to participants', async () => {
  const server = http.createServer();
  const io = initSocket(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/socket.io/?EIO=4&transport=polling`;
  async function request(url, options) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    return response.text();
  }
  async function connect(token) {
    const open = await request(base);
    const sid = JSON.parse(open.slice(1)).sid;
    const url = `${base}&sid=${sid}`;
    await request(url, { method: 'POST', body: `40${JSON.stringify({ token })}` });
    const handshake = await request(url);
    return { url, handshake };
  }
  try {
    const rider = await connect(generateAccessToken({ id: 'rider' }));
    const driver = await connect(generateAccessToken({ id: 'driver' }));
    const unrelated = await connect(generateAccessToken({ id: 'other' }));
    for (const client of [rider, driver, unrelated]) assert.ok(client.handshake.startsWith('40'));
    const invalid = await connect('invalid-token');
    assert.ok(invalid.handshake.startsWith('44'));
    assert.match(invalid.handshake, /Authentication error/);

    await lifecycleTransaction(async (tx, changes) => {
      changes.push({ tripId: 'trip' });
      assert.equal(invalidated, false);
    });
    assert.ok(invalidated);
    for (const client of [rider, driver]) {
      const packets = await request(client.url);
      assert.match(packets, /trip_updated/);
      assert.match(packets, /ride_request_updated/);
      assert.match(packets, /COMPLETED/);
      assert.ok(!packets.includes('tripUsers'));
    }
    trip.status = 'CANCELLED';
    await lifecycleTransaction(async (tx, changes) => { changes.push({ tripId: 'trip' }); });
    const cancelledPackets = await request(driver.url);
    assert.match(cancelledPackets, /trip_cancelled/);
    getIo().to('other').emit('probe', { ok: true });
    const otherPackets = await request(unrelated.url);
    assert.match(otherPackets, /probe/);
    assert.ok(!otherPackets.includes('trip_updated'));
  } finally {
    await new Promise(resolve => io.close(resolve));
  }
});
