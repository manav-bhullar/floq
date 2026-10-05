const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
    require(name) {
      assert.ok(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return module.exports;
}

function harness() {
  const calls = [];
  const tx = {};
  let committed = false;
  const prisma = {
    async $transaction(work) {
      const result = await work(tx);
      calls.push('commit');
      committed = true;
      return result;
    },
    trip: { async findUnique() {
      assert.ok(committed, 'Snapshot must be read after commit');
      return { status: 'COMPLETED', tripUsers: [{ userId: 'rider' }],
        driverTrip: { driverProfile: { userId: 'driver' } } };
    } },
  };
  const cache = {
    async invalidateTripCaches(id, users) { calls.push(['cache', id, [...users]]); },
    async invalidateUserRideCaches(id) { calls.push(['user-cache', id]); },
  };
  const socket = { getIo: () => ({ to: user => ({ emit: (event, payload) => {
    assert.ok(committed);
    calls.push(['event', user, event, payload]);
  } }) }) };
  const lifecycle = load('src/socket/lifecycle.js', {
    '../prisma/client': prisma, './socket': socket, '../utils/cache': cache,
  });
  return { ...lifecycle, calls, prisma, cache, tx };
}

test('commit and cache invalidation precede private lifecycle events', async () => {
  const h = harness();
  const result = await h.lifecycleTransaction(async (tx, changes) => {
    assert.equal(tx, h.tx);
    changes.push({ tripId: 'trip', userIds: ['removed-rider', 'rider'] });
    assert.equal(h.calls.length, 0);
    return 'success';
  });
  assert.equal(result, 'success');
  assert.equal(h.calls[0], 'commit');
  assert.equal(h.calls[1][0], 'cache');
  const events = h.calls.filter(c => c[0] === 'event');
  assert.equal(events.length, 6); // two events per unique rider/driver
  assert.deepEqual([...new Set(events.map(c => c[1]))], ['removed-rider', 'rider', 'driver']);
  assert.ok(events.every(c => c[3].status === 'COMPLETED' && !('tripUsers' in c[3])));
});

test('rollback publishes nothing', async () => {
  const h = harness();
  await assert.rejects(h.lifecycleTransaction(async (tx, changes) => {
    changes.push({ tripId: 'trip' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(h.calls.length, 0);
});

test('notification outage cannot fail an already committed mutation', async () => {
  const h = harness();
  h.prisma.trip.findUnique = async () => { throw new Error('Database read down'); };
  assert.equal(await h.lifecycleTransaction(async (tx, changes) => {
    changes.push({ tripId: 'trip' });
    return 'committed';
  }), 'committed');
  assert.deepEqual(h.calls, ['commit']);
});

for (const [method, initialStatus, driverStatus] of [
  ['acceptTrip', 'RIDERS_MATCHED', 'ACCEPTED'],
  ['startTrip', 'DRIVER_MATCHED', 'ACCEPTED'],
  ['completeTrip', 'STARTED', 'STARTED'],
]) {
  test(`${method} queues an event and includes the driver`, async () => {
    const h = harness();
    Object.assign(h.tx, {
      driverProfile: { findUnique: async () => ({ id: 'profile' }) },
      driverTrip: {
        findFirst: async () => null,
        findUnique: async () => ({ id: 'assignment', driverProfileId: 'profile', status: driverStatus }),
        create: async () => ({ id: 'assignment' }),
        updateMany: async () => ({ count: 1 }),
      },
      trip: {
        findUnique: async () => ({ status: initialStatus, tripUsers: [
          { userId: 'rider', rideRequestId: 'ride', rideRequest: { preferredTime: new Date(Date.now() + 60000) } },
        ] }),
        updateMany: async () => ({ count: 1 }),
      },
      rideRequest: { updateMany: async () => ({ count: 1 }) },
    });
    const driver = load('src/modules/driver/driver.service.js', {
      '../../socket/lifecycle': h, '../../prisma/client': h.prisma, '../../utils/cache': {},
    });
    await driver[method]('driver', 'trip');
    assert.ok(h.calls.some(c => c[0] === 'event' && c[1] === 'driver' && c[2] === 'trip_updated'));
  });
}

test('cascade cancellation notifies removed co-riders after commit', async () => {
  const h = harness();
  Object.assign(h.tx, {
    rideRequest: {
      findUnique: async () => ({ userId: 'rider', status: 'RIDERS_MATCHED' }),
      update: async () => ({}), updateMany: async () => ({ count: 1 }),
    },
    tripUser: {
      findUnique: async () => ({ tripId: 'trip' }),
      findMany: async () => [
        { userId: 'rider', rideRequestId: 'ride' },
        { userId: 'removed-rider', rideRequestId: 'co-ride' },
      ],
      deleteMany: async () => ({ count: 1 }),
    },
    trip: { findUnique: async () => ({ status: 'DRIVER_MATCHED' }), updateMany: async () => ({ count: 1 }) },
    driverTrip: { findUnique: async () => ({ id: 'assignment' }), update: async () => ({}) },
  });
  const service = load('src/modules/rideRequest/rideRequest.service.js', {
    '../../socket/lifecycle': h, '../../prisma/client': h.prisma, '../../utils/cache': {},
  });
  await service.cancelRideRequest('ride', 'rider');
  assert.ok(h.calls.some(c => c[0] === 'event' && c[1] === 'removed-rider'));
  assert.equal(h.calls[0], 'commit');
});

test('scheduler expires pending requests even with an empty matching pool', async () => {
  const changes = [];
  let expired = false;
  const tx = {
    $queryRaw: async (strings) => {
      if (strings.join('').includes('FROM "Trip"')) return [];
      assert.ok(expired, 'Expiry must run before fetching match candidates');
      return [];
    },
    rideRequest: {
      findMany: async ({ where }) => {
        assert.equal(where.status, 'PENDING');
        assert.ok(where.preferredTime.lt);
        assert.ok(!where.id, 'Expired rides must not be restricted to the future-only pool');
        return [{ id: 'expired', userId: 'rider' }];
      },
      updateMany: async ({ data }) => { expired = data.status === 'CANCELLED'; return { count: 1 }; },
      count: async () => 0,
    },
  };
  const scheduler = load('src/modules/integrations/matchingIntegration.js', {
    '../matching/matchingEngine': { runMatchingBatch: () => [] },
    '../trip/trip.service': {},
    '../trip/expansion.service': { runExpansionPhase: async () => ({ expandedCount: 0 }) },
    '../../prisma/client': { rideRequest: { count: async () => 0 }, matchCycleLog: { create: async () => ({}) } },
    '../../socket/lifecycle': { lifecycleTransaction: async work => work(tx, changes) },
  });
  const result = await scheduler.runMatchingCycle();
  assert.equal(result.autoCancelledCount, 1);
  assert.equal(changes[0].rideRequestId, 'expired');
  assert.equal(changes[0].status, 'CANCELLED');
});


test('trip endpoint preserves forbidden status for requeued riders', async () => {
  let status;
  const controller = load('src/modules/trip/trip.controller.js', {
    '../../prisma/client': {},
    './trip.service': { getTripById: async () => { throw { code: 403, message: 'Forbidden' }; } },
    '../../utils/response': { error: (res, message, code) => { status = code; } },
    './trip.utils': {}, '../../utils/redis': {},
  });
  await controller.getTripById({ userId: 'removed-rider', params: { id: 'trip' } }, {});
  assert.equal(status, 403);
});
