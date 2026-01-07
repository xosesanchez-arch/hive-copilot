/**
 * Vercel KV Wrapper
 * Provides utilities for storing and retrieving data from Vercel KV (Redis)
 */

const { kv } = require("@vercel/kv");

// Key prefixes
const PREFIXES = {
  INSERTION: "insertions:",
  FEEDBACK: "feedback:",
  USER: "users:",
  INSIGHTS_CURRENT: "insights:current",
  INSIGHTS_VERSION: "insights:v",
  INSIGHTS_VERSIONS: "insights:versions",
};

// TTL values (in seconds)
const TTL = {
  INSERTION: 14 * 24 * 60 * 60, // 14 days
  FEEDBACK: 14 * 24 * 60 * 60,  // 14 days
};

/**
 * Track an insertion (when "Insert" is clicked)
 */
async function trackInsertion(data) {
  const key = `${PREFIXES.INSERTION}${data.ticketId}`;
  const value = {
    ticketId: data.ticketId,
    suggestedResponse: data.suggestedResponse,
    insertedAt: new Date().toISOString(),
    agentEmail: data.agentEmail,
    agentName: data.agentName,
  };

  await kv.set(key, value, { ex: TTL.INSERTION });
  return value;
}

/**
 * Get an insertion by ticket ID
 */
async function getInsertion(ticketId) {
  const key = `${PREFIXES.INSERTION}${ticketId}`;
  return await kv.get(key);
}

/**
 * Get all insertions (for weekly review)
 */
async function getAllInsertions() {
  const keys = await kv.keys(`${PREFIXES.INSERTION}*`);
  if (keys.length === 0) return [];

  const insertions = await Promise.all(
    keys.map(async (key) => await kv.get(key))
  );

  return insertions.filter(Boolean);
}

/**
 * Track feedback (thumbs up/down)
 */
async function trackFeedback(data) {
  const timestamp = Date.now();
  const key = `${PREFIXES.FEEDBACK}${data.ticketId}:${timestamp}`;
  const value = {
    ticketId: data.ticketId,
    type: data.type, // "positive" or "negative"
    comment: data.comment || null,
    issueType: data.issueType || null,
    userEmail: data.userEmail,
    userName: data.userName,
    timestamp: new Date().toISOString(),
  };

  await kv.set(key, value, { ex: TTL.FEEDBACK });
  return value;
}

/**
 * Get all feedback (for weekly review)
 */
async function getAllFeedback() {
  const keys = await kv.keys(`${PREFIXES.FEEDBACK}*`);
  if (keys.length === 0) return [];

  const feedback = await Promise.all(
    keys.map(async (key) => await kv.get(key))
  );

  return feedback.filter(Boolean);
}

/**
 * Get or create user role
 */
async function getUserRole(email) {
  const key = `${PREFIXES.USER}${email}`;
  const user = await kv.get(key);

  if (!user) {
    // Default role is "agent"
    return { email, role: "agent" };
  }

  return user;
}

/**
 * Set user role (admin only)
 */
async function setUserRole(email, role, updatedBy) {
  const key = `${PREFIXES.USER}${email}`;
  const value = {
    email,
    role, // "admin", "contributor", or "agent"
    updatedAt: new Date().toISOString(),
    updatedBy,
  };

  await kv.set(key, value);
  return value;
}

/**
 * List all users with roles
 */
async function listAllUsers() {
  const keys = await kv.keys(`${PREFIXES.USER}*`);
  if (keys.length === 0) return [];

  const users = await Promise.all(
    keys.map(async (key) => await kv.get(key))
  );

  return users.filter(Boolean);
}

/**
 * Check if user is admin
 */
async function isAdmin(email) {
  const user = await getUserRole(email);
  return user.role === "admin";
}

/**
 * Check if user can give feedback (admin or contributor)
 */
async function canGiveFeedback(email) {
  const user = await getUserRole(email);
  return user.role === "admin" || user.role === "contributor";
}

/**
 * Get current insights
 */
async function getCurrentInsights() {
  return await kv.get(PREFIXES.INSIGHTS_CURRENT);
}

/**
 * Save new insights (with versioning)
 */
