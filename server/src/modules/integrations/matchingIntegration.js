const { runMatchingBatch } = require('../matching/matchingEngine');
const { createTripFromMatch } = require('../trip/trip.service');
const { runExpansionPhase } = require('../trip/expansion.service');
const prisma = require('../../prisma/client');
const { lifecycleTransaction } = require('../../socket/lifecycle');

/**
 * Minimum buffer (in ms) before a ride's preferredTime for it to enter the matching pool.
 * Rides whose preferredTime is less than this far in the future are excluded from matching
 * to give enough time for a driver to accept and start.
 */
const MATCHING_TIME_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Grace period (in ms) after a RIDERS_MATCHED trip's departure time before it's auto-expired.
 * Gives the driver time to accept and start the trip after riders are matched.
 */
const MATCHED_TRIP_EXPIRY_GRACE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fetch pending ride requests with database-level locking
 * FOR UPDATE SKIP LOCKED prevents race conditions when multiple schedulers run
 * 
 * CRITICAL FIX: Only fetch requests whose preferredTime is still in the future
 * (with a buffer) to prevent matching rides that are about to expire.
 */
async function fetchPendingRequests(tx) {
  const cutoff = new Date(Date.now() + MATCHING_TIME_BUFFER_MS);
  const requests = await tx.$queryRaw`
    SELECT * FROM "RideRequest"
    WHERE status = 'PENDING'
    AND "preferredTime" >= ${cutoff}
    FOR UPDATE SKIP LOCKED
  `;

  return requests;
}

/**
 * Update pending cycles for unmatched requests + auto-cancel stale ones
 * Returns { cycleCancelled, timeCancelled } for observability
 */
async function updatePendingCycles(tx, allRequests, matchedIds) {
  const unmatchedIds = allRequests
    .map(r => r.id)
    .filter(id => !matchedIds.has(id));

  if (unmatchedIds.length === 0) return { cycleCancelled: 0, timeCancelled: 0 };

  // 🔒 STEP 1: Increment pending cycles for unmatched PENDING requests ONLY
  // Prevents dirty updates if a request somehow becomes RIDERS_MATCHED/CANCELLED
  // ⚠️ CRITICAL: This must run BEFORE cancel logic
  await tx.rideRequest.updateMany({
    where: {
      id: { in: unmatchedIds },
      status: 'PENDING'  // ✅ CRITICAL: Only update PENDING requests
    },
    data: {
      pendingCycles: { increment: 1 }
    }
  });

  return { cycleCancelled: 0, timeCancelled: 0 };
}

