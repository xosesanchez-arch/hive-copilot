const OpenAI = require("openai");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders } = require("../lib/auth");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim(),
});

const TRANSLATION_PROMPT = `You are a professional translator. Translate the following text to English.

Rules:
- Preserve the original formatting (paragraphs, line breaks)
- Maintain the professional, friendly tone
- Do not add, remove, or interpret content - just translate
- Use standard English equivalents for technical/business terms
- Keep proper nouns (names, company names) unchanged

Output only the translation, nothing else.`;

module.exports = async function handler(req, res) {
  const logger = createLogger("translate");

  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimitMiddleware(req, res)) {
    logger.log("rate_limit", "Request rate limited");
    return;
  }

  try {
    const { text, sourceLanguage = "auto" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    logger.log("request", "Translation request", {
      textLength: text.length,
      sourceLanguage,
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: TRANSLATION_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const translation = response.choices[0]?.message?.content?.trim() || "";

    logger.log("response", "Translation complete", {
      originalLength: text.length,
      translationLength: translation.length,
    });

    return res.status(200).json({
      translation,
      debug: logger.getDebug(),
    });

  } catch (error) {
    logger.error("Translation error", error);
    return res.status(500).json({
      error: "Failed to translate",
      message: error.message,
      debug: logger.getDebug(),
    });
  }
};
