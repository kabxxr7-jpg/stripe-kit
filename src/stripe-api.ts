import { randomUUID } from "node:crypto";
import { assertMinorUnits, normalizeCurrency } from "./money.ts";

export const DEFAULT_BASE_URL = "https://api.stripe.com";

export class StripeApiError extends Error {
  readonly status: number;
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  constructor(message: string, details: { status: number; type?: string | undefined; code?: string | undefined; requestId?: string | undefined }) {
    super(message);
    this.name = "StripeApiError";
    this.status = details.status;
    this.type = details.type;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

export interface StripeClientOptions {
  /** `sk_test_...` or a restricted key. Sent as a Bearer token; never logged or put in an error. */
  apiKey: string;
  /** Default `https://api.stripe.com`. Tests point this at the local fake server. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Sent as `Stripe-Version` when set. Unset means the account's default version. */
  apiVersion?: string;
  /** Retries after a network error, 409, 429 or 5xx, always with the same Idempotency-Key. Default 2. */
  maxRetries?: number;
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt. Default 20 s. */
  timeoutMs?: number;
}

/**
 * Stripe's form encoding: nested keys in brackets, arrays by index.
 * { line_items: [{ quantity: 1 }], metadata: { a: "b" } } -> line_items[0][quantity]=1&metadata[a]=b
 * `undefined` and `null` are skipped; only strings, integers and booleans are accepted as leaves.
 */
export function encodeForm(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    } else if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new RangeError(`${prefix}: only integers are sent (got ${value})`);
      out.append(prefix, String(value));
    } else if (typeof value === "string" || typeof value === "boolean") {
      out.append(prefix, String(value));
    } else {
      throw new TypeError(`${prefix}: unsupported value type ${typeof value}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString();
}

const RETRYABLE = new Set([409, 429, 500, 502, 503, 504]);

export interface StripeResponse<T> {
  data: T;
  /** True when Stripe answered from its idempotency cache (`Idempotent-Replayed: true`). */
  replayed: boolean;
}

/**
 * One API call. POSTs always carry an `Idempotency-Key` (yours, or a fresh UUID) that is reused by
 * every retry of this call, so a retry after a lost response cannot create a second object.
 */
export async function stripeRequest<T>(
  client: StripeClientOptions,
  request: { method: "GET" | "POST"; path: string; params?: Record<string, unknown>; idempotencyKey?: string },
): Promise<StripeResponse<T>> {
  if (!client.apiKey) throw new TypeError("apiKey is required");
  const doFetch = client.fetch ?? fetch;
  const sleep = client.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = client.maxRetries ?? 2;
  const url = `${(client.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${request.path}`;

  const headers: Record<string, string> = { authorization: `Bearer ${client.apiKey}` };
  if (client.apiVersion) headers["stripe-version"] = client.apiVersion;
  let body: string | undefined;
  if (request.method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["idempotency-key"] = request.idempotencyKey ?? randomUUID();
    body = encodeForm(request.params ?? {});
  }

  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    let networkError: unknown;
    try {
      response = await doFetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(client.timeoutMs ?? 20_000),
      });
    } catch (error) {
      networkError = error;
    }

    if (response && response.ok) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new StripeApiError("Stripe answered 2xx with a body that is not JSON", { status: response.status });
      }
      return { data: data as T, replayed: response.headers.get("idempotent-replayed") === "true" };
    }

    const retryable = response ? RETRYABLE.has(response.status) : true;
    if (retryable && attempt < maxRetries) {
      await sleep(Math.min(500 * 2 ** attempt, 5000));
      continue;
    }
    if (!response) {
      throw new StripeApiError(`network error calling Stripe: ${networkError instanceof Error ? networkError.message : "unknown"}`, { status: 0 });
    }
    throw await toApiError(response);
  }
}

async function toApiError(response: Response): Promise<StripeApiError> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const err = (typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["error"] : undefined) as
    | Record<string, unknown>
    | undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return new StripeApiError(str(err?.["message"]) ?? `Stripe API error (HTTP ${response.status})`, {
    status: response.status,
    type: str(err?.["type"]),
    code: str(err?.["code"]),
    requestId: response.headers.get("request-id") ?? undefined,
  });
}

// ---- Checkout Sessions ---------------------------------------------------------------------------

export interface CheckoutSession {
  id: string;
  object: "checkout.session";
  mode: "payment" | "subscription";
  status: string | null;
  payment_status: string;
  url: string | null;
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  [key: string]: unknown;
}

export type CheckoutLineItem =
  | { price: string; quantity: number }
  | {
      name: string;
      /** Integer minor units: 1999 = USD 19.99, 1500 = JPY 1500. */
      unitAmount: number;
      currency: string;
      quantity: number;
      /** Required for a subscription line, forbidden for a one-time payment. */
      recurring?: { interval: "day" | "week" | "month" | "year"; intervalCount?: number };
    };

export interface CreateCheckoutInput {
  mode: "payment" | "subscription";
  lineItems: CheckoutLineItem[];
  /** May contain `{CHECKOUT_SESSION_ID}`, which Stripe fills in. */
  successUrl: string;
  cancelUrl: string;
  customer?: string;
  customerEmail?: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  /**
   * Keep it stable per logical purchase (for example derived from your cart id) so that a double click
   * or a retried request returns the same session. Default: a fresh UUID per call (retries inside the
   * call still share it).
   */
  idempotencyKey?: string;
}

function assertUrl(value: string, what: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new TypeError(`${what} must be an absolute URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError(`${what} must be http(s)`);
}

/** Builds and validates the request fields. Exported so it can be tested without a network. */
export function checkoutParams(input: CreateCheckoutInput): Record<string, unknown> {
  if (input.mode !== "payment" && input.mode !== "subscription") throw new TypeError("mode must be payment or subscription");
  if (input.lineItems.length === 0) throw new TypeError("at least one line item is required");
  assertUrl(input.successUrl, "successUrl");
  assertUrl(input.cancelUrl, "cancelUrl");
  if (input.customer !== undefined && input.customerEmail !== undefined) {
    throw new TypeError("pass customer or customerEmail, not both");
  }

  const currencies = new Set<string>();
  const line_items = input.lineItems.map((item, i) => {
    const where = `lineItems[${i}]`;
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) throw new RangeError(`${where}.quantity must be an integer >= 1`);
    if ("price" in item) {
      if (!/^price_/.test(item.price)) throw new TypeError(`${where}.price must be a price id (price_...)`);
      return { price: item.price, quantity: item.quantity };
    }
    assertMinorUnits(item.unitAmount, `${where}.unitAmount`);
    if (item.unitAmount < 0) throw new RangeError(`${where}.unitAmount must not be negative`);
    if (!item.name.trim()) throw new TypeError(`${where}.name is required`);
    const currency = normalizeCurrency(item.currency);
    currencies.add(currency);
    if (input.mode === "payment" && item.recurring) throw new TypeError(`${where}: recurring is not allowed in payment mode`);
    if (input.mode === "subscription" && !item.recurring) throw new TypeError(`${where}: subscription mode needs recurring`);
    return {
      quantity: item.quantity,
      price_data: {
        currency,
        unit_amount: item.unitAmount,
        product_data: { name: item.name },
        ...(item.recurring
          ? { recurring: { interval: item.recurring.interval, ...(item.recurring.intervalCount === undefined ? {} : { interval_count: item.recurring.intervalCount }) } }
          : {}),
      },
    };
  });
  if (currencies.size > 1) throw new TypeError("all line items must use one currency");

  if (input.metadata) {
    const entries = Object.entries(input.metadata);
    if (entries.length > 50) throw new RangeError("metadata allows at most 50 keys");
    for (const [k, v] of entries) {
      if (k.length === 0 || k.length > 40) throw new RangeError("metadata keys must be 1-40 characters");
      if (typeof v !== "string" || v.length > 500) throw new RangeError("metadata values must be strings of at most 500 characters");
    }
  }

  return {
    mode: input.mode,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    line_items,
    customer: input.customer,
    customer_email: input.customerEmail,
    client_reference_id: input.clientReferenceId,
    metadata: input.metadata,
  };
}

/** POST /v1/checkout/sessions for a one-time payment or a subscription. */
export async function createCheckoutSession(
  client: StripeClientOptions,
  input: CreateCheckoutInput,
): Promise<StripeResponse<CheckoutSession>> {
  return stripeRequest<CheckoutSession>(client, {
    method: "POST",
    path: "/v1/checkout/sessions",
    params: checkoutParams(input),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
  });
}

export async function retrieveCheckoutSession(client: StripeClientOptions, id: string): Promise<CheckoutSession> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new TypeError("not a checkout session id");
  return (await stripeRequest<CheckoutSession>(client, { method: "GET", path: `/v1/checkout/sessions/${id}` })).data;
}

/** An open session can be expired so a test run leaves nothing payable behind. */
export async function expireCheckoutSession(client: StripeClientOptions, id: string): Promise<CheckoutSession> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) throw new TypeError("not a checkout session id");
  return (await stripeRequest<CheckoutSession>(client, { method: "POST", path: `/v1/checkout/sessions/${id}/expire` })).data;
}
