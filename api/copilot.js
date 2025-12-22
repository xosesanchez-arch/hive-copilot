const {
  searchRelevantPages,
  getContextFromPages,
  formatForLLM,
} = require("./lib/notion");
const {
  generateCopilotResponse,
  extractSearchTerms,
} = require("./lib/openai");

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { ticket, conversationHistory } = req.body;

    if (!ticket) {
      return res.status(400).json({ error: "Ticket data is required" });
    }

    // Extract search terms from ticket
    const searchQuery = extractSearchTerms(ticket);
    console.log("Search query:", searchQuery);

    // Search Notion for relevant SOPs
    const pages = await searchRelevantPages(searchQuery, 5);
    console.log("Found pages:", pages.length);

    // Get content from found pages
    let notionContext = "";
    let sources = [];

    if (pages.length > 0) {
      const pagesWithContent = await getContextFromPages(pages);
      notionContext = formatForLLM(pagesWithContent);
      sources = pagesWithContent.map((p) => ({
        title: p.title,
        url: p.url,
      }));
    }

    // Generate response using OpenAI
    const response = await generateCopilotResponse(
      ticket,
      notionContext,
      conversationHistory || []
    );

    return res.status(200).json({
      summary: response.summary,
      nextSteps: response.nextSteps,
      suggestedResponse: response.suggestedResponse,
      sources: sources,
    });
  } catch (error) {
    console.error("Copilot error:", error);
    return res.status(500).json({
      error: "Failed to generate copilot response",
      message: error.message,
    });
  }
};
