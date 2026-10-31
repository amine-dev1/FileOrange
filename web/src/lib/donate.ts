/**
 * Where "Donate" sends people. Off unless the site is built with VITE_DONATE_URL (for example a paypal.me, Ko-fi or Buy Me a Coffee
 * link): without it, no donate button or section is shown anywhere.
 */
export const DONATE_URL: string | null = (import.meta.env.VITE_DONATE_URL as string | undefined)?.trim() || null;
