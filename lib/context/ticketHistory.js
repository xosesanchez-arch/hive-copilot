/**
 * Ticket History Module
 * Fetches recent tickets from requester and organization for context
 */

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

// Zendesk API configuration
const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || "hiveapp").trim();
const ZENDESK_EMAIL = (process.env.ZENDESK_EMAIL || "deliverybee@hive.app").trim();
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN?.trim();

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

/**
 * Simple in-memory cache with TTL
 */
const cache = {
  data: new Map(),
  TTL: 5 * 60 * 1000, // 5 minutes

  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  },

  set(key, value) {
    this.data.set(key, {
      value,
      expiry: Date.now() + this.TTL,
    });
  },
};

/**
 * Make authenticated request to Zendesk API
 */
async function zendeskRequest(endpoint, logger = null) {
  if (!ZENDESK_TOKEN) {
    logger?.log("error", "ZENDESK_TOKEN not set");
    throw new Error("ZENDESK_TOKEN environment variable is not set");
  }

  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString("base64");
  const url = `${BASE_URL}${endpoint}`;

  logger?.log("zendesk", "Ticket history API request", { endpoint });

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    logger?.log("error", "Zendesk API error", {
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Zendesk API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch recent tickets from a requester
 * @param {number} requesterId - Zendesk user ID
 * @param {number} currentTicketId - Current ticket ID to exclude
 * @param {number} limit - Max tickets to fetch
 * @param {Object} logger - Logger instance
 */
async function getRequesterTickets(requesterId, currentTicketId, limit = 3, logger = null) {
  if (!requesterId) {
    logger?.log("history", "No requester ID provided");
    return [];
  }

  const cacheKey = `requester:${requesterId}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Requester tickets cache hit", { requesterId });
    // Filter out current ticket from cached results
    return cached.filter(t => t.id !== currentTicketId);
  }

  logger?.log("history", "Fetching requester tickets", { requesterId, limit });

  try {
    const query = `type:ticket requester_id:${requesterId}`;
    const response = await zendeskRequest(
      `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=${limit + 1}`,
      logger
    );

    const tickets = (response.results || [])
      .filter(t => t.id !== currentTicketId) // Exclude current ticket
      .slice(0, limit)
      .map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        description: t.description?.substring(0, 500) || "", // First 500 chars
      }));

    logger?.log("history", "Requester tickets fetched", {
      requesterId,
      found: tickets.length,
    });

    // Cache all results (before filtering current ticket)
    cache.set(cacheKey, response.results || []);

    return tickets;
  } catch (error) {
    logger?.log("error", "Failed to fetch requester tickets", { error: error.message });
    return [];
  }
}

/**
 * Fetch recent tickets from an organization
 * @param {number} organizationId - Zendesk organization ID
 * @param {number} currentTicketId - Current ticket ID to exclude
 * @param {number} limit - Max tickets to fetch
 * @param {Object} logger - Logger instance
 */
async function getOrganizationTickets(organizationId, currentTicketId, limit = 3, logger = null) {
  if (!organizationId) {
    logger?.log("history", "No organization ID provided");
    return [];
  }

  const cacheKey = `org:${organizationId}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Organization tickets cache hit", { organizationId });
    return cached.filter(t => t.id !== currentTicketId);
  }

  logger?.log("history", "Fetching organization tickets", { organizationId, limit });

  try {
    const query = `type:ticket organization_id:${organizationId}`;
    const response = await zendeskRequest(
      `/search.json?query=${encodeURIComponent(query)}&sort_by=created_at&sort_order=desc&per_page=${limit + 1}`,
      logger
    );

    const tickets = (response.results || [])
      .filter(t => t.id !== currentTicketId)
      .slice(0, limit)
      .map(t => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        description: t.description?.substring(0, 500) || "",
      }));

    logger?.log("history", "Organization tickets fetched", {
      organizationId,
      found: tickets.length,
    });

    cache.set(cacheKey, response.results || []);

    return tickets;
  } catch (error) {
    logger?.log("error", "Failed to fetch organization tickets", { error: error.message });
    return [];
  }
}

/**
 * Extract keywords from text for quick relevance pre-filtering
 */
function extractKeywords(text) {
  if (!text) return new Set();
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those', 'am', 'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their', 'what', 'which', 'who', 'whom', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'us', 'them', 'hi', 'hello', 'thanks', 'thank', 'please', 'help', 'issue', 'problem', 'ticket', 'support', 'customer', 'order', 'orders']);

  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  return new Set(words);
}

/**
 * Quick check if any history tickets might be relevant based on keyword overlap
 */
