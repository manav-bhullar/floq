/**
 * Phase 7 Verification — Distributed Matching Lock
 *
 * Tests:
 * 1. acquireLock succeeds when key is free
 * 2. acquireLock returns null when key already held (overlap protection)
 * 3. releaseLock removes the key
 * 4. Lock auto-expires after TTL (crash safety)
 * 5. Only the owner can release (token mismatch → rejected)
 * 6. extendLock extends TTL for long cycles
 * 7. isLocked reflects correct state
 * 8. Concurrent simulated workers — only one wins
 */

require('dotenv').config();
const { connectRedis, disconnectRedis } = require('../src/utils/redis');
const { acquireLock, releaseLock, extendLock, isLocked } = require('../src/utils/lock');

const LOCK_KEY = `matching:test:lock:${Date.now()}`;

async function run() {
  connectRedis();
  await new Promise(r => setTimeout(r, 500));

  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) { console.log(`  ✅ ${label}`); passed++; }
    else           { console.log(`  ❌ FAIL: ${label}`); failed++; }
  }

  try {
    // ─── Test 1: Acquire a free lock ───
    console.log('\n🔒 Test 1: Acquire free lock');
    const lock1 = await acquireLock(LOCK_KEY, 10000);
    assert(lock1 !== null, 'Lock acquired on free key');
    assert(typeof lock1.token === 'string' && lock1.token.length === 32, 'Lock token is 32-char hex');
    assert(lock1.key === LOCK_KEY, 'Lock key matches');

    // ─── Test 2: Second acquire fails (overlap protection) ───
    console.log('\n🚫 Test 2: Second acquire returns null (already held)');
    const lock2 = await acquireLock(LOCK_KEY, 10000);
    assert(lock2 === null, 'Second acquireLock returns null while lock is held');

    // ─── Test 3: isLocked reflects state ───
    console.log('\n🔍 Test 3: isLocked reflects lock state');
    const lockedNow = await isLocked(LOCK_KEY);
    assert(lockedNow === true, 'isLocked=true while lock is held');

    // ─── Test 4: Only owner can release (token mismatch) ───
    console.log('\n🛡️  Test 4: Non-owner cannot release the lock');
    const fakeHandle = { key: LOCK_KEY, token: 'wrong-token-1234567890abcdef' };
    const fakeRelease = await releaseLock(fakeHandle);
    assert(fakeRelease === false, 'releaseLock returns false with wrong token');

    // Verify lock still exists after failed fake release
    const stillLocked = await isLocked(LOCK_KEY);
    assert(stillLocked === true, 'Lock still held after failed fake release');

    // ─── Test 5: Owner can release ───
    console.log('\n🔓 Test 5: Owner releases the lock');
    const released = await releaseLock(lock1);
    assert(released === true, 'releaseLock returns true for owner');

    const afterRelease = await isLocked(LOCK_KEY);
    assert(afterRelease === false, 'isLocked=false after release');

    // ─── Test 6: Lock auto-expires after TTL ───
    console.log('\n⏱️  Test 6: Lock auto-expires after TTL (2s)');
    const shortLock = await acquireLock(`${LOCK_KEY}:ttl`, 2000); // 2s TTL
    assert(shortLock !== null, 'Short-TTL lock acquired');

    const beforeExpiry = await isLocked(`${LOCK_KEY}:ttl`);
    assert(beforeExpiry === true, 'Lock held before TTL expires');

    console.log('    Waiting 2.5s for auto-expiry...');
    await new Promise(r => setTimeout(r, 2500));

    const afterExpiry = await isLocked(`${LOCK_KEY}:ttl`);
    assert(afterExpiry === false, 'Lock auto-expired after TTL (crash safety)');

    // ─── Test 7: extendLock renews TTL ───
    console.log('\n⏳ Test 7: extendLock extends TTL');
    const extendableLock = await acquireLock(`${LOCK_KEY}:extend`, 2000); // 2s initial
    assert(extendableLock !== null, 'Extendable lock acquired');

    console.log('    Waiting 1.5s then extending...');
    await new Promise(r => setTimeout(r, 1500));

    const extended = await extendLock(extendableLock, 5000); // extend to 5s
    assert(extended === true, 'extendLock returns true for owner');

    console.log('    Waiting 2s (would have expired without extension)...');
    await new Promise(r => setTimeout(r, 2000));

    const stillExtended = await isLocked(`${LOCK_KEY}:extend`);
    assert(stillExtended === true, 'Lock still alive after extension');

    await releaseLock(extendableLock);

    // ─── Test 8: Concurrent workers — only one wins ───
    console.log('\n🏁 Test 8: Concurrent simulated workers (only one acquires lock)');
    const concurrentKey = `${LOCK_KEY}:concurrent`;

    // Simulate 5 workers trying to acquire simultaneously
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        acquireLock(concurrentKey, 5000).then(lock => ({ worker: i + 1, lock }))
      )
    );

    const winners = results.filter(r => r.lock !== null);
    const losers  = results.filter(r => r.lock === null);

    assert(winners.length === 1, `Exactly 1 of 5 workers acquired the lock (got ${winners.length})`);
    assert(losers.length === 4, `4 of 5 workers were blocked (got ${losers.length})`);
    console.log(`    Winner: worker ${winners[0].worker}`);

    // Release the winner's lock
    await releaseLock(winners[0].lock);
    assert(await isLocked(concurrentKey) === false, 'Concurrent lock released cleanly');

  } catch (err) {
    console.error('\n💥 Test error:', err);
    failed++;
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('Phase 7 verification: ALL PASSED ✅');
  else              console.log('Phase 7 verification: SOME FAILED ❌');

  await disconnectRedis();
  process.exit(failed > 0 ? 1 : 0);
}

run();
