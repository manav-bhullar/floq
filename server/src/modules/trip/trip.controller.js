const prisma = require('../../prisma/client');
const service = require('./trip.service');
const { success, error } = require('../../utils/response');
const { calculatePassengerMetrics } = require('./trip.utils');
const { getRedis } = require('../../utils/redis');

const DRIVER_LOCATION_KEY = (tripId) => `driver:location:${tripId}`;

function serializeTrip(trip, userId) {
	const myTripUser = trip.tripUsers.find((tu) => tu.userId === userId);
	const fareShare = myTripUser ? Math.round((myTripUser.fareShare + Number.EPSILON) * 100) / 100 : null;

	const stops = (trip.tripStops || [])
		.slice()
		.sort((a, b) => a.stopOrder - b.stopOrder)
		.map((s) => {
			const addressField = s.type === 'PICKUP' ? s.rideRequest?.pickupAddress : s.rideRequest?.dropAddress;
			return {
				stopOrder: s.stopOrder,
				type: s.type,
				lat: s.lat,
				lng: s.lng,
				address: addressField ?? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`,
				rideRequestId: s.rideRequestId,
				segmentDistKm: s.segmentDistKm,
				activePassengersOnSegment: s.activePassengersOnSegment,
			};
		});

	const passengers = trip.tripUsers.map((tu) => {
		const base = {
			userId: tu.userId,
			name: tu.user.name,
			rideRequestId: tu.rideRequestId,
			fareShare: Math.round((tu.fareShare + Number.EPSILON) * 100) / 100,
		};

		const metrics = calculatePassengerMetrics(stops, tu.rideRequestId);

		return {
			...base,
			distanceKm: Number((metrics.distanceKm || 0)),
			etaMinutes: metrics.etaMinutes,
		};
	});

	return {
		id: trip.id,
		status: trip.status,
		totalDistanceKm: trip.totalDistanceKm,
		estimatedEtaMinutes: trip.estimatedEtaMinutes,
		detourRatio: trip.detourRatio,
		fareShare,
		passengers,
		stops,
		createdAt: trip.createdAt,
		completedAt: trip.completedAt || null,
	};
}

/**
 * GET /api/trips
 * Returns trips relevant to the requesting user (via `x-user-id` header).
 */
exports.getTrips = async (req, res) => {
	try {
		const userId = req.userId;

		const trips = await prisma.trip.findMany({
			where: {
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
			orderBy: { createdAt: 'desc' },
		});

		const payload = trips.map((trip) => serializeTrip(trip, userId));

		return success(res, payload);
	} catch (err) {
		console.error('Get trips error:', err);
		return error(res, err.message || 'Failed to fetch trips', 500);
	}
};

/**
 * POST /api/trips/:id/complete
 * Mark a trip as completed. Requesting user must be a participant.
 * 
 * PHASE 3 FIX: Lifecycle Synchronization
 * Trip completion now updates all associated ride requests to COMPLETED state.
 * This ensures trip.status and rideRequest.status are always consistent.
 */
exports.getTripById = async (req, res) => {
	try {
		const userId = req.userId;
		const { id } = req.params;
		if (!id) {
			return error(res, 'Missing trip id', 400);
		}

		const trip = await service.getTripById(id, userId);
		if (!trip) {
			return error(res, 'Trip not found', 404);
		}

		const payload = serializeTrip(trip, userId);
		return success(res, payload);
	} catch (err) {
		console.error('Get trip by id error:', err);
		return error(res, err.message || 'Failed to fetch trip', err.code || 500);
	}
};

exports.getCurrent = async (req, res) => {
	try {
		const userId = req.userId;

		const trip = await service.getCurrentTrip(userId);
		if (!trip) {
			return success(res, null);
		}

		const payload = serializeTrip(trip, userId);
		return success(res, payload);
	} catch (err) {
		console.error('Get current trip error:', err);
		return error(res, err.message || 'Failed to fetch current trip', 500);
	}
};

/**
 * GET /api/trips/:id/driver-location
 * Returns the last known driver GPS location from Redis.
 * REST fallback for riders who briefly lose their socket connection.
 */
exports.getDriverLocation = async (req, res) => {
	try {
		const userId = req.userId;
		const { id: tripId } = req.params;

		// Verify the requesting user is a participant of this trip
		const tripUser = await prisma.tripUser.findFirst({
			where: { tripId, userId },
		});
		if (!tripUser) {
			return error(res, 'Forbidden: you are not a participant of this trip', 403);
		}

		const cached = await getRedis().get(DRIVER_LOCATION_KEY(tripId));
		if (!cached) {
			return error(res, 'No driver location available yet', 404);
		}

		return success(res, JSON.parse(cached));
	} catch (err) {
		console.error('Get driver location error:', err);
		return error(res, err.message || 'Failed to fetch driver location', 500);
	}
};

