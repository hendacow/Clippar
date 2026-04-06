/**
 * Web stubs for stripe — @stripe/stripe-react-native is native-only.
 */

export async function initPaymentSheet(_params: {
  amount: number;
  currency: string;
  productType: 'standard' | 'premium';
}): Promise<void> {
  throw new Error('Stripe not available on web');
}

export async function presentPaymentSheet(): Promise<boolean> {
  throw new Error('Stripe not available on web');
}
