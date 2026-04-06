import { supabase } from '@/lib/supabase';

// @stripe/stripe-react-native requires native module — not available in Expo Go
let stripeInitPaymentSheet: any = null;
let stripePresentPaymentSheet: any = null;
try {
  const Stripe = require('@stripe/stripe-react-native');
  stripeInitPaymentSheet = Stripe.initPaymentSheet;
  stripePresentPaymentSheet = Stripe.presentPaymentSheet;
} catch {
  // Native module not available
}

/**
 * Initialize the Stripe PaymentSheet for a hardware purchase.
 */
export async function initPaymentSheet(params: {
  amount: number;
  currency: string;
  productType: 'standard' | 'premium';
}) {
  if (!stripeInitPaymentSheet) {
    throw new Error('Stripe not available — requires a development build');
  }

  const { data, error } = await supabase.functions.invoke(
    'create-payment-intent',
    {
      body: {
        amount: params.amount,
        currency: params.currency,
        product_type: params.productType,
      },
    }
  );

  if (error || !data) {
    throw new Error(error?.message || 'Failed to create payment intent');
  }

  const { error: initError } = await stripeInitPaymentSheet({
    paymentIntentClientSecret: data.clientSecret,
    merchantDisplayName: 'Clippar Golf',
    style: 'automatic',
  });

  if (initError) throw new Error(initError.message);
}

/**
 * Present the Stripe PaymentSheet.
 * Returns true if payment succeeded, false if cancelled.
 */
export async function presentPaymentSheet(): Promise<boolean> {
  if (!stripePresentPaymentSheet) {
    throw new Error('Stripe not available — requires a development build');
  }

  const { error } = await stripePresentPaymentSheet();

  if (error) {
    if (error.code === 'Canceled') return false;
    throw new Error(error.message);
  }

  return true;
}
