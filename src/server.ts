import { createServer, type IncomingMessage, type Server } from "node:http";
import { handleStripeWebhook, type EventHandler, type WebhookResult } from "./webhook.ts";
import type { Store } from "./idempotency.ts";

export interface WebhookServerOptions {
  secret: string | readonly string[];
  store: Store;
  handler: EventHandler;
  /** Default `/webhooks/stripe`. */
  path?: string;
  /** Default 1 MiB. Stripe events are far smaller. */
  maxBodyBytes?: number;
  toleranceSeconds?: number;
  lockTimeoutMs?: number;
  nowMs?: () => number;
  /** Called once per webhook request with the outcome, for logging. */
  onResult?: (result: WebhookResult) => void;
}

class BodyTooLarge extends Error {}

function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge()); // the rest of the upload is discarded; the caller answers 413 and closes
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A tiny `node:http` server around `handleStripeWebhook`. The body is collected as a Buffer and handed
 * over untouched: no JSON middleware sits in front, which is the whole point.
 */
export function createWebhookServer(options: WebhookServerOptions): Server {
  const path = options.path ?? "/webhooks/stripe";
  const limit = options.maxBodyBytes ?? 1024 * 1024;

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") return send(200, { ok: true });
    if (url.pathname !== path) return send(404, { error: "not_found" });
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return send(405, { error: "method_not_allowed" });
    }

    let rawBody: Buffer;
    try {
      rawBody = await readRaw(req, limit);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        res.setHeader("connection", "close");
        send(413, { error: "payload_too_large" });
        return void res.on("finish", () => req.destroy());
      }
      return send(400, { error: "unreadable_body" });
    }

    const result = await handleStripeWebhook({
      rawBody,
      headers: req.headers,
      secret: options.secret,
      store: options.store,
      handler: options.handler,
      ...(options.toleranceSeconds === undefined ? {} : { toleranceSeconds: options.toleranceSeconds }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs() }),
    });
    options.onResult?.(result);
    send(result.status, result.body);
  });
}
