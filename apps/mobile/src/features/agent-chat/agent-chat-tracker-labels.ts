import type { AgentChatTrackerArtifact } from '@caxri/protocol';

import type { Translate } from '../../i18n';

/**
 * The tracker card's reference line, localized at render time like Desktop's `trackerReferenceText`: an acceptance
 * report's round when the ingest output reported one, else the reference. `@caxri/protocol`'s helper of the same name
 * is English-only.
 */
export const trackerReferenceLabel = (artifact: AgentChatTrackerArtifact, t: Translate): string =>
    artifact.round === undefined
        ? artifact.reference
        : t('chat.tracker.round', { round: artifact.round });

/**
 * The tracker card's excerpt line: an acceptance report's check count, else the body's first line.
 */
export const trackerExcerptLabel = (
    artifact: AgentChatTrackerArtifact,
    t: Translate,
): string | undefined => {
    if (artifact.checks === undefined) return artifact.excerpt;
    return t(artifact.checks === 1 ? 'chat.tracker.checksOne' : 'chat.tracker.checksOther', {
        count: artifact.checks,
    });
};
