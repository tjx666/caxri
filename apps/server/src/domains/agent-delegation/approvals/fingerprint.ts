import { createHash } from 'node:crypto';

import type { AgentChatRequest } from '@caxri/protocol';

/**
 * The provider-private decisions a request offers; see `AgentChatProviderSession.requests`.
 */
export interface RequestOffers {
    accept: boolean;
    decline: boolean;
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => stable(entry));
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => [key, stable(entry)]),
        );
    return value;
}

/**
 * SHA-256 hex over a key-sorted JSON of the whole projected request plus the provider-private offers. Both brokers
 * overwrite a request with the same id in place and emit no second `attentionRequested`, so an id alone does not
 * identify what a parent approves: any change to any field is a different request. Deliberately conservative. Never
 * logged.
 */
export function requestFingerprint(
    request: AgentChatRequest,
    offers: RequestOffers | undefined,
): string {
    return createHash('sha256')
        .update(JSON.stringify(stable({ request, offers: offers ?? null })))
        .digest('hex');
}

/**
 * The opaque `revision` a delegating Agent echoes to `approve`: a prefix of the fingerprint, which reveals nothing of
 * the request. 64 bits is enough to tell one provider rewrite from another.
 */
export function revisionOf(fingerprint: string): string {
    return fingerprint.slice(0, 16);
}
