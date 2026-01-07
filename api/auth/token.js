/**
 * Token Generation Endpoint
 * POST: Generate a signed auth token for the user
 *
 * The frontend calls this with the user's email to get a token
 * that can be used to authenticate subsequent API calls.
 */

const { generateToken, setCorsHeaders } = require("../../lib/auth");
const { rateLimitMiddleware } = require("../../lib/rateLimit");

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const timestamp = Date.now();
    const token = generateToken(email, timestamp);

    return res.status(200).json({
      token,
      expiresAt: timestamp + 5 * 60 * 1000, // 5 minutes
    });
  } catch (error) {
    console.error("Token generation error:", error);
    return res.status(500).json({ error: "Failed to generate token" });
  }
};
