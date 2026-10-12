import type {
    AgentChatTrackerArtifact,
    TerminalReferencePreview,
    TerminalReferencePreviewRequest,
} from '@caxri/protocol';

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

const GITHUB_REFERENCE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/u;

/**
 * The reference preview request that can supply a title the card lacks, or `undefined` when there is nothing to ask:
 * the card already has a title, or it is not a GitHub pull request or issue. A `gh api` edit (`-F body=@file`) names
 * only the number, so its card otherwise reads `owner/repo#N` alone.
 */
export function trackerTitlePreviewRequest(
    artifact: AgentChatTrackerArtifact,
): Extract<TerminalReferencePreviewRequest, { kind: 'github' }> | undefined {
    if (artifact.title !== undefined || artifact.provider !== 'github') return undefined;
    if (artifact.kind !== 'pull' && artifact.kind !== 'issue') return undefined;
    const match = GITHUB_REFERENCE.exec(artifact.reference);
    if (!match) return undefined;
    const [, owner, repo, number] = match;
    if (!owner || !repo || !number) return undefined;
    return { kind: 'github', owner, repo, number: Number(number) };
}

/**
 * The title a reference preview found, or `undefined` while it loads, when it failed, or when the repository is not one
 * of the Session's, so the card keeps showing its reference.
 */
export function trackerPreviewTitle(
    preview: TerminalReferencePreview | undefined,
): string | undefined {
    if (preview?.kind !== 'github') return undefined;
    const title = preview.title.trim();
    return title === '' ? undefined : title;
}
