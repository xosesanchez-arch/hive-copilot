(function () {
  "use strict";

  // State
  let client;
  let apiEndpoint;
  let ticketData = null;
  let chatHistory = [];
  let notionContext = "";

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

  // Initialize
  async function init() {
    try {
      client = ZAFClient.init();

      // Get app settings
      const metadata = await client.metadata();
      apiEndpoint = metadata.settings.apiEndpoint;

      if (!apiEndpoint) {
        throw new Error("API endpoint not configured. Please set it in app settings.");
      }

      // Resize app
      await client.invoke("resize", { width: "100%", height: "600px" });

      // Fetch ticket data and generate response
      await loadTicketData();
      await generateResponse();
    } catch (error) {
      showError(error.message);
    }
  }

  // Fetch ticket data from Zendesk
  async function loadTicketData() {
    const data = await client.get([
      "ticket.id",
      "ticket.subject",
      "ticket.status",
      "ticket.priority",
      "ticket.tags",
      "ticket.requester",
      "ticket.comments",
    ]);

    ticketData = {
      id: data["ticket.id"],
      subject: data["ticket.subject"],
      status: data["ticket.status"],
      priority: data["ticket.priority"],
      tags: data["ticket.tags"],
      requester: data["ticket.requester"],
      comments: data["ticket.comments"],
    };
  }

  // Generate copilot response
  async function generateResponse() {
    showLoading();

    try {
      const response = await fetch(`${apiEndpoint}/api/copilot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ticket: ticketData }),
      });

      if (!response.ok) {
        throw new Error("Failed to get copilot response");
      }

      const data = await response.json();
      displayResponse(data);
    } catch (error) {
      showError(error.message);
    }
  }

  // Display the copilot response
  function displayResponse(data) {
    summaryEl.innerHTML = formatContent(data.summary || "No summary available.");
    nextStepsEl.innerHTML = formatContent(data.nextSteps || "No next steps available.");
    suggestedResponseEl.textContent = data.suggestedResponse || "No suggestion available.";

    // Display sources
    if (data.sources && data.sources.length > 0) {
      sourcesEl.innerHTML = data.sources
        .map((s) => `<a href="${s.url}" target="_blank">${escapeHtml(s.title)}</a>`)
        .join("");
    } else {
      sourcesEl.innerHTML = "<p>No sources found</p>";
    }

    showContent();
  }

  // Format content (simple markdown-like formatting)
  function formatContent(text) {
    if (!text) return "";

    // Convert bullet points
    text = text.replace(/^[-*]\s+/gm, "<li>");
    text = text.replace(/(<li>.*?)(?=<li>|$)/gs, "$1</li>");

    // Wrap lists
    if (text.includes("<li>")) {
      text = "<ul>" + text + "</ul>";
    }

    // Convert line breaks
    text = text.replace(/\n\n/g, "</p><p>");
    text = text.replace(/\n/g, "<br>");

    // Wrap in paragraph if not a list
    if (!text.startsWith("<ul>")) {
      text = "<p>" + text + "</p>";
    }

    return text;
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Insert response into reply box
  async function insertResponse() {
    const response = suggestedResponseEl.textContent;
    if (response && response !== "No suggestion available.") {
      await client.invoke("comment.appendText", response);
    }
  }

  // Send chat message
  async function sendChatMessage() {
    const message = chatInputEl.value.trim();
    if (!message) return;

    // Add user message to chat
    addChatMessage(message, "user");
    chatInputEl.value = "";

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
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get chat response");
      }

      const data = await response.json();
      addChatMessage(data.response, "assistant");

      // Update chat history
      chatHistory.push(
        { role: "user", content: message },
        { role: "assistant", content: data.response }
      );
    } catch (error) {
      addChatMessage("Sorry, I couldn't process that. Please try again.", "assistant");
    }
  }

  // Add message to chat display
  function addChatMessage(content, role) {
    const messageEl = document.createElement("div");
    messageEl.className = `chat-message ${role}`;
    messageEl.textContent = content;
    chatMessagesEl.appendChild(messageEl);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // Toggle sources visibility
  function toggleSources() {
    sourcesEl.classList.toggle("collapsed");
    const icon = sourcesToggle.querySelector(".toggle-icon");
    icon.textContent = sourcesEl.classList.contains("collapsed") ? "+" : "-";
  }

  // UI State helpers
  function showLoading() {
    loadingEl.classList.remove("hidden");
    errorEl.classList.add("hidden");
    contentEl.classList.add("hidden");
  }

  function showError(message) {
    loadingEl.classList.add("hidden");
    errorEl.classList.remove("hidden");
    contentEl.classList.add("hidden");
    errorEl.querySelector(".error-message").textContent = message;
  }

  function showContent() {
    loadingEl.classList.add("hidden");
    errorEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
  }

  // Event Listeners
  document.getElementById("insert-btn").addEventListener("click", insertResponse);
  document.getElementById("regenerate-btn").addEventListener("click", generateResponse);
  document.getElementById("retry-btn").addEventListener("click", generateResponse);
  document.getElementById("send-btn").addEventListener("click", sendChatMessage);
  sourcesToggle.addEventListener("click", toggleSources);

  chatInputEl.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  });

  // Start the app
  init();
})();
