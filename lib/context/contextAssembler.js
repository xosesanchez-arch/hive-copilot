/**
 * Context Assembler Module
 * Orchestrates all context sources in parallel for the copilot
 */

const {
  searchRelevantPages,
  getContextFromPages,
  formatForLLM,
  getGlossary,
  detectLanguage,
} = require("../notion");

const {
  searchFAQArticles,
  getContentFromArticles,
  formatFAQForLLM,
} = require("../zendesk");

const { getTicketHistory } = require("./ticketHistory");
const { getCurrentInsights } = require("../kv");
const { fetchEntityContext } = require("../hive");

/**
 * Fetch improvement insights from KV
 */
async function fetchImprovementInsights(logger = null) {
  try {
    const insights = await getCurrentInsights();

    if (!insights || !insights.content) {
      return { context: "", version: null };
    }

    logger?.log("context", "Improvement insights fetched", {
      version: insights.version,
      patternsCount: insights.patterns?.length || 0,
    });

    // Format insights for context
    let context = "## Improvement Insights (from agent feedback)\n\n";

    // Add patterns as actionable guidance
    if (insights.patterns && insights.patterns.length > 0) {
      for (const pattern of insights.patterns) {
        context += `- **${pattern.category}**: ${pattern.recommendation}\n`;
      }
    } else if (insights.content) {
      // Fallback to raw content
      context += insights.content;
    }

    return {
      context,
      version: insights.version,
      stats: insights.stats,
    };
  } catch (error) {
    logger?.log("error", "Failed to fetch improvement insights", { error: error.message });
    return { context: "", version: null };
  }
}

/**
 * Extract search terms from ticket for knowledge base search
 * Simplified version - main logic in individual modules if needed
 */
function extractSearchTerms(ticket) {
  const text = [
    ticket.subject || "",
    ...(ticket.comments || []).map((c) => c.value || c.body || ""),
  ].join(" ");

  // Common words to filter out
  const commonWords = new Set([
    "this", "that", "with", "from", "have", "been", "will", "would",
    "could", "should", "about", "there", "their", "what", "when",
    "where", "which", "while", "your", "please", "thank", "thanks",
    "hello", "help", "need", "want", "like", "just", "also", "very",
    "some", "they", "them", "then", "than", "these", "those", "being",
  ]);

  // Domain-specific important terms
  const domainTerms = new Set([
    "label", "outbound", "inbound", "shipping", "delivery", "tracking",
    "carrier", "pickup", "return", "refund", "processing", "stuck",
    "delayed", "lost", "damaged", "inventory", "warehouse", "fulfillment",
    "order", "package", "parcel", "shipment", "customs", "international",
  ]);

  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const words = cleanText.split(/\s+/).filter((w) => w.length > 2);

  const keywords = [];
  for (const word of words) {
    if (!commonWords.has(word) && word.length > 3) {
      if (domainTerms.has(word)) {
        keywords.unshift(word);
      } else {
        keywords.push(word);
      }
    }
  }

  return [...new Set(keywords)].slice(0, 5).join(" ");
}

/**
 * Assemble all context for the copilot in parallel
 * @param {Object} ticket - Ticket data
 * @param {Object} logger - Logger instance
 * @returns {Object} All context sources assembled
 */
