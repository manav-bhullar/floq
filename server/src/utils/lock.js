/**
 * Redis Distributed Lock (Redlock-lite)
 *
 * Uses the standard Redis pattern:
 *   SET lock_key owner_token NX PX ttlMs
 *
 * - NX: only sets the key if it does NOT exist  → atomic "take if free"
 * - PX: key expires after ttlMs ms              → crash-safe auto-release
 * - Owner token: a unique random value so only the lock holder can release it
 *   (prevents a slow process from releasing a lock it no longer owns)
 *
 * Usage:
 *   const lock = await acquireLock('matching:lock', 60000);   // 60s TTL
 *   if (!lock) { console.log('Already locked'); return; }
 *   try {
 *     await doWork();
 *   } finally {
 *     await releaseLock(lock);
 *   }
 */

const crypto = require('crypto');
const { getRedis } = require('./redis');

/**
 * Attempt to acquire a distributed lock.
 *
 * @param {string} key     - Redis key name for the lock
 * @param {number} ttlMs   - Auto-expiry in milliseconds (crash safety net)
 * @returns {{ key: string, token: string } | null}
 *   Returns the lock handle on success, null if already held.
 */
async function acquireLock(key, ttlMs) {
  const token = crypto.randomBytes(16).toString('hex');

  // SET key token NX PX ttlMs — atomic, fails if key already exists
  const result = await getRedis().set(key, token, 'NX', 'PX', ttlMs);

  if (result !== 'OK') {
    return null; // Lock already held by another process
  }

  return { key, token };
}

/**
 * Release a lock — only if we still own it (token matches).
 * Uses a Lua script for atomic check-and-delete.
 *
 * @param {{ key: string, token: string }} lock - Lock handle from acquireLock
 * @returns {boolean} true if released, false if already expired/stolen
 */
async function releaseLock(lock) {
  if (!lock) return false;

  // Lua script: atomically check token and delete — prevents releasing another owner's lock
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  const result = await getRedis().eval(script, 1, lock.key, lock.token);
  return result === 1;
}

/**
 * Extend the TTL of an existing lock (if still owned).
 * Useful for long-running cycles to prevent premature expiry.
 *
 * @param {{ key: string, token: string }} lock
 * @param {number} ttlMs - New TTL in milliseconds
 * @returns {boolean} true if extended
 */
async function extendLock(lock, ttlMs) {
  if (!lock) return false;

  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  const result = await getRedis().eval(script, 1, lock.key, lock.token, String(ttlMs));
  return result === 1;
}

/**
 * Check if a lock is currently held (for observability/debugging).
 * @param {string} key
 * @returns {boolean}
 */
async function isLocked(key) {
  const val = await getRedis().exists(key);
  return val === 1;
}

module.exports = { acquireLock, releaseLock, extendLock, isLocked };
