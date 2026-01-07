/**
 * Zendesk Help Center (FAQ) Integration
 * Searches and retrieves FAQ articles for AI context
 */

// Zendesk API configuration - trim to remove any trailing newlines from env vars
const ZENDESK_SUBDOMAIN = (process.env.ZENDESK_SUBDOMAIN || "hiveapp").trim();
const ZENDESK_EMAIL = (process.env.ZENDESK_EMAIL || "deliverybee@hive.app").trim();
const ZENDESK_TOKEN = process.env.ZENDESK_TOKEN?.trim();

const BASE_URL = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

/**
 * Simple in-memory cache with TTL (same pattern as Notion)
 */
const cache = {
  data: new Map(),
  TTL: 30 * 60 * 1000, // 30 minutes - FAQ articles rarely change

  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  },

  set(key, value) {
    this.data.set(key, {
      value,
      expiry: Date.now() + this.TTL,
    });
  },

  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.data.entries()) {
      if (now > item.expiry) {
        this.data.delete(key);
      }
    }
  },
};

/**
 * Make authenticated request to Zendesk API
 * @param {string} endpoint - API endpoint
 * @param {Object} logger - Optional logger instance
 */
async function zendeskRequest(endpoint, logger = null) {
  if (!ZENDESK_TOKEN) {
    logger?.log("error", "ZENDESK_TOKEN not set");
    throw new Error("ZENDESK_TOKEN environment variable is not set");
  }

  const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_TOKEN}`).toString("base64");
  const url = `${BASE_URL}${endpoint}`;

  logger?.log("zendesk", "API request", { endpoint });

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    logger?.log("error", "Zendesk API error", {
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`Zendesk API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Calculate relevance score based on query terms matching title and labels
 */
function calculateRelevance(article, query) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const titleLower = article.title.toLowerCase();
  const labels = (article.label_names || []).map((l) => l.toLowerCase());

  let score = 0;
  for (const term of queryTerms) {
    // Title matches (highest weight)
    if (titleLower.includes(term)) {
      score += 10;
      if (titleLower.split(/\s+/).includes(term)) {
        score += 5; // Exact word match bonus
      }
    }
    // Label matches
    for (const label of labels) {
      if (label.includes(term)) {
        score += 3;
      }
    }
  }
  return score;
}

/**
 * Convert HTML to plain text
 */
function htmlToText(html) {
  if (!html) return "";

  return (
    html
      // Remove script and style tags with content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      // Convert common block elements to newlines
      .replace(/<\/?(p|div|br|h[1-6]|li|tr)[^>]*>/gi, "\n")
      // Convert list items to bullets
      .replace(/<li[^>]*>/gi, "- ")
      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/&mdash;/g, "—")
      .replace(/&ndash;/g, "–")
      // Clean up whitespace
      .replace(/\n\s*\n/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

/**
 * Search for relevant FAQ articles based on query terms
 * Returns articles sorted by relevance, limited to top matches (with caching)
 * @param {string} query - Search query
 * @param {number} limit - Max results to return
 * @param {Object} logger - Optional logger instance
 */
async function searchFAQArticles(query, limit = 5, logger = null) {
  // Check cache first
  const cacheKey = `zendesk:search:${query.toLowerCase().trim()}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Zendesk cache hit", { query, cachedResults: cached.length });
    return cached;
  }

  logger?.log("zendesk", "Cache miss, calling Zendesk API", { query, limit });

  try {
    // Search Help Center articles
    const response = await zendeskRequest(
      `/help_center/articles/search.json?query=${encodeURIComponent(query)}&per_page=10`,
      logger
    );

    logger?.log("zendesk", "Zendesk API response", { rawResultCount: response.results?.length || 0 });

    // Score and filter articles by relevance
    const articles = (response.results || [])
      .map((article) => ({
        id: article.id,
        title: article.title,
        url: article.html_url,
        body: article.body,
        labels: article.label_names || [],
        relevance: calculateRelevance(article, query),
      }))
      .filter((article) => article.title && article.body) // Skip empty articles
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);

    logger?.log("zendesk", "Articles scored and filtered", {
      afterFiltering: articles.length,
      topArticles: articles.slice(0, 3).map(a => ({ title: a.title, relevance: a.relevance })),
    });

    // Cache the results
    cache.set(cacheKey, articles);

    return articles;
  } catch (error) {
    logger?.log("error", "Zendesk search error", { error: error.message });
    console.error("Zendesk search error:", error.message);
    return [];
  }
}

/**
 * Get full content of a specific article (with caching)
 * Note: Search results already include body, but this can fetch by ID if needed
 * @param {string} articleId - Zendesk article ID
 * @param {Object} logger - Optional logger instance
 */
async function getArticleContent(articleId, logger = null) {
  const cacheKey = `zendesk:article:${articleId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger?.log("cache", "Zendesk article cache hit", { articleId });
    return cached;
  }

  logger?.log("zendesk", "Fetching article content", { articleId });

  try {
    const response = await zendeskRequest(`/help_center/articles/${articleId}.json`, logger);
    const content = htmlToText(response.article?.body || "");

    logger?.log("zendesk", "Article content fetched", {
      articleId,
      contentLength: content.length,
    });

    cache.set(cacheKey, content);

    return content;
  } catch (error) {
    logger?.log("error", "Error fetching Zendesk article", { articleId, error: error.message });
    console.error("Error fetching Zendesk article:", error.message);
    return "";
  }
}

/**
 * Get content from multiple articles
 */
function getContentFromArticles(articles) {
  if (!articles || !Array.isArray(articles)) {
    return [];
  }
  return articles.map((article) => ({
    title: article.title,
    url: article.url,
    content: htmlToText(article.body || "").trim(),
  })).filter((a) => a.content.length > 0);
}

/**
 * Format FAQ articles for LLM prompt
 */
function formatFAQForLLM(articlesWithContent) {
  if (!articlesWithContent || articlesWithContent.length === 0) {
    return "";
  }

  return articlesWithContent
    .map(
      (article) =>
        `## FAQ: ${article.title}\nSource: ${article.url}\n\n${article.content}`
    )
    .join("\n\n---\n\n");
}

module.exports = {
  searchFAQArticles,
  getArticleContent,
  getContentFromArticles,
  formatFAQForLLM,
  htmlToText,
};
