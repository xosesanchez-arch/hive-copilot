/**
 * Summary Generation Endpoint
 * Returns summary only - for progressive loading
 */

const { generateSummary } = require("../../lib/modules/summaryGenerator");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("summary");

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
    const { ticket, historyContext } = req.body;

    if (!ticket) {
      return res.status(400).json({ error: "Ticket data is required" });
    }

    logger.log("request", "Summary generation request", {
      ticketId: ticket.id,
      hasHistory: !!historyContext?.hasRelevantHistory,
    });

    const result = await generateSummary(ticket, historyContext || {}, logger);

    logger.log("response", "Summary generated", {
      length: result.summary?.length || 0,
    });

    return res.status(200).json({
      summary: result.summary,
      hasRelevantHistory: result.hasRelevantHistory,
      hasReferencedTickets: result.hasReferencedTickets,
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Summary error", error);
    return res.status(500).json({
      error: "Failed to generate summary",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
