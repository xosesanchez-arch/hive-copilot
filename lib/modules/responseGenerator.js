/**
 * Response Generator Module
 * Generates suggested customer response using context chaining
 * Uses summary output + all context sources for coherent responses
 */

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

/**
 * Build system prompt for response generation
 */
function buildSystemPrompt(agentName, requesterFirstName) {
  return `You are a Copilot AI helping Hive support agents draft customer responses.

Your task is to write a professional, helpful reply that addresses the customer's LATEST message.

Guidelines:
- IMPORTANT: Write in the SAME LANGUAGE as the customer. If they write in German, respond in German. Match their language.
- When responding in non-English, use official Hive terminology from the glossary provided.
- Start with "Hi ${requesterFirstName},"
- Address the LAST customer comment specifically - what did they most recently ask?
- Be concise and solution-oriented
- If macros are provided, MATCH their style and tone
- End with a friendly closing and sign off with "${agentName}"

CRITICAL formatting rules:
- Output PLAIN TEXT only - NO HTML tags (<p>, <br>, &nbsp;, etc.)
- NO markdown formatting (no **bold**, no *italic*, no bullet points with -, no numbered lists)
- Use regular line breaks for paragraphs
- Just plain sentences and paragraphs`;
}

/**
 * Generate suggested response for customer
 * Uses context chaining: summary output feeds into this prompt
 * @param {string} summaryOutput - LLM-generated summary (from summaryGenerator)
 * @param {Object} ticket - Ticket data (for last comment and requester info)
 * @param {string} notionContext - SOP context
 * @param {string} faqContext - FAQ context
 * @param {string} historyFormattedContext - Relevant history context
 * @param {string} agentName - Agent name for sign-off
 * @param {Array} macros - Zendesk macros for style reference
 * @param {string} glossaryContext - Terminology glossary
 * @param {string} improvementsContext - Improvement insights from feedback analysis
 * @param {Object} logger - Logger instance
 * @returns {Object} { suggestedResponse: string }
 */
async function generateResponse(
  summaryOutput,
  ticket,
  notionContext = "",
  faqContext = "",
  historyFormattedContext = "",
  agentName = "Support Agent",
  macros = [],
  glossaryContext = "",
  improvementsContext = "",
  logger = null
) {
  logger?.log("response", "Starting response generation");

  const requesterFirstName = getFirstName(ticket.requester?.name);
  const systemPrompt = buildSystemPrompt(agentName, requesterFirstName);

  // Get the last customer comment
  const lastCustomerComment = getLastCustomerComment(ticket);

  // Format macros for style reference
  const macrosContext = formatMacrosForPrompt(macros);

  // Build knowledge context (combine SOPs + FAQ)
  const knowledgeContext = [notionContext, faqContext]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const messages = [
    { role: "system", content: systemPrompt },
  ];

  // Add knowledge context if available
  if (knowledgeContext) {
    messages.push({
      role: "system",
      content: `## Relevant Documentation (use for accurate information):\n\n${knowledgeContext}`,
    });
  }

  // Add glossary if available
  if (glossaryContext) {
    messages.push({
      role: "system",
      content: glossaryContext,
    });
  }

  // Add macros for style reference
  if (macrosContext) {
    messages.push({
      role: "system",
      content: macrosContext,
    });
  }

  // Add history context if available
  if (historyFormattedContext) {
    messages.push({
      role: "system",
      content: `## Previous Interactions (reference if helpful):\n\n${historyFormattedContext}`,
    });
  }

  // Add improvement insights if available (from autonomous learning)
  if (improvementsContext) {
    messages.push({
      role: "system",
      content: `## Response Improvement Guidelines (learned from agent feedback):\n\n${improvementsContext}\n\nApply these insights to improve your response quality.`,
    });
  }

  // Main user prompt - uses SUMMARY instead of raw ticket (context chaining!)
  messages.push({
    role: "user",
    content: `## Ticket Summary (from analysis):
${summaryOutput}

## Last Customer Message (respond to this):
${lastCustomerComment}

## Agent Name: ${agentName}
## Customer Name: ${requesterFirstName}

Write a helpful response to the customer's latest message.`,
  });

  logger?.log("response", "Calling OpenAI for response", {
    ticketId: ticket.id,
    summaryLength: summaryOutput?.length || 0,
    hasKnowledge: !!knowledgeContext,
    hasMacros: !!macrosContext,
    hasGlossary: !!glossaryContext,
    hasHistory: !!historyFormattedContext,
    hasImprovements: !!improvementsContext,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    const suggestedResponse = response.choices[0]?.message?.content?.trim() || "";

    logger?.log("response", "Response generated", {
      length: suggestedResponse.length,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
    });

    return { suggestedResponse };
  } catch (error) {
    logger?.log("error", "Response generation failed", { error: error.message });
    throw new Error("Failed to generate response");
  }
}

/**
 * Get first name from full name
 */
function getFirstName(fullName) {
  if (!fullName) return "there";
  return fullName.split(" ")[0];
}

/**
 * Get the last customer comment from ticket
 */
function getLastCustomerComment(ticket) {
  const customerComments = (ticket.comments || [])
    .filter(c => c.author?.role !== "agent");

  if (customerComments.length === 0) {
    return ticket.subject || "No customer message available";
  }

  const lastComment = customerComments[customerComments.length - 1];
  return lastComment.value || lastComment.body || "No content";
}

/**
 * Format macros as style examples
 */
function formatMacrosForPrompt(macros) {
  if (!macros || macros.length === 0) return null;

  // Only include macros that have actual content
  const macrosWithContent = macros.filter(m => m.content && m.content.trim());

  if (macrosWithContent.length === 0) {
    return null;
  }

  // Format top 5 macros as style examples
  const macroExamples = macrosWithContent
    .slice(0, 5)
    .map((m) => `### ${m.title}\n${m.content}`)
    .join("\n\n");

  return `## Response Style Examples (match this tone and format):\n\n${macroExamples}`;
}

module.exports = {
  generateResponse,
};
