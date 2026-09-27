import type { MethodResult } from '@caxri/protocol';

import type { MobileConnectionStatus } from '../connection/connection-state';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];
type AttentionListResult = MethodResult<'mobile.attention.list'>;

/**
 * A busy transcript needs room too: the visible request list never grows past this many cards before "show more" takes
 * over, matching `AttentionCards`' own scroll cap for the whole block.
 */
export const VISIBLE_REQUEST_LIMIT = 3;

/**
 * Polling only makes sense while the app can act on a result: foregrounded, connected, and scoped to a known connection
 * (a fresh `connectionScopeKey` invalidates any in-flight request from a previous one).
 */
export function isAttentionQueryEnabled(
    isForeground: boolean,
    status: MobileConnectionStatus,
    connectionScopeKey: string | null,
): boolean {
    return isForeground && status === 'connected' && connectionScopeKey !== null;
}

/**
 * `undefined` while the first fetch is in flight, so callers get an empty list instead of having to guard the query
 * result themselves.
 */
export function attentionRequestList(data: AttentionListResult | undefined): Attention[] {
    return data?.requests ?? [];
}

/**
 * Caps the rendered list to the most recent `VISIBLE_REQUEST_LIMIT` requests until the user asks to see the rest;
 * returns the same array reference when already expanded so an unrelated re-render does not reset FlatList's memo.
 */
export function visibleAttentionRequests(requests: Attention[], isExpanded: boolean): Attention[] {
    return isExpanded ? requests : requests.slice(-VISIBLE_REQUEST_LIMIT);
}

/**
 * Whether the Session's "Always allow in this Session" grant (issue caxri#1295) is currently active.
 */
export function isAutoAllowGranted(data: AttentionListResult | undefined): boolean {
    return data?.autoAllow.granted ?? false;
}