function hasKeywordOverlap(historyTickets, currentTicket) {
  const currentText = `${currentTicket.subject || ''} ${currentTicket.comments?.[0]?.value || ''}`;
  const currentKeywords = extractKeywords(currentText);

  if (currentKeywords.size === 0) return true; // Can't determine, let LLM decide

  for (const ticket of historyTickets) {
    const historyText = `${ticket.subject || ''} ${ticket.description || ''}`;
    const historyKeywords = extractKeywords(historyText);

    // Check for any overlap
    for (const keyword of currentKeywords) {
      if (historyKeywords.has(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Analyze if historical tickets are relevant to current ticket using LLM
 * @param {Array} historyTickets - Past tickets (requester + org combined)
 * @param {Object} currentTicket - Current ticket data
 * @param {Object} logger - Logger instance
 */
async function analyzeHistoryRelevance(historyTickets, currentTicket, logger = null) {
  if (!historyTickets || historyTickets.length === 0) {
    logger?.log("history", "No history tickets to analyze");
    return { relevant: [], hasRelevantHistory: false };
  }

  // Quick pre-filter: skip expensive LLM call if no keyword overlap at all
  if (!hasKeywordOverlap(historyTickets, currentTicket)) {
    logger?.log("history", "No keyword overlap, skipping LLM analysis", {
      historyCount: historyTickets.length,
    });
    return { relevant: [], hasRelevantHistory: false, reasoning: "No keyword overlap with past tickets" };
  }

  logger?.log("history", "Analyzing history relevance", {
    historyCount: historyTickets.length,
    currentSubject: currentTicket.subject,
  });

  const historyList = historyTickets
    .map((t, i) => `${i + 1}. [#${t.id}] "${t.subject}" (${t.status}) - ${t.description?.substring(0, 200) || "No description"}`)
    .join("\n");

  const currentSummary = `Subject: ${currentTicket.subject}\nDescription: ${
    currentTicket.comments?.[0]?.value?.substring(0, 300) || "No description"
  }`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You analyze ticket history to find relevant past interactions.
Given a current support ticket and a list of past tickets, identify which past tickets are relevant to the current issue.
A ticket is relevant if it discusses the same topic, product, or type of problem.

Respond in JSON format:
{
  "relevantTicketNumbers": [1, 3],  // Numbers from the list (1-indexed)
  "reasoning": "Brief explanation of why these are relevant"
}

If no tickets are relevant, return: { "relevantTicketNumbers": [], "reasoning": "No related tickets found" }`,
        },
        {
          role: "user",
          content: `## Current Ticket:
${currentSummary}

## Past Tickets:
${historyList}

Which past tickets are relevant to the current ticket?`,
        },
      ],
      temperature: 0.3,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content || "{}";

    // Parse JSON response
    let parsed;
    try {
      // Handle markdown code blocks
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      parsed = JSON.parse(jsonStr);
    } catch {
      logger?.log("error", "Failed to parse relevance response", { content });
      parsed = { relevantTicketNumbers: [], reasoning: "Parse error" };
    }

    const relevantIndices = parsed.relevantTicketNumbers || [];
    const relevantTickets = relevantIndices
      .map(i => historyTickets[i - 1]) // Convert to 0-indexed
      .filter(Boolean);

    logger?.log("history", "Relevance analysis complete", {
      relevant: relevantTickets.length,
      reasoning: parsed.reasoning,
    });

    return {
      relevant: relevantTickets,
      hasRelevantHistory: relevantTickets.length > 0,
      reasoning: parsed.reasoning,
    };
  } catch (error) {
    logger?.log("error", "Relevance analysis failed", { error: error.message });
    return { relevant: [], hasRelevantHistory: false };
  }
}

/**
 * Format relevant history for LLM context
 * @param {Array} relevantTickets - Tickets deemed relevant
 */
function formatHistoryForContext(relevantTickets) {
  if (!relevantTickets || relevantTickets.length === 0) {
    return "";
  }

  const formatted = relevantTickets
    .map(t => {
      const age = getTicketAge(t.createdAt);
      return `- Ticket #${t.id} (${age}): "${t.subject}" [${t.status}]\n  ${t.description?.substring(0, 150) || "No description"}...`;
    })
    .join("\n\n");

  return `## Context from Previous Interactions\n${formatted}`;
}

/**
 * Get human-readable ticket age
 */
function getTicketAge(dateStr) {
  if (!dateStr) return "unknown";
  const created = new Date(dateStr);
  const now = new Date();
  const diffMs = now - created;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

/**
 * Extract ticket IDs mentioned in text
 * Looks for patterns like #123456, ticket 123456, Ticket #123456, etc.
 */
function extractMentionedTicketIds(text, currentTicketId) {
  if (!text) return [];

  // Patterns to match ticket references
  const patterns = [
    /#(\d{5,8})/g,                    // #123456
    /ticket\s*#?\s*(\d{5,8})/gi,      // ticket 123456, ticket #123456
    /case\s*#?\s*(\d{5,8})/gi,        // case 123456
    /reference\s*#?\s*(\d{5,8})/gi,   // reference 123456
    /follow[- ]?up\s+(?:to|on|from)?\s*#?\s*(\d{5,8})/gi, // follow-up to 123456
  ];

  const foundIds = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const id = parseInt(match[1], 10);
      // Exclude current ticket and invalid IDs
      if (id !== currentTicketId && id > 10000) {
        foundIds.add(id);
      }
    }
  }

  return Array.from(foundIds);
}

/**
 * Fetch a specific ticket by ID with full details
 */
async function getTicketById(ticketId, logger = null) {
  const cacheKey = `ticket:${ticketId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Ticket cache hit", { ticketId });
    return cached;
  }

  logger?.log("history", "Fetching specific ticket", { ticketId });

  try {
    const response = await zendeskRequest(`/tickets/${ticketId}.json`, logger);
    const ticket = response.ticket;

    if (!ticket) {
      logger?.log("history", "Ticket not found", { ticketId });
      return null;
    }

    // Also fetch comments for this ticket
    let comments = [];
    try {
      const commentsResponse = await zendeskRequest(`/tickets/${ticketId}/comments.json`, logger);
      comments = (commentsResponse.comments || []).slice(0, 3).map(c => ({
        body: c.body?.substring(0, 500) || "",
        author: c.author_id,
        public: c.public,
        createdAt: c.created_at,
      }));
    } catch (err) {
      logger?.log("error", "Failed to fetch ticket comments", { ticketId, error: err.message });
    }

    const ticketData = {
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      description: ticket.description?.substring(0, 1000) || "",
      tags: ticket.tags || [],
      comments,
    };

    cache.set(cacheKey, ticketData);

    logger?.log("history", "Specific ticket fetched", {
      ticketId,
      subject: ticketData.subject,
      status: ticketData.status,
      commentsCount: comments.length,
    });

    return ticketData;
  } catch (error) {
    logger?.log("error", "Failed to fetch ticket", { ticketId, error: error.message });
    return null;
  }
}

/**
 * Check if ticket is a follow-up and get the source ticket ID
 * @param {Object} ticket - Ticket data with via object
 * @returns {number|null} - Source ticket ID if follow-up, null otherwise
 */
function getFollowUpSourceId(ticket) {
  const via = ticket.via;
  if (!via || !via.source) return null;

  // Check if this is a follow-up ticket
  if (via.source.rel === "follow_up" && via.source.ticket_id) {
    return via.source.ticket_id;
  }

  return null;
}

/**
 * Get explicitly mentioned/referenced tickets from current ticket text
 * Also includes follow-up source ticket from Zendesk metadata
 */
async function getReferencedTickets(ticket, logger = null) {
  const currentTicketId = ticket.id;
  const ticketIdsToFetch = new Set();

  // 1. Check if this is a follow-up ticket (Zendesk metadata)
  const followUpSourceId = getFollowUpSourceId(ticket);
  if (followUpSourceId) {
    logger?.log("history", "Ticket is a follow-up", { sourceTicketId: followUpSourceId });
    ticketIdsToFetch.add(followUpSourceId);
  }

  // 2. Search for explicitly mentioned ticket IDs in text
  const textToSearch = [
    ticket.subject || "",
    ...(ticket.comments || []).map(c => c.value || c.body || ""),
  ].join(" ");

  const mentionedIds = extractMentionedTicketIds(textToSearch, currentTicketId);

  for (const id of mentionedIds) {
    ticketIdsToFetch.add(id);
  }

  if (ticketIdsToFetch.size === 0) {
    logger?.log("history", "No ticket references found (no follow-up, no mentions)");
    return [];
  }

  logger?.log("history", "Found ticket references", {
    followUpSourceId,
    mentionedIds,
    total: ticketIdsToFetch.size
  });

  // Fetch each referenced ticket (limit to 3 to avoid too many API calls)
  const ticketsToFetch = Array.from(ticketIdsToFetch).slice(0, 3);
  const fetchedTickets = await Promise.all(
    ticketsToFetch.map(id => getTicketById(id, logger))
  );

  // Mark which one is the follow-up source for special handling
  const results = fetchedTickets.filter(Boolean).map(t => ({
    ...t,
    isFollowUpSource: t.id === followUpSourceId,
  }));

  return results;
}

/**
 * Format referenced tickets for LLM prompt context
 * This produces clean text for inclusion in the summary generation prompt
 */
function formatReferencedTicketsForSummary(referencedTickets) {
  if (!referencedTickets || referencedTickets.length === 0) {
    return "";
  }

  const formatted = referencedTickets.map(t => {
    const age = getTicketAge(t.createdAt);
    const isFollowUp = t.isFollowUpSource;

    let section = isFollowUp
      ? `## Follow-up Source: Ticket #${t.id}`
      : `## Referenced Ticket #${t.id}`;

    section += `\nSubject: ${t.subject}`;
    section += `\nStatus: ${t.status} | Created: ${age}`;

    if (t.description) {
      section += `\n\nOriginal Issue:\n${t.description.substring(0, 500)}${t.description.length > 500 ? "..." : ""}`;
    }

    // Include conversation context from comments
    if (t.comments && t.comments.length > 0) {
      section += `\n\nConversation Summary (${t.comments.length} comments):`;
      // Include up to 3 most relevant comments
      const relevantComments = t.comments.slice(0, 3);
      for (const comment of relevantComments) {
        if (comment.body) {
          section += `\n- ${comment.body.substring(0, 200)}${comment.body.length > 200 ? "..." : ""}`;
        }
      }
    }

    // Include resolution if solved/closed
    if ((t.status === "solved" || t.status === "closed") && t.comments?.length > 0) {
      const lastComment = t.comments[t.comments.length - 1];
      if (lastComment.body) {
        section += `\n\nResolution/Final Response:\n${lastComment.body.substring(0, 400)}${lastComment.body.length > 400 ? "..." : ""}`;
      }
    }

    return section;
  }).join("\n\n---\n\n");

  return formatted;
}

