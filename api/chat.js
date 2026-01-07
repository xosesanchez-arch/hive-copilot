const {
  searchRelevantPages,
  getContextFromPages,
  formatForLLM,
} = require("../lib/notion");
const {
  searchFAQArticles,
  getContentFromArticles,
  formatFAQForLLM,
} = require("../lib/zendesk");
const { chatFollowUp } = require("../lib/openai");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders } = require("../lib/auth");

module.exports = async function handler(req, res) {
  // Create logger for this request
  const logger = createLogger("chat");

  // Enable CORS
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Check rate limit
  if (!rateLimitMiddleware(req, res)) {
    logger.log("rate_limit", "Request rate limited");
    return;
  }

  try {
    const { message, ticket, previousMessages, notionContext, previousSuggestion } = req.body;

    if (!message) {
      logger.log("error", "Missing message");
      return res.status(400).json({ error: "Message is required" });
    }

    if (!ticket) {
      logger.log("error", "Missing ticket context");
      return res.status(400).json({ error: "Ticket context is required" });
    }

    logger.log("request", "Chat message received", {
      ticketId: ticket.id,
      messageLength: message.length,
      hasExistingContext: !!notionContext,
      previousMessagesCount: previousMessages?.length || 0,
    });

    // If no context provided, search for relevant docs based on the question
    let context = notionContext;
    let sources = [];
    let faqSources = [];

    if (!context) {
      logger.log("search", "No context provided, searching for docs", { query: message });

      // Search both Notion and Zendesk FAQ in parallel
      const [notionResult, zendeskResult] = await Promise.allSettled([
        searchRelevantPages(message, 3, logger),
        searchFAQArticles(message, 3, logger),
      ]);

      let sopContext = "";
      let faqContext = "";

      // Process Notion results
      if (notionResult.status === "fulfilled") {
        const notionPages = notionResult.value || [];
        logger.log("notion", "Search complete", {
          found: notionPages.length,
          pages: notionPages.map(p => ({ title: p.title, relevance: p.relevance })),
        });

        if (notionPages.length > 0) {
          const topPages = notionPages.slice(0, 2);
          const pagesWithContent = await getContextFromPages(topPages, logger);
          sopContext = formatForLLM(pagesWithContent);
          sources = notionPages.map((p) => ({
            title: p.title,
            url: p.url,
            type: "sop",
          }));
        }
      } else {
        logger.error("Notion search failed", notionResult.reason);
      }

      // Process Zendesk FAQ results
      if (zendeskResult.status === "fulfilled") {
        const faqArticles = zendeskResult.value || [];
        logger.log("zendesk", "Search complete", {
          found: faqArticles.length,
          articles: faqArticles.map(a => ({ title: a.title, relevance: a.relevance })),
        });

        if (faqArticles.length > 0) {
          const topArticles = faqArticles.slice(0, 2);
          const articlesWithContent = getContentFromArticles(topArticles);
          faqContext = formatFAQForLLM(articlesWithContent);
          faqSources = faqArticles.map((a) => ({
            title: a.title,
            url: a.url,
            type: "faq",
          }));
        }
      } else {
        logger.error("Zendesk search failed", zendeskResult.reason);
      }

      // Combine contexts
      context = [sopContext, faqContext].filter(Boolean).join("\n\n---\n\n");

      logger.log("decision", "Context assembled", {
        sopContextLength: sopContext.length,
        faqContextLength: faqContext.length,
        combinedContextLength: context.length,
      });
    } else {
      logger.log("cache", "Using provided context", { contextLength: context.length });
    }

    // Generate chat response
    logger.log("openai", "Generating chat response");

    const response = await chatFollowUp(
      message,
      ticket,
      context || "",
      previousMessages || [],
      previousSuggestion || "",
      logger
    );

    logger.log("response", "Sending chat response", {
      responseLength: response.length,
      sourcesCount: sources.length,
      faqSourcesCount: faqSources.length,
    });

    return res.status(200).json({
      response: response,
      sources: sources,
      faqSources: faqSources,
      debug: logger.getDebug(),
    });
  } catch (error) {
    logger.error("Chat error", error);
    return res.status(500).json({
      error: "Failed to generate chat response",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
