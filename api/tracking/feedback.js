/**
 * Feedback Tracking Endpoint
 * Logs thumbs up/down feedback from contributors and admins
 */

const { trackFeedback, canGiveFeedback } = require("../../lib/kv");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("tracking-feedback");

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
    const {
      ticketId,
      type,
      comment,
      issueType,
      userEmail,
      userName,
    } = req.body;

    // Validate required fields
    if (!ticketId || !type || !userEmail) {
      return res.status(400).json({
        error: "Missing required fields: ticketId, type, userEmail",
      });
    }

    // Validate type
    if (!["positive", "negative"].includes(type)) {
      return res.status(400).json({
        error: "Type must be 'positive' or 'negative'",
      });
    }

    // For negative feedback, comment and issueType are required
    if (type === "negative" && (!comment || !issueType)) {
      return res.status(400).json({
        error: "Negative feedback requires comment and issueType",
      });
    }

    // Check if user can give feedback
    const canFeedback = await canGiveFeedback(userEmail);
    if (!canFeedback) {
      logger.log("unauthorized", "User cannot give feedback", { userEmail });
      return res.status(403).json({
        error: "You don't have permission to give feedback",
        hint: "Only Contributors and Admins can provide feedback",
      });
    }

    logger.log("request", "Recording feedback", {
      ticketId,
      type,
      issueType,
      userEmail,
    });

    const feedback = await trackFeedback({
      ticketId,
      type,
      comment: comment || null,
      issueType: issueType || null,
      userEmail,
      userName: userName || userEmail,
    });

    logger.log("response", "Feedback recorded", {
      ticketId,
      type,
      timestamp: feedback.timestamp,
    });

    return res.status(200).json({
      success: true,
      feedback: {
        ticketId: feedback.ticketId,
        type: feedback.type,
        timestamp: feedback.timestamp,
      },
    });
  } catch (error) {
    logger.error("Feedback error", error);
    return res.status(500).json({
      error: "Failed to record feedback",
      message: error.message,
    });
  }
};
