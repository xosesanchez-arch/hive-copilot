/**
 * User List Endpoint
 * GET: List all users with Copilot roles (admin only)
 *
 * Note: Zendesk team members are fetched directly from the Zendesk app
 * using the ZAF Client for better authentication. This endpoint only
 * returns users who have been assigned a Copilot role.
 */

const { listAllUsers, isAdmin } = require("../../lib/kv");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders, authMiddleware } = require("../../lib/auth");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

module.exports = async function handler(req, res) {
  const logger = createLogger("users-list");

  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  try {
    const adminEmail = req.query.adminEmail;

    // Verify admin via token or legacy email
    let verifiedEmail = null;
    const auth = authMiddleware(req);
    if (auth.isValid && auth.email) {
      verifiedEmail = auth.email;
    } else if (adminEmail) {
      verifiedEmail = adminEmail; // Legacy fallback
    }

    if (!verifiedEmail) {
      return res.status(400).json({ error: "Authentication required" });
    }

    // Check if requester is admin
    const adminCheck = await isAdmin(verifiedEmail);
    if (!adminCheck) {
      logger.log("unauthorized", "Non-admin tried to list users", { email: verifiedEmail });
      return res.status(403).json({
        error: "Only admins can list all users",
      });
    }

    logger.log("request", "Listing Copilot roles", { email: verifiedEmail });

    const users = await listAllUsers();

    logger.log("response", "Copilot roles listed", { count: users.length });

    return res.status(200).json({
      users: users.sort((a, b) => {
        // Sort by role: admin > contributor > agent
        const roleOrder = { admin: 0, contributor: 1, agent: 2 };
        return (roleOrder[a.role] || 3) - (roleOrder[b.role] || 3);
      }),
    });
  } catch (error) {
    logger.error("User list error", error);
    return res.status(500).json({
      error: "Failed to list users",
      message: IS_PRODUCTION ? "Internal server error" : error.message,
    });
  }
};
