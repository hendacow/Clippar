import { supabase } from '@/lib/supabase';
import { config } from '@/constants/config';

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
 *
 * Apple Pay is offered as the primary method (one-tap, highest conversion
 * for physical goods — which pay Apple 0%, unlike IAP). It only appears when
 * the merchant ID + Apple Pay capability are provisioned; otherwise the
 * sheet falls back to card entry automatically. `label`/`amount` drive the
 * Apple Pay summary line; shipping address is collected in-sheet since the
 * Clippar box ships to the buyer.
 */
export async function initPaymentSheet(params: {
  amount: number;
  currency: string;
  productType: 'standard' | 'premium';
  label: string;
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
    applePay: {
      merchantCountryCode: config.stripe.merchantCountryCode,
      // One summary line on the Apple Pay sheet. Amount in major units.
      cartItems: [
        {
          label: params.label,
          amount: (params.amount / 100).toFixed(2),
          paymentType: 'Immediate',
        },
      ],
      // Physical goods → collect where to ship the Clippar box.
      requiredShippingAddressFields: ['postalAddress', 'name', 'phoneNumber'],
    },
    // Card path also collects a shipping address so fulfilment has one.
    billingDetailsCollectionConfiguration: {
      address: 'full',
      name: 'always',
    },
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
