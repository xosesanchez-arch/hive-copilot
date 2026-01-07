/**
 * Insight Generator
 * Uses OpenAI to analyze patterns from outcomes and feedback
 */

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate improvement insights from outcomes and feedback
 */
async function generateInsights(outcomes, feedback, weekStart, weekEnd, logger) {
  // Filter outcomes with edits for analysis
  const editedOutcomes = outcomes.filter((o) => o.wasEdited === true && o.actual);

  // Prepare data for analysis
  const analysisData = {
    summary: {
      totalInsertions: outcomes.length,
      editedResponses: editedOutcomes.length,
      unchangedResponses: outcomes.filter((o) => o.wasEdited === false).length,
      solvedTickets: outcomes.filter((o) => o.status === "solved").length,
      reopenedTickets: outcomes.filter((o) => o.reopened).length,
      positiveFeedback: feedback.filter((f) => f.type === "positive").length,
      negativeFeedback: feedback.filter((f) => f.type === "negative").length,
    },
    edits: editedOutcomes.slice(0, 20).map((o) => ({
      ticketId: o.ticketId,
      suggested: o.suggested?.substring(0, 500),
      actual: o.actual?.substring(0, 500),
      status: o.status,
      reopened: o.reopened,
    })),
    feedback: feedback.filter((f) => f.type === "negative").slice(0, 20).map((f) => ({
      issueType: f.issueType,
      comment: f.comment,
    })),
  };

  logger?.log("openai", "Generating insights", {
    editsCount: analysisData.edits.length,
    feedbackCount: analysisData.feedback.length,
  });

  const systemPrompt = `You are analyzing support ticket patterns to improve AI-suggested responses for a logistics/fulfillment company.

## Data Provided:
1. SUMMARY: Statistics about insertions, edits, and outcomes
2. EDITS: Tickets where the AI suggestion was modified by agents
   - For each: suggested response, actual response sent, ticket status, if reopened
3. FEEDBACK: Team lead feedback on suggestions (negative feedback with issue types)

## Your Task:
Analyze the differences between suggested and actual responses to identify actionable patterns:

1. **Common Additions**: What do agents consistently add that the AI missed?
   - Examples: tracking links, delivery timeframes, specific product names

2. **Common Removals**: What do agents remove that the AI shouldn't include?
   - Examples: overly formal phrases, unnecessary disclaimers

3. **Tone Adjustments**: How do agents modify the tone?
   - Examples: more empathetic for complaints, more casual for German market

4. **Procedure Improvements**: What processes should be followed differently?

5. **Team Lead Insights**: Key points from contributor feedback

Focus on ACTIONABLE, SPECIFIC insights that can directly improve future responses.
Prioritize patterns that appear frequently or correlate with better outcomes (solved, not reopened).`;

  const userPrompt = `## Week: ${formatDate(weekStart)} - ${formatDate(weekEnd)}

## Summary Statistics:
- Total insertions tracked: ${analysisData.summary.totalInsertions}
- Responses edited by agents: ${analysisData.summary.editedResponses}
- Responses used unchanged: ${analysisData.summary.unchangedResponses}
- Tickets solved: ${analysisData.summary.solvedTickets}
- Tickets reopened: ${analysisData.summary.reopenedTickets}
- Positive feedback: ${analysisData.summary.positiveFeedback}
- Negative feedback: ${analysisData.summary.negativeFeedback}

## Edited Responses (suggested vs actual):
${analysisData.edits.map((e, i) => `
### Edit ${i + 1} (Ticket #${e.ticketId}, ${e.status}${e.reopened ? ', REOPENED' : ''})
**Suggested:**
${e.suggested}

**Actual (what agent sent):**
${e.actual}
`).join('\n---\n')}

## Team Lead Feedback:
${analysisData.feedback.length > 0 ? analysisData.feedback.map((f, i) => `
${i + 1}. [${f.issueType}] ${f.comment}
`).join('\n') : 'No negative feedback this week.'}

---

Based on this data, provide your analysis in the following JSON format:
{
  "patterns": [
    {
      "category": "additions|removals|tone|procedure",
      "insight": "Specific, actionable insight",
      "frequency": 0.85,
      "examples": ["Example 1", "Example 2"],
      "recommendation": "What the AI should do differently"
    }
  ],
  "markdown": "## Improvement Insights\\n\\n### Patterns from Agent Edits\\n- Pattern 1\\n- Pattern 2\\n\\n### Team Lead Feedback Summary\\n- Key point 1\\n\\n### Recommended Actions\\n1. Action 1\\n2. Action 2"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error("No response from OpenAI");
    }

    const parsed = JSON.parse(content);

    logger?.log("openai", "Insights generated", {
      patternsCount: parsed.patterns?.length || 0,
    });

    return {
      patterns: parsed.patterns || [],
      markdown: parsed.markdown || "No insights generated.",
      raw: content,
    };
  } catch (error) {
    logger?.error("Insight generation error", error);

    // Return a default response on error
    return {
      patterns: [],
      markdown: `## Improvement Insights\n\nAnalysis could not be completed. Error: ${error.message}`,
      error: error.message,
    };
  }
}

/**
 * Format date for display
 */
function formatDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format insights for Notion page
 */
function formatInsightsForNotion(insights, stats, weekStart, weekEnd, version) {
  const dateRange = `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;

  return `# Improvement Insights v${version}
*Week of ${dateRange}*

## Statistics
- Insertions analyzed: ${stats.insertionsAnalyzed}
- Feedback processed: ${stats.feedbackProcessed}
- Tickets solved: ${stats.ticketsSolved}
- Tickets reopened: ${stats.ticketsReopened}

${insights.markdown}

---
*Generated automatically on ${formatDate(new Date())}*
`;
}

module.exports = {
  generateInsights,
  formatInsightsForNotion,
  formatDate,
};
