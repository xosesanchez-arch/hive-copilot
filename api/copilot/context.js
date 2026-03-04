/**
 * Context Assembly Endpoint
 * First call - assembles all context and returns it for subsequent calls
 */

const { assembleContext } = require("../../lib/context/contextAssembler");
const { rateLimitMiddleware } = require("../../lib/rateLimit");
const { createLogger } = require("../../lib/logger");
const { setCorsHeaders } = require("../../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("context");

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
    const { ticket } = req.body;

    if (!ticket) {
      return res.status(400).json({ error: "Ticket data is required" });
    }

    logger.log("request", "Context assembly request", {
      ticketId: ticket.id,
      subject: ticket.subject,
    });

    const context = await assembleContext(ticket, logger);

    logger.log("response", "Context assembled", {
      searchQuery: context.searchQuery,
      detectedLanguage: context.detectedLanguage,
      hasHistory: context.historyContext?.hasRelevantHistory,
      improvementsVersion: context.improvementsVersion,
      hasEntityContext: !!context.entityContext,
    });

    return res.status(200).json({
      searchQuery: context.searchQuery,
      detectedLanguage: context.detectedLanguage,
      notionContext: context.notionContext,
      faqContext: context.faqContext,
      glossaryContext: context.glossaryContext,
      historyContext: context.historyContext,
      improvementsContext: context.improvementsContext,
      improvementsVersion: context.improvementsVersion,
      entityContext: context.entityContext,
      entitySources: context.entitySources,
      combinedContext: context.combinedContext,
      sopSources: context.sopSources,
      faqSources: context.faqSources,
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Context error", error);
    const isTimeout = error.name === "TimeoutError" || error.name === "AbortError";
    return res.status(isTimeout ? 504 : 500).json({
      error: "Failed to assemble context",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
