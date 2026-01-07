const { Client } = require("@notionhq/client");

// Trim token to remove any trailing newlines/whitespace from env var
const notion = new Client({ auth: process.env.NOTION_API_TOKEN?.trim() });
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID?.trim();

// Hive Glossary database ID for terminology consistency (Merchant Glossary DB)
const GLOSSARY_DATABASE_ID = "2230c0de327d80e4974dc8572ded9c75";

/**
 * Simple in-memory cache with TTL
 * For production, consider Redis or similar
 */
const cache = {
  data: new Map(),
  TTL: 5 * 60 * 1000, // 5 minutes

  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  },

  set(key, value, ttl = null) {
    this.data.set(key, {
      value,
      expiry: Date.now() + (ttl || this.TTL),
    });
  },

  // Clean expired entries periodically
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.data.entries()) {
      if (now > item.expiry) {
        this.data.delete(key);
      }
    }
  },
};

// Longer TTL for glossary (1 hour) - terms rarely change
const GLOSSARY_TTL = 60 * 60 * 1000;

/**
 * Calculate relevance score based on query terms matching the title
 */
function calculateRelevance(title, query) {
  const titleLower = title.toLowerCase();
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  let score = 0;
  for (const term of queryTerms) {
    if (titleLower.includes(term)) {
      score += 10;
      // Bonus for exact word match
      if (titleLower.split(/\s+/).includes(term)) {
        score += 5;
      }
    }
  }
  return score;
}

/**
 * Search for relevant SOP pages based on query terms
 * Returns pages sorted by relevance, limited to top matches (with caching)
 * @param {string} query - Search query
 * @param {number} limit - Max results to return
 * @param {Object} logger - Optional logger instance
 */
async function searchRelevantPages(query, limit = 5, logger = null) {
  // Check cache first (cache by normalized query)
  const cacheKey = `search:${query.toLowerCase().trim()}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Notion cache hit", { query, cachedResults: cached.length });
    return cached;
  }

  logger?.log("notion", "Cache miss, calling Notion API", { query, limit });

  try {
    // Fetch more pages initially for better relevance filtering
    const response = await notion.search({
      query: query,
      filter: { property: "object", value: "page" },
      page_size: 10,
    });

    logger?.log("notion", "Notion API response", { rawResultCount: response.results.length });

    // Score and filter pages by relevance
    const pages = response.results
      .map((page) => {
        const title = getPageTitle(page);
        const relevance = calculateRelevance(title, query);
        return {
          id: page.id,
          title: title,
          url: page.url,
          relevance: relevance,
        };
      })
      .filter((page) => page.title !== "Untitled") // Skip untitled pages
      .sort((a, b) => b.relevance - a.relevance) // Sort by relevance
      .slice(0, limit); // Take top N

    logger?.log("notion", "Pages scored and filtered", {
      afterFiltering: pages.length,
      topPages: pages.slice(0, 3).map(p => ({ title: p.title, relevance: p.relevance })),
    });

    // Cache the results
    cache.set(cacheKey, pages);

    return pages;
  } catch (error) {
    logger?.log("error", "Notion search error", { error: error.message });
    console.error("Notion search error:", error);
    return [];
  }
}

/**
 * Extract page title from Notion page object
 */
function getPageTitle(page) {
  // Check common title property names (Hive uses "Page" for titles)
  const titleProp = page.properties?.Page || page.properties?.title || page.properties?.Name;
  if (titleProp?.title?.[0]?.plain_text) {
    return titleProp.title[0].plain_text;
  }
  return "Untitled";
}

/**
 * Get content of a specific page (with caching)
 * @param {string} pageId - Notion page ID
 * @param {Object} logger - Optional logger instance
 */
async function getPageContent(pageId, logger = null) {
  // Check cache first
  const cacheKey = `page:${pageId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Notion page cache hit", { pageId });
    return cached;
  }

  logger?.log("notion", "Fetching page content", { pageId });

  try {
    const blocks = await getAllBlocks(pageId);
    const content = blocksToText(blocks);

    logger?.log("notion", "Page content fetched", {
      pageId,
      blocksCount: blocks.length,
      contentLength: content.length,
    });

    // Cache the result
    cache.set(cacheKey, content);

    return content;
  } catch (error) {
    logger?.log("error", "Error fetching page content", { pageId, error: error.message });
    console.error("Error fetching page content:", error);
    return "";
  }
}

