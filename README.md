# MCP SDK Socket Leak: `StreamableHTTPServerTransport.close()` does not close TCP sockets

## Bug

When `StreamableHTTPServerTransport.close()` is called, the underlying Node.js TCP sockets are not closed. SSE GET connections remain open indefinitely after the transport is closed.

This affects any server that creates and destroys multiple transports over time — which is the [recommended pattern](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) from the SDK's own examples.

## Reproduction

```bash
npm install
node repro.mjs
```

### Output

```
Server listening on http://localhost:3456

Initial sockets: 0

Creating 5 MCP sessions (initialize + SSE GET)...
Sockets after 5 sessions: 11 (+11)

Calling transport.close() on all 5 transports...
Sockets after transport.close(): 11

>>> BUG: 11 sockets leaked!
>>> transport.close() did not close the underlying TCP sockets.
>>> The SSE GET connections remain open after the transport is closed.

Destroying client-side sockets manually...
Sockets after client destroy: 1

=== Summary ===
  Initial:                 0 sockets
  After 5 sessions:        11 sockets
  After transport.close(): 11 sockets (expected: ~0)
  After client destroy:    1 sockets
```

## What the repro does

1. Starts an HTTP server
2. Creates 5 MCP sessions (POST `initialize` + GET SSE stream per session) — the standard MCP Streamable HTTP flow
3. Calls `transport.close()` on all 5 transports — simulating session cleanup/eviction
4. Counts TCP sockets — **unchanged**, the sockets are still alive
5. Destroys sockets from the client side — they drop, proving they were real open connections

## Root cause

`StreamableHTTPServerTransport` is a thin wrapper around `WebStandardStreamableHTTPServerTransport`, bridged to Node.js via `@hono/node-server`'s `getRequestListener`.

When `close()` is called, the chain is:

```
StreamableHTTPServerTransport.close()
  → WebStandardStreamableHTTPServerTransport.close()
    → _streamMapping.forEach(({ cleanup }) => cleanup())
      → streamController.close()  // closes the Web Standard ReadableStreamController
```

The `ReadableStreamController.close()` ends the Web Standard stream, but `@hono/node-server` does not propagate this to the Node.js `ServerResponse`. The `res.end()` / `res.socket.destroy()` is never called. The TCP socket stays open.

## Impact

For the typical single-server-per-process usage, this is invisible — the socket is cleaned up when the process exits.

For servers that manage multiple sessions (the pattern shown in the SDK's own `simpleStreamableHttp.ts` example), sockets accumulate over time:

- Each session with an SSE GET connection leaves a zombie socket after `transport.close()`
- The sockets are only cleaned up when the **client** disconnects or a load balancer timeout fires
- In a long-running server handling many sessions, this leads to thousands of leaked sockets and eventual OOM

### Production data

On our multi-tenant MCP proxy (~60 sessions/min, 30-min TTL):

| Time | Active TCP sockets |
|---|---|
| Container start | 46 |
| +20 min | 437 |
| +38 min | 590 |
| +16 hours | 1,480 |
| Before OOM (RSS: 2,006 MB / 2,048 MB limit) | 1,321 |

## Suggested fix

The Node.js wrapper (`StreamableHTTPServerTransport`) should track active `ServerResponse` objects and end them on `close()`:

```typescript
// In StreamableHTTPServerTransport

private _activeResponses = new Set<ServerResponse>();

async handleRequest(req: IncomingMessage, res: ServerResponse, body?: unknown) {
  this._activeResponses.add(res);
  res.on('close', () => this._activeResponses.delete(res));
  // ... existing handleRequest logic
}

async close() {
  for (const res of this._activeResponses) {
    if (!res.writableEnded) res.end();
  }
  this._activeResponses.clear();
  return this._webStandardTransport.close();
}
```

## Related issues

- [n8n #25740](https://github.com/n8n-io/n8n/issues/25740) — MCP Client connections not properly closed, causing connection leak
- [java-sdk #620](https://github.com/modelcontextprotocol/java-sdk/issues/620) — HttpClient resource leak causes thread accumulation and memory exhaustion
- [python-sdk #1076](https://github.com/modelcontextprotocol/python-sdk/issues/1076) — Memory leak in MCP Server until OOM
- [python-sdk #756](https://github.com/modelcontextprotocol/python-sdk/issues/756) — Stateless mode memory leak

## Environment

- `@modelcontextprotocol/sdk`: 1.27.1
- Node.js: v24.14.0
