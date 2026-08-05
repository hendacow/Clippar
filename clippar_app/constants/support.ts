/**
 * The one address a customer is ever told to write to.
 *
 * Shared rather than re-declared per screen so a change of provider is one
 * edit — a stale address on one screen is a support request that silently
 * goes nowhere, and the screens that use it (Feedback, Redeem a Code) are
 * exactly the ones reached by someone who is already stuck.
 */
/*
 * clippargolf@gmail.com, not support@clippar.com (2026-08-05). The old address
 * was on a domain Clippar does not own — clippar.com belongs to someone else —
 * so every support request sent to it went to a stranger's inbox rather than
 * merely bouncing. This is the mailbox Henry actually reads.
 *
 * If this ever becomes support@clippargolf.com, the MX records for that domain
 * have to exist FIRST. An address on a domain we control but have not set up
 * mail for fails exactly as silently as the one it replaced.
 */
export const SUPPORT_EMAIL = 'clippargolf@gmail.com';