/**
 * Fetch blocks from a page with depth limit for performance
 * @param {string} blockId - The block/page ID to fetch
 * @param {number} maxDepth - Maximum recursion depth (default 2)
 * @param {number} currentDepth - Current depth (internal use)
 */
async function getAllBlocks(blockId, maxDepth = 2, currentDepth = 0) {
  const blocks = [];

  // Stop recursion if we've reached max depth
  if (currentDepth >= maxDepth) {
    return blocks;
  }

  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 50, // Reduced from 100 for faster response
    });

    for (const block of response.results) {
      blocks.push(block);

      // Only recurse if we haven't reached max depth
      if (block.has_children && currentDepth < maxDepth - 1) {
        block.children = await getAllBlocks(block.id, maxDepth, currentDepth + 1);
      }
    }

    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);

  return blocks;
}

/**
 * Convert Notion blocks to plain text
 */
function blocksToText(blocks, indent = 0) {
  let text = "";
  const prefix = "  ".repeat(indent);

  for (const block of blocks) {
    const content = extractBlockText(block);
    if (content) {
      text += prefix + content + "\n";
    }

    if (block.children) {
      text += blocksToText(block.children, indent + 1);
    }
  }

  return text;
}

/**
 * Extract text from a single block
 */
function extractBlockText(block) {
  const type = block.type;
  const data = block[type];

  if (!data) return "";

  // Handle different block types
  switch (type) {
    case "paragraph":
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "bulleted_list_item":
    case "numbered_list_item":
    case "quote":
    case "callout":
    case "toggle":
      return richTextToPlain(data.rich_text);

    case "code":
      return `\`\`\`${data.language || ""}\n${richTextToPlain(data.rich_text)}\n\`\`\``;

    case "to_do":
      const checkbox = data.checked ? "[x]" : "[ ]";
      return `${checkbox} ${richTextToPlain(data.rich_text)}`;

    case "divider":
      return "---";

    case "table_row":
      return data.cells.map((cell) => richTextToPlain(cell)).join(" | ");

    default:
      return "";
  }
}

/**
 * Convert rich text array to plain text
 */
function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text || "").join("");
}

/**
 * Fetch multiple pages and format for LLM context
 * @param {Array} pages - Array of page objects with id, title, url
 * @param {Object} logger - Optional logger instance
 */
async function getContextFromPages(pages, logger = null) {
  logger?.log("notion", "Fetching content for pages", {
    pageCount: pages.length,
    pages: pages.map(p => p.title),
  });

  const contents = await Promise.all(
    pages.map(async (page) => {
      const content = await getPageContent(page.id, logger);
      return {
        title: page.title,
        url: page.url,
        content: content.trim(),
      };
    })
  );

  const filtered = contents.filter((c) => c.content.length > 0);

  logger?.log("notion", "Content fetched for pages", {
    requestedPages: pages.length,
    pagesWithContent: filtered.length,
  });

  return filtered;
}

/**
 * Format page contents for LLM prompt
 */
function formatForLLM(pagesWithContent) {
  return pagesWithContent
    .map(
      (page) =>
        `## ${page.title}\nSource: ${page.url}\n\n${page.content}`
    )
    .join("\n\n---\n\n");
}

/**
 * Fetch Hive Glossary for terminology consistency
 * Returns formatted glossary based on detected language
 * @param {string} language - Target language code (en, de, es, fr, nl, it)
 * @param {Object} logger - Optional logger instance
 */
