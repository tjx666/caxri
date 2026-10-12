import type { AgentChatTrackerArtifact } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * The card's reference line. An acceptance round is localized here at render time rather than when the timeline is
 * collected, because the collected timeline is memoized and would keep the language it was first built in. The phone
 * reads the English `trackerReferenceText` in `@caxri/protocol`.
 */
export function trackerReferenceText(artifact: AgentChatTrackerArtifact, t: Translate): string {
    return artifact.round === undefined
        ? artifact.reference
        : t('agentChat.tracker.round', { round: artifact.round });
}

/**
 * The card's excerpt line; an acceptance report's check count, localized at render time like `trackerReferenceText()`.
 */
export function trackerExcerptText(
    artifact: AgentChatTrackerArtifact,
    t: Translate,
): string | undefined {
    if (artifact.checks === undefined) return artifact.excerpt;
    return t(
        artifact.checks === 1 ? 'agentChat.tracker.checksOne' : 'agentChat.tracker.checksOther',
        { count: artifact.checks },
    );
}
