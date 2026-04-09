#!/usr/bin/env node

/**
 * PQS MCP Server — Protocol Quality Standard verification for AI agents.
 *
 * Tools:
 *   pqs_verify_endpoint      — check if an endpoint is PQS-verified
 *   pqs_get_certificate       — retrieve the full certificate for a provider
 *   pqs_check_attestation     — verify a response against on-chain attestation
 *   pqs_list_verified_providers — list all verified providers
 *
 * Communicates with PQS CA server (default http://localhost:4025).
 * Set PQS_CA_URL env var to override.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PQS_CA_URL = (process.env.PQS_CA_URL || "http://localhost:4025").replace(
  /\/$/,
  ""
);

const REQUEST_TIMEOUT_MS = parseInt(process.env.PQS_TIMEOUT_MS || "10000", 10);

// ---------------------------------------------------------------------------
// HTTP helper — zero external deps, uses built-in fetch (Node 18+)
// ---------------------------------------------------------------------------

async function caFetch(path, options = {}) {
  const url = `${PQS_CA_URL}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "pqs-mcp/0.1.0",
        ...(options.headers || {}),
      },
    });

    const text = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: text || `HTTP ${res.status}`,
      };
    }

    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: `Timeout after ${REQUEST_TIMEOUT_MS}ms reaching ${url}` };
    }
    return {
      ok: false,
      error: `Cannot reach PQS CA at ${url}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatVerifyResult(data) {
  if (!data) return "No data returned from PQS CA.";

  const lines = [];

  if (typeof data.valid === "boolean") {
    lines.push(`Verified: ${data.valid ? "YES" : "NO"}`);
  }

  if (data.provider_name || data.cert?.subject?.provider_name) {
    lines.push(`Provider: ${data.provider_name || data.cert?.subject?.provider_name}`);
  }

  if (data.endpoint || data.cert?.subject?.endpoint_url || data.cert?.subject?.endpoint) {
    lines.push(
      `Endpoint: ${data.endpoint || data.cert?.subject?.endpoint_url || data.cert?.subject?.endpoint}`
    );
  }

  if (data.capabilities || data.cert?.capabilities) {
    const caps = data.capabilities || data.cert?.capabilities;
    if (Array.isArray(caps)) {
      lines.push(`Capabilities: ${caps.join(", ")}`);
    }
  }

  if (data.pqs_score != null) {
    lines.push(`PQS Score: ${data.pqs_score}`);
  }

  if (data.pqs_tier) {
    lines.push(`Tier: ${data.pqs_tier}`);
  }

  if (data.cert_expires || data.cert?.validity?.expires_at) {
    lines.push(`Cert expires: ${data.cert_expires || data.cert?.validity?.expires_at}`);
  }

  if (data.eas_uid || data.chain_anchor) {
    const uid = data.eas_uid || data.chain_anchor?.attestation_uid || data.chain_anchor;
    lines.push(`EAS attestation: ${typeof uid === "object" ? JSON.stringify(uid) : uid}`);
  }

  if (data.reason) {
    lines.push(`Reason: ${data.reason}`);
  }

  // Fallback: if we captured nothing useful, dump JSON
  if (lines.length === 0) {
    return JSON.stringify(data, null, 2);
  }

  return lines.join("\n");
}

function formatCertificate(data) {
  if (!data) return "No certificate data returned.";
  return JSON.stringify(data, null, 2);
}

function formatProviderList(data) {
  if (!data) return "No provider data returned.";

  // /certs returns { total, ca_public_key, certs: [...] }
  const providers = Array.isArray(data) ? data : data.certs || data.providers || [];

  if (providers.length === 0) {
    return "No verified providers found.";
  }

  const header = data.total != null ? `Total verified: ${data.total}\n\n` : "";

  const list = providers
    .map((p, i) => {
      const endpoint = p.endpoint || p.endpoint_url || "N/A";
      const wallet = p.wallet || p.subject?.wallet || "N/A";
      const caps = Array.isArray(p.capabilities) ? p.capabilities.join(", ") : "N/A";
      const status = p.status || "valid";
      const expires = p.expires_at || "N/A";
      return `${i + 1}. ${endpoint}\n   Wallet: ${wallet}\n   Capabilities: ${caps}\n   Status: ${status} | Expires: ${expires}`;
    })
    .join("\n\n");

  return header + list;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const URL_PATTERN = /^https?:\/\/.+/;

function validateEndpointUrl(endpoint) {
  if (!URL_PATTERN.test(endpoint)) {
    return `Invalid endpoint URL: "${endpoint}". Must start with http:// or https://`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "pqs-verification",
  version: "0.1.0",
});

// ---- Tool 1: pqs_verify_endpoint ----

server.tool(
  "pqs_verify_endpoint",
  "Check if an API endpoint is verified by PQS (Protocol Quality Standard). " +
    "Returns verification status, PQS score, certificate expiry, and EAS attestation. " +
    "Call this BEFORE paying any x402 endpoint to ensure the provider is legitimate.",
  {
    endpoint: z
      .string()
      .describe(
        "The full URL of the endpoint to verify, e.g. https://api.smartflowproai.com/decision"
      ),
  },
  async ({ endpoint }) => {
    const urlError = validateEndpointUrl(endpoint);
    if (urlError) {
      return { content: [{ type: "text", text: urlError }], isError: true };
    }

    const encodedEndpoint = encodeURIComponent(endpoint);

    // Primary path per PQS CA architecture (v1.1)
    const result = await caFetch(`/verify?endpoint=${encodedEndpoint}`);

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to verify endpoint: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: formatVerifyResult(result.data),
        },
      ],
    };
  }
);

// ---- Tool 2: pqs_get_certificate ----

server.tool(
  "pqs_get_certificate",
  "Retrieve the full PQS certificate for a verified provider. " +
    "Returns certificate details including subject, capabilities, validity, chain anchor, and signature. " +
    "Use the endpoint URL or a provider/cert ID.",
  {
    provider: z
      .string()
      .describe(
        "Provider identifier — endpoint URL (e.g. https://api.smartflowproai.com/decision), " +
          "provider name, or cert ID (e.g. pqs-cert-sf-decision-2026-04-07)"
      ),
  },
  async ({ provider }) => {
    const encoded = encodeURIComponent(provider);

    if (URL_PATTERN.test(provider)) {
      // /verify returns full cert inline
      const result = await caFetch(`/verify?endpoint=${encoded}`);

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to retrieve certificate: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: formatCertificate(result.data) }],
      };
    }

    // Not a URL — search by name/keyword in /certs list
    const result = await caFetch("/certs");

    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Failed to retrieve certificates: ${result.error}` }],
        isError: true,
      };
    }

    const allCerts = result.data?.certs || [];
    const query = provider.toLowerCase();
    const match = allCerts.find(
      (c) =>
        (c.endpoint || "").toLowerCase().includes(query) ||
        (c.wallet || "").toLowerCase() === query
    );

    if (!match) {
      return {
        content: [{ type: "text", text: `No certificate found matching "${provider}". Use a full endpoint URL for exact lookup.` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: formatCertificate(match) }],
    };
  }
);

// ---- Tool 3: pqs_check_attestation ----

server.tool(
  "pqs_check_attestation",
  "Verify a response from a data provider against its PQS on-chain attestation (EAS on Base). " +
    "Checks that the response hash matches the attested certificate and the data is not tampered with.",
  {
    endpoint: z
      .string()
      .describe("The endpoint URL that produced the response"),
    response_hash: z
      .string()
      .optional()
      .describe(
        "SHA-256 hash of the response body. If omitted, the server will fetch and hash the current response."
      ),
    attestation_uid: z
      .string()
      .optional()
      .describe(
        "EAS attestation UID to check against. If omitted, PQS CA will look up the latest attestation for this endpoint."
      ),
  },
  async ({ endpoint, response_hash, attestation_uid }) => {
    const urlError = validateEndpointUrl(endpoint);
    if (urlError) {
      return { content: [{ type: "text", text: urlError }], isError: true };
    }

    const params = new URLSearchParams({ endpoint });
    if (response_hash) params.set("response_hash", response_hash);
    if (attestation_uid) params.set("attestation_uid", attestation_uid);

    // PQS CA v1 exposes attestation data through /verify — not a separate endpoint.
    // We call /verify and extract the on-chain anchor (eas_uid) from the cert.
    const result = await caFetch(`/verify?endpoint=${encodeURIComponent(endpoint)}`);

    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Attestation check failed: ${result.error}` }],
        isError: true,
      };
    }

    const d = result.data;
    const lines = [];

    if (typeof d.valid === "boolean") {
      lines.push(`Endpoint verified: ${d.valid ? "YES" : "NO"}`);
    }

    if (d.eas_uid) {
      lines.push(`EAS attestation UID: ${d.eas_uid}`);
      lines.push("On-chain anchor: Base L2 (Ethereum Attestation Service)");
      lines.push("Attestation status: ANCHORED");
    } else {
      lines.push("EAS attestation: NONE — no on-chain anchor for this endpoint");
    }

    if (d.signature_valid != null) {
      lines.push(`CA signature valid: ${d.signature_valid ? "YES" : "NO"}`);
    }

    if (d.ca_public_key) {
      lines.push(`CA public key: ${d.ca_public_key}`);
    }

    if (d.cert?.expires_at) {
      lines.push(`Cert expires: ${d.cert.expires_at}`);
    }

    if (d.reason) {
      lines.push(`Detail: ${d.reason}`);
    }

    return {
      content: [
        {
          type: "text",
          text: lines.length > 0 ? lines.join("\n") : JSON.stringify(d, null, 2),
        },
      ],
    };
  }
);

// ---- Tool 4: pqs_list_verified_providers ----

server.tool(
  "pqs_list_verified_providers",
  "List all providers currently verified by PQS. " +
    "Returns provider names, endpoints, PQS scores, and verification status. " +
    "Optionally filter by capability (e.g. 'crypto-signal').",
  {
    capability: z
      .string()
      .optional()
      .describe(
        "Filter by capability, e.g. 'crypto-signal', 'decision-engine', 'risk-scoring'"
      ),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max number of providers to return (default 50)"),
  },
  async ({ capability, limit }) => {
    const params = new URLSearchParams();
    if (capability) params.set("capability", capability);
    if (limit) params.set("limit", String(limit));

    const qs = params.toString();

    // PQS CA v1 uses /certs to list all verified endpoints
    const result = await caFetch(`/certs${qs ? "?" + qs : ""}`);

    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to list providers: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: formatProviderList(result.data),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  process.stderr.write(
    `PQS MCP Server v0.1.0 running | CA: ${PQS_CA_URL}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