// Expire independently of the matching pool, which excludes past departure times.
async function autoExpirePendingRequests(tx, changes) {
  // 🔒 STEP 2: Auto-cancel by time — preferredTime has passed
  // If the ride's departure time has already passed, no point matching
  const now = new Date();

  // Find the requests we are about to cancel so we can notify the users
  const expiringRequests = await tx.rideRequest.findMany({
    where: {
      status: 'PENDING',
      preferredTime: { lt: now }
    },
    select: { id: true, userId: true }
  });

  const expiringIds = expiringRequests.map(r => r.id);

  let timeCancelledCount = 0;
  
  if (expiringIds.length > 0) {
    const timeCancelled = await tx.rideRequest.updateMany({
      where: { id: { in: expiringIds }, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    });
    timeCancelledCount = timeCancelled.count;

    for (const req of expiringRequests) {
      changes.push({ rideRequestId: req.id, userIds: [req.userId], status: 'CANCELLED',
        reason: 'Your ride was automatically cancelled because the departure time has passed.' });
    }
  }

  // ✅ Return counts for observability (enables debugging)
  console.log(`Auto-cancelled: time=${timeCancelledCount}`);
  return timeCancelledCount;
}

/**
 * Auto-expire RIDERS_MATCHED trips whose departure time + grace period has passed.
 * These are trips where riders were matched but the departure time has long passed
 * without a driver accepting (or the ride was matched at the current time edge case).
 * 
 * Returns count of expired trips for observability.
 */
async function autoExpireMatchedTrips(tx, changes) {
  const graceCutoff = new Date(Date.now() - MATCHED_TRIP_EXPIRY_GRACE_MS);

  // Find RIDERS_MATCHED trips where ALL ride requests' preferredTime + grace < now
  const staleTrips = await tx.$queryRaw`
    SELECT t.id FROM "Trip" t
    WHERE t.status = 'RIDERS_MATCHED'
    AND NOT EXISTS (
      SELECT 1 FROM "TripUser" tu
      JOIN "RideRequest" rr ON rr.id = tu."rideRequestId"
      WHERE tu."tripId" = t.id
      AND rr."preferredTime" >= ${graceCutoff}
    )
  `;

  if (staleTrips.length === 0) return 0;

  let cancelledCount = 0;

  for (const { id: tripId } of staleTrips) {
    // Cancel the trip
    await tx.trip.update({ where: { id: tripId }, data: { status: 'CANCELLED' } });

    // Get all trip users
    const tripUsers = await tx.tripUser.findMany({
      where: { tripId },
      include: { rideRequest: { select: { id: true, userId: true } } },
    });

    const rideRequestIds = tripUsers.map(tu => tu.rideRequestId);

    // Cancel all ride requests (time has passed, no point requeueing)
    await tx.rideRequest.updateMany({
      where: { id: { in: rideRequestIds } },
      data: { status: 'CANCELLED' },
    });

    // Cancel any associated DriverTrip
    const driverTrip = await tx.driverTrip.findUnique({ where: { tripId } });
    if (driverTrip) {
      await tx.driverTrip.update({
        where: { id: driverTrip.id },
        data: { status: 'CANCELLED' },
      });
    }

    changes.push({ tripId, userIds: tripUsers.map(tu => tu.rideRequest.userId),
      reason: 'Your matched ride was automatically cancelled because the departure time has passed without a driver accepting.' });

    cancelledCount++;
  }

  if (cancelledCount > 0) {
    console.log(`🕐 Auto-expired ${cancelledCount} stale RIDERS_MATCHED trip(s)`);
  }
  return cancelledCount;
}

/**
 * Log matching cycle to database
 */
async function logMatchingCycle(result, triggerType = 'CRON') {
  try {
    await prisma.matchCycleLog.create({
      data: {
        triggerType,
        pendingCountStart: result.pendingCountStart || 0,
        tripsCreated: result.tripsCreated || 0,
        usersMatched: result.usersMatched || 0,
        usersStillPending: result.usersStillPending || 0,
        autoCancelledCount: result.autoCancelledCount || 0,
        pairsRejectedDirection: 0, // TODO: track in matching engine
        pairsRejectedDetour: 0,    // TODO: track in matching engine
        durationMs: result.durationMs || 0,
        errorMessage: result.error || null,
      },
    });
  } catch (err) {
    console.warn(`⚠️  Failed to log matching cycle:`, err.message);
  }
}

/**
 * Run complete matching cycle with full transaction safety
 */
async function runMatchingCycle(triggerType = 'CRON') {
  const startTime = Date.now();

  try {
    const result = await lifecycleTransaction(async (tx, changes) => {
      /**
       * 🕐 STEP 0a: Auto-expire stale RIDERS_MATCHED trips
       * This must run before matching to clean up edge cases where
       * rides were matched at the current time boundary.
       */
      await autoExpireMatchedTrips(tx, changes);
      const expiredPendingCount = await autoExpirePendingRequests(tx, changes);

      /**
       * 🔒 STEP 0b: Count pending at start for logging
       */
      const pendingCountStart = await tx.rideRequest.count({
        where: { status: 'PENDING' },
      });

      /**
       * 🔒 STEP 1: Fetch pending requests with row-level lock
       * FOR UPDATE SKIP LOCKED ensures:
       * - Other concurrent transactions won't see these rows
       * - Multiple schedulers won't double-match
       */
      const pending = await fetchPendingRequests(tx);

      if (pending.length < 3) {
        console.log(`⏭️  Not enough pending requests (${pending.length}, minimum 3 required)`);

        // ⚠️ CRITICAL: Still increment pending_cycles for unmatched requests
        if (pending.length > 0) {
          const matchedIds = new Set(); // No matches found
          const { cycleCancelled, timeCancelled } = await updatePendingCycles(tx, pending, matchedIds);
          const autoCancelledCount = expiredPendingCount + cycleCancelled + timeCancelled;

          const usersStillPending = await tx.rideRequest.count({
            where: { status: 'PENDING' },
          });

          return {
            pendingCountStart,
            tripsCreated: 0,
            usersMatched: 0,
            usersStillPending,
            autoCancelledCount,  // ✅ Precise delta
            durationMs: Date.now() - startTime,
          };
        }

        const usersStillPending = await tx.rideRequest.count({
          where: { status: 'PENDING' },
        });

        return {
          pendingCountStart,
          tripsCreated: 0,
          usersMatched: 0,
          usersStillPending,
          autoCancelledCount: expiredPendingCount,
          durationMs: Date.now() - startTime,
        };
      }

      /**
       * ✅ STEP 2: Run matching engine (pure logic, no DB)
       */
      const matches = runMatchingBatch(pending);

      if (matches.length === 0) {
        console.log(`❌ No valid matches found for ${pending.length} requests`);

        // ⚠️ CRITICAL: Still increment pending_cycles for all unmatched requests
        const matchedIds = new Set(); // No matches found
        const { cycleCancelled, timeCancelled } = await updatePendingCycles(tx, pending, matchedIds);
        const autoCancelledCount = expiredPendingCount + cycleCancelled + timeCancelled;

        const usersStillPending = await tx.rideRequest.count({
          where: { status: 'PENDING' },
        });

        return {
          pendingCountStart,
          tripsCreated: 0,
          usersMatched: 0,
          usersStillPending,
          autoCancelledCount,  // ✅ Precise delta
          durationMs: Date.now() - startTime,
        };
      }

      /**
       * ✅ STEP 3: Create trips from matches (within transaction)
       * 
       * PHASE 1 FIX: Pre-validate each match before attempting trip creation
       * This prevents logical errors from causing batch-wide transaction failures.
       * 
       * Process:
       * 1. Validate: all users in match still PENDING
       * 2. If valid: create trip (expected to succeed)
       * 3. If invalid: skip match (continue with next)
       * 4. If trip creation throws despite validation: real system error, let propagate
       */
      const validMatches = [];
      const matchedIds = new Set();

      for (const match of matches) {
        // 🔒 PRE-VALIDATION: Ensure all users in this match are still PENDING
        // This catches cases where a user cancelled between matching and trip creation
        const matchUserIds = match.users.map(u => u.rideRequestId);
        const stillPendingCount = await tx.rideRequest.count({
          where: {
            id: { in: matchUserIds },
            status: 'PENDING'
          }
        });

        if (stillPendingCount !== match.users.length) {
          const skipped = match.users.length - stillPendingCount;
          console.log(
            `⏭️  Skipping match: ${skipped}/${match.users.length} users no longer PENDING ` +
            `(likely cancelled during batch)`
          );
          continue;  // Skip this match, move to next
        }

        validMatches.push(match);
        match.users.forEach(u => matchedIds.add(u.rideRequestId));

        console.log(
          `✅ Match validated for trip creation: ${match.users.length} users, ${match.route.totalDistance.toFixed(2)}km`
        );
      }

      /**
       * ✅ STEP 4: Update pending_cycles for unmatched requests + track cancellations
       */
      const { cycleCancelled, timeCancelled } = await updatePendingCycles(tx, pending, matchedIds);
      const autoCancelledCount = expiredPendingCount + cycleCancelled + timeCancelled;

      // Count remaining pending
      const usersStillPending = await tx.rideRequest.count({
        where: { status: 'PENDING' },
      });

      return {
        pendingCountStart,
        validMatches,
        usersStillPending,
        autoCancelledCount,
        durationMs: Date.now() - startTime,
      };
    });

    let tripsCreated = 0;
    let usersMatched = 0;

    for (const match of result.validMatches || []) {
      try {
        const trip = await createTripFromMatch(match);
        tripsCreated += 1;
        usersMatched += match.users.length;

        console.log(
          `✅ Trip created: ${trip.id} (${match.users.length} users, ${match.route.totalDistance.toFixed(2)}km)`
        );
      } catch (err) {
        if (err.message === 'ROAD_DETOUR_EXCEEDED' || err.message === 'Some ride requests already processed') {
          console.warn(`⏭️ Skipping trip creation for match: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    /**
     * ✅ STEP 5: Expansion phase — add remaining PENDING riders to existing trips
     */
    let usersExpanded = 0;
    try {
      const expansion = await runExpansionPhase();
      usersExpanded = expansion.expandedCount;
      if (usersExpanded > 0) {
        console.log(`✅ Expansion: ${usersExpanded} riders added to existing trips`);
      }
    } catch (err) {
      console.warn('⚠️ Expansion phase failed (non-fatal):', err.message);
    }

    const usersStillPending = await prisma.rideRequest.count({
      where: { status: 'PENDING' },
    });

    const resultToLog = {
      pendingCountStart: result.pendingCountStart,
      tripsCreated,
      usersMatched: usersMatched + usersExpanded,
      usersStillPending,
      autoCancelledCount: result.autoCancelledCount,
      durationMs: Date.now() - startTime,
    };

    // Log to database
    await logMatchingCycle(resultToLog, triggerType);

    return resultToLog;
  } catch (err) {
    console.error(`❌ Matching cycle failed:`, err);
    const result = {
      pendingCountStart: 0,
      tripsCreated: 0,
      usersMatched: 0,
      usersStillPending: 0,
      autoCancelledCount: 0,
      durationMs: Date.now() - startTime,
      error: err.message,
    };

    // Log error to database
    await logMatchingCycle(result, triggerType);

    return result;
  }
}

module.exports = {
  runMatchingCycle,
  logMatchingCycle,
};
