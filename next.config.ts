import type { NextConfig } from "next";

// The non-nonce header path (see docs/next.js content-security-policy guide):
// a nonce-based CSP forces every page to dynamic rendering, which is a much
// bigger change than this pass. React/Next set inline styles through the
// CSSOM property-by-property (React's own style prop, and StaysMap/HotelMap's
// `el.style.x = y`), not through the `style` HTML attribute or a `<style>`
// tag — CSP's style-src only gates the latter, so it stays strict here with
// no `'unsafe-inline'`.
//
// Domains below are every one the app is KNOWN to call:
//   - js.stripe.com / api.stripe.com: the Payment Element on checkout
//     (CheckoutClient.tsx loads https://js.stripe.com/v3/ directly)
//   - build.protomaps.com: the pmtiles basemap (map-style.ts)
//   - protomaps.github.io: glyphs + sprites for the same basemap
//   - static.cupid.travel / *.cupid.travel: hotel photos (matches the
//     images.remotePatterns below)
//   - lh3.googleusercontent.com: Google OAuth profile photos
// Shipped as Report-Only first. Flip to enforcing (rename the header to
// Content-Security-Policy) only after a pass through
// docs/testing-strategy.md with devtools open and zero violation reports —
// Stripe in particular has sub-resources (fraud-detection domains) this list
// may be missing, and Report-Only is what surfaces them safely.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' https://js.stripe.com",
  "style-src 'self'",
  "frame-src https://js.stripe.com",
  "connect-src 'self' https://api.stripe.com https://build.protomaps.com https://protomaps.github.io",
  "img-src 'self' data: https://static.cupid.travel https://*.cupid.travel https://lh3.googleusercontent.com",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing in the app uses any of these — deny by default rather
          // than inherit the browser's permissive fallback.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
        ],
      },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "static.cupid.travel" },
      { protocol: "https", hostname: "**.cupid.travel" },
    ],
  },
};

export default nextConfig;
