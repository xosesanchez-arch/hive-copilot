const OpenAI = require("openai");

// Trim API key to remove any trailing newlines from env var
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

const SYSTEM_PROMPT = `You are a Copilot AI agent for Hive, helping support agents respond to merchant inquiries.

Based on the merchant's ticket, provide:

1. **Summary**: A brief summary of the ENTIRE conversation so far - what has the merchant asked about across ALL comments, and what responses have been given. Do NOT start with "Subject:" or repeat the ticket subject verbatim.
2. **Next Steps**: Bullet points of recommended actions based on our procedures
3. **Suggested Response**: A professional, helpful draft reply that SPECIFICALLY addresses the LAST comment from the customer/merchant.

For generating the Suggested Response, use these knowledge sources IN ORDER OF PRIORITY:
1. **Notion SOPs/Documentation** (primary) - Use this for accurate internal procedural information and policies
2. **Zendesk FAQ Articles** (secondary) - Use these for customer-facing knowledge and common questions
3. **Zendesk Macros** (tertiary) - Use these as EXAMPLES of tone, format, and style. Match how the macros are written.
4. **Hive Terminology Glossary** - Use this for consistent terminology translations. When the customer writes in a non-English language, use the official Hive term translations from the glossary.
5. **Your knowledge** (fallback) - Only when the above don't cover the topic

Guidelines for the Suggested Response:
- IMPORTANT: Write the response in the SAME LANGUAGE as the customer's messages. If they write in German, respond in German. If Spanish, respond in Spanish. Match their language.
- IMPORTANT: When responding in a non-English language, use the Hive Terminology Glossary for consistent translations of Hive-specific terms (e.g., use the official German term for "Carrier" instead of a generic translation).
- CRITICAL: Output PLAIN TEXT only. Do NOT use any HTML tags like <p>, <br>, &nbsp;, etc. Use regular line breaks for paragraphs.
- CRITICAL: Do NOT use any markdown formatting. No **bold**, no *italic*, no bullet points with -, no numbered lists. Just plain sentences and paragraphs.
- Start with "Hi {requester_name}," (use the requester's first name from the ticket)
- Do NOT start with "Subject:" or include any subject line
- Address the LAST customer comment specifically - what did they most recently ask or say?
- Be concise and solution-oriented
- MATCH THE STYLE of the provided macros - they show how Hive agents write
- End with a friendly closing and sign off with "{agent_name}"

General guidelines:
- Be concise and actionable
- Reference specific SOPs when applicable
- If you're unsure about something, say so rather than guessing

Always structure your response with clear headers for Summary, Next Steps, and Suggested Response.`;

const CHAT_SYSTEM_PROMPT = `You are a helpful AI assistant for Hive support agents. You help them with follow-up questions about tickets they are handling.

You have access to:
- The current ticket information and conversation history
- Hive's internal documentation and SOPs (Notion)
- Zendesk FAQ articles (customer-facing knowledge base)
- The previous suggestions you made for this ticket

Guidelines:
- Answer the agent's question directly and concisely
- Be context-aware of the ticket, customer messages, and any previous suggestions
- IMPORTANT: If the agent asks you to draft a message or reply, write it in the SAME LANGUAGE as the customer's messages in the ticket
- Do NOT format your response with headers like "Summary", "Next Steps", or "Suggested Response"
- Just provide a natural, helpful answer to whatever the agent asks
- If they ask for a draft message, provide just the message text ready to be inserted`;

/**
 * Generate copilot response for a ticket
 * @param {Object} ticketData - Ticket information
 * @param {string} notionContext - Combined context from knowledge sources
 * @param {Array} conversationHistory - Previous conversation messages
 * @param {string} agentName - Agent name for sign-off
 * @param {Array} macros - Zendesk macros for style reference
 * @param {Object} logger - Optional logger instance
 */
