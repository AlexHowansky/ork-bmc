/** The panel shown when a larger copy of an upload exists somewhere on the web. */
import type { FC } from 'hono/jsx';

import type { UploadCandidate } from '../models/uploadCandidates.ts';
import { badge, badgeWarning, button, card, hint, link } from './ui.ts';
import { FORM_ID, type StagedUpload } from './MapForm.tsx';

/**
 * How much bigger a copy is, in the terms people actually think in.
 *
 * Pixel counts are the honest measure and the useless one: 8.4 megapixels
 * against 2.1 says nothing until you work out the ratio. "2× wider" is the same
 * fact in the units a map is judged in — how much detail there is to zoom into.
 */
function scaleLabel(candidate: UploadCandidate, staged: StagedUpload): string {
  const factor = candidate.width / staged.imageWidth;

  if (factor >= 1.95) return `${Math.round(factor)}× wider`;
  return `${Math.round((factor - 1) * 100)}% wider`;
}

const Candidate: FC<{ candidate: UploadCandidate; staged: StagedUpload }> = ({ candidate, staged }) => (
  <li class="flex items-center gap-4 py-3">
    {candidate.thumb ? (
      <img
        src={`/i/pending/${staged.uuid}/candidate/${candidate.id}`}
        alt=""
        loading="lazy"
        decoding="async"
        width="72"
        height="72"
        class="h-18 w-18 shrink-0 rounded-lg border border-stone-200 object-cover dark:border-stone-700"
      />
    ) : (
      // A candidate whose preview would not download is still worth offering;
      // the source link is there to be looked at instead.
      <div class="flex h-18 w-18 shrink-0 items-center justify-center rounded-lg border border-dashed border-stone-300 text-xs text-stone-400 dark:border-stone-700 dark:text-stone-500">
        No preview
      </div>
    )}

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class={badge}>
          {candidate.width} × {candidate.height}
        </span>
        <span class="text-xs font-medium text-amber-800 dark:text-amber-300">{scaleLabel(candidate, staged)}</span>
      </div>
      <p class="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">
        {candidate.pageUrl ? (
          // A new tab, so looking at where a copy came from does not throw away
          // the staged upload and everything typed about it.
          <a href={candidate.pageUrl} target="_blank" rel="noopener noreferrer nofollow" class={link}>
            {candidate.source ?? candidate.title ?? 'Source'}
          </a>
        ) : (
          (candidate.source ?? candidate.title ?? 'Unknown source')
        )}
      </p>
    </div>

    {/*
      `form` binds this to the metadata form further down the page, so choosing a
      copy carries whatever has already been typed into it rather than throwing
      it away. A submit button sends one name and one value, so the candidate
      travels inside the action rather than in a field of its own.

      `formnovalidate` for the same reason the discard button carries it: the
      name field is required, and adopting a copy is not saving the map.
    */}
    <button
      type="submit"
      form={FORM_ID}
      name="action"
      value={`adopt:${candidate.id}`}
      formnovalidate
      class={button.secondary}
    >
      Use this one
    </button>
  </li>
);

export const UpgradeOffer: FC<{ candidates: UploadCandidate[]; staged: StagedUpload }> = ({
  candidates,
  staged,
}) => (
  <div
    role="alert"
    class="rounded-xl border border-amber-300 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/40"
  >
    <div class="flex flex-wrap items-center gap-3">
      <span class={badgeWarning}>Higher resolution available</span>
      <h2 class="text-lg font-semibold text-amber-900 dark:text-amber-200">
        {candidates.length === 1
          ? 'A larger copy of this map is published elsewhere'
          : `${candidates.length} larger copies of this map are published elsewhere`}
      </h2>
    </div>

    <p class="mt-3 text-sm text-amber-900 dark:text-amber-200">
      What you uploaded is {staged.imageWidth} × {staged.imageHeight}. Choosing one of these downloads it, checks it
      really is the same map, and keeps it in place of your file — everything you have typed stays as it is, and
      nothing joins the library until you save.
    </p>

    <div class={`mt-5 px-4 ${card}`}>
      <ul class="divide-y divide-stone-100 dark:divide-stone-800">
        {candidates.map((candidate) => (
          <Candidate candidate={candidate} staged={staged} />
        ))}
      </ul>
    </div>

    <p class={hint}>
      Sizes are as reported by the search; each one is confirmed against the actual file before it replaces yours.
    </p>
  </div>
);
