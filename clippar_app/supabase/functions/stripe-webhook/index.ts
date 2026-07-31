import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

/**
 * stripe-webhook — records the physical mount purchase in hardware_orders.
 *
 * The Shop is hidden at v1, but this is the only path that ever creates a paid
 * order row: the Orders screen (app/profile/orders.tsx) and lib/api.ts read
 * hardware_orders, and nothing else writes 'paid'. If this handler fails
 * silently the customer is charged and no order exists to fulfil.
 */

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
});

const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

/**
 * hardware_orders.kit_type is `CHECK (kit_type IN ('standard','premium'))`
 * (migration 001). The value arrives in Stripe PaymentIntent metadata, which
 * is set from the client checkout call, so it is untrusted input — anything
 * outside the allowlist would make the whole insert fail the CHECK and, with
 * it, lose a paid order. Coerce instead.
 */
const KIT_TYPES = ['standard', 'premium'] as const;
export type KitType = (typeof KIT_TYPES)[number];

export function normalizeKitType(raw: unknown): KitType {
  return KIT_TYPES.includes(raw as KitType) ? (raw as KitType) : 'standard';
}

export interface HardwareOrderInsert {
  user_id: string;
  kit_type: KitType;
  amount_cents: number;
  currency: string;
  stripe_payment_intent_id: string;
  status: 'paid';
}

/**
 * Build the hardware_orders row for a succeeded PaymentIntent.
 *
 * Every key here MUST be a real column on hardware_orders (001_initial_schema
 * :212-233). This previously wrote `product_type` (the column is `kit_type`)
 * and `email` (no such column), so PostgREST rejected every insert with
 * PGRST204 — and because the result was never checked and the handler always
 * returned 200, Stripe recorded a successful delivery and never retried. Every
 * real payment would have been captured with no order row behind it.
 * tests/../index.test.ts asserts these keys against the migration.
 */
export function buildOrderInsert(
  paymentIntent: { id: string; amount: number; currency: string; metadata: Record<string, string> },
  userId: string
): HardwareOrderInsert {
  return {
    user_id: userId,
    kit_type: normalizeKitType(paymentIntent.metadata.product_type),
    amount_cents: paymentIntent.amount,
    currency: paymentIntent.currency,
    stripe_payment_intent_id: paymentIntent.id,
    status: 'paid',
  };
}

/** Postgres unique_violation — the order already exists from an earlier delivery. */
export function isDuplicateOrderError(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

/** Minimal shape of the service-role client used by recordOrder (test seam). */
export interface OrderClient {
  from(table: string): {
    insert(values: HardwareOrderInsert): Promise<{ error: { code?: string; message?: string } | null }>;
  };
}

/**
 * Insert the order, treating a duplicate as success.
 *
 * Idempotency comes from `stripe_payment_intent_id TEXT UNIQUE` (001:215):
 * Stripe re-delivers on any non-2xx, so a retry after a partial failure hits
 * the unique index and we ack. We deliberately do NOT upsert — a redelivery
 * arriving after fulfilment would overwrite status='shipped' back to 'paid'.
 *
 * Returns false on a real failure so the caller can 5xx and let Stripe retry
 * with backoff, instead of marking a lost order delivered.
 */
export async function recordOrder(
  client: OrderClient,
  row: HardwareOrderInsert
): Promise<boolean> {
  const { error } = await client.from('hardware_orders').insert(row);
  if (!error) return true;
  if (isDuplicateOrderError(error)) {
    console.log(`hardware_orders: ${row.stripe_payment_intent_id} already recorded`);
    return true;
  }
  console.error('hardware_orders insert failed', error);
  return false;
}

export async function handler(req: Request): Promise<Response> {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing signature', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch (err) {
    // Log the detail, return a fixed string.
    //
    // constructEvent's message distinguishes the failure modes — "No signatures
    // found matching the expected signature", "Timestamp outside the tolerance
    // zone", a malformed header — which tells anyone POSTing this endpoint
    // exactly how close they are to forging a valid webhook, and whether the
    // signing secret they are guessing against is even the right one. Stripe
    // errors can also carry account ids and API versions. The signature check is
    // the only thing standing between an unauthenticated caller and a forged
    // "payment succeeded", so it must not narrate its own failures (spec 5.3).
    //
    // Stripe itself does not read this body — it retries on any non-2xx — so
    // nothing is lost operationally, and the detail is still in the function log.
    console.error(
      '[stripe-webhook] signature verification failed:',
      err instanceof Error ? err.message : err,
    );
    return new Response('Webhook Error', { status: 400 });
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const userId = paymentIntent.metadata.user_id;

    if (userId) {
      const row = buildOrderInsert(
        {
          id: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          metadata: paymentIntent.metadata as Record<string, string>,
        },
        userId
      );
      const ok = await recordOrder(supabase as unknown as OrderClient, row);
      if (!ok) {
        // 500 → Stripe retries with backoff. Money has been captured; the row
        // must exist or the order is unfulfillable and invisible to the buyer.
        return new Response('Order insert failed', { status: 500 });
      }
    } else {
      // No user_id in metadata means we cannot attribute the payment. Ack so
      // Stripe stops retrying, but make it findable in the logs.
      console.error(`payment_intent ${paymentIntent.id} succeeded with no user_id metadata`);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Only bind the server when run as the entry module (Edge Function runtime).
// Importing this file from a test must not start a listener.
if (import.meta.main) {
  Deno.serve(handler);
}