async function assembleContext(ticket, logger = null) {
  logger?.log("context", "Starting context assembly");

  // Extract search query from ticket
  const searchQuery = extractSearchTerms(ticket);
  logger?.log("context", "Search query extracted", { query: searchQuery });

  // Detect customer language
  const customerComments = (ticket.comments || [])
    .filter(c => c.author?.role !== "agent")
    .map(c => c.value || c.body || "")
    .join(" ");
  const detectedLanguage = detectLanguage(customerComments);
  logger?.log("context", "Language detected", { language: detectedLanguage });

  // Fetch all context sources in parallel, each with a 7s timeout so
  // a slow source fails gracefully rather than killing the whole request
  logger?.log("context", "Fetching all sources in parallel");

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Source timeout after ${ms}ms`)), ms)),
  ]);

  const [notionResult, zendeskResult, glossaryResult, historyResult, improvementsResult, hiveResult] = await Promise.allSettled([
    withTimeout(fetchNotionContext(searchQuery, logger), 7000),
    withTimeout(fetchZendeskContext(searchQuery, logger), 7000),
    withTimeout(getGlossary(detectedLanguage, logger), 7000),
    withTimeout(getTicketHistory(ticket, logger), 7000),
    withTimeout(fetchImprovementInsights(logger), 7000),
    withTimeout(fetchEntityContext(ticket, logger), 7000),
  ]);

  // Process Notion results
  let notionContext = "";
  let sopSources = [];

  if (notionResult.status === "fulfilled" && notionResult.value) {
    notionContext = notionResult.value.context;
    sopSources = notionResult.value.sources;
    logger?.log("context", "Notion context ready", {
      contextLength: notionContext.length,
      sourcesCount: sopSources.length,
    });
  } else if (notionResult.status === "rejected") {
    logger?.log("error", "Notion context failed", { error: notionResult.reason?.message });
  }

  // Process Zendesk FAQ results
  let faqContext = "";
  let faqSources = [];

  if (zendeskResult.status === "fulfilled" && zendeskResult.value) {
    faqContext = zendeskResult.value.context;
    faqSources = zendeskResult.value.sources;
    logger?.log("context", "Zendesk FAQ context ready", {
      contextLength: faqContext.length,
      sourcesCount: faqSources.length,
    });
  } else if (zendeskResult.status === "rejected") {
    logger?.log("error", "Zendesk FAQ context failed", { error: zendeskResult.reason?.message });
  }

  // Process Glossary results
  let glossaryContext = "";

  if (glossaryResult.status === "fulfilled" && glossaryResult.value?.formatted) {
    glossaryContext = glossaryResult.value.formatted;
    logger?.log("context", "Glossary context ready", {
      language: glossaryResult.value.language,
      termCount: glossaryResult.value.terms?.length || 0,
    });
  } else if (glossaryResult.status === "rejected") {
    logger?.log("error", "Glossary fetch failed", { error: glossaryResult.reason?.message });
  }

  // Process History results
  let historyContext = {
    requesterTickets: [],
    orgTickets: [],
    relevantTickets: [],
    hasRelevantHistory: false,
    formattedContext: "",
  };

  if (historyResult.status === "fulfilled" && historyResult.value) {
    historyContext = historyResult.value;
    logger?.log("context", "History context ready", {
      hasRelevantHistory: historyContext.hasRelevantHistory,
      relevantCount: historyContext.relevantTickets?.length || 0,
    });
  } else if (historyResult.status === "rejected") {
    logger?.log("error", "History fetch failed", { error: historyResult.reason?.message });
  }

  // Process Improvement Insights results
  let improvementsContext = "";
  let improvementsVersion = null;

  if (improvementsResult.status === "fulfilled" && improvementsResult.value) {
    improvementsContext = improvementsResult.value.context;
    improvementsVersion = improvementsResult.value.version;
    logger?.log("context", "Improvements context ready", {
      version: improvementsVersion,
      contextLength: improvementsContext.length,
    });
  } else if (improvementsResult.status === "rejected") {
    logger?.log("error", "Improvements fetch failed", { error: improvementsResult.reason?.message });
  }

  // Process Hive entity context results
  let entityContext = "";
  let entitySources = [];

  if (hiveResult.status === "fulfilled" && hiveResult.value) {
    entityContext = hiveResult.value.entityContext;
    entitySources = hiveResult.value.entitySources || [];
    logger?.log("context", "Hive entity context ready", {
      contextLength: entityContext.length,
      entitiesCount: entitySources.length,
    });
  } else if (hiveResult.status === "rejected") {
    logger?.log("error", "Hive entity fetch failed", { error: hiveResult.reason?.message });
  }

  // Combine all contexts
  const combinedContext = [
    notionContext,
    faqContext,
    glossaryContext,
    improvementsContext,
    entityContext,
  ].filter(Boolean).join("\n\n---\n\n");

  logger?.log("context", "Context assembly complete", {
    notionLength: notionContext.length,
    faqLength: faqContext.length,
    glossaryLength: glossaryContext.length,
    historyLength: historyContext.formattedContext?.length || 0,
    improvementsLength: improvementsContext.length,
    entityLength: entityContext.length,
    combinedLength: combinedContext.length,
  });

  return {
    searchQuery,
    detectedLanguage,
    notionContext,
    faqContext,
    glossaryContext,
    historyContext,
    improvementsContext,
    improvementsVersion,
    entityContext,
    entitySources,
    combinedContext,
    sopSources,
    faqSources,
  };
}

/**
 * Fetch Notion SOP context
 */
async function fetchNotionContext(searchQuery, logger = null) {
  const pages = await searchRelevantPages(searchQuery, 5, logger);

  if (!pages || pages.length === 0) {
    return { context: "", sources: [] };
  }

  // Get content from top 2 pages
  const topPages = pages.slice(0, 2);
  const pagesWithContent = await getContextFromPages(topPages, logger);
  const context = formatForLLM(pagesWithContent);

  const sources = pages.map((p) => ({
    title: p.title,
    url: p.url,
    type: "sop",
  }));

  return { context, sources };
}

/**
 * Fetch Zendesk FAQ context
 */
async function fetchZendeskContext(searchQuery, logger = null) {
  const articles = await searchFAQArticles(searchQuery, 5, logger);

  if (!articles || articles.length === 0) {
    return { context: "", sources: [] };
  }

  // Get content from top 2 articles
  const topArticles = articles.slice(0, 2);
  const articlesWithContent = getContentFromArticles(topArticles);
  const context = formatFAQForLLM(articlesWithContent);

  const sources = articles.map((a) => ({
    title: a.title,
    url: a.url,
    type: "faq",
  }));

  return { context, sources };
}

module.exports = {
  assembleContext,
  extractSearchTerms,
};
