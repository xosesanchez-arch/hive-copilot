/**
 * Analytics Endpoint
 * Combined endpoint for weekly-review, rollback, and versions
 * Routes based on query param: ?action=weekly-review|rollback|versions
 */

const {
  getAllInsertions,
  getAllFeedback,
  saveInsights,
  isAdmin,
  rollbackToVersion,
  getInsightsVersionsList,
  getCurrentInsights,
} = require("../lib/kv");
const { analyzeOutcomes, calculateEditStats } = require("../lib/analytics/outcomeTracker");
const { generateInsights, formatInsightsForNotion } = require("../lib/analytics/insightGenerator");
const { rateLimitMiddleware } = require("../lib/rateLimit");
const { createLogger } = require("../lib/logger");
const { setCorsHeaders, authMiddleware } = require("../lib/auth");

const CRON_SECRET = process.env.CRON_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

module.exports = async function handler(req, res) {
  const logger = createLogger("analytics");

  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = req.query.action || req.body?.action;

  if (!action) {
    return res.status(400).json({
      error: "Missing action parameter",
      hint: "Use ?action=weekly-review|rollback|versions",
    });
  }

  switch (action) {
    case "weekly-review":
      return handleWeeklyReview(req, res, logger);
    case "rollback":
      return handleRollback(req, res, logger);
    case "versions":
      return handleVersions(req, res, logger);
    default:
      return res.status(400).json({
        error: `Unknown action: ${action}`,
        hint: "Use ?action=weekly-review|rollback|versions",
      });
  }
};

/**
 * Weekly Review Handler
 */
async function handleWeeklyReview(req, res, logger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization;
    const { adminEmail, secret } = req.body;

    let authorized = false;
    let triggeredBy = "unknown";

    // Method 1: Cron secret (for automated jobs)
    if (authHeader === `Bearer ${CRON_SECRET}` || secret === CRON_SECRET) {
      authorized = true;
      triggeredBy = "cron";
      logger.log("auth", "Authorized via cron secret");
    }

    // Method 2: Token-based auth (verifies the user's identity)
    if (!authorized) {
      const auth = authMiddleware(req);
      if (auth.isValid && auth.email) {
        const adminCheck = await isAdmin(auth.email);
        if (adminCheck) {
          authorized = true;
          triggeredBy = auth.email;
          logger.log("auth", "Authorized via signed token", { email: auth.email });
        }
      }
    }

    // Method 3: Legacy admin email (fallback, less secure)
    if (!authorized && adminEmail) {
      const adminCheck = await isAdmin(adminEmail);
      if (adminCheck) {
        authorized = true;
        triggeredBy = adminEmail;
        logger.log("auth", "Authorized via admin email (legacy)", { adminEmail });
      }
    }

    if (!authorized) {
      logger.log("unauthorized", "Unauthorized access attempt");
      return res.status(403).json({
        error: "Unauthorized. Provide valid cron secret or auth token.",
      });
    }

    logger.log("start", "Starting weekly review", { triggeredBy });

    const weekEnd = new Date();
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    logger.log("dateRange", "Review period", {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
    });

    const allInsertions = await getAllInsertions();
    const weekInsertions = allInsertions.filter((i) => {
      const insertedAt = new Date(i.insertedAt);
      return insertedAt >= weekStart && insertedAt <= weekEnd;
    });

    logger.log("insertions", "Fetched insertions", {
      total: allInsertions.length,
      thisWeek: weekInsertions.length,
    });

    const allFeedback = await getAllFeedback();
    const weekFeedback = allFeedback.filter((f) => {
      const timestamp = new Date(f.timestamp);
      return timestamp >= weekStart && timestamp <= weekEnd;
    });

    logger.log("feedback", "Fetched feedback", {
      total: allFeedback.length,
      thisWeek: weekFeedback.length,
    });

    logger.log("analysis", "Analyzing outcomes...");
    const outcomes = await analyzeOutcomes(weekInsertions, logger);
    const editStats = calculateEditStats(outcomes);

    logger.log("outcomes", "Outcomes analyzed", {
      total: outcomes.length,
      editRate: editStats.editRate,
      solveRate: editStats.solveRate,
      reopenRate: editStats.reopenRate,
    });

    logger.log("insights", "Generating insights with OpenAI...");
    const insights = await generateInsights(
      outcomes,
      weekFeedback,
      weekStart,
      weekEnd,
      logger
    );

    logger.log("insights", "Insights generated", {
      patternsCount: insights.patterns?.length || 0,
    });

    const stats = {
      insertionsAnalyzed: outcomes.length,
      feedbackProcessed: weekFeedback.length,
      ticketsSolved: editStats.solved,
      ticketsReopened: editStats.reopened,
    };

    const savedInsights = await saveInsights({
      content: insights.markdown,
      patterns: insights.patterns,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      stats,
      triggeredBy,
    });

    logger.log("saved", "Insights saved", {
      version: savedInsights.version,
    });

    const notionPageId = process.env.NOTION_INSIGHTS_PAGE_ID;
    if (notionPageId) {
      try {
        await updateNotionPage(
          notionPageId,
          formatInsightsForNotion(
            insights,
            stats,
            weekStart,
            weekEnd,
            savedInsights.version
          ),
          logger
        );
        logger.log("notion", "Notion page updated");
      } catch (notionError) {
        logger.error("Notion update failed", notionError);
      }
    }

    logger.log("complete", "Weekly review complete", {
      version: savedInsights.version,
      stats,
    });

    const response = {
      success: true,
      version: savedInsights.version,
      stats,
      insights: insights.markdown,
      patternsCount: insights.patterns?.length || 0,
    };

    // Only include debug data in non-production environments
    if (!IS_PRODUCTION) {
      response.debug = logger.getDebug();
    }

    return res.status(200).json(response);
  } catch (error) {
    logger.error("Weekly review error", error);
    const errorResponse = {
      error: "Failed to complete weekly review",
      message: IS_PRODUCTION ? "Internal server error" : error.message,
    };

    // Only include debug data in non-production environments
    if (!IS_PRODUCTION) {
      errorResponse.debug = logger.getDebug();
    }

    return res.status(500).json(errorResponse);
  }
}

