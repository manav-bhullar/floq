const { lifecycleTransaction } = require('../../socket/lifecycle');
/**
 * Expansion Service — Add riders to existing RIDERS_MATCHED trips
 * 
 * Core guarantee: Pareto improvement only.
 * No existing rider's fare will increase after expansion.
 */

const prisma = require('../../prisma/client');
const { optimizeRoute, MAX_GROUP_SIZE } = require('../matching/route');
const { getRoadDistances, ROAD_DETOUR_THRESHOLD } = require('./osrm');
const { calculateFares } = require('./trip.fare');
const { haversine } = require('../matching/utils');

const AVG_SPEED_KMH = 30;
const MAX_USER_DETOUR = 0.30;
const LOCK_BEFORE_DEPARTURE_MS = 30 * 60 * 1000;

/**
 * Try to add a new rider to an existing RIDERS_MATCHED trip.
 * 
 * @param {string} tripId - ID of the existing trip
 * @param {Object} newRideRequest - The PENDING ride request to add
 *   { id, userId, pickupLat, pickupLng, dropLat, dropLng, preferredTime }
 * @returns {{ expanded: boolean, reason?: string, tripId?: string }}
 */
async function tryExpandTrip(tripId, newRideRequest) {
  return await lifecycleTransaction(async (tx, changes) => {

    // ─── Step 0: Lock resources to prevent concurrent expansion ───
    // This solves the critical distributed race condition
    const tripLock = await tx.$queryRaw`SELECT id FROM "Trip" WHERE id = ${tripId}::uuid FOR UPDATE`;
    if (!tripLock || tripLock.length === 0) {
      return { expanded: false, reason: 'TRIP_NOT_FOUND' };
    }

    const reqLock = await tx.$queryRaw`SELECT id, status FROM "RideRequest" WHERE id = ${newRideRequest.id}::uuid FOR UPDATE`;
    if (!reqLock || reqLock.length === 0 || reqLock[0].status !== 'PENDING') {
      return { expanded: false, reason: 'REQUEST_NOT_PENDING' };
    }

    // ─── Step 1: Fetch trip with all relations ───
    const trip = await tx.trip.findUnique({
      where: { id: tripId },
      include: {
        tripUsers: {
          include: {
            rideRequest: {
              select: {
                id: true,
                pickupLat: true,
                pickupLng: true,
                dropLat: true,
                dropLng: true,
                preferredTime: true,
              },
            },
          },
        },
        tripStops: true,
      },
    });

    if (!trip) {
      return { expanded: false, reason: 'TRIP_NOT_FOUND' };
    }

    // ─── Step 2: Guard checks ───
    if (trip.status !== 'RIDERS_MATCHED') {
      return { expanded: false, reason: 'WRONG_STATUS' };
    }

    if (trip.lockedAt && new Date() >= trip.lockedAt) {
      return { expanded: false, reason: 'LOCKED' };
    }

    if (trip.tripUsers.length >= MAX_GROUP_SIZE) {
      return { expanded: false, reason: 'FULL' };
    }



    // ─── Step 3: Build combined user list ───
    // Existing users (from their ride requests)
    const existingUsers = trip.tripUsers.map(tu => ({
      id: tu.rideRequest.id,           // matching engine uses rideRequest.id as user.id
      userId: tu.userId,
      rideRequestId: tu.rideRequest.id,
      pickupLat: tu.rideRequest.pickupLat,
      pickupLng: tu.rideRequest.pickupLng,
      dropLat: tu.rideRequest.dropLat,
      dropLng: tu.rideRequest.dropLng,
    }));

    // New user
    const newUser = {
      id: newRideRequest.id,
      userId: newRideRequest.userId,
      rideRequestId: newRideRequest.id,
      pickupLat: newRideRequest.pickupLat,
      pickupLng: newRideRequest.pickupLng,
      dropLat: newRideRequest.dropLat,
      dropLng: newRideRequest.dropLng,
    };

    const combinedUsers = [...existingUsers, newUser];

    // ─── Step 4: Route optimization ───
    const route = optimizeRoute(combinedUsers);

    if (!route || !route.sequence) {
      return { expanded: false, reason: 'NO_VALID_ROUTE' };
    }

    if (route.maxUserDetour > MAX_USER_DETOUR) {
      return { expanded: false, reason: 'DETOUR_EXCEEDED' };
    }

    // ─── Step 5: Road distance validation ───
    const coords = [
      ...combinedUsers.map(u => ({ lat: u.pickupLat, lng: u.pickupLng })),
      ...combinedUsers.map(u => ({ lat: u.dropLat, lng: u.dropLng })),
    ];
    const orderedStops = route.orderedIndices.map(idx => coords[idx]);
    const haversineTotal = route.totalDistance;

    const roadData = await getRoadDistances(orderedStops, combinedUsers, haversineTotal);

    if (roadData.roadDetourRatio > ROAD_DETOUR_THRESHOLD) {
      return { expanded: false, reason: 'ROAD_DETOUR_EXCEEDED' };
    }

    // ─── Step 6: Calculate new fares ───
    const n = combinedUsers.length;
    const allCoords = [
      ...combinedUsers.map(u => ({ lat: u.pickupLat, lng: u.pickupLng })),
      ...combinedUsers.map(u => ({ lat: u.dropLat, lng: u.dropLng })),
    ];

    const active = new Set();
    const stopsData = [];

    for (let i = 0; i < route.orderedIndices.length; i++) {
      const idx = route.orderedIndices[i];
      const { lat, lng } = allCoords[idx];
      const segmentDistKm = i === 0 ? 0 : roadData.legDistances[i - 1];
      const activePassengers = active.size;

      let type;
      let rideRequestId;

      if (idx < n) {
        type = 'PICKUP';
        rideRequestId = combinedUsers[idx].rideRequestId;
        active.add(idx);
      } else {
        type = 'DROPOFF';
        const userIdx = idx - n;
        rideRequestId = combinedUsers[userIdx].rideRequestId;
        active.delete(userIdx);
      }

      stopsData.push({
        stopOrder: i,
        type,
        lat,
        lng,
        rideRequestId,
        segmentDistKm,
        activePassengersOnSegment: activePassengers,
      });
    }

    const newFares = calculateFares(combinedUsers, stopsData);

    // ─── Step 7: PARETO CHECK ───
    // Every existing rider's fare must stay same or decrease
    const oldFares = {};
    for (const tu of trip.tripUsers) {
      oldFares[tu.rideRequestId] = tu.fareShare;
    }

    for (const [rideRequestId, oldFare] of Object.entries(oldFares)) {
      const newFare = newFares[rideRequestId];
      if (newFare > oldFare) {
        console.log(
          `⏭️ Pareto check failed: rider ${rideRequestId} fare would increase ` +
          `₹${oldFare.toFixed(2)} → ₹${newFare.toFixed(2)}`
        );
        return { expanded: false, reason: 'PARETO_FAILED' };
      }
    }

    // ─── Step 8: Apply expansion (all checks passed) ───
    const totalRoadDistanceKm = roadData.totalRoadDistanceKm;
    const estimatedEtaMinutes = Math.round((totalRoadDistanceKm / AVG_SPEED_KMH) * 60);

    // Recalculate lockedAt (new rider might have earlier preferredTime)
    const allPreferredTimes = [
      ...trip.tripUsers.map(tu => tu.rideRequest.preferredTime),
      newRideRequest.preferredTime,
    ];
    const earliestTime = new Date(
      Math.min(...allPreferredTimes.map(t => new Date(t).getTime()))
    );
    const lockedAt = new Date(earliestTime.getTime() - LOCK_BEFORE_DEPARTURE_MS);

    // 8a. Add new TripUser
    await tx.tripUser.create({
      data: {
        tripId: trip.id,
        userId: newRideRequest.userId,
        rideRequestId: newRideRequest.id,
        fareShare: newFares[newRideRequest.id],
      },
    });

    // 8b. Update existing TripUsers' fares
    for (const tu of trip.tripUsers) {
      await tx.tripUser.update({
        where: { id: tu.id },
        data: { fareShare: newFares[tu.rideRequestId] },
      });
    }

    // 8c. Delete old stops, create new ones
    await tx.tripStop.deleteMany({ where: { tripId: trip.id } });
    await tx.tripStop.createMany({
      data: stopsData.map(stop => ({ tripId: trip.id, ...stop })),
    });

    // 8d. Update trip metadata
    await tx.trip.update({
      where: { id: trip.id },
      data: {
        totalDistanceKm: totalRoadDistanceKm,
        estimatedEtaMinutes,
        detourRatio: roadData.roadDetourRatio,
        lockedAt,
      },
    });

    // 8e. Update ride request status
    await tx.rideRequest.update({
      where: { id: newRideRequest.id },
      data: { status: 'RIDERS_MATCHED', pendingCycles: 0 },
    });

    console.log(
      `✅ Trip ${trip.id} expanded: ${trip.tripUsers.length} → ${trip.tripUsers.length + 1} riders. ` +
      `Pareto check passed. New distance: ${totalRoadDistanceKm.toFixed(2)}km`
    );

    changes.push({ tripId: trip.id, userIds: [...trip.tripUsers.map(tu => tu.userId), newRideRequest.userId] });
    return { expanded: true, tripId: trip.id };
  });
}

