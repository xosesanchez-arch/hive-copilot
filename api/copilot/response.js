/**
 * Response Generation Endpoint
 * Returns suggested response - uses summary (context chaining)
 */

const { generateResponse } = require("../../lib/modules/responseGenerator");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("response");

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
      ticket,
      summary,
      notionContext,
      faqContext,
      historyFormattedContext,
      agentName,
      macros,
      glossaryContext,
      improvementsContext,
    } = req.body;

    if (!ticket) {
      return res.status(400).json({ error: "Ticket data is required" });
    }

    if (!summary) {
      return res.status(400).json({ error: "Summary is required (call /summary first)" });
    }

    logger.log("request", "Response generation request", {
      ticketId: ticket.id,
      summaryLength: summary?.length || 0,
      hasContext: !!notionContext || !!faqContext,
    });

    const result = await generateResponse(
      summary,
      ticket,
      notionContext || "",
      faqContext || "",
      historyFormattedContext || "",
      agentName || "Support Agent",
      macros || [],
      glossaryContext || "",
      improvementsContext || "",
      logger
    );

    logger.log("response", "Response generated", {
      length: result.suggestedResponse?.length || 0,
    });

    return res.status(200).json({
      suggestedResponse: result.suggestedResponse,
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Response error", error);
    return res.status(500).json({
      error: "Failed to generate response",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
