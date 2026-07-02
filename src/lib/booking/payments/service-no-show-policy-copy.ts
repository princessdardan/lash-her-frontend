/**
 * Client-safe canonical copy for the service no-show policy.
 *
 * This module only exports literal strings so it can be imported by both
 * server-side audit code and client-side UI code without pulling in
 * server-only dependencies such as Node.js crypto.
 */

export const SERVICE_NO_SHOW_POLICY_VERSION = "service-no-show-full-amount-v1";

export const SERVICE_NO_SHOW_POLICY_TEXT = `I authorize Lash Her to charge today’s booking payment and store my payment card on file for this appointment. I understand that my card may be charged up to the total amount shown above in the event of a missed appointment or late cancellation, according to Lash Her by Nataliea's cancellation policy.`;
