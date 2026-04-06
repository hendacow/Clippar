import type { ReactNode } from 'react';
import { config } from '@/constants/config';

// @stripe/stripe-react-native requires native module — not available in Expo Go
let StripeProvider: any = null;
try {
  StripeProvider = require('@stripe/stripe-react-native').StripeProvider;
} catch {
  // Native module not available
}

export function StripeWrapper({ children }: { children: ReactNode }) {
  if (!StripeProvider) {
    return <>{children}</>;
  }

  return (
    <StripeProvider publishableKey={config.stripe.publishableKey}>
      <>{children}</>
    </StripeProvider>
  );
}
