import { Buffer } from 'node:buffer';

import type {
    MobileSessionSearchEntry,
    MobileSessionSearchResult,
    Principal,
    ServerRequest,
    SessionSearchResult,
    SessionSearchSnippet,
} from '@caxri/protocol';
import {
    MOBILE_SESSION_SEARCH_MAX_BYTES,
    MOBILE_SESSION_SEARCH_MAX_HIGHLIGHTS,
    MOBILE_SESSION_SEARCH_MAX_RESULTS,
    MOBILE_SESSION_SEARCH_SNIPPET_MAX_LENGTH,
    MOBILE_SESSION_SEARCH_TITLE_MAX_LENGTH,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

type MobileSessionSearchRequest = Extract<ServerRequest, { method: 'mobile.session.search' }>;

const ELLIPSIS = '…';
/**
 * Text kept ahead of the first match, so the clipped quote still reads as a sentence rather than starting on the term.
 */
const LEADING_CONTEXT = 40;

const isLowSurrogate = (text: string, index: number): boolean => {
    const code = text.codePointAt(index) ?? 0;
    return code >= 0xdc_00 && code <= 0xdf_ff;
};

/**
 * Cuts a snippet to the phone's length around its first match and rebases the highlight ranges onto the cut text. A cut
 * never splits a surrogate pair.
 */
export function clipMobileSessionSearchSnippet(
    snippet: SessionSearchSnippet,
): NonNullable<MobileSessionSearchEntry['match']['snippet']> {
    const { text } = snippet;
    let start = Math.max(0, (snippet.highlights[0]?.[0] ?? 0) - LEADING_CONTEXT);
    let end = Math.min(text.length, start + MOBILE_SESSION_SEARCH_SNIPPET_MAX_LENGTH);
    start = Math.max(0, Math.min(start, end - MOBILE_SESSION_SEARCH_SNIPPET_MAX_LENGTH));
    if (start > 0 && isLowSurrogate(text, start)) start += 1;
    if (end < text.length && isLowSurrogate(text, end)) end -= 1;
    const prefix = start > 0 ? ELLIPSIS : '';
    const suffix = end < text.length ? ELLIPSIS : '';
    const highlights = snippet.highlights
        .map(([from, to]): [number, number] => [
            Math.max(from, start) - start + prefix.length,
            Math.min(to, end) - start + prefix.length,
        ])
        .filter(([from, to]) => to > from)
        .slice(0, MOBILE_SESSION_SEARCH_MAX_HIGHLIGHTS);
    return { role: snippet.role, text: `${prefix}${text.slice(start, end)}${suffix}`, highlights };
}

/**
 * Projects Desktop's search result onto the phone's smaller rows and drops trailing rows until the reply fits one
 * gateway frame, which only text full of JSON-escaped characters can exceed.
 */
export function projectMobileSessionSearch(result: SessionSearchResult): MobileSessionSearchResult {
    const entries = result.entries.flatMap((entry): MobileSessionSearchEntry[] =>
        entry.sessionId && entry.projectId && entry.status !== 'external'
            ? [
                  {
                      sessionId: entry.sessionId,
                      projectId: entry.projectId,
                      title: entry.title.slice(0, MOBILE_SESSION_SEARCH_TITLE_MAX_LENGTH),
                      status: entry.status,
                      ...(entry.provider && { provider: entry.provider }),
                      updatedAt: entry.updatedAt,
                      match: {
                          field: entry.match.field,
                          ...(entry.match.snippet && {
                              snippet: clipMobileSessionSearchSnippet(entry.match.snippet),
                          }),
                          ...(entry.match.messageCount !== undefined && {
                              messageCount: entry.match.messageCount,
                          }),
                      },
                  },
              ]
            : [],
    );
    const projected: MobileSessionSearchResult = {
        entries: entries.slice(0, MOBILE_SESSION_SEARCH_MAX_RESULTS),
        index: result.index,
        relaxation: result.relaxation,
    };
    while (
        projected.entries.length > 0 &&
        Buffer.byteLength(JSON.stringify(projected)) > MOBILE_SESSION_SEARCH_MAX_BYTES
    )
        projected.entries.pop();
    return projected;
}

/**
 * Runs Desktop's Session search inside the paired device's Project grant. The domain search applies the grant before
 * its result limit, so another Project's Sessions never crowd out the device's own.
 */
export async function searchMobileSessions(
    domainService: ServerDomainService,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    request: MobileSessionSearchRequest,
): Promise<MobileSessionSearchResult> {
    const { currentProjectId, query, status } = request.params;
    const result = await domainService.request('session.searchInternal', {
        query,
        status,
        ...(currentProjectId && { currentProjectId }),
        projectScope: [...principal.projectIds],
    });
    return projectMobileSessionSearch(result);
}
