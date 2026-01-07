/**
 * Outcome Tracker
 * Fetches ticket outcomes from Zendesk and compares suggested vs actual responses
 */

const { createLogger } = require("../logger");

// Zendesk API configuration
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN || "hiveapp";
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN;

/**
 * Get ticket details from Zendesk
 */
async function getTicketWithComments(ticketId, logger) {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString("base64");

  try {
    // Get ticket with comments
    const response = await fetch(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json?include=comment_count`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      logger?.log("error", `Failed to fetch ticket ${ticketId}`, {
        status: response.status,
      });
      return null;
    }

    const ticketData = await response.json();

    // Get comments separately
    const commentsResponse = await fetch(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!commentsResponse.ok) {
      logger?.log("error", `Failed to fetch comments for ticket ${ticketId}`, {
        status: commentsResponse.status,
      });
      return { ticket: ticketData.ticket, comments: [] };
    }

    const commentsData = await commentsResponse.json();

    return {
      ticket: ticketData.ticket,
      comments: commentsData.comments || [],
    };
  } catch (error) {
    logger?.error(`Error fetching ticket ${ticketId}`, error);
    return null;
  }
}

/**
 * Get ticket audit log to check for reopens
 */
async function getTicketAudits(ticketId, logger) {
  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString("base64");

  try {
    const response = await fetch(
      `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/audits.json`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.audits || [];
  } catch (error) {
    logger?.error(`Error fetching audits for ticket ${ticketId}`, error);
    return [];
  }
}

/**
 * Check if a ticket was reopened after being solved
 */
async function checkIfReopened(ticketId, logger) {
  const audits = await getTicketAudits(ticketId, logger);

  // Look for status changes
  let wasSolved = false;
  let wasReopened = false;

  for (const audit of audits) {
    for (const event of audit.events || []) {
      if (event.field_name === "status") {
        if (event.value === "solved") {
          wasSolved = true;
        } else if (wasSolved && ["open", "pending"].includes(event.value)) {
          wasReopened = true;
        }
      }
    }
  }

  return wasReopened;
}

/**
 * Find the agent's public comment after the insertion timestamp
 */
function findAgentCommentAfterInsertion(comments, agentEmail, insertedAt) {
  const insertTime = new Date(insertedAt);

  // Filter to public comments by the agent after insertion
  const agentComments = comments.filter((c) => {
    const commentTime = new Date(c.created_at);
    const isAfterInsertion = commentTime > insertTime;
    const isPublic = c.public === true;
    const isAgent = c.author?.email === agentEmail ||
      c.via?.source?.from?.address === agentEmail;

    return isAfterInsertion && isPublic && isAgent;
  });

  // Return the first one (closest to insertion time)
  return agentComments.length > 0 ? agentComments[0] : null;
}

/**
 * Analyze outcomes for a list of insertions
 */
async function analyzeOutcomes(insertions, logger) {
  const outcomes = [];

  for (const insertion of insertions) {
    const ticketData = await getTicketWithComments(insertion.ticketId, logger);

    if (!ticketData) {
      outcomes.push({
        ticketId: insertion.ticketId,
        suggested: insertion.suggestedResponse,
        actual: null,
        status: "unknown",
        reopened: false,
        wasEdited: null,
        error: "Failed to fetch ticket",
      });
      continue;
    }

    const { ticket, comments } = ticketData;

    // Find the agent's comment after insertion
    const agentComment = findAgentCommentAfterInsertion(
      comments,
      insertion.agentEmail,
      insertion.insertedAt
    );

    // Check if reopened
    const reopened = await checkIfReopened(insertion.ticketId, logger);

    // Calculate if edited
    let wasEdited = null;
    if (agentComment) {
      // Normalize for comparison (trim whitespace, normalize newlines)
      const normalizedSuggested = insertion.suggestedResponse
        .trim()
        .replace(/\r\n/g, "\n");
      const normalizedActual = (agentComment.plain_body || agentComment.body || "")
        .trim()
        .replace(/\r\n/g, "\n");

      wasEdited = normalizedSuggested !== normalizedActual;
    }

    outcomes.push({
      ticketId: insertion.ticketId,
      suggested: insertion.suggestedResponse,
      actual: agentComment?.plain_body || agentComment?.body || null,
      status: ticket.status,
      reopened,
      wasEdited,
      insertedAt: insertion.insertedAt,
      agentEmail: insertion.agentEmail,
    });
  }

  return outcomes;
}

/**
 * Calculate edit statistics
 */
function calculateEditStats(outcomes) {
  const total = outcomes.length;
  const withActual = outcomes.filter((o) => o.actual !== null);
  const edited = withActual.filter((o) => o.wasEdited === true);
  const unedited = withActual.filter((o) => o.wasEdited === false);
  const solved = outcomes.filter((o) => o.status === "solved");
  const reopened = outcomes.filter((o) => o.reopened === true);

  return {
    total,
    withActualResponse: withActual.length,
    edited: edited.length,
    unedited: unedited.length,
    editRate: withActual.length > 0 ? edited.length / withActual.length : 0,
    solved: solved.length,
    solveRate: total > 0 ? solved.length / total : 0,
    reopened: reopened.length,
    reopenRate: total > 0 ? reopened.length / total : 0,
  };
}

module.exports = {
  getTicketWithComments,
  checkIfReopened,
  findAgentCommentAfterInsertion,
  analyzeOutcomes,
  calculateEditStats,
};
