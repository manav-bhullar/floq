const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rideRequestRoutes = require('./modules/rideRequest/rideRequest.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const tripRoutes = require('./modules/trip/trip.routes');
const authRoutes = require('./modules/auth/auth.routes');
const driverRoutes = require('./modules/driver/driver.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const { authenticate } = require('./middleware/auth.middleware');
const { authLimiter, apiLimiter } = require('./middleware/rateLimiter');

const app = express();

const allowedOrigins = [
  /^http:\/\/localhost:\d+$/,        // All localhost ports (dev)
  /^https:\/\/.*\.vercel\.app$/,    // All Vercel preview + production URLs
];
if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Auth routes: apply strict IP-based limiter to sensitive endpoints
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/resend-otp', authLimiter);
app.use('/api/auth', authRoutes);

// Authenticated API routes: apply per-user rate limiter
app.use('/api/ride-requests', authenticate, apiLimiter, rideRequestRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trips', authenticate, apiLimiter, tripRoutes);
app.use('/api/driver', apiLimiter, driverRoutes); // auth is handled inside driverRoutes
app.use('/api/payment', authenticate, apiLimiter, paymentRoutes);

module.exports = app;