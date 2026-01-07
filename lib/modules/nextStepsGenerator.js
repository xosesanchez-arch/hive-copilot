/**
 * Next Steps Generator Module
 * Generates recommended actions based on SOPs and FAQ
 * Separate LLM call for focused, accurate recommendations
 */

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

const NEXT_STEPS_SYSTEM_PROMPT = `You are a support workflow advisor for Hive, a logistics/fulfillment company.

Your task is to recommend specific next steps for the support agent based on the ticket and internal procedures.

Guidelines:
- Provide EXACTLY 2-3 actionable bullet points (MAXIMUM 3, never more)
- Reference specific procedures from the SOPs when applicable
- Be specific and practical (e.g., "Check order status in FC App" not "Investigate the issue")
- Prioritize by importance - only include the most critical steps
- Keep each step concise (1-2 sentences max)
- Use imperative form (e.g., "Check...", "Verify...", "Contact...")
- Write in English (internal guidance for agents)`;

/**
 * Generate next steps for a ticket
 * @param {Object} ticket - Ticket data
 * @param {string} notionContext - SOP context from Notion
 * @param {string} faqContext - FAQ context from Zendesk
 * @param {Object} logger - Logger instance
 * @returns {Object} { nextSteps: string }
 */
async function generateNextSteps(ticket, notionContext = "", faqContext = "", logger = null) {
  logger?.log("nextSteps", "Starting next steps generation");

  // Format ticket briefly for this prompt
  const ticketBrief = formatTicketBrief(ticket);

  // Combine knowledge context
  const knowledgeContext = [notionContext, faqContext]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const messages = [
    { role: "system", content: NEXT_STEPS_SYSTEM_PROMPT },
    {
      role: "system",
      content: knowledgeContext
        ? `## Relevant SOPs and Knowledge Base:\n\n${knowledgeContext}`
        : "No specific SOPs found for this issue.",
    },
    {
      role: "user",
      content: `${ticketBrief}\n\nBased on the ticket and available SOPs, what are the recommended next steps for the agent?`,
    },
  ];

  logger?.log("nextSteps", "Calling OpenAI for next steps", {
    ticketId: ticket.id,
    contextLength: knowledgeContext.length,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.3,
      max_tokens: 400,
    });

    const nextSteps = response.choices[0]?.message?.content?.trim() || "";

    logger?.log("nextSteps", "Next steps generated", {
      length: nextSteps.length,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    return { nextSteps };
  } catch (error) {
    logger?.log("error", "Next steps generation failed", { error: error.message });
    throw new Error("Failed to generate next steps");
  }
}

/**
 * Format ticket briefly for next steps prompt
 */
function formatTicketBrief(ticket) {
  let brief = `## Current Ticket\n`;
  brief += `Subject: ${ticket.subject || "No subject"}\n`;
  brief += `Status: ${ticket.status || "Unknown"}\n`;

  // Include last customer comment only (most relevant for next steps)
  const customerComments = (ticket.comments || [])
    .filter(c => c.author?.role !== "agent");

  if (customerComments.length > 0) {
    const lastComment = customerComments[customerComments.length - 1];
    brief += `\nLatest customer message:\n${lastComment.value || lastComment.body || "No content"}\n`;
  }

  return brief;
}

module.exports = {
  generateNextSteps,
};
