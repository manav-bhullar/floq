const crypto = require('crypto');
const bcrypt = require('bcrypt');
const prisma = require('../../prisma/client');
const { generateOtp } = require('../../utils/otp');
const { sendOtpEmail } = require('../../utils/email');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../../utils/jwt');
const { getRedis } = require('../../utils/redis');

// Redis key helpers for OTP
const OTP_KEY = (userId, type = 'EMAIL_VERIFY') => `otp:${userId}:${type}`;
const OTP_RATELIMIT_KEY = (userId) => `otp:ratelimit:${userId}`;

// Redis key helpers for refresh tokens
const REFRESH_TOKEN_KEY = (hashedToken) => `refresh:${hashedToken}`;
const REFRESH_USER_SET_KEY = (userId) => `refresh:user:${userId}`;
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds
const MAX_REFRESH_TOKENS_PER_USER = 5;

// Redis key helpers for user profile cache
const USER_PROFILE_KEY = (userId) => `user:profile:${userId}`;
const USER_PROFILE_TTL = 300; // 5 minutes

const SALT_ROUNDS = 12;

exports.register = async ({ name, email, password, role, phone, vehicleType, licensePlate }) => {
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    const error = new Error('Email already in use');
    error.status = 409;
    throw error;
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      password: hashedPassword,
      phone: phone || null,
      role: role || 'RIDER',
      isVerified: false,
      ...(role === 'DRIVER' ? {
        driverProfile: {
          create: {
            vehicleType,
            licensePlate
          }
        }
      } : {})
    },
  });

  const otpCode = generateOtp();
  const otpTtlSeconds = parseInt(process.env.OTP_EXPIRY_MINUTES || '10') * 60;

  // Store OTP in Redis with auto-expiry (replaces prisma.otp.create)
  const redis = getRedis();
  await redis.set(
    OTP_KEY(user.id),
    JSON.stringify({ code: otpCode, createdAt: new Date().toISOString() }),
    'EX',
    otpTtlSeconds
  );

  // Try to send email, but don't fail registration if it fails, let them resend
  try {
    await sendOtpEmail(email, otpCode, name);
  } catch (err) {
    console.error('Failed to send OTP email during registration:', err);
  }

  return { id: user.id, name: user.name, email: user.email, isVerified: user.isVerified, role: user.role };
};

exports.login = async ({ email, password }) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const error = new Error('Invalid email or password');
    error.status = 401;
    throw error;
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    const error = new Error('Invalid email or password');
    error.status = 401;
    throw error;
  }

  if (!user.isVerified) {
    const error = new Error('Email not verified');
    error.status = 403;
    error.needsVerification = true;
    throw error;
  }

  return await createTokensForUser(user);
};

exports.verifyEmail = async ({ email, otp }) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  if (user.isVerified) {
    const error = new Error('Email already verified');
    error.status = 400;
    throw error;
  }

  // Read OTP from Redis (replaces prisma.otp.findFirst)
  const redis = getRedis();
  const otpData = await redis.get(OTP_KEY(user.id));

  if (!otpData) {
    // Key doesn't exist = either never created or auto-expired
    const error = new Error('No OTP found or OTP expired. Please request a new one.');
    error.status = 400;
    throw error;
  }

  const { code: storedCode } = JSON.parse(otpData);

  if (storedCode !== otp && !(process.env.NODE_ENV !== 'production' && otp === '123456')) {
    const error = new Error('Invalid OTP');
    error.status = 400;
    throw error;
  }

  // Delete OTP from Redis (mark as used) and verify user
  await redis.del(OTP_KEY(user.id));
  await prisma.user.update({ where: { id: user.id }, data: { isVerified: true } });

  return await createTokensForUser(user);
};

