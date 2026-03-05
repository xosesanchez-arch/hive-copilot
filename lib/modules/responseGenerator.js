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
- IMPORTANT: This is a continuing conversation. Do NOT re-introduce yourself or re-explain things already covered in the thread. Build on what has already been said.
- If the agent has already acknowledged the issue in a previous message, do NOT re-acknowledge it - move forward with updates or next steps.
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
 * @param {string} entityContext - Entity context from Hive MCP (order/shipment/return status)
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
  entityContext = "",
  logger = null
) {
  logger?.log("response", "Starting response generation");

  const requesterFirstName = resolveRequesterName(ticket);
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

  // Add entity context if available (from Hive MCP - order/shipment/return status)
  if (entityContext) {
    messages.push({
      role: "system",
      content: `## Entity Status Information (real-time data):\n\n${entityContext}\n\nUse this information to provide accurate, contextual responses about the specific order/shipment/return.`,
    });
  }

  // Build conversation thread context (last few exchanges for state awareness)
  const threadContext = buildThreadContext(ticket);

  // Main user prompt - uses SUMMARY instead of raw ticket (context chaining!)
  messages.push({
    role: "user",
    content: `## Ticket Summary (from analysis):
${summaryOutput}
${threadContext ? `\n## Conversation Thread (${ticket.comments?.length || 0} messages so far):\n${threadContext}` : ""}

## Last Customer Message (respond to this):
${lastCustomerComment}

## Agent Name: ${agentName}
## Customer Name: ${requesterFirstName}

Write a helpful response to the customer's latest message. This is a continuing conversation - do not repeat what has already been addressed.`,
  });

  logger?.log("response", "Calling OpenAI for response", {
    ticketId: ticket.id,
    summaryLength: summaryOutput?.length || 0,
    hasKnowledge: !!knowledgeContext,
    hasMacros: !!macrosContext,
    hasGlossary: !!glossaryContext,
    hasHistory: !!historyFormattedContext,
    hasImprovements: !!improvementsContext,
    hasEntityContext: !!entityContext,
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
 * Extract a usable first name from a string, or null if it's an email / unusable
 */
function getFirstName(str) {
  if (!str || typeof str !== "string" || str.includes("@")) return null;
  const first = str.trim().split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Resolve customer first name from multiple sources, in order of reliability
 */
function resolveRequesterName(ticket) {
  // 1. Requester display name (most reliable when set properly)
  const fromRequester = getFirstName(ticket.requester?.name);
  if (fromRequester) return fromRequester;

  // 2. Customer comment author names (first non-agent, non-email name found)
  const customerComments = (ticket.comments || []).filter(c => c.author?.role !== "agent");
  for (const comment of customerComments) {
    const fromAuthor = getFirstName(comment.author?.name);
    if (fromAuthor && fromAuthor !== "Unknown") return fromAuthor;
  }

  // 3. Try to extract a readable name from the requester email prefix
  // e.g. "ingrid@vertellis.nl" → "Ingrid", "john.doe@example.com" → "John"
  const email = ticket.requester?.email || (ticket.requester?.name?.includes("@") ? ticket.requester.name : null);
  if (email) {
    const prefix = email.split("@")[0];
    const namePart = prefix.split(/[._+-]/)[0];
    if (namePart && namePart.length > 1 && !/^\d+$/.test(namePart)) {
      return namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();
    }
  }

  return "there";
}

/**
 * Build a short thread recap (last 4 public exchanges) for conversation state awareness
 */
function buildThreadContext(ticket) {
  const publicComments = (ticket.comments || [])
    .filter(c => c.public !== false && (c.value || c.body));

  if (publicComments.length <= 1) return ""; // Only one message, no thread to recap

  // Take last 4 comments (excluding the very last customer message which is shown separately)
  const thread = publicComments.slice(-5, -1);
  if (thread.length === 0) return "";

  return thread.map(c => {
    const role = c.author?.role === "agent" ? "Agent" : "Customer";
    const text = (c.value || c.body || "").slice(0, 200);
    return `[${role}]: ${text}${text.length >= 200 ? "..." : ""}`;
  }).join("\n");
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
