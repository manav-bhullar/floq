const prisma = require('../../prisma/client');
const { lifecycleTransaction, publishChanges } = require('../../socket/lifecycle');
const { cacheGet, cacheSet, invalidateUserRideCaches,
  CACHE_CURRENT_RIDE_KEY, TTL_CURRENT_RIDE } = require('../../utils/cache');

exports.createRideRequest = async (userId, data) => {
  const existing = await prisma.rideRequest.findFirst({
    where: {
      userId,
      status: {
        in: ["PENDING", "RIDERS_MATCHED", "DRIVER_MATCHED", "STARTED"]
      },

    },
  });

  if (existing) {
    const err = new Error("User already has an active ride request");
    err.status = 409;
    throw err;
  }

  const rideRequest = await prisma.rideRequest.create({
    data: {
      userId,
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      dropLat: data.dropLat,
      dropLng: data.dropLng,
      pickupAddress: data.pickupAddress ?? null,
      dropAddress: data.dropAddress ?? null,
      preferredTime: new Date(data.preferredTime),
    },
  });

  // Invalidate rider's cached state — new request is now active
  await invalidateUserRideCaches(userId);

  await publishChanges([{ rideRequestId: rideRequest.id, userIds: [userId] }]);
  return rideRequest;
}

exports.getRideRequests = async (userId, status) => {
  const requests = await prisma.rideRequest.findMany({
    where: {
      userId,
      ...(status && { status }),
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  // ✅ Phase 1: Enrich PENDING requests with requeue metadata
  // Detect: PENDING + TripUser exists + trip.status='CANCELLED' → requeued from cascade
  if (requests.length === 0) {
    return [];
  }

  const pendingRequests = requests.filter(r => r.status === 'PENDING');
  const tripUsers = pendingRequests.length > 0
    ? await prisma.tripUser.findMany({
      where: { rideRequestId: { in: pendingRequests.map(r => r.id) } },
      include: { trip: { select: { id: true, status: true } } }
    })
    : [];

  const tripUserMap = Object.fromEntries(
    tripUsers.map(tu => [tu.rideRequestId, tu])
  );

  return requests.map(r => {
    if (r.status === 'PENDING') {
      const tripUser = tripUserMap[r.id];
      const requeued = tripUser?.trip?.status === 'CANCELLED';
      return {
        ...r,
        requeued,
        requeueReason: requeued ? 'CO_RIDER_CANCELLED' : null
      };
    }
    // Non-PENDING requests should still be returned with consistent schema
    return {
      ...r,
      requeued: false,
      requeueReason: null
    };
  });
};

exports.getCurrentRideRequest = async (userId) => {
  // Cache-aside: most-polled rider endpoint
  const cacheKey = CACHE_CURRENT_RIDE_KEY(userId);
  const cached = await cacheGet(cacheKey);
  if (cached !== null) return cached;

  const matchedRequest = await prisma.rideRequest.findFirst({
    where: {
      userId,
      status: 'RIDERS_MATCHED',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (matchedRequest) {
    const result = {
      ...matchedRequest,
      requeued: false,
      requeueReason: null,
    };
    await cacheSet(cacheKey, result, TTL_CURRENT_RIDE);
    return result;
  }

  const pendingRequest = await prisma.rideRequest.findFirst({
    where: {
      userId,
      status: 'PENDING',
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (!pendingRequest) {
    // Cache null too (avoids repeated DB hits when no active request)
    await cacheSet(cacheKey, null, TTL_CURRENT_RIDE);
    return null;
  }

  const tripUser = await prisma.tripUser.findFirst({
    where: { rideRequestId: pendingRequest.id },
    include: { trip: { select: { status: true } } },
  });

  const requeued = tripUser?.trip?.status === 'CANCELLED';
  const result = {
    ...pendingRequest,
    requeued,
    requeueReason: requeued ? 'CO_RIDER_CANCELLED' : null,
  };

  await cacheSet(cacheKey, result, TTL_CURRENT_RIDE);
  return result;
};

exports.cancelRideRequest = async (id, userId) => {
  return lifecycleTransaction(async (tx, changes) => {
    const request = await tx.rideRequest.findUnique({
      where: { id },
    });
    if (!request) throw new Error("Ride request not found");
    if (request.userId !== userId) {
      throw new Error("Unauthorized");
    }
    if (request.status === "CANCELLED") {
      // Already cancelled → idempotent success
      // Try to find associated trip if it exists
      const tripUser = await tx.tripUser.findUnique({
        where: { rideRequestId: id },
      });
      return {
        id,
        status: "CANCELLED",
        cancelledTripId: tripUser?.tripId || null,
        note: "Already cancelled",
      };
    }
    // 🔹 CASE 1: PENDING → simple cancel
    if (request.status === "PENDING") {
      await tx.rideRequest.update({
        where: { id },
        data: { status: "CANCELLED" },
      });

      await tx.tripUser.deleteMany({
        where: { rideRequestId: id },
      });

      changes.push({ rideRequestId: id, userIds: [userId], status: 'CANCELLED' });
      return {
        id,
        status: "CANCELLED",
        cancelledTripId: null,
      };
    }
    // 🔹 CASE 2: MATCHED → CASCADE CANCEL
    // PHASE 2 FIX: Explicit state machine instead of count-based assumptions
    if (request.status === "RIDERS_MATCHED") {
      // 1. Find trip association
      const tripUser = await tx.tripUser.findUnique({
        where: { rideRequestId: id },
      });
      if (!tripUser) {
        throw new Error("Trip association not found");
      }
      const tripId = tripUser.tripId;

      // 2. PHASE 2 FIX: Fetch trip to inspect actual status (not guess from updateMany count)
      const trip = await tx.trip.findUnique({
        where: { id: tripId },
      });
      if (!trip) {
        throw new Error("Trip not found");
      }

      // 3. Branch by trip status (explicit state machine)
      if (trip.status === 'COMPLETED') {
        // ❌ CRITICAL: Cannot cascade cancel a completed trip
        // Rider should not be MATCHED on a completed trip; this is an invalid state
        throw new Error("TRIP_ALREADY_COMPLETED: Cannot cancel request on completed trip");
      }

      if (trip.status === 'STARTED') {
        // ❌ CRITICAL: Cannot cascade cancel a started trip
        // The driver is already driving, cancelling ruins it for everyone.
        throw new Error("TRIP_ALREADY_STARTED: Cannot cancel request on a trip that has already started");
      }

      if (trip.status === 'CANCELLED') {
        // ✅ Idempotent: Trip already cancelled, co-riders already reverted
        // Just return success
        return {
          id,
          status: "CANCELLED",
          cancelledTripId: tripId,
          note: "Trip already cancelled",
        };
      }

      if (['RIDERS_MATCHED', 'DRIVER_MATCHED'].includes(trip.status)) {
        // ✅ Active trips can be cascaded
        // 4. Atomic cancel the trip
        const updatedTripResult = await tx.trip.updateMany({
          where: { id: tripId, status: trip.status },
          data: { status: "CANCELLED" },
        });

        if (updatedTripResult.count === 0) {
          throw new Error("Trip state changed concurrently, please try again");
        }

        // 5. Get all ride requests in this trip
        const tripUsers = await tx.tripUser.findMany({
          where: { tripId },
        });
        const rideRequestIds = tripUsers.map(tu => tu.rideRequestId);
        const coRiderIds = rideRequestIds.filter(rid => rid !== id);

        // 6. Cancel the triggering user
        await tx.rideRequest.update({
          where: { id },
          data: { status: "CANCELLED" },
        });

        // 7. Revert co-riders to PENDING and remove their TripUser linkage
        if (coRiderIds.length > 0) {
          await tx.rideRequest.updateMany({
            where: {
              id: { in: coRiderIds },
              status: "RIDERS_MATCHED",
            },
            data: {
              status: "PENDING",
            },
          });

          await tx.tripUser.deleteMany({
            where: {
              tripId,
              rideRequestId: { in: coRiderIds },
            },
          });
        }

        // 8. Cancel DriverTrip if it exists
        const driverTrip = await tx.driverTrip.findUnique({ where: { tripId } });
        if (driverTrip) {
          await tx.driverTrip.update({
            where: { id: driverTrip.id },
            data: { status: 'CANCELLED' },
          });
        }

        // Capture participants before their trip links are removed from the snapshot.
        changes.push({
          tripId,
          userIds: tripUsers.map(tu => tu.userId),
          reason: 'A co-rider cancelled — remaining riders have been re-queued for matching.',
        });

        return {
          id,
          status: "CANCELLED",
          cancelledTripId: tripId,
        };
      }

      // Should never reach here
      throw new Error(`Unexpected trip status: ${trip.status}`);
    }
    throw new Error("Invalid state");
  });
}