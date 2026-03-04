/**
 * Users Endpoint (consolidated)
 * Routes by resource: "role" or "list"
 *
 * GET  /api/users?resource=role&email=...  → get user role
 * POST /api/users?resource=role            → update user role (admin only)
 * GET  /api/users?resource=list&adminEmail=... → list all users (admin only)
 */

const { getUserRole, setUserRole, isAdmin, listAllUsers } = require("../lib/kv");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders, authMiddleware } = require("../lib/auth");

const IS_PRODUCTION = process.env.NODE_ENV === "production";

module.exports = async function handler(req, res) {
  const logger = createLogger("users");

  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  const resource = req.query.resource || "role";

  try {
    // --- LIST: GET all users with Copilot roles (admin only) ---
    if (resource === "list") {
      if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const adminEmail = req.query.adminEmail;

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

      const adminCheck = await isAdmin(verifiedEmail);
      if (!adminCheck) {
        logger.log("unauthorized", "Non-admin tried to list users", { email: verifiedEmail });
        return res.status(403).json({ error: "Only admins can list all users" });
      }

      logger.log("request", "Listing Copilot roles", { email: verifiedEmail });

      const users = await listAllUsers();

      logger.log("response", "Copilot roles listed", { count: users.length });

      return res.status(200).json({
        users: users.sort((a, b) => {
          const roleOrder = { admin: 0, contributor: 1, agent: 2 };
          return (roleOrder[a.role] || 3) - (roleOrder[b.role] || 3);
        }),
      });
    }

    // --- ROLE: GET user role / POST update role ---
    if (resource === "role") {
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
          return res.status(400).json({ error: "Missing required fields: email, role" });
        }

        if (!["admin", "contributor", "agent"].includes(role)) {
          return res.status(400).json({ error: "Role must be 'admin', 'contributor', or 'agent'" });
        }

        let verifiedAdminEmail = null;
        const auth = authMiddleware(req);
        if (auth.isValid && auth.email) {
          verifiedAdminEmail = auth.email;
        } else if (adminEmail) {
          verifiedAdminEmail = adminEmail; // Legacy fallback
        }

        // Bootstrap: first user can be set as admin
        const existingUsers = await listAllUsers();
        const isFirstUser = existingUsers.length === 0;

        if (!isFirstUser) {
          if (!verifiedAdminEmail) {
            return res.status(400).json({ error: "Authentication required" });
          }

          const adminCheck = await isAdmin(verifiedAdminEmail);
          if (!adminCheck) {
            logger.log("unauthorized", "Non-admin tried to change role", {
              email: verifiedAdminEmail,
              targetEmail: email,
            });
            return res.status(403).json({ error: "Only admins can change user roles" });
          }
        } else {
          logger.log("bootstrap", "First user being set as admin", { email });
          verifiedAdminEmail = email;
        }

        logger.log("request", "Updating user role", { email, role, updatedBy: verifiedAdminEmail });

        const updated = await setUserRole(email, role, verifiedAdminEmail);

        logger.log("response", "User role updated", { email, role, updatedBy: verifiedAdminEmail });

        return res.status(200).json({ success: true, updated });
      }

      return res.status(405).json({ error: "Method not allowed" });
    }

    return res.status(400).json({ error: "Invalid resource. Use 'role' or 'list'." });

  } catch (error) {
    logger.error("Users error", error);
    return res.status(500).json({
      error: "Failed to process users request",
      message: IS_PRODUCTION ? "Internal server error" : error.message,
    });
  }
};
