/** Shared shapes for the higher-resolution search, kept here to avoid a cycle. */
import type { Config } from '../config.ts';

export type WebSearchSettings = Config['webSearch'];

/** One copy of an image found somewhere on the web, as the provider described it. */
export interface SearchResult {
  /** Where the full-resolution copy is. Never fetched except through the guard. */
  imageUrl: string;
  /** The page it appears on, for the admin to look at before trusting it. */
  pageUrl: string | null;
  /** A human-readable publisher, usually a domain. */
  source: string | null;
  title: string | null;
  /** As claimed by the provider. Confirmed only once the file is in hand. */
  width: number;
  height: number;
  /** A smaller copy, for showing the admin. May be a `data:` URI. */
  thumbnailUrl: string | null;
  /** How many exact matches the provider found. A popularity signal, for ranking. */
  exact: number;
}
