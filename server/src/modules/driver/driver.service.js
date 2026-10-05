const { lifecycleTransaction } = require('../../socket/lifecycle');
const prisma = require('../../prisma/client');
const { cacheGet, cacheSet,
  CACHE_AVAILABLE_TRIPS_KEY, CACHE_CURRENT_TRIP_KEY,
  TTL_AVAILABLE_TRIPS, TTL_CURRENT_TRIP } = require('../../utils/cache');

/**
 * Grace period before a RIDERS_MATCHED trip is considered expired for the driver.
 * Must match the server-side MATCHED_TRIP_EXPIRY_GRACE_MS.
 */
const MATCHED_TRIP_EXPIRY_GRACE_MS = 10 * 60 * 1000; // 10 minutes

exports.getAvailableTrips = async () => {
  // Cache-aside: return cached list if fresh
  const cached = await cacheGet(CACHE_AVAILABLE_TRIPS_KEY());
  if (cached) return cached;

  const graceCutoff = new Date(Date.now() - MATCHED_TRIP_EXPIRY_GRACE_MS);

  const trips = await prisma.trip.findMany({
    where: {
      status: 'RIDERS_MATCHED',
      tripUsers: {
        some: {
          rideRequest: {
            preferredTime: { gte: graceCutoff },
          },
        },
      },
    },
    include: {
      tripStops: {
        orderBy: { stopOrder: 'asc' },
        include: {
          rideRequest: {
            select: {
              pickupAddress: true,
              dropAddress: true,
            }
          }
        }
      },
      tripUsers: {
        include: {
          user: {
            select: {
              name: true,
              phone: true,
            }
          }
        }
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  await cacheSet(CACHE_AVAILABLE_TRIPS_KEY(), trips, TTL_AVAILABLE_TRIPS);
  return trips;
};

exports.acceptTrip = async (userId, tripId) => {
  return await lifecycleTransaction(async (tx, changes) => {
    // 1. Get driver profile
    const driverProfile = await tx.driverProfile.findUnique({
      where: { userId },
    });
    if (!driverProfile) {
      throw { code: 404, message: 'Driver profile not found' };
    }

    // 2. Check if driver is already on an active trip
    const activeDriverTrip = await tx.driverTrip.findFirst({
      where: {
        driverProfileId: driverProfile.id,
        status: { in: ['ACCEPTED', 'STARTED'] },
      },
    });
    if (activeDriverTrip) {
      throw { code: 400, message: 'Driver is already on an active trip' };
    }

    // 3. Check trip status
    const trip = await tx.trip.findUnique({
      where: { id: tripId },
      include: {
        tripUsers: {
          include: {
            rideRequest: { select: { preferredTime: true } },
          },
        },
      },
    });
    if (!trip) throw { code: 404, message: 'Trip not found' };
    if (trip.status !== 'RIDERS_MATCHED') {
      throw { code: 400, message: 'Trip is no longer available' };
    }

    // 4. Guard: verify trip hasn't expired (departure time + grace period)
    const graceCutoff = new Date(Date.now() - MATCHED_TRIP_EXPIRY_GRACE_MS);
    const hasValidTime = trip.tripUsers.some(
      tu => new Date(tu.rideRequest.preferredTime) >= graceCutoff
    );
    if (!hasValidTime) {
      throw { code: 400, message: 'Trip has expired — departure time has passed' };
    }

    // 5. Atomic update of Trip status
    const tripUpdateResult = await tx.trip.updateMany({
      where: { id: tripId, status: 'RIDERS_MATCHED' },
      data: { status: 'DRIVER_MATCHED' },
    });
    if (tripUpdateResult.count === 0) {
      throw { code: 400, message: 'Trip is no longer available or was concurrently modified' };
    }

    const driverTrip = await tx.driverTrip.create({
      data: {
        driverProfileId: driverProfile.id,
        tripId,
        status: 'ACCEPTED',
      },
    });

    changes.push({ tripId, userIds: [userId, ...trip.tripUsers.map(tu => tu.userId)] });

    return driverTrip;
  });
};

exports.startTrip = async (userId, tripId) => {
  return await lifecycleTransaction(async (tx, changes) => {
    const driverProfile = await tx.driverProfile.findUnique({
      where: { userId },
    });
    if (!driverProfile) throw { code: 404, message: 'Driver profile not found' };

    const driverTrip = await tx.driverTrip.findUnique({
      where: { tripId },
    });
    if (!driverTrip || driverTrip.driverProfileId !== driverProfile.id) {
      throw { code: 403, message: 'Not authorized for this trip' };
    }
    // Atomic update
    const updatedDriverTripResult = await tx.driverTrip.updateMany({
      where: { id: driverTrip.id, status: 'ACCEPTED' },
      data: { status: 'STARTED', startedAt: new Date() },
    });
    if (updatedDriverTripResult.count === 0) {
      throw { code: 400, message: 'Can only start an ACCEPTED trip' };
    }

    const tripUpdateResult = await tx.trip.updateMany({
      where: { id: tripId, status: 'DRIVER_MATCHED' },
      data: { status: 'STARTED' },
    });
    if (tripUpdateResult.count === 0) {
      throw { code: 400, message: 'Trip was concurrently modified' };
    }

    changes.push({ tripId, userIds: [userId] });

    return { ...driverTrip, status: 'STARTED', startedAt: new Date() };
  });
};

exports.completeTrip = async (userId, tripId) => {
  return await lifecycleTransaction(async (tx, changes) => {
    const driverProfile = await tx.driverProfile.findUnique({
      where: { userId },
    });
    if (!driverProfile) throw { code: 404, message: 'Driver profile not found' };

    const driverTrip = await tx.driverTrip.findUnique({
      where: { tripId },
    });
    if (!driverTrip || driverTrip.driverProfileId !== driverProfile.id) {
      throw { code: 403, message: 'Not authorized for this trip' };
    }
    const now = new Date();

    const updatedDriverTripResult = await tx.driverTrip.updateMany({
      where: { id: driverTrip.id, status: 'STARTED' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (updatedDriverTripResult.count === 0) {
      throw { code: 400, message: 'Can only complete a STARTED trip' };
    }

    const tripUpdateResult = await tx.trip.updateMany({
      where: { id: tripId, status: 'STARTED' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    if (tripUpdateResult.count === 0) {
      throw { code: 400, message: 'Trip was concurrently modified' };
    }

    const trip = await tx.trip.findUnique({
      where: { id: tripId },
      include: { tripUsers: true },
    });

    await tx.rideRequest.updateMany({
      where: {
        id: { in: trip.tripUsers.map((tu) => tu.rideRequestId) },
      },
      data: {
        status: 'COMPLETED',
      },
    });

    changes.push({ tripId, userIds: [userId, ...trip.tripUsers.map(tu => tu.userId)] });

    return { ...driverTrip, status: 'COMPLETED', completedAt: now };
  });
};

exports.getCurrentTrip = async (userId) => {
  // Cache-aside for driver's active trip
  const cached = await cacheGet(CACHE_CURRENT_TRIP_KEY(userId));
  if (cached) return cached;

  const driverProfile = await prisma.driverProfile.findUnique({
    where: { userId },
  });
  if (!driverProfile) return null;

  const trip = await prisma.trip.findFirst({
    where: {
      status: { in: ['DRIVER_MATCHED', 'STARTED'] },
      driverTrip: {
        driverProfileId: driverProfile.id,
      },
    },
    include: {
      tripUsers: {
        include: { user: true },
      },
      tripStops: {
        include: {
          rideRequest: {
            select: {
              pickupAddress: true,
              dropAddress: true,
            },
          },
        },
        orderBy: { stopOrder: 'asc' }
      },
      driverTrip: true,
    },
  });

  if (trip) {
    await cacheSet(CACHE_CURRENT_TRIP_KEY(userId), trip, TTL_CURRENT_TRIP);
  }
  return trip;
};
