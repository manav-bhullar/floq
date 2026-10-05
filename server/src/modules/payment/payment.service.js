const crypto = require('crypto');
const prisma = require('../../prisma/client');
const { getRazorpayInstance, getKeyId, getKeySecret } = require('./razorpay.client');

/**
 * Standard Razorpay HMAC SHA-256 verification using timing-safe comparison
 * 
 * @param {string} orderId 
 * @param {string} paymentId 
 * @param {string} signature 
 * @param {string} secret 
 * @returns {boolean}
 */
function verifyPaymentSignature(orderId, paymentId, signature, secret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  if (
    typeof orderId !== 'string' ||
    typeof paymentId !== 'string' ||
    typeof signature !== 'string' ||
    typeof secret !== 'string'
  ) {
    return false;
  }

  const payload = `${orderId}|${paymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const signatureBuffer = Buffer.from(signature, 'utf8');

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

/**
 * Safe conversion from rupee amount to paise with IEEE 754 precision protection
 * 
 * @param {number} amountInRupees 
 * @returns {number} Amount in paise (integer)
 */
function convertRupeesToPaise(amountInRupees) {
  if (typeof amountInRupees !== 'number' || isNaN(amountInRupees) || !isFinite(amountInRupees)) {
    throw new TypeError('Fare amount must be a finite number');
  }
  if (amountInRupees < 0) {
    throw new RangeError('Fare amount cannot be negative');
  }
  return Math.round(amountInRupees * 100);
}

/**
 * Create Razorpay payment order for a rider's trip fare
 * 
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.tripId]
 * @param {string} [params.tripUserId]
 */
async function createOrder({ userId, tripId, tripUserId }) {
  if (!tripId && !tripUserId) {
    const err = new Error('tripId or tripUserId is required');
    err.status = 400;
    throw err;
  }

  let tripUser = null;

  if (tripUserId) {
    tripUser = await prisma.tripUser.findUnique({
      where: { id: tripUserId },
      include: {
        payment: true,
        trip: true,
      },
    });

    if (tripUser && userId && tripUser.userId !== userId) {
      const err = new Error('Unauthorized to pay for this ride');
      err.status = 403;
      throw err;
    }
  } else if (tripId) {
    tripUser = await prisma.tripUser.findFirst({
      where: {
        tripId,
        userId,
      },
      include: {
        payment: true,
        trip: true,
      },
    });
  }

  if (!tripUser) {
    const err = new Error('Trip record not found for user');
    err.status = 404;
    throw err;
  }

  // Prevent duplicate payment for already successful transactions
  if (tripUser.payment && tripUser.payment.status === 'SUCCESS') {
    const err = new Error('Payment already completed for this trip');
    err.status = 409;
    throw err;
  }

  const amountInPaise = convertRupeesToPaise(tripUser.fareShare);

  const razorpay = getRazorpayInstance();
  const receiptId = `rcpt_${tripUser.id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 30)}`;

  const orderOptions = {
    amount: amountInPaise,
    currency: 'INR',
    receipt: receiptId,
    notes: {
      tripId: tripUser.tripId,
      userId: tripUser.userId,
      tripUserId: tripUser.id,
    },
  };

  const razorpayOrder = await razorpay.orders.create(orderOptions);

  // Upsert Payment record in PENDING state
  await prisma.payment.upsert({
    where: { tripUserId: tripUser.id },
    create: {
      tripUserId: tripUser.id,
      razorpayOrderId: razorpayOrder.id,
      amount: tripUser.fareShare,
      currency: 'INR',
      status: 'PENDING',
    },
    update: {
      razorpayOrderId: razorpayOrder.id,
      amount: tripUser.fareShare,
      currency: 'INR',
      status: 'PENDING',
      razorpayPaymentId: null,
      razorpaySignature: null,
    },
  });

  return {
    orderId: razorpayOrder.id,
    amount: amountInPaise,
    currency: 'INR',
    keyId: getKeyId(),
    tripUserId: tripUser.id,
    fareShare: tripUser.fareShare,
  };
}

/**
 * Verify Razorpay payment cryptographic signature and update DB status to SUCCESS
 * 
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.razorpayOrderId
 * @param {string} params.razorpayPaymentId
 * @param {string} params.razorpaySignature
 * @param {string} [params.tripUserId]
 */
async function verifyPayment({ userId, razorpayOrderId, razorpayPaymentId, razorpaySignature, tripUserId }) {
  if (!razorpayOrderId || typeof razorpayOrderId !== 'string' || !razorpayOrderId.trim()) {
    const err = new Error('razorpayOrderId is required');
    err.status = 400;
    throw err;
  }
  if (!razorpayPaymentId || typeof razorpayPaymentId !== 'string' || !razorpayPaymentId.trim()) {
    const err = new Error('razorpayPaymentId is required');
    err.status = 400;
    throw err;
  }
  if (!razorpaySignature || typeof razorpaySignature !== 'string' || !razorpaySignature.trim()) {
    const err = new Error('razorpaySignature is required');
    err.status = 400;
    throw err;
  }

  const secret = getKeySecret();
  const isValid = verifyPaymentSignature(
    razorpayOrderId.trim(),
    razorpayPaymentId.trim(),
    razorpaySignature.trim(),
    secret
  );

  if (!isValid) {
    const err = new Error('Payment signature verification failed');
    err.status = 400;
    throw err;
  }

  // Find existing Payment record
  const searchConditions = [{ razorpayOrderId: razorpayOrderId.trim() }];
  if (tripUserId) {
    searchConditions.push({ tripUserId });
  }

  const payment = await prisma.payment.findFirst({
    where: {
      OR: searchConditions,
    },
    include: {
      tripUser: true,
    },
  });

  if (!payment) {
    const err = new Error('Payment record not found');
    err.status = 404;
    throw err;
  }

  if (userId && payment.tripUser && payment.tripUser.userId !== userId) {
    const err = new Error('Unauthorized payment verification');
    err.status = 403;
    throw err;
  }

  const updatedPayment = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'SUCCESS',
      razorpayPaymentId: razorpayPaymentId.trim(),
      razorpaySignature: razorpaySignature.trim(),
    },
  });

  return {
    status: 'SUCCESS',
    paymentId: razorpayPaymentId.trim(),
    tripUserId: payment.tripUserId,
    payment: updatedPayment,
  };
}

/**
 * Query payment status for a trip
 * 
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.tripId]
 * @param {string} [params.tripUserId]
 */
async function getPaymentStatus({ userId, tripId, tripUserId }) {
  let tripUser = null;

  if (tripUserId) {
    tripUser = await prisma.tripUser.findUnique({
      where: { id: tripUserId },
      include: { payment: true },
    });

    if (tripUser && userId && tripUser.userId !== userId) {
      const err = new Error('Forbidden: Cannot access payment status for another user');
      err.status = 403;
      throw err;
    }
  } else if (tripId) {
    tripUser = await prisma.tripUser.findFirst({
      where: {
        tripId,
        userId,
      },
      include: { payment: true },
    });
  }

  if (!tripUser) {
    const err = new Error('Trip user not found');
    err.status = 404;
    throw err;
  }

  const payment = tripUser.payment || null;
  const isPaid = payment?.status === 'SUCCESS';

  return {
    isPaid,
    status: payment?.status || null,
    payment,
    fareShare: tripUser.fareShare,
    tripUserId: tripUser.id,
  };
}

module.exports = {
  createOrder,
  verifyPayment,
  getPaymentStatus,
  verifyPaymentSignature,
  convertRupeesToPaise,
};
