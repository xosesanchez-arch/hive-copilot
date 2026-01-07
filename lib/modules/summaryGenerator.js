/**
 * Summary Generator Module
 * Generates ticket summary with optional context from previous interactions
 * Separate LLM call for focused, accurate summaries
 */

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

const SUMMARY_SYSTEM_PROMPT = `You are a support ticket analyzer for Hive, a logistics/fulfillment company.

Your task is to provide a clear, structured summary of the support ticket.

## Output Structure (follow this order):

1. **If this is a follow-up ticket or references another ticket:**
   Start with "**Related to Ticket #XXXXX:**" followed by a brief 1-3 sentence summary of what happened and its resolution status.

2. **Current Ticket Summary:**
   Summarize what the merchant/customer is asking about in the current conversation.
   - This section can be more detailed (3-5 sentences if needed)
   - Identify the core issue or request
   - Note important context (order numbers, tracking IDs, dates, specific details)

3. **If there's relevant history from OTHER previous tickets:**
   Add "**Previous context:**" with a brief 1-3 sentence summary.

## Guidelines:
- Current ticket summary can be thorough - include relevant details
- Previous ticket references should be concise (1-3 sentences each)
- Do NOT include recommendations or solutions - just summarize the situation
- Do NOT start with "Subject:" or repeat the ticket subject verbatim
- Write in the same language as the customer's messages`;

/**
 * Generate summary for a ticket
 * @param {Object} ticket - Ticket data with subject and comments
 * @param {Object} historyContext - Previous ticket history context
 * @param {Object} logger - Logger instance
 * @returns {Object} { summary: string, hasRelevantHistory: boolean, referencedTicketsSummary: string }
 */
async function generateSummary(ticket, historyContext = {}, logger = null) {
  logger?.log("summary", "Starting summary generation");

  // Format ticket for prompt
  const ticketInfo = formatTicketForSummary(ticket);

  // Check for referenced/follow-up tickets (HIGH PRIORITY - explicitly mentioned or Zendesk follow-up)
  const hasReferencedTickets = historyContext?.hasReferencedTickets && historyContext?.referencedTicketsSummary;
  const referencedSection = hasReferencedTickets
    ? `\n\n## DIRECTLY REFERENCED/FOLLOW-UP TICKET (include this context prominently):\n${historyContext.referencedTicketsSummary}`
    : "";

  // Check for relevant history from OTHER past tickets (LLM-analyzed relevance)
  const hasRelevantHistory = historyContext?.hasRelevantHistory && historyContext?.formattedContext;
  const historySection = hasRelevantHistory
    ? `\n\n## OTHER RELEVANT TICKET HISTORY (include under "Context from previous interactions" if helpful):\n${historyContext.formattedContext}`
    : "";

  // Build user prompt with clear instructions
  let userPrompt = `${ticketInfo}${referencedSection}${historySection}\n\n`;

  userPrompt += `Generate a structured summary following the output format in your instructions.`;

  if (hasReferencedTickets) {
    userPrompt += `\n\nIMPORTANT: This ticket references or is a follow-up to another ticket. Start your summary with the related ticket context header.`;
  }

  if (hasRelevantHistory && !hasReferencedTickets) {
    userPrompt += `\n\nNote: There is relevant history from the requester's previous tickets that may provide useful context.`;
  }

  const messages = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  logger?.log("summary", "Calling OpenAI for summary", {
    hasRelevantHistory,
    hasReferencedTickets,
    ticketId: ticket.id,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3,
      max_tokens: 400, // Increased to accommodate referenced ticket info
    });

    const summary = response.choices[0]?.message?.content?.trim() || "";

    logger?.log("summary", "Summary generated", {
      length: summary.length,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    return {
      summary,
      hasRelevantHistory: hasRelevantHistory || false,
      hasReferencedTickets: hasReferencedTickets || false,
    };
  } catch (error) {
    logger?.log("error", "Summary generation failed", { error: error.message });
    throw new Error("Failed to generate summary");
  }
}

/**
 * Format ticket data for the summary prompt
 */
function formatTicketForSummary(ticket) {
  let prompt = `## Ticket Information\n`;
  prompt += `Subject: ${ticket.subject || "No subject"}\n`;
  prompt += `Status: ${ticket.status || "Unknown"}\n`;

  if (ticket.requester) {
    prompt += `Requester: ${ticket.requester.name || "Unknown"}\n`;
  }

  prompt += `\n## Conversation (${ticket.comments?.length || 0} comments):\n`;

  if (ticket.comments && ticket.comments.length > 0) {
    ticket.comments.forEach((comment, index) => {
      const author = comment.author?.name || "Unknown";
      const isAgent = comment.author?.role === "agent";
      const prefix = isAgent ? "[Agent]" : "[Customer]";
      prompt += `\n${prefix} ${author}:\n${comment.value || comment.body || ""}\n`;
    });
  } else {
    prompt += "No comments available.\n";
  }

  return prompt;
}

module.exports = {
  generateSummary,
};
