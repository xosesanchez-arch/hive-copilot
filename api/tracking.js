/**
 * Tracking Endpoint (consolidated)
 * Routes by action: "insert" or "feedback"
 */

const { trackFeedback, canGiveFeedback, trackInsertion } = require("../lib/kv");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders } = require("../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("tracking");

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

  const { action } = req.body;

  try {
    if (action === "insert") {
      const { ticketId, suggestedResponse, agentEmail, agentName } = req.body;

      if (!ticketId || !suggestedResponse) {
        return res.status(400).json({ error: "Missing required fields: ticketId, suggestedResponse" });
      }

      logger.log("request", "Tracking insertion", { ticketId, agentEmail, responseLength: suggestedResponse.length });

      const tracked = await trackInsertion({
        ticketId,
        suggestedResponse,
        agentEmail: agentEmail || "unknown",
        agentName: agentName || "Unknown Agent",
      });

      logger.log("response", "Insertion tracked", { ticketId });
      return res.status(200).json({ success: true, tracked: true, insertedAt: tracked.insertedAt });

    } else if (action === "feedback") {
      const { ticketId, type, comment, issueType, userEmail, userName } = req.body;

      if (!ticketId || !type || !userEmail) {
        return res.status(400).json({ error: "Missing required fields: ticketId, type, userEmail" });
      }

      if (!["positive", "negative"].includes(type)) {
        return res.status(400).json({ error: "Type must be 'positive' or 'negative'" });
      }

      if (type === "negative" && (!comment || !issueType)) {
        return res.status(400).json({ error: "Negative feedback requires comment and issueType" });
      }

      const canFeedback = await canGiveFeedback(userEmail);
      if (!canFeedback) {
        logger.log("unauthorized", "User cannot give feedback", { userEmail });
        return res.status(403).json({ error: "You don't have permission to give feedback", hint: "Only Contributors and Admins can provide feedback" });
      }

      logger.log("request", "Recording feedback", { ticketId, type, issueType, userEmail });

      const feedback = await trackFeedback({
        ticketId, type, comment: comment || null, issueType: issueType || null,
        userEmail, userName: userName || userEmail,
      });

      logger.log("response", "Feedback recorded", { ticketId, type, timestamp: feedback.timestamp });
      return res.status(200).json({ success: true, feedback: { ticketId: feedback.ticketId, type: feedback.type, timestamp: feedback.timestamp } });

    } else {
      return res.status(400).json({ error: "Missing or invalid action. Use 'insert' or 'feedback'." });
    }
  } catch (error) {
    logger.error("Tracking error", error);
    return res.status(500).json({ error: "Tracking failed", message: error.message });
  }
};
