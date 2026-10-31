import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the few Stripe API routes the kit calls. It is a test double written from
 * the public docs, NOT a model of Stripe: it checks the request shape the kit sends and mimics
 * Stripe's documented idempotency behaviour (same key + same body replays the first response,
 * same key + different body is an error). Nothing here has been compared with the real API.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  form: Record<string, unknown>;
}

export interface FakeStripe {
  baseUrl: string;
  apiKey: string;
  requests: RecordedRequest[];
  /** Objects created so far, by id. */
  sessions: Map<string, Record<string, unknown>>;
  /** Make the next `count` POST /v1/checkout/sessions calls fail with `status` (or drop the connection with 0). */
  failNext(count: number, status: number): void;
  close(): Promise<void>;
}

/** "a[b][0][c]=1" -> { a: { b: [ { c: "1" } ] } } */
export function parseForm(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = [...key.matchAll(/[^[\]]+/g)].map((m) => m[0]);
    let node: Record<string, unknown> = root;
    path.forEach((part, i) => {
      if (i === path.length - 1) {
        node[part] = value;
        return;
      }
      const next = path[i + 1] as string;
      let child = node[part];
      if (typeof child !== "object" || child === null) {
        child = /^\d+$/.test(next) ? [] : {};
        node[part] = child;
      }
      node = child as Record<string, unknown>;
    });
  }
  return root;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const stripeError = (type: string, message: string, code?: string) => ({ error: { type, message, ...(code ? { code } : {}) } });

export async function startFakeStripe(options: { apiKey?: string } = {}): Promise<FakeStripe> {
  const apiKey = options.apiKey ?? "sk_test_fake_key_for_local_server_only";
  const requests: RecordedRequest[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const idempotency = new Map<string, { body: string; status: number; payload: unknown }>();
  let failures = { count: 0, status: 500 };
  let counter = 0;

  const server: Server = createServer(async (req, res) => {
    const rawBody = await readBody(req);
    const url = new URL(req.url ?? "/", "http://localhost");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      headers: req.headers,
      rawBody,
      form: parseForm(rawBody),
    };
    requests.push(recorded);

    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "request-id": `req_fake_${requests.length}`, ...extra });
      res.end(text);
    };

    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return send(401, stripeError("invalid_request_error", "Invalid API Key provided: sk_test_****", "api_key_invalid"));
    }

    const expire = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/.exec(url.pathname);
    const one = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const s = sessions.get(one[1] as string);
      return s ? send(200, s) : send(404, stripeError("invalid_request_error", "No such checkout.session", "resource_missing"));
    }
    if (req.method === "POST" && expire) {
      const s = sessions.get(expire[1] as string);
      if (!s) return send(404, stripeError("invalid_request_error", "No such checkout.session", "resource_missing"));
      s["status"] = "expired";
      return send(200, s);
    }
    if (!(req.method === "POST" && url.pathname === "/v1/checkout/sessions")) {
      return send(404, stripeError("invalid_request_error", `Unrecognized request URL (${req.method}: ${url.pathname})`));
    }

    if (failures.count > 0) {
      failures.count -= 1;
      if (failures.status === 0) return void req.socket.destroy();
      return send(failures.status, stripeError("api_error", "injected failure"));
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
      return send(400, stripeError("invalid_request_error", "Content-Type must be application/x-www-form-urlencoded"));
    }

    const key = req.headers["idempotency-key"];
    if (typeof key === "string") {
      const seen = idempotency.get(key);
      if (seen) {
        if (seen.body !== rawBody) {
          return send(400, stripeError("idempotency_error", "Keys for idempotent requests can only be used with the same parameters they were first used with.", "idempotency_key_in_use"));
        }
        return send(seen.status, seen.payload, { "idempotent-replayed": "true" });
      }
    }

    const form = recorded.form;
    const mode = form["mode"];
    const items = form["line_items"];
    if (mode !== "payment" && mode !== "subscription") return send(400, stripeError("invalid_request_error", "Invalid mode", "parameter_invalid_string"));
    if (!Array.isArray(items) || items.length === 0) return send(400, stripeError("invalid_request_error", "Missing required param: line_items."));
    if (typeof form["success_url"] !== "string") return send(400, stripeError("invalid_request_error", "Missing required param: success_url."));

    let total = 0;
    let currency: string | null = null;
    for (const item of items as Array<Record<string, unknown>>) {
      const quantity = Number(item["quantity"]);
      const pd = item["price_data"] as Record<string, unknown> | undefined;
      if (!pd) continue; // a price id: the fake does not know prices
      if (mode === "subscription" && !pd["recurring"]) return send(400, stripeError("invalid_request_error", "price_data.recurring is required in subscription mode"));
      if (mode === "payment" && pd["recurring"]) return send(400, stripeError("invalid_request_error", "recurring prices are not allowed in payment mode"));
      if (!/^\d+$/.test(String(pd["unit_amount"]))) return send(400, stripeError("invalid_request_error", "Invalid integer", "parameter_invalid_integer"));
      total += Number(pd["unit_amount"]) * quantity;
      currency = String(pd["currency"]);
    }

    counter += 1;
    const id = `cs_test_fake${String(counter).padStart(6, "0")}`;
    const session = {
      id,
      object: "checkout.session",
      mode,
      status: "open",
      payment_status: "unpaid",
      url: `https://checkout.stripe.test/c/pay/${id}`,
      amount_total: total,
      currency,
      client_reference_id: typeof form["client_reference_id"] === "string" ? form["client_reference_id"] : null,
      customer: typeof form["customer"] === "string" ? form["customer"] : null,
      success_url: form["success_url"],
      metadata: form["metadata"] ?? {},
    };
    sessions.set(id, session);
    if (typeof key === "string") idempotency.set(key, { body: rawBody, status: 200, payload: session });
    return send(200, session);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    requests,
    sessions,
    failNext(count, status) {
      failures = { count, status };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
