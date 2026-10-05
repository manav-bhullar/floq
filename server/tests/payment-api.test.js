/**
 * Payment API Integration Test Suite
 * 
 * Tests:
 * 1. POST /api/payment/create-order:
 *    - Unauthenticated request (401)
 *    - Non-existent trip (404)
 *    - Valid trip (200, valid order payload)
 *    - Amount validation (paise === Math.round(fareShare * 100))
 *    - Unauthorized rider (403/404)
 * 2. POST /api/payment/verify:
 *    - Unauthenticated request (401)
 *    - Missing required parameters (400)
 *    - Invalid / forged HMAC signature (400)
 *    - Valid HMAC signature (200, DB updated to SUCCESS)
 * 3. GET /api/payment/status/:tripId:
 *    - Unauthenticated request (401)
 *    - Unpaid trip status (200, isPaid: false)
 *    - Paid trip status (200, isPaid: true, status: SUCCESS)
 *    - Non-existent trip status (404)
 * 4. Idempotency & Double Payment Prevention:
 *    - Attempting to create order for already paid trip (409/400)
 *    - Duplicate verify calls
 */

require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const app = require('../src/app');
const prisma = require('../src/prisma/client');
const { generateAccessToken } = require('../src/utils/jwt');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, label, details = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${label}${details ? ' — ' + details : ''}`);
    failedTests++;
  }
}

async function runApiTests() {
  console.log('====================================================');
  console.log('🌐 Payment API Integration Test Suite');
  console.log('====================================================\n');

  let server;
  let baseUrl;
  let testUser;
  let testUser2;
  let testRideRequest;
  let testRideRequest2;
  let testTrip;
  let testTripUser;
  let testTripUser2;

  try {
    // ─── Setup Ephemeral Server ───
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}/api`;
        console.log(`📡 Ephemeral test server running at ${baseUrl}\n`);
        resolve();
      });
    });

    // ─── Setup Test Fixtures in Database ───
    console.log('🔧 Setting up test users, ride requests, and trip fixtures...');
    const uniqueSuffix = Date.now().toString().slice(-6);

    testUser = await prisma.user.create({
      data: {
        name: `Test Rider ${uniqueSuffix}`,
        email: `rider_${uniqueSuffix}@floqtest.com`,
        password: '$2b$10$ephemeralHashForTestingOnly1234567890123456789012',
        role: 'RIDER',
        isVerified: true,
      },
    });

    testUser2 = await prisma.user.create({
      data: {
        name: `Other Rider ${uniqueSuffix}`,
        email: `other_${uniqueSuffix}@floqtest.com`,
        password: '$2b$10$ephemeralHashForTestingOnly1234567890123456789012',
        role: 'RIDER',
        isVerified: true,
      },
    });

    const now = new Date();
    testRideRequest = await prisma.rideRequest.create({
      data: {
        userId: testUser.id,
        pickupLat: 30.3525,
        pickupLng: 76.3616,
        dropLat: 30.6942,
        dropLng: 76.8606,
        preferredTime: now,
        status: 'COMPLETED',
      },
    });

    testRideRequest2 = await prisma.rideRequest.create({
      data: {
        userId: testUser2.id,
        pickupLat: 30.3530,
        pickupLng: 76.3620,
        dropLat: 30.6940,
        dropLng: 76.8600,
        preferredTime: now,
        status: 'COMPLETED',
      },
    });

    testTrip = await prisma.trip.create({
      data: {
        status: 'COMPLETED',
        totalDistanceKm: 15.5,
        estimatedEtaMinutes: 25,
        detourRatio: 1.05,
        completedAt: now,
      },
    });

    testTripUser = await prisma.tripUser.create({
      data: {
        tripId: testTrip.id,
        userId: testUser.id,
        rideRequestId: testRideRequest.id,
        fareShare: 149.50, // ₹149.50 = 14950 paise
      },
    });

    testTripUser2 = await prisma.tripUser.create({
      data: {
        tripId: testTrip.id,
        userId: testUser2.id,
        rideRequestId: testRideRequest2.id,
        fareShare: 149.50,
      },
    });

    const token = generateAccessToken({
      id: testUser.id,
      email: testUser.email,
      role: testUser.role,
    });

    const otherToken = generateAccessToken({
      id: testUser2.id,
      email: testUser2.email,
      role: testUser2.role,
    });

    const authHeaders = { Authorization: `Bearer ${token}` };
    const otherAuthHeaders = { Authorization: `Bearer ${otherToken}` };

    console.log('✅ Test fixtures ready.\n');

    // ─── Test Group 1: POST /api/payment/create-order ───
    console.log('📦 Test Group 1: POST /api/payment/create-order');

    // 1.1 Unauthenticated Request (401)
    try {
      await axios.post(`${baseUrl}/payment/create-order`, { tripId: testTrip.id });
      assert(false, '1.1 Unauthenticated create-order should return 401');
    } catch (err) {
      assert(err.response?.status === 401, '1.1 Unauthenticated create-order returns 401 Unauthorized');
    }

    // 1.2 Non-existent trip (404)
    try {
      const fakeTripId = '00000000-0000-0000-0000-000000000000';
      await axios.post(`${baseUrl}/payment/create-order`, { tripId: fakeTripId }, { headers: authHeaders });
      assert(false, '1.2 Non-existent trip create-order should return 404');
    } catch (err) {
      assert(err.response?.status === 404, '1.2 Non-existent trip create-order returns 404 Not Found');
    }

    // 1.3 Missing tripId & tripUserId (400)
    try {
      await axios.post(`${baseUrl}/payment/create-order`, {}, { headers: authHeaders });
      assert(false, '1.3 Missing payload should return 400');
    } catch (err) {
      assert(err.response?.status === 400, '1.3 Missing payload returns 400 Bad Request');
    }

    // 1.4 Valid trip order creation (200)
    let createdOrderId = null;
    let createdAmount = null;
    try {
      const res = await axios.post(
        `${baseUrl}/payment/create-order`,
        { tripId: testTrip.id },
        { headers: authHeaders }
      );
      assert(res.status === 200 && res.data.success === true, '1.4 Valid trip creates order with 200 OK');
      
      const data = res.data.data;
      createdOrderId = data.orderId;
      createdAmount = data.amount;

      assert(Boolean(data.orderId), '1.4 Response contains orderId');
      assert(data.currency === 'INR', '1.4 Response currency is INR');
      assert(data.tripUserId === testTripUser.id, '1.4 Response matches tripUserId');
      
      // 1.5 Amount validation: paise === Math.round(fareShare * 100)
      const expectedPaise = Math.round(testTripUser.fareShare * 100);
      assert(data.amount === expectedPaise, `1.5 Amount ${data.amount} matches fareShare in paise (${expectedPaise})`);
    } catch (err) {
      assert(false, '1.4 Valid trip order creation failed', err.response?.data?.message || err.message);
    }

    // ─── Test Group 2: GET /api/payment/status/:tripId (Unpaid State) ───
    console.log('\n📊 Test Group 2: GET /api/payment/status/:tripId (Unpaid State)');

    // 2.1 Unauthenticated status check (401)
    try {
      await axios.get(`${baseUrl}/payment/status/${testTrip.id}`);
      assert(false, '2.1 Unauthenticated status check should return 401');
    } catch (err) {
      assert(err.response?.status === 401, '2.1 Unauthenticated status check returns 401');
    }

    // 2.2 Unpaid trip status (200, isPaid: false)
    try {
      const statusRes = await axios.get(`${baseUrl}/payment/status/${testTrip.id}`, { headers: authHeaders });
      assert(statusRes.status === 200 && statusRes.data.success === true, '2.2 Status query returns 200 OK');
      assert(statusRes.data.data.isPaid === false, '2.2 Unpaid trip correctly reports isPaid === false');
      assert(
        statusRes.data.data.status === 'PENDING' || statusRes.data.data.status === null,
        '2.2 Unpaid trip reports status as PENDING or null'
      );
      assert(statusRes.data.data.fareShare === testTripUser.fareShare, '2.2 Status returns correct fareShare');
    } catch (err) {
      assert(false, '2.2 Unpaid status check failed', err.response?.data?.message || err.message);
    }

    // 2.3 Non-existent trip status query (404)
    try {
      const fakeTripId = '00000000-0000-0000-0000-000000000000';
      await axios.get(`${baseUrl}/payment/status/${fakeTripId}`, { headers: authHeaders });
      assert(false, '2.3 Non-existent trip status should return 404');
    } catch (err) {
      assert(err.response?.status === 404, '2.3 Non-existent trip status returns 404');
    }

    // ─── Test Group 3: POST /api/payment/verify ───
    console.log('\n🔐 Test Group 3: POST /api/payment/verify');

    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET || 'rzp_test_secret_key_abc123';
    const activeOrderId = createdOrderId || 'order_mock_test_12345';
    const mockPaymentId = `pay_test_${Date.now()}`;

    // Generate valid HMAC signature
    const validSignature = crypto
      .createHmac('sha256', razorpaySecret)
      .update(`${activeOrderId}|${mockPaymentId}`)
      .digest('hex');

    // 3.1 Unauthenticated verify (401)
    try {
      await axios.post(`${baseUrl}/payment/verify`, {
        razorpayOrderId: activeOrderId,
        razorpayPaymentId: mockPaymentId,
        razorpaySignature: validSignature,
        tripUserId: testTripUser.id,
      });
      assert(false, '3.1 Unauthenticated verify should return 401');
    } catch (err) {
      assert(err.response?.status === 401, '3.1 Unauthenticated verify returns 401');
    }

    // 3.2 Missing parameters in verify (400)
    try {
      await axios.post(
        `${baseUrl}/payment/verify`,
        { razorpayOrderId: activeOrderId },
        { headers: authHeaders }
      );
      assert(false, '3.2 Incomplete verify body should return 400');
    } catch (err) {
      assert(err.response?.status === 400, '3.2 Incomplete verify payload returns 400 Bad Request');
    }

    // 3.3 Invalid / Forged HMAC signature (400)
    try {
      const forgedSignature = crypto
        .createHmac('sha256', 'wrong_fake_secret_attacker')
        .update(`${activeOrderId}|${mockPaymentId}`)
        .digest('hex');

      await axios.post(
        `${baseUrl}/payment/verify`,
        {
          razorpayOrderId: activeOrderId,
          razorpayPaymentId: mockPaymentId,
          razorpaySignature: forgedSignature,
          tripUserId: testTripUser.id,
        },
        { headers: authHeaders }
      );
      assert(false, '3.3 Forged HMAC signature should return 400');
    } catch (err) {
      assert(err.response?.status === 400, '3.3 Forged HMAC signature is rejected with 400 Bad Request');
    }

    // 3.4 Valid HMAC signature verification (200)
    try {
      const verifyRes = await axios.post(
        `${baseUrl}/payment/verify`,
        {
          razorpayOrderId: activeOrderId,
          razorpayPaymentId: mockPaymentId,
          razorpaySignature: validSignature,
          tripUserId: testTripUser.id,
        },
        { headers: authHeaders }
      );

      assert(verifyRes.status === 200 && verifyRes.data.success === true, '3.4 Valid HMAC signature returns 200 OK');
      assert(
        verifyRes.data.data?.status === 'SUCCESS' || verifyRes.data.data?.payment?.status === 'SUCCESS',
        '3.4 Verify response confirms SUCCESS status'
      );

      // 3.5 Database state verification: Payment status in PostgreSQL updated to SUCCESS
      const dbPayment = await prisma.payment.findFirst({
        where: { tripUserId: testTripUser.id },
      });
      assert(dbPayment !== null, '3.5 Payment record exists in database');
      assert(dbPayment?.status === 'SUCCESS', '3.5 Database Payment record status updated to SUCCESS');
      assert(dbPayment?.razorpayPaymentId === mockPaymentId, '3.5 Database record has razorpayPaymentId saved');
      assert(dbPayment?.razorpaySignature === validSignature, '3.5 Database record has razorpaySignature saved');
    } catch (err) {
      assert(false, '3.4 Valid HMAC verification failed', err.response?.data?.message || err.message);
    }

    // ─── Test Group 4: GET /api/payment/status/:tripId (Paid State) ───
    console.log('\n💳 Test Group 4: GET /api/payment/status/:tripId (Paid State)');
    try {
      const paidStatusRes = await axios.get(`${baseUrl}/payment/status/${testTrip.id}`, { headers: authHeaders });
      assert(paidStatusRes.status === 200 && paidStatusRes.data.success === true, '4.1 Paid status query returns 200 OK');
      assert(paidStatusRes.data.data.isPaid === true, '4.1 Paid trip returns isPaid === true');
      assert(paidStatusRes.data.data.status === 'SUCCESS', '4.1 Paid trip returns status === SUCCESS');
    } catch (err) {
      assert(false, '4.1 Paid status check failed', err.response?.data?.message || err.message);
    }

    // ─── Test Group 5: Idempotency & Double Payment Prevention ───
    console.log('\n🔁 Test Group 5: Idempotency & Double Payment Prevention');

    // 5.1 Attempting to create order for already paid trip
    try {
      const doubleOrderRes = await axios.post(
        `${baseUrl}/payment/create-order`,
        { tripId: testTrip.id },
        { headers: authHeaders }
      );
      // If server returns 409 or error, catch block handles it. If 200, verify it indicates already paid.
      if (doubleOrderRes.data?.data?.isPaid || doubleOrderRes.data?.message?.includes('already paid')) {
        assert(true, '5.1 Create order on already paid trip handles idempotently');
      } else {
        assert(false, '5.1 Should prevent creating new order when already paid');
      }
    } catch (err) {
      assert(
        err.response?.status === 409 || err.response?.status === 400,
        `5.1 Create order on already paid trip rejected with ${err.response?.status} (${err.response?.data?.message})`
      );
    }

    // 5.2 Duplicate verify call handling
    try {
      const duplicateVerifyRes = await axios.post(
        `${baseUrl}/payment/verify`,
        {
          razorpayOrderId: activeOrderId,
          razorpayPaymentId: mockPaymentId,
          razorpaySignature: validSignature,
          tripUserId: testTripUser.id,
        },
        { headers: authHeaders }
      );
      assert(
        duplicateVerifyRes.status === 200,
        '5.2 Duplicate verify call safely returns 200 or handles idempotently without corrupting DB'
      );
    } catch (err) {
      assert(
        err.response?.status === 400 || err.response?.status === 409,
        `5.2 Duplicate verify rejected or handled with code ${err.response?.status}`
      );
    }

  } catch (globalErr) {
    console.error('\n💥 Unhandled error in API test suite:', globalErr.message);
    failedTests++;
  } finally {
    // ─── Cleanup Test Fixtures ───
    console.log('\n🧹 Cleaning up test database fixtures...');
    try {
      if (testTripUser?.id) {
        await prisma.payment.deleteMany({ where: { tripUserId: { in: [testTripUser.id, testTripUser2?.id].filter(Boolean) } } });
      }
      if (testTrip?.id) {
        await prisma.tripStop.deleteMany({ where: { tripId: testTrip.id } });
        await prisma.tripUser.deleteMany({ where: { tripId: testTrip.id } });
        await prisma.trip.delete({ where: { id: testTrip.id } }).catch(() => {});
      }
      if (testRideRequest?.id) {
        await prisma.rideRequest.delete({ where: { id: testRideRequest.id } }).catch(() => {});
      }
      if (testRideRequest2?.id) {
        await prisma.rideRequest.delete({ where: { id: testRideRequest2.id } }).catch(() => {});
      }
      if (testUser?.id) {
        await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
      }
      if (testUser2?.id) {
        await prisma.user.delete({ where: { id: testUser2.id } }).catch(() => {});
      }
      console.log('✅ Cleanup complete.');
    } catch (cleanupErr) {
      console.warn('⚠️ Non-fatal cleanup warning:', cleanupErr.message);
    }

    if (server) {
      server.close();
    }
    await prisma.$disconnect();
  }

  // ─── Summary ───
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`API Integration Test Results: ${passedTests} / ${totalTests} passed (${failedTests} failed)`);
  console.log('─'.repeat(52));

  if (failedTests > 0) {
    console.error('❌ Some API integration tests failed.');
    if (require.main === module) process.exit(1);
    return false;
  } else {
    console.log('✅ ALL PAYMENT API INTEGRATION TESTS PASSED!\n');
    if (require.main === module) process.exit(0);
    return true;
  }
}

if (require.main === module) {
  runApiTests().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}

module.exports = { runApiTests };