/**
 * Run expansion for all remaining PENDING requests against all eligible trips.
 * Called after batch matching creates new trips.
 * 
 * @returns {{ expandedCount: number, attempts: number }}
 */
async function runExpansionPhase() {
  // Fetch all PENDING ride requests whose departure time is still in the future
  const pendingRequests = await prisma.rideRequest.findMany({
    where: {
      status: 'PENDING',
      preferredTime: { gte: new Date() },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (pendingRequests.length === 0) {
    return { expandedCount: 0, attempts: 0 };
  }

  // Fetch all eligible trips (RIDERS_MATCHED, not locked, not full)
  const eligibleTrips = await prisma.trip.findMany({
    where: {
      status: 'RIDERS_MATCHED',
      OR: [
        { lockedAt: null },
        { lockedAt: { gt: new Date() } },
      ],
    },
    include: {
      tripUsers: true,
    },
  });

  // Filter to trips that aren't full
  const expandableTrips = eligibleTrips.filter(
    t => t.tripUsers.length < MAX_GROUP_SIZE
  );

  if (expandableTrips.length === 0) {
    return { expandedCount: 0, attempts: 0 };
  }

  let expandedCount = 0;
  let attempts = 0;
  const expandedRequestIds = new Set();

  for (const request of pendingRequests) {
    // Skip if this request was already expanded in this phase
    if (expandedRequestIds.has(request.id)) continue;

    for (const trip of expandableTrips) {
      attempts++;

      const result = await tryExpandTrip(trip.id, request);

      if (result.expanded) {
        expandedCount++;
        expandedRequestIds.add(request.id);
        // Update trip's user count in memory to avoid double-expansion
        trip.tripUsers.push({ rideRequestId: request.id });
        break; // Move to next pending request
      }
    }
  }

  if (expandedCount > 0) {
    console.log(`✅ Expansion phase: ${expandedCount} riders added to existing trips (${attempts} attempts)`);
  }

  return { expandedCount, attempts };
}

module.exports = {
  tryExpandTrip,
  runExpansionPhase,
};
