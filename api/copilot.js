/**
 * Hive Copilot API - Main Orchestrator
 * Modular architecture with separate LLM calls for each section
 */

const { assembleContext } = require("../lib/context/contextAssembler");
const { generateSummary } = require("../lib/modules/summaryGenerator");
const { generateNextSteps } = require("../lib/modules/nextStepsGenerator");
const { generateResponse } = require("../lib/modules/responseGenerator");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders } = require("../lib/auth");

module.exports = async function handler(req, res) {
  const logger = createLogger("copilot");

  // CORS headers
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  if (!rateLimitMiddleware(req, res)) {
    logger.log("rate_limit", "Request rate limited");
    return;
  }

  try {
    const { ticket, agentName, macros } = req.body;

    if (!ticket) {
      logger.log("error", "Missing ticket data");
      return res.status(400).json({ error: "Ticket data is required" });
    }

    logger.log("request", "Received ticket", {
      ticketId: ticket.id,
      subject: ticket.subject,
      commentsCount: ticket.comments?.length || 0,
      macrosCount: macros?.length || 0,
      hasOrganizationId: !!ticket.organizationId,
    });

    // ============================================
    // PHASE 1: Assemble all context (parallel)
    // ============================================
    logger.log("phase", "Starting Phase 1: Context Assembly");

    const context = await assembleContext(ticket, logger);

    logger.log("phase", "Phase 1 complete", {
      searchQuery: context.searchQuery,
      detectedLanguage: context.detectedLanguage,
      hasHistory: context.historyContext?.hasRelevantHistory,
    });

    // ============================================
    // PHASE 2: Generate Summary + Next Steps (parallel)
    // ============================================
    logger.log("phase", "Starting Phase 2: Summary + Next Steps (parallel)");

    const [summaryResult, nextStepsResult] = await Promise.all([
      generateSummary(ticket, context.historyContext, logger),
      generateNextSteps(ticket, context.notionContext, context.faqContext, logger),
    ]);

    logger.log("phase", "Phase 2 complete", {
      summaryLength: summaryResult.summary?.length || 0,
      nextStepsLength: nextStepsResult.nextSteps?.length || 0,
    });

    // ============================================
    // PHASE 3: Generate Response (uses summary - context chaining)
    // ============================================
    logger.log("phase", "Starting Phase 3: Response Generation (context chaining)");

    const responseResult = await generateResponse(
      summaryResult.summary,           // Uses LLM-generated summary!
      ticket,
      context.notionContext,
      context.faqContext,
      context.historyContext?.formattedContext || "",
      agentName || "Support Agent",
      macros || [],
      context.glossaryContext,
      context.improvementsContext || "",  // Autonomous improvement insights
      logger
    );

    logger.log("phase", "Phase 3 complete", {
      responseLength: responseResult.suggestedResponse?.length || 0,
    });

    // ============================================
    // Return complete response
    // ============================================
    logger.log("response", "Sending complete response", {
      sopSourcesCount: context.sopSources?.length || 0,
      faqSourcesCount: context.faqSources?.length || 0,
    });

    return res.status(200).json({
      summary: summaryResult.summary,
      nextSteps: nextStepsResult.nextSteps,
      suggestedResponse: responseResult.suggestedResponse,
      sources: context.sopSources,
      faqSources: context.faqSources,
      searchQuery: context.searchQuery,
      detectedLanguage: context.detectedLanguage,
      notionContext: context.combinedContext,
      historyContext: {
        hasRelevantHistory: context.historyContext?.hasRelevantHistory || false,
        relevantTickets: context.historyContext?.relevantTickets || [],
      },
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Copilot error", error);
    return res.status(500).json({
      error: "Failed to generate copilot response",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
