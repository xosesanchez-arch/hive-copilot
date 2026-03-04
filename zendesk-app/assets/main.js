(function () {
  "use strict";

  // Allowed API hosts for security validation
  const ALLOWED_API_HOSTS = new Set([
    "hive-copilot.vercel.app",
    "localhost",
    "127.0.0.1"
  ]);

  // State
  let client;
  let apiEndpoint;
  let ticketData = null;
  let agentName = "Support Agent";
  let agentEmail = "";
  let agentRole = "viewer"; // viewer, contributor, admin
  let chatHistory = [];
  let notionContext = "";
  let previousSuggestion = "";
  let isLoading = false; // Prevent double-clicks
  let cachedMacros = null; // Cache macros (they rarely change)

  // Translation state
  let detectedLanguage = "en";
  let mainResponseTranslation = null; // null | "loading" | string
  let mainResponseOriginal = "";
  let showingMainTranslation = false;
  let chatTranslations = new Map(); // messageIndex -> { translation, showing, original }

  // DOM Elements
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const contentEl = document.getElementById("content");
  const summaryEl = document.getElementById("summary");
  const nextStepsEl = document.getElementById("next-steps");
  const suggestedResponseEl = document.getElementById("suggested-response");
  const sourcesEl = document.getElementById("sources");
  const sourcesToggle = document.getElementById("sources-toggle");
  const chatMessagesEl = document.getElementById("chat-messages");
  const chatInputEl = document.getElementById("chat-input");

  // Admin/Feedback DOM Elements
  const tabNavEl = document.getElementById("tab-nav");
  const tabCopilotBtn = document.getElementById("tab-copilot");
  const tabAdminBtn = document.getElementById("tab-admin");
  const adminPanelEl = document.getElementById("admin-panel");
  const feedbackSectionEl = document.getElementById("feedback-section");
  const feedbackModal = document.getElementById("feedback-modal");

  // Initialize
  async function init() {
    showLoading();

    try {
      client = ZAFClient.init();

      // Get app settings
      const metadata = await client.metadata();
      apiEndpoint = metadata.settings.apiEndpoint;

      if (!apiEndpoint) {
        throw new Error("API endpoint not configured. Please set it in app settings.");
      }

      // Validate endpoint to reduce the risk of data exfiltration via misconfiguration.
      let parsedEndpoint;
      try {
        parsedEndpoint = new URL(apiEndpoint);
      } catch (_) {
        throw new Error("Invalid API endpoint URL. Please provide a valid https URL.");
      }

      if (parsedEndpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsedEndpoint.hostname)) {
        throw new Error("API endpoint must use https.");
      }

      if (!ALLOWED_API_HOSTS.has(parsedEndpoint.hostname)) {
        throw new Error(
          `API endpoint host is not allowed: ${parsedEndpoint.hostname}. Update the app code+manifest allowlist if intentional.`
        );
      }

      // Normalize (strip trailing slash)
      apiEndpoint = parsedEndpoint.origin;

      // Maximize height - set very large value, Zendesk will cap at available space
      await client.invoke("resize", { width: "100%", height: "9999px" });

      // Wait a moment for Zendesk to fully load ticket data
      await new Promise(resolve => setTimeout(resolve, 500));

      // Load ticket data and check user role
      await loadTicketData();
      await checkUserRole();

      if (!ticketData || !ticketData.subject) {
        throw new Error("Could not load ticket data. Please try refreshing.");
      }

      await generateResponse();
    } catch (error) {
      console.error("Init error:", error);
      showError(error.message || "Failed to initialize. Please click Regenerate.");
    }
  }

  // Check user role and show/hide admin features
  async function checkUserRole() {
    try {
      const data = await client.get(["currentUser.email", "currentUser.role"]);
      agentEmail = data["currentUser.email"] || "";
      const zendeskRole = data["currentUser.role"] || "";

      // Fetch user role from our API
      const response = await fetch(`${apiEndpoint}/api/users?resource=role&email=${encodeURIComponent(agentEmail)}`);
      if (response.ok) {
        const roleData = await response.json();
        agentRole = roleData.role || "viewer";
      }

      console.log("User role:", agentRole, "Zendesk role:", zendeskRole);

      // Show feedback section for contributors and admins
      if (feedbackSectionEl && (agentRole === "contributor" || agentRole === "admin")) {
        feedbackSectionEl.classList.remove("hidden");
      }

      // Show admin tab for admins only
      if (tabNavEl && agentRole === "admin") {
        tabNavEl.classList.remove("hidden");
      }
    } catch (error) {
      console.error("Error checking user role:", error);
      // Default to viewer role on error
      agentRole = "viewer";
    }
  }

  // Field ID → customFields key mapping
  // ZAF ticket.customField: syntax only works with text keys, not numeric IDs.
  // We fetch custom_fields via the REST API instead and map by ID.
  const CUSTOM_FIELD_MAP = {
    "360019030218": "hive_order_id",   // Hive Order ID (newer)
    "360022163557": "hive_order_id",   // Hive Order ID (older, fallback)
    "360019189777": "shop_order_id",
    "9598477582365": "hive_shipment_id",
    "18139543478429": "hive_return_id",
    "6154031774237": "restocking_shipment_id",
    "6153994047645": "kitting_id",
    "28388828319773": "freight_request_id",
  };

  // Fetch ticket data from Zendesk
  async function loadTicketData() {
    try {
      const data = await client.get([
        "ticket.id",
        "ticket.subject",
        "ticket.status",
        "ticket.priority",
        "ticket.tags",
        "ticket.requester",
        "ticket.comments",
        "currentUser.name",
      ]);

      // Get agent first name from full name
      const fullName = data["currentUser.name"] || "";
      agentName = fullName.split(" ")[0] || "Support Agent";

      // Get all comments from the ticket conversation
      const rawComments = data["ticket.comments"] || [];
      const comments = rawComments.map(comment => ({
        value: comment.value || comment.body || "",
        author: {
          name: comment.author?.name || "Unknown",
          role: comment.author?.role || "end-user"
        },
        isPublic: comment.public !== false,
        isInternalNote: comment.public === false
      })).filter(c => c.value);

      // Fetch custom fields via REST API (ZAF ticket.customField: only works with text keys,
      // but all these fields have key=None in this Zendesk instance)
      const ticketId = data["ticket.id"];
      const customFields = { hive_order_id: null, shop_order_id: null, hive_shipment_id: null, hive_return_id: null, restocking_shipment_id: null, kitting_id: null, freight_request_id: null };
      try {
        const ticketResp = await client.request({ url: `/api/v2/tickets/${ticketId}.json`, type: "GET" });
        const rawFields = ticketResp.ticket?.custom_fields || [];
        console.log("Raw custom_fields from API:", rawFields.filter(f => f.value !== null));
        for (const field of rawFields) {
          const key = CUSTOM_FIELD_MAP[String(field.id)];
          if (key && field.value && !customFields[key]) {
            customFields[key] = field.value;
          }
        }
      } catch (cfError) {
        console.error("Could not fetch custom fields via API:", cfError.message, cfError);
      }

      ticketData = {
        id: ticketId,
        subject: data["ticket.subject"],
        status: data["ticket.status"],
        priority: data["ticket.priority"],
        tags: data["ticket.tags"] || [],
        requester: data["ticket.requester"],
        comments: comments,
        customFields: customFields,
      };

      console.log("Ticket data loaded:", ticketData);
      console.log("Total comments:", comments.length);
      console.log("Custom fields:", customFields);
    } catch (error) {
      console.error("Error loading ticket data:", error);
      throw new Error("Failed to load ticket data");
    }
  }

  // Fetch and cache macros from Zendesk
  async function loadMacros() {
    if (cachedMacros) {
      console.log("Using cached macros:", cachedMacros.length);
      return cachedMacros;
    }

    try {
      const response = await client.request({
        url: "/api/v2/macros/active.json",
        type: "GET",
      });

      const macros = (response.macros || []).map(macro => {
        const commentAction = macro.actions?.find(a => a.field === "comment_value" || a.field === "comment_value_html");
        return {
          id: macro.id,
          title: macro.title,
          description: macro.description || "",
          content: commentAction?.value || "",
        };
      });

      cachedMacros = macros;
      console.log("Loaded and cached macros:", macros.length);
      return macros;
    } catch (error) {
      console.error("Error loading macros:", error);
      return [];
    }
  }

  // Pre-filter and format macros for API based on ticket context
  function formatMacrosForAPI(macros, ticket) {
    if (!macros || macros.length === 0) return [];

    const ticketText = [
      ticket?.subject || "",
      ...(ticket?.comments || []).map(c => c.value || ""),
    ].join(" ").toLowerCase();

    const scoredMacros = macros.map(m => {
      const macroText = `${m.title} ${m.description || ""}`.toLowerCase();
      let score = 0;
      const keywords = ticketText.split(/\s+/).filter(w => w.length > 4);
      for (const word of keywords) {
        if (macroText.includes(word)) score += 1;
      }
      return { ...m, score };
    });

    const relevantMacros = scoredMacros
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    const macrosToSend = relevantMacros.length > 0
      ? relevantMacros
      : macros.slice(0, 10);

    console.log(`Sending ${macrosToSend.length} relevant macros (of ${macros.length} total)`);

    return macrosToSend.map(m => ({
      id: m.id,
      title: m.title,
      description: m.description ? m.description.substring(0, 100) : "",
      content: m.content ? m.content.substring(0, 500) : "",
    }));
  }

  // Generate copilot response with progressive loading
  async function generateResponse() {
    if (isLoading) {
      console.log("Already loading, ignoring request");
      return;
    }

    isLoading = true;

    // Show sections immediately with loading placeholders
    showContentProgressive();

    chatHistory = [];
    chatMessagesEl.innerHTML = "";

    // Reset translation state
    hideTranslationToggle();
    chatTranslations.clear();

    try {
      if (!ticketData || !ticketData.subject) {
        await loadTicketData();
      }

      const macros = await loadMacros();
      const macrosForAPI = formatMacrosForAPI(macros, ticketData);

      console.log("Sending ticket to API:", ticketData);
      console.log("Including macros:", macrosForAPI.length);

      // ============================================
      // PHASE 1: Context Assembly
      // ============================================
      console.log("Phase 1: Assembling context...");
      const contextResponse = await fetch(`${apiEndpoint}/api/copilot/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: ticketData }),
      });

      if (!contextResponse.ok) {
        const isTimeout = contextResponse.status === 504;
        throw new Error(isTimeout
          ? "Context assembly timed out. Please click Regenerate."
          : "Failed to assemble context. Please click Regenerate."
        );
      }

      const context = await contextResponse.json();
      detectedLanguage = context.detectedLanguage || "en";
      console.log("Context assembled:", context.searchQuery, "Language:", detectedLanguage);

      // ============================================
      // PHASE 2: Summary + Next Steps (parallel)
      // ============================================
      console.log("Phase 2: Generating summary and next steps in parallel...");

      const [summaryResult, nextStepsResult] = await Promise.all([
        fetch(`${apiEndpoint}/api/copilot/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket: ticketData,
            historyContext: context.historyContext,
          }),
        }).then(async (res) => {
          if (!res.ok) throw new Error("Failed to generate summary");
          const data = await res.json();
          // Update UI immediately when summary arrives
          renderText(summaryEl, data.summary || "No summary available.");
          console.log("Summary received and displayed");
          return data;
        }),

        fetch(`${apiEndpoint}/api/copilot/next-steps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket: ticketData,
            notionContext: context.notionContext,
            faqContext: context.faqContext,
            entityContext: context.entityContext || "",
          }),
        }).then(async (res) => {
          if (!res.ok) throw new Error("Failed to generate next steps");
          const data = await res.json();
          // Update UI immediately when next steps arrive
          renderText(nextStepsEl, data.nextSteps || "No next steps available.");
          console.log("Next steps received and displayed");
          return data;
        }),
      ]);

      // ============================================
      // PHASE 3: Response Generation (context chaining)
      // ============================================
      console.log("Phase 3: Generating response using summary...");

      const responseResult = await fetch(`${apiEndpoint}/api/copilot/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket: ticketData,
          summary: summaryResult.summary,
          notionContext: context.notionContext,
          faqContext: context.faqContext,
          historyFormattedContext: context.historyContext?.formattedContext || "",
          agentName: agentName,
          macros: macrosForAPI,
          glossaryContext: context.glossaryContext,
          improvementsContext: context.improvementsContext || "",
          entityContext: context.entityContext || "",
        }),
      });

      if (!responseResult.ok) {
        throw new Error("Failed to generate response");
      }

      const responseData = await responseResult.json();
      const response = stripHtml(responseData.suggestedResponse || "No suggestion available.");
      suggestedResponseEl.textContent = response;
      mainResponseOriginal = response;
      console.log("Response received and displayed");

      // Start background translation if non-English
      if (detectedLanguage !== "en") {
        showTranslationToggle();
        startBackgroundTranslation(response);
      }

      // Store for chat context
      previousSuggestion = `Summary: ${summaryResult.summary || ""}\n\nNext Steps: ${nextStepsResult.nextSteps || ""}\n\nSuggested Response: ${responseData.suggestedResponse || ""}`;
      notionContext = context.combinedContext || "";

      // Display sources
      displaySources(context.sopSources || [], context.faqSources || [], context.searchQuery);

    } catch (error) {
      console.error("Generate response error:", error);
      showError(error.message || "Failed to generate response. Please try again.");
    } finally {
      isLoading = false;
    }
  }

  // Show content area with loading placeholders for progressive loading
  function showContentProgressive() {
    loadingEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    if (adminPanelEl) adminPanelEl.classList.add("hidden");

    // Set loading placeholders - italic and greyed out
    summaryEl.innerHTML = '<span class="loading-text">Loading summary...</span>';
    nextStepsEl.innerHTML = '<span class="loading-text">Loading next steps...</span>';
    suggestedResponseEl.innerHTML = '<span class="loading-text">Generating response...</span>';
    sourcesEl.innerHTML = '<span class="loading-text">Loading sources...</span>';
  }

  // Display sources separately
  function displaySources(sopSources, faqSources, searchQuery) {
    const hasSources = sopSources.length > 0 || faqSources.length > 0;

    sourcesEl.textContent = "";
    if (hasSources) {
      const addGroup = (label, items) => {
        if (!items || items.length === 0) return;
        const group = document.createElement("div");
        group.className = "source-group";
        const lbl = document.createElement("span");
        lbl.className = "source-label";
        lbl.textContent = label;
        group.appendChild(lbl);
        for (const s of items) {
          const safeUrl = sanitizeHttpUrl(s.url);
          if (!safeUrl) continue;
          const a = document.createElement("a");
          a.href = safeUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = s.title || safeUrl;
          group.appendChild(a);
        }
        sourcesEl.appendChild(group);
      };

      addGroup("SOPs:", sopSources);
      addGroup("FAQ:", faqSources);

      if (!sourcesEl.childNodes.length) {
        sourcesEl.textContent = "No usable sources (invalid URLs).";
      }
    } else {
      const p = document.createElement("p");
      p.textContent = searchQuery
        ? `No sources found (searched: "${stripHtml(searchQuery)}")`
        : "No sources found";
      sourcesEl.appendChild(p);
    }
  }

  // Strip HTML tags, entities, and markdown from text
  function stripHtml(text) {
    if (!text) return "";
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p>/gi, '\n\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<p>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&rsquo;/g, "'")
      .replace(/&lsquo;/g, "'")
      .replace(/&rdquo;/g, '"')
      .replace(/&ldquo;/g, '"')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  // Only allow http/https links
  function sanitizeHttpUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  // Render text with **bold** support and bullets/newlines
  function renderText(targetEl, text, preserveBold = false) {
    targetEl.innerHTML = "";
    if (!text) return;

    // Clean HTML entities but preserve **bold** for summary
    let clean = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p>/gi, '\n\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<p>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\\n/g, '\n')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();

    const lines = clean.split(/\n/);
    const bulletLines = lines.filter(l => /^\s*[-*]\s+/.test(l));

    // Helper to render text with **bold** support
    const renderLineWithBold = (line) => {
      const fragment = document.createDocumentFragment();
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      parts.forEach(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
          const bold = document.createElement('strong');
          bold.textContent = part.slice(2, -2);
          fragment.appendChild(bold);
        } else if (part) {
          fragment.appendChild(document.createTextNode(part));
        }
      });
      return fragment;
    };

    if (bulletLines.length && bulletLines.length === lines.filter(l => l.trim().length).length) {
      const ul = document.createElement("ul");
      for (const line of lines) {
        const m = line.match(/^\s*[-*]\s+(.*)$/);
        if (!m) continue;
        const li = document.createElement("li");
        li.appendChild(renderLineWithBold(m[1]));
        ul.appendChild(li);
      }
      targetEl.appendChild(ul);
      return;
    }

    let p = document.createElement("p");
    for (const line of lines) {
      if (!line.trim()) {
        if (p.textContent?.trim() || p.childNodes.length) targetEl.appendChild(p);
        p = document.createElement("p");
        continue;
      }
      if (p.childNodes.length) p.appendChild(document.createElement("br"));
      p.appendChild(renderLineWithBold(line));
    }
    if (p.textContent?.trim() || p.childNodes.length) targetEl.appendChild(p);
  }


  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Insert response into reply box AND track the insertion
  async function insertResponse() {
    const response = suggestedResponseEl.textContent;
    if (response && response !== "No suggestion available." && response !== "Generating response...") {
      // Insert into Zendesk
      await client.invoke("comment.appendText", response);

      // Track the insertion for analytics (fire and forget)
      trackInsertion(response).catch(err => console.error("Failed to track insertion:", err));
    }
  }

  // Track insertion via API for analytics
  async function trackInsertion(suggestedResponse) {
    try {
      await fetch(`${apiEndpoint}/api/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "insert",
          ticketId: ticketData?.id,
          suggestedResponse: suggestedResponse,
          agentEmail: agentEmail,
          agentName: agentName,
        }),
      });
      console.log("Insertion tracked for ticket:", ticketData?.id);
    } catch (error) {
      console.error("Error tracking insertion:", error);
    }
  }

  // Send chat message
  let isChatLoading = false;

  async function sendChatMessage() {
    const message = chatInputEl.value.trim();
    if (!message || isChatLoading) return;

    isChatLoading = true;
    addChatMessage(message, "user");
    chatInputEl.value = "";

    const typingEl = document.createElement("div");
    typingEl.className = "chat-message assistant typing";
    typingEl.textContent = "Thinking...";
    chatMessagesEl.appendChild(typingEl);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    try {
      const response = await fetch(`${apiEndpoint}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: message,
          ticket: ticketData,
          previousMessages: chatHistory,
          notionContext: notionContext,
          previousSuggestion: previousSuggestion,
        }),
      });

      typingEl.remove();

      if (!response.ok) {
        throw new Error("Failed to get chat response");
      }

      const data = await response.json();

      if (data.debug) {
        console.group(`💬 Chat Debug [${data.debug.requestId}]`);
        console.log("Timing:", data.debug.timing);
        console.table(data.debug.logs);
        console.groupEnd();
      }

      addChatMessage(data.response, "assistant");

      chatHistory.push(
        { role: "user", content: message },
        { role: "assistant", content: data.response }
      );
    } catch (error) {
      typingEl.remove();
      addChatMessage("Sorry, I couldn't process that. Please try again.", "assistant");
    } finally {
      isChatLoading = false;
    }
  }

  // Add message to chat display
  function addChatMessage(content, role) {
    const messageEl = document.createElement("div");
    messageEl.className = `chat-message ${role}`;
    const cleanContent = role === "assistant" ? stripHtml(content) : content;
    const messageIndex = chatMessagesEl.children.length;

    if (role === "assistant") {
      const textEl = document.createElement("div");
      textEl.className = "chat-message-text";
      textEl.textContent = cleanContent;
      messageEl.appendChild(textEl);

      const actionsEl = document.createElement("div");
      actionsEl.className = "chat-message-actions";

      const insertBtn = document.createElement("button");
      insertBtn.className = "btn-chat-insert";
      insertBtn.textContent = "Insert";
      insertBtn.onclick = () => insertChatMessage(cleanContent);
      actionsEl.appendChild(insertBtn);

      // Add translation button if non-English
      if (detectedLanguage !== "en") {
        const translateBtn = document.createElement("button");
        translateBtn.className = "btn-chat-translation";
        translateBtn.textContent = "EN";
        translateBtn.onclick = () => toggleChatTranslation(messageIndex, textEl, translateBtn);
        actionsEl.appendChild(translateBtn);

        // Start background translation
        startChatTranslation(messageIndex, cleanContent);
      }

      messageEl.appendChild(actionsEl);
    } else {
      messageEl.textContent = cleanContent;
    }

    chatMessagesEl.appendChild(messageEl);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // Insert chat message into reply box AND track the insertion
  async function insertChatMessage(content) {
    if (content) {
      await client.invoke("comment.appendText", content);

      // Track the insertion for analytics (fire and forget)
      trackInsertion(content).catch(err => console.error("Failed to track chat insertion:", err));
    }
  }

  // Toggle sources visibility
  function toggleSources() {
    sourcesEl.classList.toggle("collapsed");
    const icon = sourcesToggle.querySelector(".toggle-icon");
    icon.textContent = sourcesEl.classList.contains("collapsed") ? "+" : "-";
  }

  // ============================================
  // Translation Functions
  // ============================================

  function showTranslationToggle() {
    const toggleBtn = document.getElementById("translation-toggle");
    if (toggleBtn) {
      toggleBtn.classList.remove("hidden");
      toggleBtn.textContent = "Show English";
    }
  }

  function hideTranslationToggle() {
    const toggleBtn = document.getElementById("translation-toggle");
    if (toggleBtn) {
      toggleBtn.classList.add("hidden");
    }
    const statusEl = document.getElementById("translation-status");
    if (statusEl) {
      statusEl.classList.add("hidden");
    }
    mainResponseTranslation = null;
    showingMainTranslation = false;
    mainResponseOriginal = "";
  }

  async function startBackgroundTranslation(text) {
    mainResponseTranslation = "loading";

    try {
      const response = await fetch(`${apiEndpoint}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          sourceLanguage: detectedLanguage,
        }),
      });

      if (!response.ok) {
        throw new Error("Translation failed");
      }

      const data = await response.json();
      mainResponseTranslation = data.translation;
      console.log("Background translation complete");

      // If user is already waiting to see translation, update display
      if (showingMainTranslation) {
        suggestedResponseEl.textContent = mainResponseTranslation;
        const statusEl = document.getElementById("translation-status");
        if (statusEl) statusEl.classList.add("hidden");
      }

    } catch (error) {
      console.error("Translation error:", error);
      mainResponseTranslation = null;
    }
  }

  function toggleMainTranslation() {
    const toggleBtn = document.getElementById("translation-toggle");
    const statusEl = document.getElementById("translation-status");

    if (mainResponseTranslation === "loading") {
      // Show loading state
      if (statusEl) {
        statusEl.classList.remove("hidden");
        statusEl.innerHTML = '<span class="loading-text">Loading translation...</span>';
      }
      showingMainTranslation = true;
      return;
    }

    if (mainResponseTranslation === null) {
      console.log("No translation available");
      return;
    }

    if (showingMainTranslation) {
      // Switch back to original
      suggestedResponseEl.textContent = mainResponseOriginal;
      if (toggleBtn) toggleBtn.textContent = "Show English";
      showingMainTranslation = false;
    } else {
      // Show translation
      suggestedResponseEl.textContent = mainResponseTranslation;
      if (toggleBtn) toggleBtn.textContent = "Show Original";
      showingMainTranslation = true;
    }

    if (statusEl) statusEl.classList.add("hidden");
  }

  async function startChatTranslation(messageIndex, text) {
    chatTranslations.set(messageIndex, { translation: "loading", showing: false, original: text });

    try {
      const response = await fetch(`${apiEndpoint}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          sourceLanguage: detectedLanguage,
        }),
      });

      if (!response.ok) throw new Error("Translation failed");

      const data = await response.json();
      const entry = chatTranslations.get(messageIndex);
      if (entry) {
        entry.translation = data.translation;
        // If user was waiting, update display
        if (entry.showing && entry.textEl) {
          entry.textEl.textContent = entry.translation;
        }
      }

    } catch (error) {
      console.error("Chat translation error:", error);
      const entry = chatTranslations.get(messageIndex);
      if (entry) {
        entry.translation = null;
      }
    }
  }

  function toggleChatTranslation(messageIndex, textEl, translateBtn) {
    const entry = chatTranslations.get(messageIndex);

    if (!entry) return;

    // Store textEl reference for async update
    entry.textEl = textEl;

    if (entry.translation === "loading") {
      textEl.innerHTML = '<span class="loading-text">Loading translation...</span>';
      entry.showing = true;
      return;
    }

    if (entry.translation === null) {
      console.log("No translation available for message", messageIndex);
      return;
    }

    if (entry.showing) {
      // Switch back to original
      textEl.textContent = entry.original;
      translateBtn.textContent = "EN";
      entry.showing = false;
    } else {
      // Show translation
      textEl.textContent = entry.translation;
      translateBtn.textContent = detectedLanguage.toUpperCase();
      entry.showing = true;
    }
  }

  // UI State helpers
  function showLoading() {
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    contentEl.classList.add("hidden");
    if (adminPanelEl) adminPanelEl.classList.add("hidden");
  }

  function showError(message) {
    loadingEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    if (adminPanelEl) adminPanelEl.classList.add("hidden");
    errorEl.querySelector(".error-message").textContent = message;
  }

  function showContent() {
    loadingEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    if (adminPanelEl) adminPanelEl.classList.add("hidden");
  }

  // Tab navigation
  function switchToTab(tab) {
    if (tab === "copilot") {
      contentEl.classList.remove("hidden");
      if (adminPanelEl) adminPanelEl.classList.add("hidden");
      if (tabCopilotBtn) tabCopilotBtn.classList.add("active");
      if (tabAdminBtn) tabAdminBtn.classList.remove("active");
    } else if (tab === "admin") {
      contentEl.classList.add("hidden");
      if (adminPanelEl) {
        adminPanelEl.classList.remove("hidden");
        loadAdminData();
      }
      if (tabCopilotBtn) tabCopilotBtn.classList.remove("active");
      if (tabAdminBtn) tabAdminBtn.classList.add("active");
    }
  }

  // Load admin panel data
  async function loadAdminData() {
    // Load versions list
    loadInsightVersions();
    // Load users list
    loadUsersList();
  }

  // Load insight versions
  async function loadInsightVersions() {
    const versionsListEl = document.getElementById("versions-list");
    if (!versionsListEl) return;

    try {
      const response = await fetch(`${apiEndpoint}/api/analytics?action=versions&adminEmail=${encodeURIComponent(agentEmail)}`);
      if (!response.ok) throw new Error("Failed to load versions");
      const data = await response.json();

      versionsListEl.innerHTML = "";
      if (data.versions && data.versions.length > 0) {
        data.versions.forEach((version, index) => {
          const item = document.createElement("div");
          item.className = "version-item";

          const infoDiv = document.createElement("div");
          infoDiv.className = "version-info";
          infoDiv.innerHTML = `
            <span class="version-date">${new Date(version.createdAt).toLocaleDateString()}${index === 0 ? ' <em>(current)</em>' : ''}</span>
            <span class="version-count">${version.stats?.insertionsAnalyzed || 0} insertions</span>
          `;
          item.appendChild(infoDiv);

          // Add rollback button for non-current versions
          if (index > 0 && version.id) {
            const rollbackBtn = document.createElement("button");
            rollbackBtn.className = "btn-rollback";
            rollbackBtn.textContent = "Rollback";
            rollbackBtn.title = "Restore this version as the active insights";
            rollbackBtn.onclick = () => rollbackToVersion(version.id, version.createdAt);
            item.appendChild(rollbackBtn);
          }

          versionsListEl.appendChild(item);
        });
      } else {
        versionsListEl.innerHTML = "<p>No insight versions yet.</p>";
      }
    } catch (error) {
      console.error("Error loading versions:", error);
      versionsListEl.innerHTML = "<p>Failed to load versions.</p>";
    }
  }

  // Rollback to a previous insight version
  async function rollbackToVersion(versionId, versionDate) {
    const dateStr = new Date(versionDate).toLocaleDateString();
    if (!confirm(`Are you sure you want to rollback to the version from ${dateStr}? This will replace the current active insights.`)) {
      return;
    }

    try {
      const response = await fetch(`${apiEndpoint}/api/analytics?action=rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetVersion: versionId,
          adminEmail: agentEmail,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to rollback");
      }

      alert("Successfully rolled back to the selected version.");
      // Reload versions to reflect the change
      loadInsightVersions();
    } catch (error) {
      console.error("Error rolling back:", error);
      alert("Failed to rollback: " + error.message);
    }
  }

  // Load users list - fetch ALL Zendesk team members with avatars
  async function loadUsersList() {
    const usersListEl = document.getElementById("users-list");
    if (!usersListEl) return;

    usersListEl.innerHTML = '<span class="loading-text">Loading team members...</span>';

    try {
      // Fetch all team members from Zendesk (agents and admins)
      const [agentsResponse, adminsResponse] = await Promise.all([
        client.request({ url: "/api/v2/users.json?role=agent", type: "GET" }),
        client.request({ url: "/api/v2/users.json?role=admin", type: "GET" }),
      ]);

      // Combine and dedupe by email
      const allUsers = [...(agentsResponse.users || []), ...(adminsResponse.users || [])];
      const uniqueUsers = allUsers.filter((user, index, self) =>
        index === self.findIndex(u => u.email === user.email)
      );

      console.log("Fetched Zendesk team members:", uniqueUsers.length);

      if (uniqueUsers.length === 0) {
        usersListEl.innerHTML = "<p>No team members found.</p>";
        return;
      }

      // Fetch Copilot roles for all users in parallel
      const usersWithRoles = await Promise.all(
        uniqueUsers.map(async (user) => {
          try {
            const roleResponse = await fetch(
              `${apiEndpoint}/api/users?resource=role&email=${encodeURIComponent(user.email)}`
            );
            if (roleResponse.ok) {
              const roleData = await roleResponse.json();
              return { ...user, copilotRole: roleData.role || "agent" };
            }
          } catch (e) {
            console.log(`Could not fetch role for ${user.email}:`, e);
          }
          return { ...user, copilotRole: "agent" }; // Default to agent
        })
      );

      // Sort by role: admins first, then contributors, then agents
      const roleOrder = { admin: 0, contributor: 1, agent: 2 };
      usersWithRoles.sort((a, b) => {
        const orderA = roleOrder[a.copilotRole] ?? 2;
        const orderB = roleOrder[b.copilotRole] ?? 2;
        if (orderA !== orderB) return orderA - orderB;
        // Secondary sort by name
        return (a.name || "").localeCompare(b.name || "");
      });

      usersListEl.innerHTML = "";

      usersWithRoles.forEach(user => {
        const item = document.createElement("div");
        item.className = "user-item";

        // Create avatar
        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        if (user.photo && user.photo.content_url) {
          avatar.style.backgroundImage = `url(${user.photo.content_url})`;
        } else {
          // Use initials as fallback
          const initials = (user.name || user.email || "?")
            .split(" ")
            .map(n => n[0])
            .slice(0, 2)
            .join("")
            .toUpperCase();
          avatar.textContent = initials;
          avatar.classList.add("user-avatar-initials");
        }

        // Create user info
        const userInfo = document.createElement("div");
        userInfo.className = "user-info";
        userInfo.innerHTML = `
          <span class="user-name">${escapeHtml(user.name || "Unknown")}</span>
          <span class="user-email">${escapeHtml(user.email)}</span>
        `;

        // Create role badge/dropdown container
        const roleContainer = document.createElement("div");
        roleContainer.className = "user-role-container";

        // Create role dropdown
        const roleSelect = document.createElement("select");
        roleSelect.className = "user-role-select";
        roleSelect.dataset.email = user.email;
        roleSelect.innerHTML = `
          <option value="agent" ${user.copilotRole === "agent" ? "selected" : ""}>Agent</option>
          <option value="contributor" ${user.copilotRole === "contributor" ? "selected" : ""}>Contributor</option>
          <option value="admin" ${user.copilotRole === "admin" ? "selected" : ""}>Admin</option>
        `;
        roleSelect.addEventListener("change", (e) => updateUserRole(e.target.dataset.email, e.target.value));

        roleContainer.appendChild(roleSelect);

        item.appendChild(avatar);
        item.appendChild(userInfo);
        item.appendChild(roleContainer);
        usersListEl.appendChild(item);
      });

      console.log("Users list rendered with", usersWithRoles.length, "members");
    } catch (error) {
      console.error("Error loading users:", error);
      usersListEl.innerHTML = "<p>Failed to load team members.</p>";
    }
  }

  // Update user role
  async function updateUserRole(email, role) {
    try {
      const response = await fetch(`${apiEndpoint}/api/users?resource=role`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role, adminEmail: agentEmail }),
      });
      if (!response.ok) throw new Error("Failed to update role");
      console.log(`Updated ${email} to ${role}`);
    } catch (error) {
      console.error("Error updating role:", error);
      alert("Failed to update user role");
    }
  }

  // Trigger insights generation
  async function triggerInsights() {
    const btn = document.getElementById("trigger-insights-btn");
    const resultEl = document.getElementById("insights-result");
    if (!btn || !resultEl) return;

    const btnText = btn.querySelector(".btn-text");
    const btnLoading = btn.querySelector(".btn-loading");

    btn.disabled = true;
    if (btnText) btnText.classList.add("hidden");
    if (btnLoading) btnLoading.classList.remove("hidden");

    try {
      const response = await fetch(`${apiEndpoint}/api/analytics?action=weekly-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminEmail: agentEmail }),
      });

      if (!response.ok) throw new Error("Failed to generate insights");
      const data = await response.json();

      resultEl.classList.remove("hidden");
      const statsEl = resultEl.querySelector(".insights-stats");
      const contentEl = resultEl.querySelector(".insights-content");

      if (statsEl) {
        statsEl.innerHTML = `<p>Analyzed ${data.stats?.insertionsAnalyzed || 0} insertions, ${data.stats?.feedbackProcessed || 0} feedback items</p>`;
      }
      if (contentEl) {
        contentEl.innerHTML = `<pre>${escapeHtml(data.insights || "No insights generated")}</pre>`;
      }

      // Reload versions
      loadInsightVersions();
    } catch (error) {
      console.error("Error generating insights:", error);
      alert("Failed to generate insights: " + error.message);
    } finally {
      btn.disabled = false;
      if (btnText) btnText.classList.remove("hidden");
      if (btnLoading) btnLoading.classList.add("hidden");
    }
  }

  // Feedback functions
  async function submitPositiveFeedback() {
    try {
      await fetch(`${apiEndpoint}/api/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "feedback",
          ticketId: ticketData?.id,
          userEmail: agentEmail,
          userName: agentName,
          type: "positive",
        }),
      });

      // Visual feedback
      const thumbsUp = document.getElementById("feedback-thumbs-up");
      if (thumbsUp) {
        thumbsUp.classList.add("selected");
        setTimeout(() => thumbsUp.classList.remove("selected"), 1000);
      }
      console.log("Positive feedback submitted");
    } catch (error) {
      console.error("Error submitting feedback:", error);
    }
  }

  function openFeedbackModal() {
    if (feedbackModal) {
      // Position the popover below the thumbs down button
      const thumbsDownBtn = document.getElementById("feedback-thumbs-down");
      if (thumbsDownBtn) {
        const btnRect = thumbsDownBtn.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

        // Position below the button with a small gap
        feedbackModal.style.top = (btnRect.bottom + scrollTop + 8) + "px";
        feedbackModal.style.right = "12px";
        feedbackModal.style.left = "auto";
      }

      feedbackModal.classList.remove("hidden");
    }
  }

  function closeFeedbackModal() {
    if (feedbackModal) {
      feedbackModal.classList.add("hidden");
      // Reset form
      const issueType = document.getElementById("issue-type");
      const feedbackWrong = document.getElementById("feedback-wrong");
      const feedbackImprove = document.getElementById("feedback-improve");
      const feedbackExample = document.getElementById("feedback-example");
      if (issueType) issueType.value = "";
      if (feedbackWrong) feedbackWrong.value = "";
      if (feedbackImprove) feedbackImprove.value = "";
      if (feedbackExample) feedbackExample.value = "";
    }
  }

  async function submitNegativeFeedback() {
    const issueType = document.getElementById("issue-type")?.value;
    const feedbackWrong = document.getElementById("feedback-wrong")?.value || "";
    const feedbackImprove = document.getElementById("feedback-improve")?.value || "";
    const feedbackExample = document.getElementById("feedback-example")?.value || "";

    if (!issueType) {
      alert("Please select an issue type");
      return;
    }

    // Combine all feedback into a single comment for the API
    const commentParts = [];
    if (feedbackWrong) commentParts.push(`What was wrong: ${feedbackWrong}`);
    if (feedbackImprove) commentParts.push(`How to improve: ${feedbackImprove}`);
    if (feedbackExample) commentParts.push(`Example response: ${feedbackExample}`);
    const comment = commentParts.join("\n\n") || "No details provided";

    try {
      await fetch(`${apiEndpoint}/api/tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "feedback",
          ticketId: ticketData?.id,
          userEmail: agentEmail,
          userName: agentName,
          type: "negative",
          issueType: issueType,
          comment: comment,
        }),
      });

      closeFeedbackModal();
      console.log("Negative feedback submitted");
    } catch (error) {
      console.error("Error submitting feedback:", error);
      alert("Failed to submit feedback");
    }
  }

  // Toggle collapsible sections
  function toggleSection(toggleEl, contentEl) {
    if (!toggleEl || !contentEl) return;
    contentEl.classList.toggle("collapsed");
    const icon = toggleEl.querySelector(".toggle-icon");
    if (icon) {
      icon.textContent = contentEl.classList.contains("collapsed") ? "+" : "-";
    }
  }

  // Event Listeners
  document.getElementById("insert-btn")?.addEventListener("click", insertResponse);
  document.getElementById("regenerate-btn")?.addEventListener("click", generateResponse);
  document.getElementById("retry-btn")?.addEventListener("click", generateResponse);
  document.getElementById("send-btn")?.addEventListener("click", sendChatMessage);
  sourcesToggle?.addEventListener("click", toggleSources);

  // Translation toggle
  document.getElementById("translation-toggle")?.addEventListener("click", toggleMainTranslation);

  // Tab navigation
  tabCopilotBtn?.addEventListener("click", () => switchToTab("copilot"));
  tabAdminBtn?.addEventListener("click", () => switchToTab("admin"));

  // Feedback buttons
  document.getElementById("feedback-thumbs-up")?.addEventListener("click", submitPositiveFeedback);
  document.getElementById("feedback-thumbs-down")?.addEventListener("click", openFeedbackModal);

  // Feedback modal
  document.getElementById("modal-close")?.addEventListener("click", closeFeedbackModal);
  document.getElementById("modal-cancel")?.addEventListener("click", closeFeedbackModal);
  document.getElementById("modal-submit")?.addEventListener("click", submitNegativeFeedback);
  document.querySelector(".modal-overlay")?.addEventListener("click", closeFeedbackModal);

  // Admin panel
  document.getElementById("trigger-insights-btn")?.addEventListener("click", triggerInsights);

  // Admin collapsible sections
  document.getElementById("versions-toggle")?.addEventListener("click", function() {
    toggleSection(this, document.getElementById("versions-list"));
  });
  document.getElementById("users-toggle")?.addEventListener("click", function() {
    toggleSection(this, document.getElementById("users-list"));
  });

  // Chat input
  chatInputEl?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  });

  // Keyboard shortcut: Cmd+Enter to insert response
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      insertResponse();
    }
  });

  // Start the app
  init();
})();
