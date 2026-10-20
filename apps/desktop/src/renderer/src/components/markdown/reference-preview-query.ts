import type { TerminalReferencePreview } from '@caxri/protocol';

import { pullRequestLinkState } from '../../lib/link-summary';
import { useCaxriQuery } from '../../queries/client';

/**
 * How long a settled reference (a merged or closed pull request, an issue) is trusted before a focus or remount
 * refetches it.
 */
const SETTLED_STALE_TIME_MS = 5 * 60_000;
/**
 * How long a pull request that can still change (open, draft, or not yet known) is trusted. A transcript can stay
 * mounted for hours, so a pull request merged in the browser must show as merged shortly after the user returns to
 * Caxri. The Server's reference cache for an open pull request is the same length (see `github-reference.ts`), so a
 * refetch after this window reads GitHub again instead of the Server's copy.
 */
const LIVE_STALE_TIME_MS = 60_000;

/**
 * Stale window for a `terminal.reference.preview` answer: short while the pull request can still change, long once it
 * is merged or closed, long for an issue whose title is all the preview carries, and short when the read has not
 * answered yet.
 */
export function referencePreviewStaleTime(preview: TerminalReferencePreview | undefined): number {
    if (preview?.kind !== 'github') return LIVE_STALE_TIME_MS;
    if (!preview.isPullRequest) return SETTLED_STALE_TIME_MS;
    const state = pullRequestLinkState(preview);
    return state === 'merged' || state === 'closed' ? SETTLED_STALE_TIME_MS : LIVE_STALE_TIME_MS;
}

/**
 * The one Terminal reference preview read behind a pull request link's icon and text, and the Chat's tracker card.
 * Sharing the query key and options lets them dedupe into one request and one targeted invalidation.
 */
export function useReferencePreview(
    terminalId: string | undefined,
    reference: { number: number; owner: string; repo: string } | undefined,
) {
    return useCaxriQuery(
        'terminal.reference.preview',
        {
            terminalId: terminalId ?? '',
            reference: { kind: 'github', ...(reference ?? { owner: '', repo: '', number: 1 }) },
        },
        {
            enabled: terminalId !== undefined && reference !== undefined,
            refetchOnWindowFocus: true,
            retry: false,
            staleTime: (query) => referencePreviewStaleTime(query.state.data),
        },
    );
}
