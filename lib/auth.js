/**
 * Authentication & Authorization Module
 * Handles request verification for the Copilot API
 */

const crypto = require("crypto");

// Secret key for signing requests (should be set in Vercel env vars)
const AUTH_SECRET = process.env.COPILOT_AUTH_SECRET || "default-dev-secret-change-in-production";

// Token expiry time (5 minutes)
const TOKEN_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Generate a signed token for a user
 * Called from the frontend to create auth tokens
 */
function generateToken(email, timestamp = Date.now()) {
  const payload = `${email}:${timestamp}`;
  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(payload)
    .digest("hex");

  return `${Buffer.from(payload).toString("base64")}.${signature}`;
}

/**
 * Verify a signed token
 * Returns the email if valid, null if invalid
 */
function verifyToken(token) {
  if (!token) return null;

  try {
    const [payloadB64, signature] = token.split(".");
    if (!payloadB64 || !signature) return null;

    const payload = Buffer.from(payloadB64, "base64").toString("utf-8");
    const [email, timestampStr] = payload.split(":");
    const timestamp = parseInt(timestampStr, 10);

    // Check if token has expired
    if (Date.now() - timestamp > TOKEN_EXPIRY_MS) {
      return null;
    }

    // Verify signature
    const expectedSignature = crypto
      .createHmac("sha256", AUTH_SECRET)
      .update(payload)
      .digest("hex");

    if (signature !== expectedSignature) {
      return null;
    }

    return email;
  } catch (error) {
    return null;
  }
}

/**
 * Express/Vercel middleware to verify auth token
 * Extracts token from Authorization header or x-copilot-token header
 */
function authMiddleware(req) {
  const authHeader = req.headers.authorization || "";
  const tokenHeader = req.headers["x-copilot-token"] || "";

  let token = null;

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  } else if (tokenHeader) {
    token = tokenHeader;
  }

  const email = verifyToken(token);

  return {
    isValid: !!email,
    email: email,
  };
}

/**
 * Allowed origins for CORS
 */
const ALLOWED_ORIGINS = [
  "https://hiveapp.zendesk.com",
  "https://*.zendesk.com",
];

// In development, also allow localhost
if (process.env.NODE_ENV !== "production") {
  ALLOWED_ORIGINS.push("http://localhost:3000");
  ALLOWED_ORIGINS.push("http://localhost:4567"); // ZAT server
}

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin) {
  if (!origin) return false;

  for (const allowed of ALLOWED_ORIGINS) {
    if (allowed.includes("*")) {
      // Wildcard match
      const pattern = allowed.replace("*", ".*");
      if (new RegExp(`^${pattern}$`).test(origin)) {
        return true;
      }
    } else if (origin === allowed) {
      return true;
    }
  }

  return false;
}

/**
 * Set CORS headers based on origin
 */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Copilot-Token");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

module.exports = {
  generateToken,
  verifyToken,
  authMiddleware,
  setCorsHeaders,
  isOriginAllowed,
  ALLOWED_ORIGINS,
  TOKEN_EXPIRY_MS,
};
