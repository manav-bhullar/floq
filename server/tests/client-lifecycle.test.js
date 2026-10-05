const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
function harness({ initialError = false } = {}) {
  const handlers = new Map();
  const windowHandlers = new Map();
  const documentHandlers = new Map();
  const effects = [];
  const actions = [];
  let socketOptions;
  let disconnected = false;
  let snapshot = { trip: { id: 'trip', status: 'STARTED' }, ride: null };
  let tripRead = async () => snapshot.trip;
  let previousRead = async () => ({ id: 'trip', status: 'COMPLETED' });
  const apiClient = { accessToken: 'first-token', async refreshToken() { this.accessToken = 'new-token'; } };
  const source = fs.readFileSync(path.join(__dirname, '../../client/src/hooks/useGlobalSocket.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('import.meta.env.VITE_API_URL', 'undefined')
    .replace('export function useGlobalSocket', 'function useGlobalSocket');
  const context = {
    useEffect: effect => effects.push(effect), useRef: value => ({ current: value }),
    useApp: () => ({ state: { trip: null }, dispatch: action => actions.push(action) }),
    useAuth: () => ({ user: { id: 'user' }, loading: false }),
    io: (url, options) => {
      socketOptions = options;
      return { on: (event, fn) => handlers.set(event, fn), connect() {},
        disconnect() { disconnected = true; } };
    },
    apiClient,
    getCurrentRideRequest: async () => snapshot.ride,
    getCurrentTrip: () => initialError ? Promise.reject(new Error('offline')) : tripRead(),
    getTripById: () => previousRead(),
    window: { addEventListener: (key, fn) => windowHandlers.set(key, fn),
      removeEventListener: key => windowHandlers.delete(key) },
    document: { visibilityState: 'visible', addEventListener: (key, fn) => documentHandlers.set(key, fn),
      removeEventListener: key => documentHandlers.delete(key) },
    console: { error() {} },
    setInterval: () => { throw new Error('Polling must not be used'); },
  };
  vm.runInNewContext(source + '\nuseGlobalSocket();', context);
  const cleanups = effects.map(fn => fn()).filter(Boolean);
  return {
    actions, handlers, apiClient,
    setSnapshot(value) { snapshot = value; },
    setTripRead(fn) { tripRead = fn; },
    setPreviousRead(fn) { previousRead = fn; },
    cleanup() { cleanups.forEach(fn => fn()); },
    get options() { return socketOptions; },
    get disconnected() { return disconnected; },
    windowHandlers, documentHandlers,
  };
}

test('initial snapshot, event refresh and reconnect need no polling', async () => {
  const h = harness();
  await flush();
  assert.equal(h.actions.at(-1).payload.trip.status, 'STARTED');
  h.setSnapshot({ trip: { id: 'trip', status: 'DRIVER_MATCHED' }, ride: null });
  await h.handlers.get('trip_updated')({ tripId: 'trip' });
  assert.equal(h.actions.at(-1).payload.trip.status, 'DRIVER_MATCHED');
  h.setSnapshot({ trip: { id: 'trip', status: 'STARTED' }, ride: null });
  await h.handlers.get('connect')();
  assert.equal(h.actions.at(-1).payload.trip.status, 'STARTED');
  h.apiClient.accessToken = 'refreshed';
  h.options.auth(data => assert.equal(data.token, 'refreshed'));
  h.cleanup();
  assert.ok(h.disconnected);
  assert.equal(h.windowHandlers.size + h.documentHandlers.size, 0);
});

test('completion fetches terminal trip when active endpoint returns null', async () => {
  const h = harness();
  await flush();
  h.setSnapshot({ trip: null, ride: null });
  await h.handlers.get('trip_updated')({ tripId: 'trip', status: 'COMPLETED' });
  assert.equal(h.actions.at(-1).payload.trip.status, 'COMPLETED');
});

test('cascade cancellation keeps the requeued request and clears former trip', async () => {
  const h = harness();
  await flush();
  h.setSnapshot({ trip: null, ride: { id: 'ride', status: 'PENDING' } });
  h.setPreviousRead(async () => { throw { status: 403 }; });
  await h.handlers.get('trip_updated')({ tripId: 'trip', status: 'CANCELLED', reason: 'Requeued' });
  assert.equal(h.actions.at(-1).payload.trip, null);
  assert.equal(h.actions.at(-1).payload.rideRequest.status, 'PENDING');
  assert.equal(h.actions.at(-1).payload.reason, 'Requeued');
});

test('event arriving during HTTP fetch discards stale response', async () => {
  const h = harness();
  await flush();
  const initialCount = h.actions.length;
  let resolve;
  h.setTripRead(() => new Promise(done => { resolve = done; }));
  const pending = h.handlers.get('trip_updated')({});
  await flush();
  h.setTripRead(async () => ({ id: 'trip', status: 'COMPLETED' }));
  await h.handlers.get('ride_request_updated')({});
  resolve({ id: 'trip', status: 'STARTED' });
  await pending;
  assert.equal(h.actions.length, initialCount + 1);
  assert.equal(h.actions.at(-1).payload.trip.status, 'COMPLETED');
});

test('cleanup prevents delayed snapshot from updating logged-out session', async () => {
  const h = harness();
  await flush();
  let resolve;
  h.setTripRead(() => new Promise(done => { resolve = done; }));
  const pending = h.handlers.get('trip_updated')({});
  await flush();
  const initialCount = h.actions.length;
  h.cleanup();
  resolve({ id: 'trip', status: 'STARTED' });
  await pending;
  assert.equal(h.actions.length, initialCount);
});

test('failed initial fetch ends loading and surfaces error', async () => {
  const h = harness({ initialError: true });
  await flush();
  assert.equal(h.actions[0].type, 'SYNC_LIFECYCLE');
  assert.equal(h.actions.at(-1).type, 'SET_NOTIFICATION');
  h.cleanup();
});
