/**
 * Simple in-memory rate limiter
 * For production, use Redis-based solution
 */

const requests = new Map();

const WINDOW_MS = 60 * 1000; // 1 minute window
const MAX_REQUESTS = 20; // Max requests per window

/**
 * Check if request should be rate limited
 * @param {string} identifier - Usually IP address or user ID
 * @returns {{ limited: boolean, remaining: number, resetIn: number }}
 */
function checkRateLimit(identifier) {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Get or create request log for this identifier
  let record = requests.get(identifier);

  if (!record) {
    record = { timestamps: [], blocked: false };
    requests.set(identifier, record);
  }

  // Remove old timestamps outside the window
  record.timestamps = record.timestamps.filter((t) => t > windowStart);

  // Check if over limit
  if (record.timestamps.length >= MAX_REQUESTS) {
    const oldestInWindow = Math.min(...record.timestamps);
    const resetIn = Math.ceil((oldestInWindow + WINDOW_MS - now) / 1000);

    return {
      limited: true,
      remaining: 0,
      resetIn: resetIn,
    };
  }

  // Add current request
  record.timestamps.push(now);

  return {
    limited: false,
    remaining: MAX_REQUESTS - record.timestamps.length,
    resetIn: Math.ceil(WINDOW_MS / 1000),
  };
}

/**
 * Express/Vercel middleware for rate limiting
 */
function rateLimitMiddleware(req, res) {
  // Get identifier (IP or forwarded IP)
  const identifier =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.connection?.remoteAddress ||
    "unknown";

  const result = checkRateLimit(identifier);

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", MAX_REQUESTS);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader("X-RateLimit-Reset", result.resetIn);

  if (result.limited) {
    res.status(429).json({
      error: "Too many requests",
      message: `Rate limit exceeded. Please wait ${result.resetIn} seconds.`,
      retryAfter: result.resetIn,
    });
    return false; // Request was blocked
  }

  return true; // Request allowed
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  for (const [key, record] of requests.entries()) {
    record.timestamps = record.timestamps.filter((t) => t > windowStart);
    if (record.timestamps.length === 0) {
      requests.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = {
  checkRateLimit,
  rateLimitMiddleware,
};
