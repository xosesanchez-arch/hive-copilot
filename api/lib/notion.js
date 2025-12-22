const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

/**
 * Search for relevant SOP pages based on query terms
 */
async function searchRelevantPages(query, limit = 5) {
  try {
    const response = await notion.search({
      query: query,
      filter: { property: "object", value: "page" },
      page_size: limit,
    });

    return response.results.map((page) => ({
      id: page.id,
      title: getPageTitle(page),
      url: page.url,
    }));
  } catch (error) {
    console.error("Notion search error:", error);
    return [];
  }
}

/**
 * Extract page title from Notion page object
 */
function getPageTitle(page) {
  const titleProp = page.properties?.title || page.properties?.Name;
  if (titleProp?.title?.[0]?.plain_text) {
    return titleProp.title[0].plain_text;
  }
  return "Untitled";
}

/**
 * Get content of a specific page (recursively fetches all blocks)
 */
async function getPageContent(pageId) {
  try {
    const blocks = await getAllBlocks(pageId);
    return blocksToText(blocks);
  } catch (error) {
    console.error("Error fetching page content:", error);
    return "";
  }
}

/**
 * Recursively fetch all blocks from a page
 */
async function getAllBlocks(blockId) {
  const blocks = [];
  let cursor;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      blocks.push(block);

      // Recursively get children if block has them
      if (block.has_children) {
        block.children = await getAllBlocks(block.id);
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
 */
async function getContextFromPages(pages) {
  const contents = await Promise.all(
    pages.map(async (page) => {
      const content = await getPageContent(page.id);
      return {
        title: page.title,
        url: page.url,
        content: content.trim(),
      };
    })
  );

  return contents.filter((c) => c.content.length > 0);
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

module.exports = {
  searchRelevantPages,
  getPageContent,
  getContextFromPages,
  formatForLLM,
};
