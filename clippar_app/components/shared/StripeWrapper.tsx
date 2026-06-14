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
    <StripeProvider
      publishableKey={config.stripe.publishableKey}
      // Required for Apple Pay (physical-goods checkout). Harmless when the
      // merchant ID / capability aren't provisioned yet — the sheet just
      // falls back to card entry.
      merchantIdentifier={config.stripe.merchantIdentifier}
      urlScheme="clippar"
    >
      <>{children}</>
    </StripeProvider>
  );
}
