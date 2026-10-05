const prisma = require('../prisma/client');
const { getIo } = require('./socket');
const { invalidateTripCaches, invalidateUserRideCaches } = require('../utils/cache');

// Collect changes inside the transaction; publish only after a successful commit.
// Events contain IDs, never user records. Clients read authorized REST snapshots.
async function publishChanges(changes) {
  for (const change of changes) {
    try {
      let userIds = change.userIds || [];
      let status = change.status;
      if (change.tripId) {
        const trip = await prisma.trip.findUnique({
          where: { id: change.tripId },
          include: { tripUsers: true, driverTrip: { include: { driverProfile: true } } },
        });
        userIds = [...new Set([
          ...userIds,
          ...(trip?.tripUsers || []).map(tu => tu.userId),
          ...(trip?.driverTrip ? [trip.driverTrip.driverProfile.userId] : []),
        ])];
        status = trip?.status || status;
        await invalidateTripCaches(change.tripId, userIds);
      } else {
        await Promise.all(userIds.map(invalidateUserRideCaches));
      }
      const io = getIo();
      for (const userId of userIds) {
        const payload = {
          tripId: change.tripId,
          rideRequestId: change.rideRequestId,
          status,
          reason: change.reason,
        };
        if (change.tripId) {
          io.to(userId).emit('trip_updated', payload);
          // Preserve the driver client's existing cancellation listener.
          if (status === 'CANCELLED') io.to(userId).emit('trip_cancelled', payload);
        }
        io.to(userId).emit('ride_request_updated', payload);
      }
    } catch (err) {
      // A notification failure must never turn a committed mutation into an HTTP failure.
      console.warn('Lifecycle notification failed:', err.message);
    }
  }
}

async function lifecycleTransaction(work) {
  const changes = [];
  const result = await prisma.$transaction(tx => work(tx, changes));
  await publishChanges(changes);
  return result;
}

module.exports = { lifecycleTransaction, publishChanges };
