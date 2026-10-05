/**
 * Shared Redis cache helpers for Phase 4 hot-query caching.
 *
 * Convention: all keys are namespaced under `cache:` so they can be
 * flushed independently from auth keys (refresh:*, otp:*) if needed.
 *
 * TTL strategy:
 *  - available_trips  : 10 s  — drivers poll frequently; short TTL avoids stale listings
 *  - trip:{id}        : 30 s  — trip details change slowly once matched
 *  - current_trip:{u} : 15 s  — rider-facing active trip; needs to be reasonably fresh
 *  - current_ride:{u} : 15 s  — rider's pending/matched request
 */

const { getRedis } = require('./redis');

// ─── Key builders ────────────────────────────────────────────────────────────
const CACHE_AVAILABLE_TRIPS_KEY = () => 'cache:available_trips';
const CACHE_TRIP_KEY = (tripId) => `cache:trip:${tripId}`;
const CACHE_CURRENT_TRIP_KEY = (userId) => `cache:current_trip:${userId}`;
const CACHE_CURRENT_RIDE_KEY = (userId) => `cache:current_ride:${userId}`;

// ─── TTLs (seconds) ──────────────────────────────────────────────────────────
const TTL_AVAILABLE_TRIPS = 10;
const TTL_TRIP = 30;
const TTL_CURRENT_TRIP = 15;
const TTL_CURRENT_RIDE = 15;

// ─── Generic helpers ─────────────────────────────────────────────────────────

/**
 * Get JSON from cache. Returns null if missing.
 * @param {string} key
 */
async function cacheGet(key) {
  const raw = await getRedis().get(key);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Set JSON into cache with TTL.
 * @param {string} key
 * @param {*} value
 * @param {number} ttlSeconds
 */
async function cacheSet(key, value, ttlSeconds) {
  await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Delete one or many cache keys.
 * @param {...string} keys
 */
async function cacheDel(...keys) {
  if (keys.length === 0) return;
  await getRedis().del(...keys);
}

// ─── Domain-specific invalidation ────────────────────────────────────────────

/**
 * Invalidate all caches that are affected when a trip's status changes.
 * Called after: trip accept, start, complete, cancel, expansion.
 *
 * @param {string} tripId
 * @param {string[]} userIds  - all rider userIds in this trip
 */
async function invalidateTripCaches(tripId, userIds = []) {
  const keys = [
    CACHE_AVAILABLE_TRIPS_KEY(),
    CACHE_TRIP_KEY(tripId),
    ...userIds.map(CACHE_CURRENT_TRIP_KEY),
    ...userIds.map(CACHE_CURRENT_RIDE_KEY),
  ];
  await cacheDel(...keys);
}

/**
 * Invalidate caches related to a single user's ride request state.
 * Called after: createRideRequest, cancelRideRequest.
 *
 * @param {string} userId
 */
async function invalidateUserRideCaches(userId) {
  await cacheDel(
    CACHE_CURRENT_RIDE_KEY(userId),
    CACHE_CURRENT_TRIP_KEY(userId),
  );
}

module.exports = {
  // Key builders (exported so tests can verify keys directly)
  CACHE_AVAILABLE_TRIPS_KEY,
  CACHE_TRIP_KEY,
  CACHE_CURRENT_TRIP_KEY,
  CACHE_CURRENT_RIDE_KEY,
  // TTLs
  TTL_AVAILABLE_TRIPS,
  TTL_TRIP,
  TTL_CURRENT_TRIP,
  TTL_CURRENT_RIDE,
  // Helpers
  cacheGet,
  cacheSet,
  cacheDel,
  // Domain invalidation
  invalidateTripCaches,
  invalidateUserRideCaches,
};
