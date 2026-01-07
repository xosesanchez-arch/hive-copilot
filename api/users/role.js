/**
 * User Role Endpoint
 * GET: Get current user's role
 * POST: Update a user's role (admin only)
 */

const { getUserRole, setUserRole, isAdmin, listAllUsers } = require("../../lib/kv");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders, authMiddleware } = require("../../lib/auth");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

module.exports = async function handler(req, res) {
  const logger = createLogger("users-role");

  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  try {
    // GET: Get user role
    if (req.method === "GET") {
      const email = req.query.email;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      logger.log("request", "Getting user role", { email });

      const user = await getUserRole(email);

      logger.log("response", "User role retrieved", { email, role: user.role });

      return res.status(200).json(user);
    }

    // POST: Update user role (admin only)
    if (req.method === "POST") {
      const { email, role, adminEmail } = req.body;

      if (!email || !role) {
        return res.status(400).json({
          error: "Missing required fields: email, role",
        });
      }

      // Validate role
      if (!["admin", "contributor", "agent"].includes(role)) {
        return res.status(400).json({
          error: "Role must be 'admin', 'contributor', or 'agent'",
        });
      }

      // Verify admin via token or legacy email
      let verifiedAdminEmail = null;
      const auth = authMiddleware(req);
      if (auth.isValid && auth.email) {
        verifiedAdminEmail = auth.email;
      } else if (adminEmail) {
        verifiedAdminEmail = adminEmail; // Legacy fallback
      }

      // Check if requester is admin (bootstrap: first user can be set as admin)
      const existingUsers = await listAllUsers();
      const isFirstUser = existingUsers.length === 0;

      if (!isFirstUser) {
        if (!verifiedAdminEmail) {
          return res.status(400).json({
            error: "Authentication required",
          });
        }

        const adminCheck = await isAdmin(verifiedAdminEmail);
        if (!adminCheck) {
          logger.log("unauthorized", "Non-admin tried to change role", {
            email: verifiedAdminEmail,
            targetEmail: email,
          });
          return res.status(403).json({
            error: "Only admins can change user roles",
          });
        }
      } else {
        logger.log("bootstrap", "First user being set as admin", { email });
        verifiedAdminEmail = email; // Bootstrap: user is setting themselves as admin
      }

      logger.log("request", "Updating user role", {
        email,
        role,
        updatedBy: verifiedAdminEmail,
      });

      const updated = await setUserRole(email, role, verifiedAdminEmail);

      logger.log("response", "User role updated", {
        email,
        role,
        updatedBy: verifiedAdminEmail,
      });

      return res.status(200).json({
        success: true,
        updated,
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    logger.error("User role error", error);
    return res.status(500).json({
      error: "Failed to process user role request",
      message: IS_PRODUCTION ? "Internal server error" : error.message,
    });
  }
};
