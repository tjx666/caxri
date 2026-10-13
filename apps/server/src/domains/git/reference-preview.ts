import type {
    GitCommitDetails,
    TerminalCommitLinkResolution,
    TerminalReferencePreview,
    TerminalReferencePreviewRequest,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { GitHubReferenceStore } from '../external-status';

/**
 * The card shows a couple of lines under the subject at most, so the rest of a long commit message is dropped at the
 * Server rather than shipped across the wire on every hover.
 */
const MAX_PREVIEW_BODY_LENGTH = 2_048;

export interface TerminalReferencePreviewOptions {
    commitDetails: (repoId: string, sha: string) => Promise<GitCommitDetails>;
    githubReferences: GitHubReferenceStore;
    logger: StructuredLogger;
    resolveCommit: (reference: string) => Promise<TerminalCommitLinkResolution>;
    /**
     * Admits the read through the Git command semaphore, so a burst of hovers cannot outrun the concurrency budget the
     * rest of the Git domain respects.
     */
    schedule: <T>(work: () => Promise<T>) => Promise<T>;
    terminalCwd: string;
}

/**
 * Maps a CLI failure onto the closed reason enum the card renders. Every branch is a real, separately actionable state:
 * an operator reading "cli-missing" installs `gh`, one reading "rate-limited" waits.
 */
function unavailableReason(error: unknown): TerminalReferencePreview {
    const failure = error as { code?: string; kind?: string };
    // `not-found` is `ExternalStatusCliError`'s word for "the CLI itself is not on this machine", not for a missing issue.
    if (failure.kind === 'not-found' || failure.code === 'ENOENT')
        return { kind: 'unavailable', reason: 'cli-missing' };
    if (['not-logged-in', 'not-linked', 'permission-denied'].includes(failure.kind ?? ''))
        return { kind: 'unavailable', reason: 'not-authenticated' };
    if (failure.kind === 'rate-limited') return { kind: 'unavailable', reason: 'rate-limited' };
    return { kind: 'unavailable', reason: 'failed' };
}

async function commitPreview(
    reference: string,
    options: TerminalReferencePreviewOptions,
): Promise<TerminalReferencePreview> {
    const resolution = await options.resolveCommit(reference);
    // An abbreviation matching commits in two of the Session's repositories names no single commit; the card says so
    // rather than picking one, which is the same answer `⌘ click` gives.
    if (resolution.status !== 'resolved') return { kind: 'unavailable', reason: 'ambiguous' };
    const { candidate } = resolution;
    let details: GitCommitDetails;
    try {
        details = await options.commitDetails(candidate.repositoryId, candidate.sha);
    } catch {
        // The abbreviation resolved a moment ago, so the commit is gone (a rebase, a pruned fetch) rather than absent.
        return { kind: 'unavailable', reason: 'not-found' };
    }
    return {
        kind: 'commit',
        author: details.commit.author,
        authoredAt: details.commit.authoredAt,
        body: details.commit.body.slice(0, MAX_PREVIEW_BODY_LENGTH),
        changedFileCount: details.files.length,
        deletions: details.deletions,
        insertions: details.additions,
        repositoryName: candidate.repositoryName,
        sha: candidate.sha,
        shortSha: details.commit.shortSha,
        subject: details.commit.subject,
    };
}

/**
 * Reads any github.com repository, not only the Session's own. An Agent routinely links pull requests it opened in a
 * sibling repository, and limiting the read to the Session's remotes left every such link stuck on the unknown glyph
 * even after it merged. The read is a REST GET on github.com whose answer only reaches this machine; the owner and
 * repository are held to GitHub's name characters by the protocol, so a crafted link cannot reshape the API path, and
 * the per-reference cache plus the Git command semaphore bound what a burst of links can spend.
 */
async function githubPreview(
    request: Extract<TerminalReferencePreviewRequest, { kind: 'github' }>,
    options: TerminalReferencePreviewOptions,
): Promise<TerminalReferencePreview> {
    const startedAt = performance.now();
    return options.schedule(async () => {
        try {
            const reference = await options.githubReferences.view({
                cwd: options.terminalCwd,
                number: request.number,
                owner: request.owner,
                repo: request.repo,
            });
            options.logger.write('info', logEventCatalog.git.githubCommand, {
                durationMs: performance.now() - startedAt,
                fields: { operation: 'reference.preview' },
            });
            if (!reference) return { kind: 'unavailable', reason: 'not-found' };
            return {
                kind: 'github',
                author: reference.author,
                createdAt: reference.createdAt,
                isDraft: reference.isDraft,
                isMerged: reference.isMerged,
                isPullRequest: reference.isPullRequest,
                number: reference.number,
                state: reference.state,
                title: reference.title,
                url: reference.url,
            };
        } catch (error) {
            const unavailable = unavailableReason(error);
            options.logger.write('warn', logEventCatalog.git.githubCommandFailed, {
                durationMs: performance.now() - startedAt,
                fields: {
                    operation: 'reference.preview',
                    // The reason enum, not the CLI's message: a blank card has to stay countable by cause, and `gh`
                    // output can carry a repository path or a token hint that must never reach a log.
                    reason: unavailable.kind === 'unavailable' ? unavailable.reason : 'failed',
                },
            });
            return unavailable;
        }
    });
}

/**
 * Metadata for one hovered Terminal reference. Never rejects for an ordinary miss: a hover card that throws would
 * surface a toast the user did not ask for, so every "nothing to show" case comes back as an `unavailable` card with a
 * reason instead.
 */
export function loadTerminalReferencePreview(
    request: TerminalReferencePreviewRequest,
    options: TerminalReferencePreviewOptions,
): Promise<TerminalReferencePreview> {
    return request.kind === 'commit'
        ? commitPreview(request.reference, options)
        : githubPreview(request, options);
}