/**
 * Rollback Handler
 */
async function handleRollback(req, res, logger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  try {
    const { targetVersion, adminEmail } = req.body;

    if (!targetVersion) {
      return res.status(400).json({
        error: "Missing required field: targetVersion",
      });
    }

    // Verify admin via token or legacy email
    let verifiedEmail = null;
    const auth = authMiddleware(req);
    if (auth.isValid && auth.email) {
      verifiedEmail = auth.email;
    } else if (adminEmail) {
      verifiedEmail = adminEmail; // Legacy fallback
    }

    if (!verifiedEmail) {
      return res.status(400).json({
        error: "Authentication required",
      });
    }

    const adminCheck = await isAdmin(verifiedEmail);
    if (!adminCheck) {
      logger.log("unauthorized", "Non-admin tried to rollback", { email: verifiedEmail });
      return res.status(403).json({
        error: "Only admins can rollback insights",
      });
    }

    logger.log("request", "Rollback requested", {
      targetVersion,
      email: verifiedEmail,
    });

    const versionsList = await getInsightsVersionsList();
    const validVersions = versionsList.versions.map((v) => v.version);

    if (!validVersions.includes(targetVersion)) {
      return res.status(400).json({
        error: `Version ${targetVersion} not found`,
        availableVersions: validVersions,
      });
    }

    const result = await rollbackToVersion(targetVersion, verifiedEmail);

    logger.log("response", "Rollback successful", result);

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    logger.error("Rollback error", error);
    return res.status(500).json({
      error: "Failed to rollback",
      message: error.message,
    });
  }
}

/**
 * Versions Handler
 */
async function handleVersions(req, res, logger) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!rateLimitMiddleware(req, res)) {
    return;
  }

  try {
    const adminEmail = req.query.adminEmail;

    // Verify admin via token or legacy email
    let verifiedEmail = null;
    const auth = authMiddleware(req);
    if (auth.isValid && auth.email) {
      verifiedEmail = auth.email;
    } else if (adminEmail) {
      verifiedEmail = adminEmail; // Legacy fallback
    }

    if (!verifiedEmail) {
      return res.status(400).json({ error: "Authentication required" });
    }

    const adminCheck = await isAdmin(verifiedEmail);
    if (!adminCheck) {
      logger.log("unauthorized", "Non-admin tried to list versions", { email: verifiedEmail });
      return res.status(403).json({
        error: "Only admins can view insight versions",
      });
    }

    logger.log("request", "Listing versions", { email: verifiedEmail });

    const versionsList = await getInsightsVersionsList();
    const current = await getCurrentInsights();

    logger.log("response", "Versions listed", {
      currentVersion: versionsList.current,
      versionsCount: versionsList.versions.length,
    });

    return res.status(200).json({
      current: versionsList.current,
      currentInsights: current ? {
        version: current.version,
        createdAt: current.createdAt,
        weekStart: current.weekStart,
        weekEnd: current.weekEnd,
        stats: current.stats,
      } : null,
      versions: versionsList.versions,
    });
  } catch (error) {
    logger.error("Versions list error", error);
    return res.status(500).json({
      error: "Failed to list versions",
      message: error.message,
    });
  }
}

/**
 * Update Notion page with insights
 */
async function updateNotionPage(pageId, content, logger) {
  const { Client } = require("@notionhq/client");
  const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

  try {
    const existingBlocks = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
    });

    for (const block of existingBlocks.results) {
      await notion.blocks.delete({ block_id: block.id });
    }

    const lines = content.split("\n");
    const blocks = [];

    for (const line of lines) {
      if (line.startsWith("# ")) {
        blocks.push({
          object: "block",
          type: "heading_1",
          heading_1: {
            rich_text: [{ type: "text", text: { content: line.substring(2) } }],
          },
        });
      } else if (line.startsWith("## ")) {
        blocks.push({
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: line.substring(3) } }],
          },
        });
      } else if (line.startsWith("### ")) {
        blocks.push({
          object: "block",
          type: "heading_3",
          heading_3: {
            rich_text: [{ type: "text", text: { content: line.substring(4) } }],
          },
        });
      } else if (line.startsWith("- ")) {
        blocks.push({
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: line.substring(2) } }],
          },
        });
      } else if (line.match(/^\d+\. /)) {
        blocks.push({
          object: "block",
          type: "numbered_list_item",
          numbered_list_item: {
            rich_text: [{ type: "text", text: { content: line.replace(/^\d+\. /, "") } }],
          },
        });
      } else if (line.startsWith("*") && line.endsWith("*")) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{
              type: "text",
              text: { content: line.replace(/^\*|\*$/g, "") },
              annotations: { italic: true },
            }],
          },
        });
      } else if (line.trim()) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: line } }],
          },
        });
      }
    }

    for (let i = 0; i < blocks.length; i += 100) {
      const batch = blocks.slice(i, i + 100);
      await notion.blocks.children.append({
        block_id: pageId,
        children: batch,
      });
    }

    logger?.log("notion", "Page updated successfully", { blockCount: blocks.length });
  } catch (error) {
    logger?.error("Notion update error", error);
    throw error;
  }
}