async function saveInsights(insights) {
  // Get current version to archive
  const current = await getCurrentInsights();

  if (current) {
    // Archive current version
    const versionKey = `${PREFIXES.INSIGHTS_VERSION}${current.version}`;
    await kv.set(versionKey, current);

    // Update versions list
    const versions = (await kv.get(PREFIXES.INSIGHTS_VERSIONS)) || [];
    if (!versions.includes(current.version)) {
      versions.push(current.version);
      await kv.set(PREFIXES.INSIGHTS_VERSIONS, versions);
    }
  }

  // Calculate new version number
  const newVersion = (current?.version || 0) + 1;

  // Save new insights as current
  const newInsights = {
    ...insights,
    version: newVersion,
    createdAt: new Date().toISOString(),
  };

  await kv.set(PREFIXES.INSIGHTS_CURRENT, newInsights);

  return newInsights;
}

/**
 * Get a specific version of insights
 */
async function getInsightsVersion(version) {
  const key = `${PREFIXES.INSIGHTS_VERSION}${version}`;
  return await kv.get(key);
}

/**
 * Get all available versions
 */
async function getInsightsVersionsList() {
  const versions = (await kv.get(PREFIXES.INSIGHTS_VERSIONS)) || [];
  const current = await getCurrentInsights();

  // Build version details
  const versionDetails = await Promise.all(
    versions.map(async (v) => {
      const data = await getInsightsVersion(v);
      return data ? {
        version: v,
        createdAt: data.createdAt,
        weekStart: data.weekStart,
        weekEnd: data.weekEnd,
      } : null;
    })
  );

  return {
    current: current?.version || null,
    versions: versionDetails.filter(Boolean).sort((a, b) => b.version - a.version),
  };
}

/**
 * Rollback to a specific version
 */
async function rollbackToVersion(targetVersion, adminEmail) {
  const current = await getCurrentInsights();
  const target = await getInsightsVersion(targetVersion);

  if (!target) {
    throw new Error(`Version ${targetVersion} not found`);
  }

  // Archive current before rollback
  if (current) {
    const versionKey = `${PREFIXES.INSIGHTS_VERSION}${current.version}`;
    await kv.set(versionKey, current);

    const versions = (await kv.get(PREFIXES.INSIGHTS_VERSIONS)) || [];
    if (!versions.includes(current.version)) {
      versions.push(current.version);
      await kv.set(PREFIXES.INSIGHTS_VERSIONS, versions);
    }
  }

  // Restore target as current
  const restored = {
    ...target,
    restoredAt: new Date().toISOString(),
    restoredBy: adminEmail,
    restoredFrom: current?.version,
  };

  await kv.set(PREFIXES.INSIGHTS_CURRENT, restored);

  return {
    rolledBackFrom: current?.version,
    rolledBackTo: targetVersion,
    currentVersion: targetVersion,
  };
}

/**
 * Clear old insertions and feedback (for maintenance)
 */
async function cleanupOldData(daysOld = 14) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  // Insertions
  const insertionKeys = await kv.keys(`${PREFIXES.INSERTION}*`);
  for (const key of insertionKeys) {
    const data = await kv.get(key);
    if (data && new Date(data.insertedAt) < cutoff) {
      await kv.del(key);
    }
  }

  // Feedback
  const feedbackKeys = await kv.keys(`${PREFIXES.FEEDBACK}*`);
  for (const key of feedbackKeys) {
    const data = await kv.get(key);
    if (data && new Date(data.timestamp) < cutoff) {
      await kv.del(key);
    }
  }
}

module.exports = {
  // Insertions
  trackInsertion,
  getInsertion,
  getAllInsertions,

  // Feedback
  trackFeedback,
  getAllFeedback,

  // Users
  getUserRole,
  setUserRole,
  listAllUsers,
  isAdmin,
  canGiveFeedback,

  // Insights
  getCurrentInsights,
  saveInsights,
  getInsightsVersion,
  getInsightsVersionsList,
  rollbackToVersion,

  // Maintenance
  cleanupOldData,

  // Constants
  PREFIXES,
  TTL,
};
