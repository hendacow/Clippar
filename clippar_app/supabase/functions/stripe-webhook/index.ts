import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.8';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-04-10',
});

const endpointSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

Deno.serve(async (req: Request) => {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing signature', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch (err) {
    return new Response(`Webhook Error: ${(err as Error).message}`, {
      status: 400,
    });
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const userId = paymentIntent.metadata.user_id;
    // `product_type` is the PaymentIntent metadata name (set by
    // create-payment-intent); the column is `kit_type` and is CHECK-constrained
    // to standard|premium, so anything else falls back rather than failing the
    // whole insert. The buyer's email is not duplicated here — it lives on
    // profiles.email, joined via user_id.
    const kitType =
      paymentIntent.metadata.product_type === 'premium' ? 'premium' : 'standard';

    if (userId) {
      // Create hardware order
      const { error } = await supabase.from('hardware_orders').insert({
        user_id: userId,
        kit_type: kitType,
        amount_cents: paymentIntent.amount,
        currency: paymentIntent.currency,
        stripe_payment_intent_id: paymentIntent.id,
        status: 'paid',
      });

      if (error) {
        // 23505 = unique violation on stripe_payment_intent_id, i.e. Stripe
        // redelivered an event we already recorded. That is success, not failure.
        if (error.code === '23505') {
          console.log(
            `[stripe-webhook] order already exists for ${paymentIntent.id}, ignoring replay`
          );
        } else {
          console.error(
            `[stripe-webhook] failed to insert hardware_order for payment_intent ${paymentIntent.id} (user ${userId}): ${error.code ?? 'no-code'} ${error.message}`
          );
          // Non-2xx tells Stripe to retry the event, so a transient DB failure
          // doesn't silently lose a paid order.
          return new Response(
            JSON.stringify({ error: 'Failed to record hardware order' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    } else {
      console.error(
        `[stripe-webhook] payment_intent ${paymentIntent.id} succeeded with no user_id in metadata; no hardware order recorded`
      );
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
