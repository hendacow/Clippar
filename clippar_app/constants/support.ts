/**
 * The one address a customer is ever told to write to.
 *
 * Shared rather than re-declared per screen so a change of provider is one
 * edit — a stale address on one screen is a support request that silently
 * goes nowhere, and the screens that use it (Feedback, Redeem a Code) are
 * exactly the ones reached by someone who is already stuck.
 */
export const SUPPORT_EMAIL = 'support@clippar.com';
