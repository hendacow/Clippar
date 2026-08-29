import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CURRENCY, resolvePriceCents } from './pricing.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  try {
    // NOTE: any `amount` in the request body is deliberately ignored. The price
    // is resolved server-side from product_type so the client cannot set it.
    const { product_type } = await req.json();

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

    // Resolve the price server-side. Unknown product types are rejected rather
    // than defaulted, so a typo can never silently charge the wrong amount.
    let amount: number;
    try {
      amount = resolvePriceCents(product_type);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: (err as Error).message }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: CURRENCY,
      metadata: {
        user_id: user.id,
        user_email: user.email ?? '',
        product_type,
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
