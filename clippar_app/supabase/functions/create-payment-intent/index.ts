import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';
import { enforceRateLimits, RATE_LIMITS } from '../_shared/rateLimit.ts';
import {
  PRICE_CURRENCY,
  resolvePriceCents,
  resolveProductType,
} from './pricing.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Price table and the allowlist lookup live in ./pricing.ts — see the comment
// there for why the table has a null prototype and why the lookup is an
// own-property test rather than `table[key] === undefined`.

const handler = async (req: Request): Promise<Response> => {
  try {
    // Authenticate BEFORE parsing the body. Parsing first meant an unauthenticated
    // caller could make us decode arbitrary JSON, and malformed input landed in the
    // catch as a 500 rather than an honest 400.
    const authHeader = req.headers.get('Authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser(token);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Every call here reaches Stripe's API on our credentials. Unmetered, a
    // scripted account can burn our Stripe rate limit and litter the dashboard
    // with abandoned intents. Fails CLOSED (see RATE_LIMITS.createPaymentIntent):
    // if the limiter is down, refusing checkout beats an unmetered flood.
    const limited = await enforceRateLimits(
      supabase,
      RATE_LIMITS.createPaymentIntent,
      user.id,
      { 'Content-Type': 'application/json' },
    );
    if (limited) return limited;

    const body = await req.json().catch(() => null);
    if (body === null || typeof body !== 'object') {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const product_type = (body as Record<string, unknown>).product_type;

    // Resolve the price from the server-side catalog, ignoring any
    // client-supplied amount/currency. Unknown products are rejected.
    const resolvedType = resolveProductType(product_type);
    const amount = resolvePriceCents(product_type);
    if (amount === null) {
      return new Response(
        JSON.stringify({ error: 'Unknown product' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: PRICE_CURRENCY,
      metadata: {
        user_id: user.id,
        user_email: user.email ?? '',
        product_type: resolvedType,
      },
    });

    return new Response(
      JSON.stringify({ clientSecret: paymentIntent.client_secret }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    // Stripe errors are especially bad to echo: they can carry account ids, API
    // versions and key prefixes. Log, return a fixed string (spec 5.3).
    console.error('[create-payment-intent]', err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: 'Could not start checkout.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
};

// Guarded so `deno test` can import the pure helpers above without binding a
// port (same pattern as delete-account / revenuecat-webhook). Supabase runs
// index.ts as the entry module, so this is true in production.
if (import.meta.main) {
  Deno.serve(handler);
}
