const { publishChanges } = require('../../socket/lifecycle');
const prisma = require("../../prisma/client");
const { calculateFares } = require("./trip.fare");
const { getRoadDistances, ROAD_DETOUR_THRESHOLD } = require("./osrm");
const { haversine } = require("../matching/utils");
const { cacheGet, cacheSet, invalidateTripCaches,
  CACHE_TRIP_KEY, CACHE_CURRENT_TRIP_KEY, CACHE_AVAILABLE_TRIPS_KEY,
  TTL_TRIP, TTL_CURRENT_TRIP, cacheDel } = require('../../utils/cache');

const AVG_SPEED_KMH = 30;
const LOCK_BEFORE_DEPARTURE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create Trip from matching result
 * STRICT version (safe + aligned with schema)
 * @param {Object} match - Match object with users, route, detourRatio
 * @param {Object} tx - Optional transaction client. If provided, uses it; otherwise creates new transaction
 */
async function createTripFromMatch(match, tx = null) {
  const { users, route, detourRatio } = match;

  if (!route || !route.orderedIndices) {
    throw new Error('Invalid match: route.orderedIndices missing');
  }

  if (route.orderedIndices.length !== users.length * 2) {
    throw new Error(`Invalid match: orderedIndices.length=${route.orderedIndices.length} expected=${users.length * 2}`);
  }

  if (!users || users.length < 2) {
    throw new Error('Invalid match: not enough users');
  }

  const rideRequestIds = users.map((u) => u.rideRequestId);
  const coords = [
    ...users.map((u) => ({ lat: u.pickupLat, lng: u.pickupLng })),
    ...users.map((u) => ({ lat: u.dropLat, lng: u.dropLng })),
  ];

  const orderedStops = route.orderedIndices.map((idx) => coords[idx]);
  const haversineTotal = route.totalDistance;

  // Always use OSRM (or its fallback logic inside getRoadDistances)
  const roadData = await getRoadDistances(orderedStops, users, haversineTotal);

  if (roadData.roadDetourRatio > ROAD_DETOUR_THRESHOLD) {
    console.warn(
      `[OSRM] Road detour too high: ${roadData.roadDetourRatio.toFixed(2)} > ${ROAD_DETOUR_THRESHOLD}. Rejecting match.`
    );
    throw new Error('ROAD_DETOUR_EXCEEDED');
  }

  const totalRoadDistanceKm = roadData.totalRoadDistanceKm;
  const estimatedEtaMinutes = Math.round((totalRoadDistanceKm / AVG_SPEED_KMH) * 60);

  const executor = tx || prisma;
  const isNestedTransaction = !!tx;

  const executeTransaction = async (txContext) => {
    const validRequests = await txContext.rideRequest.findMany({
      where: {
        id: { in: rideRequestIds },
        status: 'PENDING',
      },
      select: { id: true },
    });

    if (validRequests.length !== rideRequestIds.length) {
      throw new Error('Some ride requests already processed');
    }

    // Calculate lockedAt from earliest preferredTime
    const rideRequestsForLock = await txContext.rideRequest.findMany({
      where: { id: { in: rideRequestIds } },
      select: { preferredTime: true },
    });
    const earliestTime = new Date(
      Math.min(...rideRequestsForLock.map(r => r.preferredTime.getTime()))
    );
    const lockedAt = new Date(earliestTime.getTime() - LOCK_BEFORE_DEPARTURE_MS);

    const trip = await txContext.trip.create({
      data: {
        status: 'RIDERS_MATCHED',
        totalDistanceKm: totalRoadDistanceKm,
        estimatedEtaMinutes,
        detourRatio: roadData.roadDetourRatio,
        lockedAt,
      },
    });

    const stopsData = buildTripStopsWithRoadDistances(users, route.orderedIndices, roadData.legDistances).map((stop) => ({
      tripId: trip.id,
      ...stop,
    }));

    const fares = calculateFares(users, stopsData);

    await txContext.tripUser.createMany({
      data: users.map((user) => ({
        tripId: trip.id,
        userId: user.userId,
        rideRequestId: user.rideRequestId,
        fareShare: fares[user.rideRequestId],
      })),
    });

    await txContext.tripStop.createMany({ data: stopsData });

    await txContext.rideRequest.updateMany({
      where: {
        id: { in: rideRequestIds },
        status: 'PENDING',
      },
      data: {
        status: 'RIDERS_MATCHED',
        pendingCycles: 0,
      },
    });

    return trip;
  };

  if (isNestedTransaction) {
    const result = await executeTransaction(tx);
    // Invalidate available trips list + all newly matched riders' caches
    const userIds = users.map(u => u.userId);
    await cacheDel(CACHE_AVAILABLE_TRIPS_KEY(), ...userIds.map(CACHE_CURRENT_TRIP_KEY));
    return result;
  }

  const result = await executor.$transaction(executeTransaction);
  // Invalidate available trips list + all newly matched riders' caches
  const userIds = users.map(u => u.userId);
  await publishChanges([{ tripId: result.id, userIds }]);
  return result;
}

function buildTripStopsWithRoadDistances(users, orderedIndices, legDistances) {
  const n = users.length;
  const coords = [
    ...users.map((u) => ({ lat: u.pickupLat, lng: u.pickupLng })),
    ...users.map((u) => ({ lat: u.dropLat, lng: u.dropLng })),
  ];

  const active = new Set();
  const stops = [];

  for (let i = 0; i < orderedIndices.length; i++) {
    const idx = orderedIndices[i];
    const { lat, lng } = coords[idx];
    const segmentDistKm = i === 0 ? 0 : legDistances[i - 1];
    const activePassengers = active.size;

    let type;
    let rideRequestId;

    if (idx < n) {
      type = 'PICKUP';
      rideRequestId = users[idx].rideRequestId;
      active.add(idx);
    } else {
      type = 'DROPOFF';
      const userIdx = idx - n;
      rideRequestId = users[userIdx].rideRequestId;
      active.delete(userIdx);
    }

    stops.push({
      stopOrder: i,
      type,
      lat,
      lng,
      rideRequestId,
      segmentDistKm,
      activePassengersOnSegment: activePassengers,
    });
  }

  return stops;
}

async function getTripById(tripId, userId) {
  // Cache-aside: serve from Redis if fresh
  const cacheKey = CACHE_TRIP_KEY(tripId);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    // Still enforce auth even on cache hit
    const isParticipant = cached.tripUsers.some((tu) => tu.userId === userId);
    if (!isParticipant) throw { code: 403, message: 'Forbidden' };
    return cached;
  }

  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
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
      },
    },
  });

  if (!trip) {
    return null;
  }

  const isParticipant = trip.tripUsers.some((tu) => tu.userId === userId);
  if (!isParticipant) {
    throw { code: 403, message: 'Forbidden' };
  }

  await cacheSet(cacheKey, trip, TTL_TRIP);
  return trip;
}

async function getCurrentTrip(userId) {
  // Cache-aside: serve from Redis if fresh
  const cacheKey = CACHE_CURRENT_TRIP_KEY(userId);
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const activeTrip = await prisma.trip.findFirst({
    where: {
      status: { in: ['RIDERS_MATCHED', 'DRIVER_MATCHED', 'STARTED'] },
      tripUsers: {
        some: { userId },
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
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  if (activeTrip) {
    await cacheSet(cacheKey, activeTrip, TTL_CURRENT_TRIP);
    return activeTrip;
  }

  return null;
}



module.exports = {
  createTripFromMatch,
  getTripById,
  getCurrentTrip,
};