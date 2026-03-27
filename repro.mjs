/**
 * Minimal reproduction: StreamableHTTPServerTransport.close() does not close
 * the underlying Node.js TCP socket for SSE GET connections.
 *
 * Run: npm install && node repro.mjs
 *
 * Expected: after transport.close(), active sockets should decrease
 * Actual: sockets keep growing, never decrease from close()
 */

import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

const PORT = 3456;
const transports = new Map();

function countSockets() {
  return process
    .getActiveResourcesInfo()
    .filter((r) => r === "TCPSocketWrap").length;
}

async function createSession() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const server = new Server({ name: "repro", version: "1.0" });
  await server.connect(transport);
  return transport;
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method === "GET" || req.method === "DELETE")
      return resolve(undefined);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const httpServer = createServer(async (req, res) => {
  const body = await parseBody(req);
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, body);
    return;
  }

  const transport = await createSession();
  transports.set(transport.sessionId, transport);
  await transport.handleRequest(req, res, body);
});

// Use http.request to open an SSE GET — no connection pooling
function openSSEConnection(sessionId) {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: "localhost",
        port: PORT,
        path: "/",
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "mcp-session-id": sessionId,
        },
      },
      (res) => {
        // Keep the response open (SSE stream)
        resolve({ req, res });
      },
    );
    req.end();
  });
}

async function initializeSession() {
  const res = await fetch(`http://localhost:${PORT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "repro-client", version: "1.0" },
      },
    }),
  });

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) {
    const body = await res.text();
    throw new Error(`No session ID returned. Status: ${res.status}, Body: ${body}`);
  }
  return sessionId;
}

httpServer.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log("");
  runTest();
});

async function runTest() {
  const initialSockets = countSockets();
  console.log(`Initial sockets: ${initialSockets}`);

  // Create 5 sessions with SSE GET connections
  const NUM_SESSIONS = 5;
  console.log(`\nCreating ${NUM_SESSIONS} MCP sessions (initialize + SSE GET)...`);
  const sessions = [];

  for (let i = 0; i < NUM_SESSIONS; i++) {
    const sessionId = await initializeSession();
    const sse = await openSSEConnection(sessionId);
    sessions.push({ sessionId, sse });
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterOpen = countSockets();
  console.log(`Sockets after ${NUM_SESSIONS} sessions: ${afterOpen} (+${afterOpen - initialSockets})`);

  // Close all transports (simulates session TTL eviction)
  console.log(`\nCalling transport.close() on all ${NUM_SESSIONS} transports...`);
  for (const { sessionId } of sessions) {
    const transport = transports.get(sessionId);
    if (transport) {
      await transport.close();
      transports.delete(sessionId);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterClose = countSockets();
  console.log(`Sockets after transport.close(): ${afterClose}`);

  const leaked = afterClose - initialSockets;
  if (leaked > 0) {
    console.log(`\n>>> BUG: ${leaked} sockets leaked!`);
    console.log(">>> transport.close() did not close the underlying TCP sockets.");
    console.log(">>> The SSE GET connections remain open after the transport is closed.");
  } else {
    console.log("\nOK: All sockets were properly closed.");
  }

  // Destroy client-side sockets to prove they were alive
  console.log("\nDestroying client-side sockets manually...");
  for (const { sse } of sessions) {
    sse.req.destroy();
  }

  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterDestroy = countSockets();
  console.log(`Sockets after client destroy: ${afterDestroy}`);

  console.log("\n=== Summary ===");
  console.log(`  Initial:                 ${initialSockets} sockets`);
  console.log(`  After ${NUM_SESSIONS} sessions:        ${afterOpen} sockets`);
  console.log(`  After transport.close(): ${afterClose} sockets (expected: ~${initialSockets})`);
  console.log(`  After client destroy:    ${afterDestroy} sockets`);

  httpServer.close();
  process.exit(0);
}
