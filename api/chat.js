const {
  searchRelevantPages,
  getContextFromPages,
  formatForLLM,
} = require("./lib/notion");
const { chatFollowUp } = require("./lib/openai");

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
    const { message, ticket, previousMessages, notionContext } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    if (!ticket) {
      return res.status(400).json({ error: "Ticket context is required" });
    }

    // If no context provided, search for relevant docs based on the question
    let context = notionContext;
    let sources = [];

    if (!context) {
      const pages = await searchRelevantPages(message, 3);
      if (pages.length > 0) {
        const pagesWithContent = await getContextFromPages(pages);
        context = formatForLLM(pagesWithContent);
        sources = pagesWithContent.map((p) => ({
          title: p.title,
          url: p.url,
        }));
      }
    }

    // Generate chat response
    const response = await chatFollowUp(
      message,
      ticket,
      context || "",
      previousMessages || []
    );

    return res.status(200).json({
      response: response,
      sources: sources,
    });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      error: "Failed to generate chat response",
      message: error.message,
    });
  }
};
