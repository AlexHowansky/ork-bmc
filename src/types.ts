/** Shared Hono environment: the variables middleware attaches to every request. */
import type { Session } from './auth/session.ts';
import type { Logger } from './log.ts';
import type { User } from './models/users.ts';

export type Theme = 'light' | 'dark' | 'system';

export interface AppEnv {
  Variables: {
    /** Correlates a log line with the id shown on a user's error page. */
    requestId: string;
    /**
     * Per-request CSP nonce for the one `<style>` block a page may need for
     * values that cannot be known at build time (the grid overlay spacing).
     * Using a nonce keeps `style-src` free of 'unsafe-inline'.
     */
    nonce: string;
    logger: Logger;
    /** Populated by `attachSession`; null for anonymous requests. */
    user: User | null;
    session: Session | null;
    /** Rendered into the form token by `csrfField`. Empty when anonymous. */
    csrfToken: string;
    theme: Theme;
  };
}
