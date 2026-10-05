const express = require('express');
const router = express.Router();
const controller = require('./payment.controller');

// POST /api/payment/create-order
router.post('/create-order', controller.createOrder);

// POST /api/payment/verify
router.post('/verify', controller.verifyPayment);

// GET /api/payment/status/:tripId
router.get('/status/:tripId', controller.getPaymentStatus);

module.exports = router;
