/**
 * Hive MCP Integration
 * Fetches entity context (orders, shipments, returns, restocking) via Hive's MCP server
 */

const HIVE_MCP_URL = "https://app.hive.app/mcp";
const HIVE_MCP_TOKEN = process.env.HIVE_MCP_TOKEN?.trim();

let _requestId = 1;

/**
 * Call a Hive MCP tool via JSON-RPC
 */
async function callTool(name, args, logger = null) {
  if (!HIVE_MCP_TOKEN) {
    throw new Error("HIVE_MCP_TOKEN environment variable is not set");
  }

  const id = _requestId++;

  logger?.log("hive", `Calling tool: ${name}`, { args });

  const response = await fetch(HIVE_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HIVE_MCP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Hive MCP HTTP error: ${response.status}`);
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(`Hive MCP tool error: ${result.error.message}`);
  }

  // MCP returns content as array of text blocks
  const content = result.result?.content;
  if (!content || content.length === 0) return null;

  // If the tool returned an error, throw so callers can handle it
  if (result.result?.isError) {
    const errText = content.map((c) => c.text || "").join("");
    throw new Error(`Hive MCP tool error: ${errText}`);
  }

  const text = content.map((c) => c.text || "").join("");

  try {
    const parsed = JSON.parse(text);
    // MCP sometimes returns {"error": "..."} as a normal response (isError=false)
    if (parsed && typeof parsed === "object" && parsed.error && !parsed.id) {
      throw new Error(`Hive MCP tool error: ${parsed.error}`);
    }
    return parsed;
  } catch (e) {
    if (e.message.startsWith("Hive MCP")) throw e;
    return text;
  }
}

/**
 * Resolve merchant_id from the Zendesk ticket ID.
 * Falls back to requester email if ticket lookup fails.
 */
async function resolveMerchant(ticket, logger = null) {
  const ticketId = ticket.id;

  // Try ticket-based lookup first
  if (ticketId) {
    try {
      const result = await callTool("get_merchant_from_ticket", { ticket_id: String(ticketId) }, logger);
      const merchantId = result?.merchant_id || result?.id;
      if (merchantId) {
        logger?.log("hive", "Merchant resolved from ticket", { ticketId, merchantId });
        return String(merchantId);
      }
    } catch (error) {
      logger?.log("error", "Failed to resolve merchant from ticket", { error: error.message });
    }
  }

  // Fallback: resolve from requester email
  const email = ticket.requester?.email;
  if (email) {
    try {
      const result = await callTool("get_merchant_from_email", { email: String(email) }, logger);
      const merchantId = result?.merchant_id || result?.id;
      if (merchantId) {
        logger?.log("hive", "Merchant resolved from email fallback", { email, merchantId });
        return String(merchantId);
      }
    } catch (error) {
      logger?.log("error", "Failed to resolve merchant from email", { error: error.message });
    }
  }

  logger?.log("hive", "Could not resolve merchant from ticket or email");
  return null;
}

/**
 * Format order data for LLM context
 */
function formatOrderForLLM(order) {
  const lines = [
    "## Order Information",
    `- Order ID: ${order.id || "N/A"}`,
    `- Reference: ${order.external_order_name || order.customer_facing_order_name || "N/A"}`,
    `- Internal Status: ${order.internal_status || order.status || "N/A"}`,
    `- Fulfillment Status: ${order.fulfillment_status || "N/A"}`,
    `- Financial Status: ${order.financial_status || "N/A"}`,
    `- Order Type: ${order.order_type || "N/A"}`,
    `- Created: ${order.created_at ? new Date(order.created_at).toLocaleDateString() : "N/A"}`,
  ];

  if (order.shipping_address) {
    const a = order.shipping_address;
    lines.push(`- Recipient: ${[a.name, a.city, a.country_code || a.country].filter(Boolean).join(", ")}`);
  }

  if (order.eta) {
    const eta = order.eta.estimated_delivery_date || order.eta.latest_delivery_date;
    if (eta) lines.push(`- Estimated Delivery: ${eta}`);
  }

  if (order.issues?.length > 0) {
    lines.push(`- Blocking Issues:`);
    for (const issue of order.issues) {
      lines.push(`  • ${issue.description || issue.type || "Unknown issue"}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format shipment data for LLM context
 */
function formatShipmentForLLM(shipment, status) {
  const lines = [
    "## Shipment Information",
    `- Shipment ID: ${shipment.id || "N/A"}`,
    `- Carrier: ${shipment.carrier || "N/A"}`,
    `- Tracking Code: ${shipment.tracking_code || "N/A"}`,
    `- Status: ${shipment.fulfillment_status || "N/A"}`,
    `- Delivery Status: ${shipment.delivery_status || "N/A"}`,
  ];

  if (status?.latest_event) {
    const evt = status.latest_event;
    const when = evt.timestamp ? ` (${new Date(evt.timestamp).toLocaleString()})` : "";
    lines.push(`- Latest Tracking: ${evt.description || evt.status || "N/A"}${when}`);
  }

  return lines.join("\n");
}

/**
 * Format return data for LLM context
 */
function formatReturnForLLM(ret) {
  const lines = [
    "## Return Information",
    `- Return ID: ${ret.id || "N/A"}`,
    `- Status: ${ret.status || "N/A"}`,
    `- Created: ${ret.created_at ? new Date(ret.created_at).toLocaleDateString() : "N/A"}`,
  ];

  if (ret.items?.length > 0) {
    lines.push(`- Items: ${ret.items.map((i) => i.merchant_sku || i.name || "Unknown").join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Format restocking shipment for LLM context
 */
function formatRestockingForLLM(restock) {
  const lines = [
    "## Restocking Shipment",
    `- ID: ${restock.id || "N/A"}`,
    `- Status: ${restock.status || "N/A"}`,
    `- Expected Arrival: ${restock.expected_arrival || restock.expected_arrival_date || "N/A"}`,
  ];

  const issues = restock.inbound_issues || restock.discrepancies;
  if (issues?.length > 0) {
    lines.push(`- Inbound Issues: ${issues.length} item(s) flagged`);
  }

  return lines.join("\n");
}

/**
 * Fetch all entity context from Hive MCP based on ticket data
 * Fetches order/shipment/return/restocking context from the Hive MCP
 */
async function fetchEntityContext(ticket, logger = null) {
  const customFields = ticket?.customFields || {};
  const results = { entityContext: "", entitySources: [] };

  // Step 1: Resolve merchant from requester email + tags
  const merchantId = await resolveMerchant(ticket, logger);
  if (!merchantId) {
    logger?.log("hive", "Could not resolve merchant — skipping entity context");
    return results;
  }

  const contextParts = [];

  // Fetch all available entities in parallel
  const fetches = [];

  // Helper: reject placeholder values like "-", "N/A", etc.
  const isValidId = (v) => v && String(v).trim().length > 1 && String(v).trim() !== "-";

  const orderId = customFields.hive_order_id;
  if (isValidId(orderId)) {
    fetches.push(
      callTool("get_order", { merchant_id: merchantId, order_id: orderId }, logger)
        .then((order) => {
          if (order) {
            contextParts.push(formatOrderForLLM(order));
            results.entitySources.push({ type: "order", id: orderId, name: order.external_order_name || orderId });
          }
        })
        .catch((err) => logger?.log("error", "Order fetch failed", { error: err.message }))
    );
  }

  const shipmentId = customFields.hive_shipment_id;
  if (isValidId(shipmentId)) {
    fetches.push(
      Promise.all([
        callTool("get_shipment", { merchant_id: merchantId, shipment_id: shipmentId }, logger),
        callTool("get_shipment_status", { merchant_id: merchantId, shipment_id: shipmentId }, logger),
      ])
        .then(([shipment, status]) => {
          if (shipment) {
            contextParts.push(formatShipmentForLLM(shipment, status));
            results.entitySources.push({ type: "shipment", id: shipmentId });
          }
        })
        .catch((err) => logger?.log("error", "Shipment fetch failed", { error: err.message }))
    );
  }

  const returnId = customFields.hive_return_id;
  if (isValidId(returnId)) {
    fetches.push(
      callTool("get_return", { merchant_id: merchantId, return_id: returnId }, logger)
        .then((ret) => {
          if (ret) {
            contextParts.push(formatReturnForLLM(ret));
            results.entitySources.push({ type: "return", id: returnId });
          }
        })
        .catch((err) => logger?.log("error", "Return fetch failed", { error: err.message }))
    );
  }

  const restockingId = customFields.restocking_shipment_id;
  if (isValidId(restockingId)) {
    fetches.push(
      callTool("get_restocking_shipment", { merchant_id: merchantId, restocking_shipment_id: restockingId }, logger)
        .then((restock) => {
          if (restock) {
            contextParts.push(formatRestockingForLLM(restock));
            results.entitySources.push({ type: "restocking", id: restockingId });
          }
        })
        .catch((err) => logger?.log("error", "Restocking fetch failed", { error: err.message }))
    );
  }

  await Promise.all(fetches);

  results.entityContext = contextParts.join("\n\n---\n\n");

  logger?.log("hive", "Entity context assembled", {
    merchantId,
    sources: results.entitySources.length,
    contextLength: results.entityContext.length,
  });

  return results;
}

module.exports = {
  fetchEntityContext,
  resolveMerchant,
  callTool,
};