async function generateCopilotResponse(ticketData, notionContext, conversationHistory = [], agentName = "Support Agent", macros = [], logger = null) {
  // Build prompt with agent name substitution
  const systemPrompt = SYSTEM_PROMPT
    .replace(/{agent_name}/g, agentName)
    .replace(/{requester_name}/g, getFirstName(ticketData.requester?.name));

  // Format macros for the prompt (only if provided)
  const macrosContext = formatMacrosForPrompt(macros);

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content: `## Relevant SOPs and Documentation:\n\n${notionContext || "No relevant documentation found."}`,
    },
  ];

  // Add macros context if available
  if (macrosContext) {
    messages.push({
      role: "system",
      content: macrosContext,
    });
  }

  messages.push(
    ...conversationHistory,
    {
      role: "user",
      content: formatTicketForPrompt(ticketData, agentName),
    }
  );

  logger?.log("openai", "Calling OpenAI API", {
    model: "gpt-4o-mini",
    messageCount: messages.length,
    contextLength: notionContext?.length || 0,
    macrosIncluded: !!macrosContext,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content || "";
    const parsed = parseResponse(content);

    logger?.log("openai", "OpenAI response received", {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      parsedSections: {
        hasSummary: !!parsed.summary,
        hasNextSteps: !!parsed.nextSteps,
        hasSuggestedResponse: !!parsed.suggestedResponse,
      },
    });

    return parsed;
  } catch (error) {
    logger?.log("error", "OpenAI API error", { error: error.message });
    console.error("OpenAI error:", error.message);
    throw new Error("Failed to generate response");
  }
}

/**
 * Handle follow-up chat messages
 * @param {string} message - User's chat message
 * @param {Object} ticketData - Ticket information
 * @param {string} notionContext - Combined context from knowledge sources
 * @param {Array} previousMessages - Previous chat messages
 * @param {string} previousSuggestion - Previous copilot suggestion
 * @param {Object} logger - Optional logger instance
 */
async function chatFollowUp(message, ticketData, notionContext, previousMessages = [], previousSuggestion = "", logger = null) {
  const messages = [
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    {
      role: "system",
      content: `## Internal Documentation:\n\n${notionContext || "No relevant documentation found."}`,
    },
    {
      role: "system",
      content: `## Current Ticket:\n\n${formatTicketForPrompt(ticketData)}`,
    },
    {
      role: "system",
      content: `## Previous Suggestion Given:\n\n${previousSuggestion || "No previous suggestion yet."}`,
    },
    ...previousMessages,
    { role: "user", content: message },
  ];

  logger?.log("openai", "Calling OpenAI for chat", {
    model: "gpt-4o-mini",
    messageCount: messages.length,
    previousMessagesCount: previousMessages.length,
  });

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content || "";

    logger?.log("openai", "Chat response received", {
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      responseLength: content.length,
    });

    return content;
  } catch (error) {
    logger?.log("error", "OpenAI chat error", { error: error.message });
    console.error("OpenAI chat error:", error);
    throw new Error("Failed to generate chat response");
  }
}

/**
 * Get first name from a full name
 */
function getFirstName(fullName) {
  if (!fullName) return "there";
  return fullName.split(" ")[0];
}

/**
 * Format macros as style examples for the AI to learn from
 */
function formatMacrosForPrompt(macros) {
  if (!macros || macros.length === 0) return null;

  // Only include macros that have actual content
  const macrosWithContent = macros.filter(m => m.content && m.content.trim());

  if (macrosWithContent.length === 0) {
    // Fallback to titles only if no content available
    const macroList = macros
      .map((m) => `- "${m.title}"${m.description ? `: ${m.description}` : ""}`)
      .join("\n");
    return `## Response Style Examples (Zendesk Macros):\nThese macro titles indicate the tone and topics used by Hive support:\n\n${macroList}`;
  }

  // Format macros with their actual content as style examples
  const macroExamples = macrosWithContent
    .slice(0, 5) // Limit to 5 to control token usage
    .map((m) => `### ${m.title}\n${m.content}`)
    .join("\n\n");

  return `## Response Style Examples (Zendesk Macros):\nThese are EXAMPLES of how Hive support agents write responses. MATCH THIS STYLE, TONE, AND FORMAT in your suggested response:\n\n${macroExamples}`;
}

