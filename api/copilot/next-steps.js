/**
 * Next Steps Generation Endpoint
 * Returns next steps only - for progressive loading
 */

const { generateNextSteps } = require("../../lib/modules/nextStepsGenerator");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("next-steps");

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
    const { ticket, notionContext, faqContext, entityContext } = req.body;

    if (!ticket) {
      return res.status(400).json({ error: "Ticket data is required" });
    }

    logger.log("request", "Next steps generation request", {
      ticketId: ticket.id,
      hasNotionContext: !!notionContext,
      hasFaqContext: !!faqContext,
      hasEntityContext: !!entityContext,
    });

    const result = await generateNextSteps(
      ticket,
      notionContext || "",
      faqContext || "",
      entityContext || "",
      logger
    );

    logger.log("response", "Next steps generated", {
      length: result.nextSteps?.length || 0,
    });

    return res.status(200).json({
      nextSteps: result.nextSteps,
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Next steps error", error);
    return res.status(500).json({
      error: "Failed to generate next steps",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
