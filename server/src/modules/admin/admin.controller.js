const { runMatchingCycle, logMatchingCycle } = require('../integrations/matchingIntegration');
const { success, error } = require('../../utils/response');
const prisma = require('../../prisma/client');

/**
 * Manually trigger a matching cycle
 */
exports.runMatching = async (req, res) => {
  try {
    console.log(`\n🔧 [ADMIN] Triggering matching cycle...`);

    const result = await runMatchingCycle('ADMIN');

    return success(res, {
      trips_created: result.tripsCreated,
      users_matched: result.usersMatched,
      users_still_pending: result.usersStillPending,
      auto_cancelled_count: result.autoCancelledCount,
      duration_ms: result.durationMs,
      error: result.error || null,
    });
  } catch (err) {
    console.error('Admin matching error:', err);
    return error(res, err.message || 'Failed to run matching', 500);
  }
};

/**
 * Get recent matching cycles
 */
exports.getMatchingCycles = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const cycles = await prisma.matchCycleLog.findMany({
      orderBy: { runAt: 'desc' },
      take: limit,
    });

    return success(res, {
      count: cycles.length,
      cycles: cycles.map(c => ({
        id: c.id,
        runAt: c.runAt,
        triggerType: c.triggerType,
        tripsCreated: c.tripsCreated,
        usersMatched: c.usersMatched,
        usersPending: c.usersStillPending,
        autoCancelled: c.autoCancelledCount,
        duration_ms: c.durationMs,
        error: c.errorMessage,
      })),
    });
  } catch (err) {
    console.error('Get cycles error:', err);
    return error(res, err.message || 'Failed to fetch cycles', 500);
  }
};

/**
 * Get system health
 */
exports.getHealth = async (req, res) => {
  try {
    const pendingCount = await prisma.rideRequest.count({
      where: { status: 'PENDING' },
    });

    const matchedCount = await prisma.rideRequest.count({
      where: { status: 'RIDERS_MATCHED' },
    });

    const cancelledCount = await prisma.rideRequest.count({
      where: { status: 'CANCELLED' },
    });

    const tripCount = await prisma.trip.count();

    const lastCycle = await prisma.matchCycleLog.findFirst({
      orderBy: { runAt: 'desc' },
    });

    return success(res, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      requests: {
        pending: pendingCount,
        matched: matchedCount,
        cancelled: cancelledCount,
        total: pendingCount + matchedCount + cancelledCount,
      },
      trips: {
        total: tripCount,
      },
      lastCycle: lastCycle ? {
        runAt: lastCycle.runAt,
        tripsCreated: lastCycle.tripsCreated,
        usersMatched: lastCycle.usersMatched,
        durationMs: lastCycle.durationMs,
        error: lastCycle.errorMessage,
      } : null,
    });
  } catch (err) {
    console.error('Health check error:', err);
    return error(res, err.message || 'Failed to check health', 500);
  }
};
