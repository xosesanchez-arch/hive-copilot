/**
 * Request-scoped logger for Hive Copilot
 * Logs to both console (Vercel) and collects entries for API response
 */

/**
 * Create a new logger instance for a request
 * @param {string} prefix - Prefix for log messages (e.g., "copilot", "chat")
 * @returns {Object} Logger instance with log(), getLogs(), getRequestId() methods
 */
function createLogger(prefix = "copilot") {
  const requestId = generateRequestId();
  const logs = [];
  const startTime = Date.now();

  return {
    requestId,

    /**
     * Log a message with category and optional data
     * @param {string} category - Log category (request, search, notion, zendesk, openai, cache, decision, error)
     * @param {string} message - Human-readable message
     * @param {Object} data - Additional data to log
     */
    log(category, message, data = {}) {
      const timestamp = Date.now() - startTime;
      const entry = {
        ts: timestamp,
        cat: category,
        msg: message,
        ...data,
      };

      // Log to console for Vercel
      const dataStr = Object.keys(data).length > 0 ? JSON.stringify(data) : "";
      console.log(`[${requestId}][${prefix}][${category}] ${message}`, dataStr);

      // Collect for response
      logs.push(entry);
    },

    /**
     * Log an error with stack trace
     * @param {string} message - Error message
     * @param {Error} error - Error object
     */
    error(message, error) {
      this.log("error", message, {
        error: error?.message || String(error),
        stack: error?.stack?.split("\n").slice(0, 3).join(" | "),
      });
    },

    /**
     * Get all collected log entries
     * @returns {Array} Array of log entries
     */
    getLogs() {
      return logs;
    },

    /**
     * Get the request ID
     * @returns {string} Request ID
     */
    getRequestId() {
      return requestId;
    },

    /**
     * Get timing information
     * @returns {Object} Timing data
     */
    getTiming() {
      return {
        total: Date.now() - startTime,
        startTime: new Date(startTime).toISOString(),
      };
    },

    /**
     * Get full debug object for API response
     * @returns {Object} Debug object with requestId, logs, and timing
     */
    getDebug() {
      return {
        requestId: this.getRequestId(),
        logs: this.getLogs(),
        timing: this.getTiming(),
      };
    },
  };
}

/**
 * Generate a short unique request ID
 * @returns {string} 8-character alphanumeric ID
 */
function generateRequestId() {
  return Math.random().toString(36).substring(2, 10);
}

module.exports = {
  createLogger,
};
