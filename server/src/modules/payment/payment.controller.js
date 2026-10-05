const paymentService = require('./payment.service');
const { success, error } = require('../../utils/response');

/**
 * POST /api/payment/create-order
 * Initiates Razorpay payment order for the rider's trip fare share
 */
exports.createOrder = async (req, res) => {
  try {
    const userId = req.userId;
    const { tripId, tripUserId } = req.body;

    if (!tripId && !tripUserId) {
      return error(res, 'tripId or tripUserId is required', 400);
    }

    if (tripId && (typeof tripId !== 'string' || !tripId.trim())) {
      return error(res, 'tripId must be a non-empty string', 400);
    }

    if (tripUserId && (typeof tripUserId !== 'string' || !tripUserId.trim())) {
      return error(res, 'tripUserId must be a non-empty string', 400);
    }

    const orderData = await paymentService.createOrder({
      userId,
      tripId: tripId ? tripId.trim() : undefined,
      tripUserId: tripUserId ? tripUserId.trim() : undefined,
    });

    return success(res, orderData, 200);
  } catch (err) {
    console.error('Create payment order error:', err);
    const status = err.status || (err.message && err.message.includes('not found') ? 404 : 500);
    return error(res, err.message || 'Failed to create payment order', status);
  }
};

/**
 * POST /api/payment/verify
 * Cryptographically verifies Razorpay payment signature and updates payment status
 */
exports.verifyPayment = async (req, res) => {
  try {
    const userId = req.userId;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature, tripUserId } = req.body;

    if (!razorpayOrderId || typeof razorpayOrderId !== 'string' || !razorpayOrderId.trim()) {
      return error(res, 'razorpayOrderId is required', 400);
    }

    if (!razorpayPaymentId || typeof razorpayPaymentId !== 'string' || !razorpayPaymentId.trim()) {
      return error(res, 'razorpayPaymentId is required', 400);
    }

    if (!razorpaySignature || typeof razorpaySignature !== 'string' || !razorpaySignature.trim()) {
      return error(res, 'razorpaySignature is required', 400);
    }

    const verifyResult = await paymentService.verifyPayment({
      userId,
      razorpayOrderId: razorpayOrderId.trim(),
      razorpayPaymentId: razorpayPaymentId.trim(),
      razorpaySignature: razorpaySignature.trim(),
      tripUserId: tripUserId ? tripUserId.trim() : undefined,
    });

    return success(res, {
      status: 'SUCCESS',
      paymentId: verifyResult.paymentId,
      tripUserId: verifyResult.tripUserId,
    }, 200);
  } catch (err) {
    console.error('Verify payment error:', err);
    const status = err.status || 400;
    return error(res, err.message || 'Payment verification failed', status);
  }
};

/**
 * GET /api/payment/status/:tripId
 * Fetches the payment status for the requesting rider and trip
 */
exports.getPaymentStatus = async (req, res) => {
  try {
    const userId = req.userId;
    const { tripId } = req.params;

    if (!tripId || typeof tripId !== 'string' || !tripId.trim()) {
      return error(res, 'tripId is required', 400);
    }

    const paymentStatus = await paymentService.getPaymentStatus({
      userId,
      tripId: tripId.trim(),
    });

    return success(res, paymentStatus, 200);
  } catch (err) {
    console.error('Get payment status error:', err);
    const status = err.status || (err.message && err.message.includes('not found') ? 404 : 500);
    return error(res, err.message || 'Failed to fetch payment status', status);
  }
};
