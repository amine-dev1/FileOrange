/**
 * Where "Donate" sends people: PayPal's donation page for the site owner's account. Change it in one place, or at build time
 * with VITE_DONATE_URL (for example a paypal.me link, which doesn't show the email address).
 */
const PAYPAL_EMAIL = "elidrissiamine74@gmail.com";

export const DONATE_URL: string =
  (import.meta.env.VITE_DONATE_URL as string | undefined)?.trim() ||
  `https://www.paypal.com/donate/?business=${encodeURIComponent(PAYPAL_EMAIL)}&currency_code=EUR&item_name=${encodeURIComponent("Support OrangeFile")}`;
