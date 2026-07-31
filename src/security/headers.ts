/**
 * Security response headers.
 *
 * The CSP is deny-by-default with no inline script or style allowed. That is
 * only practical because the UI ships zero inline JS: the theme toggle degrades
 * to a plain form POST and is enhanced by a same-origin /app.js.
 */
import type { MiddlewareHandler } from 'hono';

import { config } from '../config.ts';
import type { AppEnv } from '../types.ts';

/**
 * `style-src` carries a per-request nonce rather than 'unsafe-inline'. Only one
 * page needs a dynamic style — the grid overlay spacing on a map detail page —
 * and a nonce covers it without opening inline styles generally.
 */
const contentSecurityPolicy = (nonce: string): string =>
  [
    "default-src 'none'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    // data: is needed for the inline SVG favicon; images otherwise stay same-origin.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();

  // Headers are set on the existing response rather than through `c.header()`.
  // Once a response is finalised, `c.header()` reconstructs it from its body
  // stream, which discards Content-Length — and image downloads set that
  // deliberately so browsers can show real progress.
  const headers = c.res.headers;

  headers.set('Content-Security-Policy', contentSecurityPolicy(c.get('nonce') ?? ''));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');

  // Only meaningful over TLS, and actively harmful to send otherwise: a browser
  // would pin a host that cannot serve HTTPS.
  if (config.cookieSecure) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
};