/**
 * Main function: Fetch and analyze ticket history
 * @param {Object} ticket - Current ticket with requester.id and organizationId
 * @param {Object} logger - Logger instance
 */
async function getTicketHistory(ticket, logger = null) {
  const requesterId = ticket.requester?.id;
  const organizationId = ticket.organizationId;
  const currentTicketId = ticket.id;

  logger?.log("history", "Starting ticket history fetch", {
    requesterId,
    organizationId,
    currentTicketId,
  });

  // Fetch requester tickets, org tickets, and explicitly referenced tickets in parallel
  const [requesterTickets, orgTickets, referencedTickets] = await Promise.all([
    getRequesterTickets(requesterId, currentTicketId, 3, logger),
    getOrganizationTickets(organizationId, currentTicketId, 3, logger),
    getReferencedTickets(ticket, logger),
  ]);

  // Combine and deduplicate (org tickets might include requester's tickets)
  const seenIds = new Set();
  const allTickets = [];

  // Add referenced tickets first (highest priority)
  for (const t of referencedTickets) {
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      allTickets.push(t);
    }
  }

  for (const t of [...requesterTickets, ...orgTickets]) {
    if (!seenIds.has(t.id)) {
      seenIds.add(t.id);
      allTickets.push(t);
    }
  }

  logger?.log("history", "Combined history tickets", {
    requesterCount: requesterTickets.length,
    orgCount: orgTickets.length,
    referencedCount: referencedTickets.length,
    combined: allTickets.length,
  });

  // Format explicitly referenced tickets separately (for summary display)
  const referencedTicketsSummary = formatReferencedTicketsForSummary(referencedTickets);

  if (allTickets.length === 0) {
    return {
      requesterTickets: [],
      orgTickets: [],
      referencedTickets: [],
      relevantTickets: [],
      hasRelevantHistory: false,
      hasReferencedTickets: false,
      formattedContext: "",
      referencedTicketsSummary: "",
    };
  }

  // Analyze relevance (excluding explicitly referenced tickets since we already have them)
  const ticketsForRelevanceAnalysis = allTickets.filter(
    t => !referencedTickets.find(r => r.id === t.id)
  );

  let relevant = [];
  let hasRelevantHistory = false;
  let reasoning = "";

  if (ticketsForRelevanceAnalysis.length > 0) {
    const analysis = await analyzeHistoryRelevance(
      ticketsForRelevanceAnalysis,
      ticket,
      logger
    );
    relevant = analysis.relevant;
    hasRelevantHistory = analysis.hasRelevantHistory;
    reasoning = analysis.reasoning;
  }

  const formattedContext = formatHistoryForContext(relevant);

  logger?.log("history", "Ticket history complete", {
    hasRelevantHistory,
    hasReferencedTickets: referencedTickets.length > 0,
    relevantCount: relevant.length,
    referencedCount: referencedTickets.length,
    contextLength: formattedContext.length,
  });

  return {
    requesterTickets,
    orgTickets,
    referencedTickets,
    relevantTickets: relevant,
    hasRelevantHistory,
    hasReferencedTickets: referencedTickets.length > 0,
    reasoning,
    formattedContext,
    referencedTicketsSummary,
  };
}

module.exports = {
  getRequesterTickets,
  getOrganizationTickets,
  analyzeHistoryRelevance,
  formatHistoryForContext,
  getTicketHistory,
  getReferencedTickets,
  getTicketById,
  formatReferencedTicketsForSummary,
  extractMentionedTicketIds,
  getFollowUpSourceId,
};