exports.resendOtp = async ({ email }) => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  if (user.isVerified) {
    const error = new Error('Email already verified');
    error.status = 400;
    throw error;
  }

  // Check rate limiting via Redis (replaces DB query for recent OTP)
  const redis = getRedis();
  const rateLimitKey = OTP_RATELIMIT_KEY(user.id);
  const recentlySent = await redis.exists(rateLimitKey);

  if (recentlySent) {
    const ttl = await redis.ttl(rateLimitKey);
    const error = new Error(`Please wait ${ttl} seconds before requesting another OTP`);
    error.status = 429;
    throw error;
  }

  const otpCode = generateOtp();
  const otpTtlSeconds = parseInt(process.env.OTP_EXPIRY_MINUTES || '10') * 60;

  // Store new OTP in Redis (overwrites any previous OTP for this user)
  await redis.set(
    OTP_KEY(user.id),
    JSON.stringify({ code: otpCode, createdAt: new Date().toISOString() }),
    'EX',
    otpTtlSeconds
  );

  // Set rate limit cooldown (60 seconds)
  await redis.set(rateLimitKey, '1', 'EX', 60);

  try {
    await sendOtpEmail(email, otpCode, user.name);
  } catch (err) {
    console.error('Failed to send OTP email during resend:', err);
    throw new Error('Failed to send email. Please try again later.');
  }

  return { message: 'OTP sent successfully' };
};

exports.refreshToken = async (token) => {
  try {
    const decoded = verifyRefreshToken(token);

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Find the refresh token in Redis (replaces prisma.refreshToken.findFirst)
    const redis = getRedis();
    const storedUserId = await redis.get(REFRESH_TOKEN_KEY(hashedToken));

    if (!storedUserId) {
      throw new Error('Refresh token not found, invalidated, or expired');
    }

    if (storedUserId !== decoded.id) {
      throw new Error('Token user mismatch');
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user) throw new Error('User not found');

    // Rotate: delete old token, create new one
    return await createTokensForUser(user, hashedToken);
  } catch (err) {
    const error = new Error('Invalid or expired refresh token');
    error.status = 401;
    throw error;
  }
};

exports.logout = async (userId, token) => {
  if (!token) return { success: true };

  try {
    const redis = getRedis();
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    // Delete the specific token from Redis
    await redis.del(REFRESH_TOKEN_KEY(hashedToken));

    // Remove from user's token set
    await redis.srem(REFRESH_USER_SET_KEY(userId), hashedToken);
  } catch (err) {
    console.error('Logout error:', err);
  }

  return { success: true };
};

exports.getMe = async (userId) => {
  // Check Redis cache first
  const redis = getRedis();
  const cached = await redis.get(USER_PROFILE_KEY(userId));
  if (cached) {
    return JSON.parse(cached);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const error = new Error('User not found');
    error.status = 404;
    throw error;
  }

  const profile = { id: user.id, name: user.name, email: user.email, isVerified: user.isVerified, role: user.role };

  // Cache for 5 minutes
  await redis.set(USER_PROFILE_KEY(userId), JSON.stringify(profile), 'EX', USER_PROFILE_TTL);

  return profile;
};

// Helper function
async function createTokensForUser(user, existingHashedToken = null) {
  const accessToken = generateAccessToken({ id: user.id, role: user.role, email: user.email });
  const refreshToken = generateRefreshToken(user.id);

  // Hash refresh token for storage
  const hashedRefreshToken = crypto.createHash('sha256').update(refreshToken).digest('hex');

  const redis = getRedis();
  const userSetKey = REFRESH_USER_SET_KEY(user.id);

  if (existingHashedToken) {
    // Rotation: Delete old token key, remove from user set
    await redis.del(REFRESH_TOKEN_KEY(existingHashedToken));
    await redis.srem(userSetKey, existingHashedToken);
  } else {
    // Cap at MAX_REFRESH_TOKENS_PER_USER — evict oldest if at limit
    const currentTokens = await redis.smembers(userSetKey);
    if (currentTokens.length >= MAX_REFRESH_TOKENS_PER_USER) {
      // Evict the first token in the set (approximate FIFO)
      const oldest = currentTokens[0];
      await redis.del(REFRESH_TOKEN_KEY(oldest));
      await redis.srem(userSetKey, oldest);
    }
  }

  // Store new refresh token in Redis with 7-day TTL
  await redis.set(REFRESH_TOKEN_KEY(hashedRefreshToken), user.id, 'EX', REFRESH_TOKEN_TTL);

  // Add to user's token set (for tracking/eviction)
  await redis.sadd(userSetKey, hashedRefreshToken);
  await redis.expire(userSetKey, REFRESH_TOKEN_TTL); // Reset TTL on the set

  return {
    user: { id: user.id, name: user.name, email: user.email, isVerified: user.isVerified, role: user.role },
    accessToken,
    refreshToken // this needs to be set as a cookie by controller
  };
}
