/**
 * The friendly error page.
 *
 * Shows only the user-safe message plus the request id. That id is the bridge
 * between "it broke" and the exact log line, without exposing any internals.
 */
import type { FC } from 'hono/jsx';

import { button, card } from './ui.ts';

export interface ErrorPageProps {
  status: number;
  message: string;
  requestId: string;
}

const HEADINGS: Record<number, string> = {
  400: 'That request did not look right',
  401: 'Please sign in',
  403: 'You cannot do that',
  404: 'Nothing here',
  409: 'That conflicts with something',
  413: 'That file is too large',
  429: 'Slow down a moment',
  500: 'Something went wrong',
};

export const ErrorPage: FC<ErrorPageProps> = ({ status, message, requestId }) => (
  <div class="mx-auto max-w-lg text-center">
    <p class="text-6xl font-black tracking-tight text-amber-600 dark:text-amber-500">{status}</p>
    <h1 class="mt-4 text-2xl font-bold tracking-tight">{HEADINGS[status] ?? 'Something went wrong'}</h1>
    <p class="mt-3 text-stone-600 dark:text-stone-400">{message}</p>

    <div class="mt-8 flex justify-center gap-3">
      <a href="/maps" class={button.primary}>
        Back to maps
      </a>
    </div>

    <div class={`mt-8 px-4 py-3 text-xs text-stone-500 dark:text-stone-400 ${card}`}>
      If you need help, quote reference <code class="font-mono font-semibold">{requestId}</code>.
    </div>
  </div>
);