/**
 * Format ticket data for the prompt
 */
function formatTicketForPrompt(ticket, agentName = "Support Agent") {
  let prompt = `## Ticket Information\n`;
  prompt += `**Subject**: ${ticket.subject || "No subject"}\n`;
  prompt += `**Status**: ${ticket.status || "Unknown"}\n`;
  prompt += `**Priority**: ${ticket.priority || "Normal"}\n`;
  prompt += `**Agent Name (for sign-off)**: ${agentName}\n`;

  if (ticket.requester) {
    prompt += `**Requester**: ${ticket.requester.name || "Unknown"} (${ticket.requester.email || "No email"})\n`;
    prompt += `**Requester First Name (for greeting)**: ${getFirstName(ticket.requester.name)}\n`;
  }

  if (ticket.tags && ticket.tags.length > 0) {
    prompt += `**Tags**: ${ticket.tags.join(", ")}\n`;
  }

  prompt += `\n## Conversation (${ticket.comments?.length || 0} comments):\n`;

  if (ticket.comments && ticket.comments.length > 0) {
    const totalComments = ticket.comments.length;
    ticket.comments.forEach((comment, index) => {
      const author = comment.author?.name || "Unknown";
      const isAgent = comment.author?.role === "agent";
      const isInternalNote = comment.isInternalNote === true;

      // Determine prefix based on comment type
      let prefix;
      if (isInternalNote) {
        prefix = "[Internal Note]";
      } else if (isAgent) {
        prefix = "[Agent]";
      } else {
        prefix = "[Customer]";
      }

      const isLast = index === totalComments - 1;
      const marker = isLast && !isInternalNote ? " ← LATEST (respond to this)" : "";
      prompt += `\n${prefix} ${author}${marker}:\n${comment.value || comment.body || ""}\n`;
    });
  } else {
    prompt += "No comments available.\n";
  }

  return prompt;
}

/**
 * Parse the LLM response into structured sections
 * Handles various markdown formats: **Bold**, ## Header, numbered lists, plain text
 */
