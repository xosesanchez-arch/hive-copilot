const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a Copilot AI agent for Hive, helping support agents respond to merchant inquiries.

Based on the merchant's ticket and our SOPs/documentation, provide:

1. **Summary**: A brief 1-2 sentence summary of what the merchant needs
2. **Next Steps**: Bullet points of recommended actions based on our procedures
3. **Suggested Response**: A professional, helpful draft reply to send to the merchant

Guidelines:
- Be concise and actionable
- Follow Hive's tone: professional, friendly, solution-oriented
- Reference specific SOPs when applicable
- If you're unsure about something, say so rather than guessing

Always structure your response with clear headers for Summary, Next Steps, and Suggested Response.`;

/**
 * Generate copilot response for a ticket
 */
async function generateCopilotResponse(ticketData, notionContext, conversationHistory = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `## Relevant SOPs and Documentation:\n\n${notionContext || "No relevant documentation found."}`,
    },
    ...conversationHistory,
    {
      role: "user",
      content: formatTicketForPrompt(ticketData),
    },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 1500,
    });

    const content = response.choices[0]?.message?.content || "";
    return parseResponse(content);
  } catch (error) {
    console.error("OpenAI error:", error);
    throw new Error("Failed to generate response");
  }
}

/**
 * Handle follow-up chat messages
 */
async function chatFollowUp(message, ticketData, notionContext, previousMessages = []) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `## Relevant SOPs and Documentation:\n\n${notionContext || "No relevant documentation found."}`,
    },
    {
      role: "system",
      content: `## Current Ticket Context:\n\n${formatTicketForPrompt(ticketData)}`,
    },
    ...previousMessages,
    { role: "user", content: message },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    return response.choices[0]?.message?.content || "";
  } catch (error) {
    console.error("OpenAI chat error:", error);
    throw new Error("Failed to generate chat response");
  }
}

/**
 * Format ticket data for the prompt
 */
function formatTicketForPrompt(ticket) {
  let prompt = `## Ticket Information\n`;
  prompt += `**Subject**: ${ticket.subject || "No subject"}\n`;
  prompt += `**Status**: ${ticket.status || "Unknown"}\n`;
  prompt += `**Priority**: ${ticket.priority || "Normal"}\n`;

  if (ticket.requester) {
    prompt += `**Requester**: ${ticket.requester.name || "Unknown"} (${ticket.requester.email || "No email"})\n`;
  }

  if (ticket.tags && ticket.tags.length > 0) {
    prompt += `**Tags**: ${ticket.tags.join(", ")}\n`;
  }

  prompt += `\n## Conversation:\n`;

  if (ticket.comments && ticket.comments.length > 0) {
    for (const comment of ticket.comments) {
      const author = comment.author?.name || "Unknown";
      const isAgent = comment.author?.role === "agent";
      const prefix = isAgent ? "[Agent]" : "[Customer]";
      prompt += `\n${prefix} ${author}:\n${comment.value || comment.body || ""}\n`;
    }
  } else {
    prompt += "No comments available.\n";
  }

  return prompt;
}

/**
 * Parse the LLM response into structured sections
 */
function parseResponse(content) {
  const sections = {
    summary: "",
    nextSteps: "",
    suggestedResponse: "",
    raw: content,
  };

  // Extract Summary
  const summaryMatch = content.match(/\*\*Summary\*\*:?\s*([\s\S]*?)(?=\*\*Next Steps\*\*|\*\*Suggested Response\*\*|$)/i);
  if (summaryMatch) {
    sections.summary = summaryMatch[1].trim();
  }

  // Extract Next Steps
  const nextStepsMatch = content.match(/\*\*Next Steps\*\*:?\s*([\s\S]*?)(?=\*\*Suggested Response\*\*|$)/i);
  if (nextStepsMatch) {
    sections.nextSteps = nextStepsMatch[1].trim();
  }

  // Extract Suggested Response
  const responseMatch = content.match(/\*\*Suggested Response\*\*:?\s*([\s\S]*?)$/i);
  if (responseMatch) {
    sections.suggestedResponse = responseMatch[1].trim();
  }

  return sections;
}

/**
 * Extract key terms from ticket for searching
 */
function extractSearchTerms(ticket) {
  const text = [
    ticket.subject || "",
    ...(ticket.comments || []).map((c) => c.value || c.body || ""),
  ].join(" ");

  // Simple keyword extraction - get meaningful words
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);

  // Get unique words, prioritize less common ones
  const commonWords = new Set([
    "this", "that", "with", "from", "have", "been", "will", "would",
    "could", "should", "about", "there", "their", "what", "when",
    "where", "which", "while", "your", "please", "thank", "thanks",
    "hello", "help", "need", "want", "like", "just", "also", "very",
  ]);

  const keywords = [...new Set(words)]
    .filter((w) => !commonWords.has(w))
    .slice(0, 5);

  return keywords.join(" ");
}

module.exports = {
  generateCopilotResponse,
  chatFollowUp,
  extractSearchTerms,
};
