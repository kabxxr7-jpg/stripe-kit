/**
 * The few fields of a Stripe event the kit reads. Everything else stays `unknown` on purpose: an
 * event body is data from the network, so each handler checks what it uses.
 */
export interface StripeEvent {
  id: string;
  type: string;
  /** Seconds since the epoch. Stripe sets this when the event is created, not when it is delivered. */
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
}

export function isStripeEvent(value: unknown): value is StripeEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const data = v["data"] as Record<string, unknown> | null | undefined;
  return (
    typeof v["id"] === "string" &&
    v["id"].length > 0 &&
    typeof v["type"] === "string" &&
    Number.isSafeInteger(v["created"]) &&
    typeof data === "object" &&
    data !== null &&
    typeof data["object"] === "object" &&
    data["object"] !== null
  );
}