function parseResponse(content) {
  const sections = {
    summary: "",
    nextSteps: "",
    suggestedResponse: "",
    raw: content,
  };

  if (!content) return sections;

  // Try multiple parsing strategies

  // Strategy 1: Look for markdown headers (## or **)
  let summaryMatch = content.match(/(?:\*\*|#{1,3}\s*)Summary(?:\*\*)?:?\s*([\s\S]*?)(?=(?:\*\*|#{1,3}\s*)(?:Next\s*Steps|Suggested\s*Response)|$)/i);
  let nextStepsMatch = content.match(/(?:\*\*|#{1,3}\s*)Next\s*Steps(?:\*\*)?:?\s*([\s\S]*?)(?=(?:\*\*|#{1,3}\s*)Suggested\s*Response|$)/i);
  let responseMatch = content.match(/(?:\*\*|#{1,3}\s*)Suggested\s*Response(?:\*\*)?:?\s*([\s\S]*?)$/i);

  // Strategy 2: Try numbered format (1. Summary, 2. Next Steps, 3. Suggested Response)
  if (!summaryMatch) {
    summaryMatch = content.match(/1[\.\)]\s*(?:\*\*)?Summary(?:\*\*)?:?\s*([\s\S]*?)(?=2[\.\)]\s*(?:\*\*)?Next\s*Steps|$)/i);
  }
  if (!nextStepsMatch) {
    nextStepsMatch = content.match(/2[\.\)]\s*(?:\*\*)?Next\s*Steps(?:\*\*)?:?\s*([\s\S]*?)(?=3[\.\)]\s*(?:\*\*)?Suggested\s*Response|$)/i);
  }
  if (!responseMatch) {
    responseMatch = content.match(/3[\.\)]\s*(?:\*\*)?Suggested\s*Response(?:\*\*)?:?\s*([\s\S]*?)$/i);
  }

  // Strategy 3: Try plain text headers (Summary:, Next Steps:, Suggested Response:)
  if (!summaryMatch) {
    summaryMatch = content.match(/^Summary:?\s*([\s\S]*?)(?=Next\s*Steps:|Suggested\s*Response:|$)/im);
  }
  if (!nextStepsMatch) {
    nextStepsMatch = content.match(/Next\s*Steps:?\s*([\s\S]*?)(?=Suggested\s*Response:|$)/i);
  }
  if (!responseMatch) {
    responseMatch = content.match(/Suggested\s*Response:?\s*([\s\S]*?)$/i);
  }

  // Extract matched content
  if (summaryMatch) {
    sections.summary = summaryMatch[1].trim();
  }
  if (nextStepsMatch) {
    sections.nextSteps = nextStepsMatch[1].trim();
  }
  if (responseMatch) {
    sections.suggestedResponse = responseMatch[1].trim();
  }

  // Fallback: If no sections found, use the entire content as suggested response
  if (!sections.summary && !sections.nextSteps && !sections.suggestedResponse && content.trim()) {
    // Check if it looks like a greeting/response (starts with "Hi" or similar)
    if (/^(Hi|Hello|Dear|Hey)\s/i.test(content.trim())) {
      sections.suggestedResponse = content.trim();
    } else {
      // Otherwise put it in summary
      sections.summary = content.trim();
    }
  }

  return sections;
}

/**
 * Extract key terms from ticket for searching
 * Uses bigrams for multi-word terms and smarter filtering
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
    "because", "into", "through", "during", "before", "after", "above",
    "below", "between", "under", "again", "further", "once", "here",
    "there", "where", "when", "both", "each", "more", "most", "other",
    "such", "only", "same", "than", "very", "just", "can", "will",
  ]);

  // Domain-specific important terms for logistics/shipping
  const domainTerms = new Set([
    "label", "outbound", "inbound", "shipping", "delivery", "tracking",
    "carrier", "pickup", "return", "refund", "processing", "stuck",
    "delayed", "lost", "damaged", "inventory", "warehouse", "fulfillment",
    "order", "package", "parcel", "shipment", "customs", "international",
    "domestic", "express", "standard", "priority", "sendcloud", "dhl",
    "ups", "fedex", "dpd", "gls", "hermes", "royal mail", "restriction",
  ]);

  // Clean and tokenize
  const cleanText = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const words = cleanText.split(/\s+/).filter((w) => w.length > 2);

  // Extract single keywords
  const keywords = [];
  for (const word of words) {
    if (!commonWords.has(word) && word.length > 3) {
      // Prioritize domain terms
      if (domainTerms.has(word)) {
        keywords.unshift(word); // Add to front
      } else {
        keywords.push(word);
      }
    }
  }

  // Extract bigrams (two-word phrases)
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    // Check if bigram contains domain terms or is meaningful
    if (domainTerms.has(words[i]) || domainTerms.has(words[i + 1])) {
      if (!commonWords.has(words[i]) && !commonWords.has(words[i + 1])) {
        bigrams.push(bigram);
      }
    }
  }

  // Combine: prioritize bigrams, then unique keywords
  const uniqueKeywords = [...new Set(keywords)].slice(0, 5);
  const uniqueBigrams = [...new Set(bigrams)].slice(0, 2);

  // Return bigrams first (more specific), then keywords
  const result = [...uniqueBigrams, ...uniqueKeywords.filter(k =>
    !uniqueBigrams.some(b => b.includes(k))
  )].slice(0, 5);

  return result.join(" ");
}

module.exports = {
  generateCopilotResponse,
  chatFollowUp,
  extractSearchTerms,
};
