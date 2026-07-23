import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Server-authoritative price table. The amount charged is derived here from a
// fixed product catalog, NEVER from the client body — a client-supplied amount
// let any authenticated user pay 1 cent for a physical kit. Prices (in cents)
// mirror constants/config.ts (standardPriceCents / premiumPriceCents) and the
// currency is fixed. Update both together when pricing changes.
const PRICE_TABLE_AUD_CENTS: Record<string, number> = {
  standard: 5900,
  premium: 6900,
};
const PRICE_CURRENCY = 'aud';

Deno.serve(async (req: Request) => {
  try {
    const { product_type } = await req.json();

    // Authenticate user from JWT
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

    // Resolve the price from the server-side catalog, ignoring any
    // client-supplied amount/currency. Unknown products are rejected.
    const resolvedType =
      typeof product_type === 'string' ? product_type : 'standard';
    const amount = PRICE_TABLE_AUD_CENTS[resolvedType];
    if (amount === undefined) {
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
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
