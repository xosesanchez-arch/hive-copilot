/**
 * Insert Tracking Endpoint
 * Logs when "Insert" button is clicked
 */

const { trackInsertion } = require("../../lib/kv");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("tracking-insert");

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
    const { ticketId, suggestedResponse, agentEmail, agentName } = req.body;

    if (!ticketId || !suggestedResponse) {
      return res.status(400).json({
        error: "Missing required fields: ticketId, suggestedResponse",
      });
    }

    logger.log("request", "Tracking insertion", {
      ticketId,
      agentEmail,
      responseLength: suggestedResponse.length,
    });

    const tracked = await trackInsertion({
      ticketId,
      suggestedResponse,
      agentEmail: agentEmail || "unknown",
      agentName: agentName || "Unknown Agent",
    });

    logger.log("response", "Insertion tracked", { ticketId });

    return res.status(200).json({
      success: true,
      tracked: true,
      insertedAt: tracked.insertedAt,
    });
  } catch (error) {
    logger.error("Tracking error", error);
    return res.status(500).json({
      error: "Failed to track insertion",
      message: error.message,
    });
  }
};