async function getGlossary(language = "en", logger = null) {
  const cacheKey = `glossary:${language}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Glossary cache hit", { language, termCount: cached.terms.length });
    return cached;
  }

  logger?.log("glossary", "Cache miss, fetching glossary from Notion", { language });

  try {
    // Fetch all glossary entries
    const entries = [];
    let cursor;

    do {
      const response = await notion.databases.query({
        database_id: GLOSSARY_DATABASE_ID,
        start_cursor: cursor,
        page_size: 100,
      });

      for (const page of response.results) {
        const entry = extractGlossaryEntry(page, language);
        if (entry) {
          entries.push(entry);
        }
      }

      cursor = response.has_more ? response.next_cursor : null;
    } while (cursor);

    const glossary = {
      language,
      terms: entries,
      formatted: formatGlossaryForLLM(entries, language),
    };

    logger?.log("glossary", "Glossary fetched", {
      language,
      termCount: entries.length,
      formattedLength: glossary.formatted.length,
    });

    // Cache with longer TTL (30 min)
    cache.set(cacheKey, glossary, GLOSSARY_TTL);

    return glossary;
  } catch (error) {
    logger?.log("error", "Glossary fetch error", { error: error.message });
    console.error("Glossary fetch error:", error.message);
    return { language, terms: [], formatted: "" };
  }
}

/**
 * Extract glossary entry from Notion page
 * Maps language code to property columns (S = Singular, P = Plural)
 */
function extractGlossaryEntry(page, targetLang) {
  const props = page.properties;

  // Column mapping for languages (S = Singular, P = Plural)
  const langColumns = {
    en: ["EN S", "EN P"],
    de: ["DE S", "DE P"],
    es: ["ES S", "ES P"],
    fr: ["FR S", "FR P"],
    nl: ["NL S", "NL P"],
    it: ["IT S", "IT P"],
  };

  // Always get English as the reference
  const enSingular = getTextProperty(props["EN S"]);
  const enPlural = getTextProperty(props["EN P"]);

  if (!enSingular) return null; // Skip empty entries

  // Get target language translation
  const targetCols = langColumns[targetLang] || langColumns.en;
  const targetSingular = getTextProperty(props[targetCols[0]]);
  const targetPlural = getTextProperty(props[targetCols[1]]);

  return {
    en: enSingular,
    enPlural: enPlural || enSingular,
    target: targetSingular || enSingular,
    targetPlural: targetPlural || targetSingular || enSingular,
  };
}

/**
 * Get text from Notion property
 */
function getTextProperty(prop) {
  if (!prop) return null;
  if (prop.type === "title") {
    return prop.title?.[0]?.plain_text || null;
  }
  if (prop.type === "rich_text") {
    return prop.rich_text?.[0]?.plain_text || null;
  }
  return null;
}

/**
 * Format glossary for LLM prompt
 * Compact format to minimize token usage
 */
function formatGlossaryForLLM(entries, language) {
  if (!entries || entries.length === 0) return "";

  const langNames = {
    en: "English",
    de: "German",
    es: "Spanish",
    fr: "French",
    nl: "Dutch",
    it: "Italian",
  };

  const langName = langNames[language] || "English";

  // Separate translated terms from English-only terms
  const translated = entries.filter(e => e.target !== e.en);
  const englishOnly = entries.filter(e => e.target === e.en).map(e => e.en);

  // Build output
  let output = "";

  // If we have translations, show them first
  if (translated.length > 0) {
    const lines = translated
      .map(e => `${e.en} → ${e.target}`)
      .slice(0, 50);
    output += `## Hive Terminology (${langName})\nUse these official translations for Hive-specific terms:\n${lines.join("\n")}`;
  }

  // Always include English official terms (limited to save tokens)
  if (englishOnly.length > 0) {
    const termList = englishOnly.slice(0, 30).join(", ");
    if (output) output += "\n\n";
    output += `## Official Hive Terms\nUse these exact terms for consistency: ${termList}`;
  }

  return output;
}

/**
 * Detect language from text (simple heuristic)
 * Returns ISO language code
 */
function detectLanguage(text) {
  if (!text) return "en";

  const lowerText = text.toLowerCase();

  // German indicators
  if (/\b(ich|und|ist|nicht|haben|werden|können|bitte|danke|guten)\b/.test(lowerText)) {
    return "de";
  }

  // Spanish indicators
  if (/\b(hola|gracias|por favor|tengo|puedo|cómo|qué|está|tiene|para)\b/.test(lowerText)) {
    return "es";
  }

  // French indicators
  if (/\b(je|nous|vous|merci|bonjour|s'il vous plaît|est|sont|avez|comment)\b/.test(lowerText)) {
    return "fr";
  }

  // Dutch indicators
  if (/\b(ik|wij|bedankt|alstublieft|hoe|wat|hebben|kunnen|graag)\b/.test(lowerText)) {
    return "nl";
  }

  // Italian indicators
  if (/\b(ciao|grazie|per favore|come|cosa|sono|abbiamo|posso|vorrei)\b/.test(lowerText)) {
    return "it";
  }

  return "en";
}

module.exports = {
  searchRelevantPages,
  getPageContent,
  getContextFromPages,
  formatForLLM,
  getGlossary,
  detectLanguage,
};
