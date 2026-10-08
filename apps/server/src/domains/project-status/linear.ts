import type {
    LinearIssueSource,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverviewLinearIssue,
} from '@caxri/protocol';

import type { TranscriptLinearReference } from '../agents';
import { isNonIssuePrefix } from '../agents';
import type { LinearIssueStore } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import { extractLinearReferences, projectStatusCliError } from './external';

/**
 * How many issues one branch may lead with. The status bar renders the first and counts the rest, and a branch that
 * genuinely delivers more than a handful of issues is better read in the Status panel.
 */
const MAX_CANDIDATES = 4;
/**
 * How long the status bar overview waits for Linear before drawing the leading issue as a bare identifier. The overview
 * also carries the branch and pull request chips, and a Linear CLI that hangs until its 8s timeout (TLS or network
 * trouble) used to hold all of them back. A lookup that misses the deadline keeps running and lands in the
 * `LinearIssueStore` cache, so the next poll draws the resolved issue without waiting again.
 */
const OVERVIEW_LINEAR_DEADLINE_MS = 1500;

/**
 * Resolves with the promise's outcome when it settles within `deadlineMs`, or `{ settled: false }` otherwise. The
 * underlying work is not canceled; a late rejection is absorbed so it never surfaces as unhandled.
 */
async function settleWithin<T>(
    promise: Promise<T>,
    deadlineMs: number,
): Promise<{ settled: true; value: T } | { settled: true; error: unknown } | { settled: false }> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), deadlineMs);
        timer.unref();
    });
    const outcome = (async () => {
        try {
            return { settled: true as const, value: await promise };
        } catch (error) {
            return { settled: true as const, error };
        }
    })();
    try {
        return await Promise.race([outcome, deadline]);
    } finally {
        clearTimeout(timer);
    }
}
/**
 * Case-insensitive because a branch spells the team key in lower case while Linear's own identifier is upper case.
 *
 * The trailing lookahead rejects only a digit, not a hyphen: Linear's own branch names put the issue slug immediately
 * after the number (`feat/abc-42-router-monitoring`), so rejecting a following hyphen would miss the common case
 * entirely while catching nothing an allow-listed team key would have admitted.
 */
const BRANCH_IDENTIFIER_PATTERN = /(?:^|[^a-z\d])([a-z][a-z\d]{1,9})-([1-9]\d{0,6})(?!\d)/giu;

/**
 * The bare markers a branch name offers, with the prefixes that are never a Linear team already dropped. Without that
 * filter, ordinary branches like `release-1.2` or `feat/add-2fa` would each send a real query to the user's Linear
 * workspace just to learn they are not issues.
 */
function branchCandidates(branch: string): string[] {
    return branch
        .matchAll(BRANCH_IDENTIFIER_PATTERN)
        .filter((match) => !isNonIssuePrefix(match[1]))
        .map((match) => `${match[1]}-${match[2]}`)
        .toArray();
}

export interface LinearIssueCandidate {
    identifier: string;
    source: LinearIssueSource;
    workspace?: string;
}

export interface LinearCandidateInput {
    branch?: string;
    /**
     * Markers this Session's conversation named, most recent first.
     */
    conversation?: readonly TranscriptLinearReference[];
    pullRequestBody?: string;
    /**
     * The workspace's real team keys. An empty set means "not known" (never "none exist"), so the low-precision sources
     * contribute nothing rather than everything.
     */
    teamKeys: ReadonlySet<string>;
}

/**
 * Collects the Linear issues a branch is plausibly delivering, most authoritative first.
 *
 * The three sources are not equally trustworthy, and the rules differ accordingly:
 *
 * - A **pull request body** states the link on purpose (a `linear.app` URL or a `Fixes ABC-1` marker), so it keeps the
 *   precision rules `extractLinearReferences` already applies and needs no further gate. This is also the only source
 *   the Status panel reads, and its behavior is unchanged.
 * - A **branch name** and a **conversation** yield bare markers, which are shaped exactly like `UTF-8`, `RFC-2119`, and
 *   `CVE-2024`. Those are admitted only when the team key is one the workspace actually defines. A `linear.app` URL in
 *   the conversation proves its own workspace and skips the gate.
 *
 * The first identifier wins its position: a branch that repeats what the pull request already said does not produce a
 * second entry, and does not demote the statement the pull request made.
 */
export function collectLinearCandidates(input: LinearCandidateInput): LinearIssueCandidate[] {
    const candidates: LinearIssueCandidate[] = [];
    const seen = new Set<string>();
    const add = (identifier: string, source: LinearIssueSource, workspace?: string): void => {
        const normalized = identifier.toUpperCase();
        if (seen.has(normalized) || candidates.length >= MAX_CANDIDATES) return;
        seen.add(normalized);
        candidates.push({
            identifier: normalized,
            source,
            ...(workspace && { workspace: workspace.toLowerCase() }),
        });
    };
    const isAllowedKey = (identifier: string): boolean =>
        input.teamKeys.size > 0 && input.teamKeys.has(identifier.split('-', 1)[0].toUpperCase());

    if (input.pullRequestBody)
        for (const reference of extractLinearReferences(input.pullRequestBody))
            add(reference.identifier, 'pull-request', reference.workspace);
    if (input.branch)
        for (const identifier of branchCandidates(input.branch))
            if (isAllowedKey(identifier)) add(identifier, 'branch');
    const conversation = input.conversation ?? [];
    for (const reference of conversation)
        if (reference.workspace || isAllowedKey(reference.identifier))
            add(reference.identifier, 'conversation', reference.workspace);
    return candidates;
}

/**
 * Whether a low-precision source produced something the team-key allow-list has to rule on. Checking first is what
 * keeps a repository that never mentions an issue from ever spawning `linear`.
 */
function requiresTeamKeys(
    branch: string,
    conversation: readonly TranscriptLinearReference[],
): boolean {
    return (
        conversation.some((reference) => !reference.workspace) ||
        branchCandidates(branch).length > 0
    );
}

/**
 * The Status panel's Linear rows: every reference the pull request body deliberately names, resolved in full, with the
 * first provider failure reported so the panel can render it.
 */
export async function loadPullRequestLinearIssues(
    store: LinearIssueStore,
    cwd: string,
    body: string,
    options: { isForced: boolean; onParseFailure: (error: unknown) => void },
): Promise<{ issues: ProjectStatusLinearIssue[]; error?: ProjectStatusError }> {
    const references = extractLinearReferences(body);
    if (references.length === 0) return { issues: [] };
    let firstError: ProjectStatusError | undefined;
    const issues = await Promise.all(
        references.map(async (reference): Promise<ProjectStatusLinearIssue> => {
            try {
                return await store.issue({
                    cwd,
                    identifier: reference.identifier,
                    // A pull request body is written deliberately, so its identifier may name the log record.
                    isStated: true,
                    // An explicit user refresh must reach Linear; an automatic revalidation may reuse the record.
                    maxAgeMs: options.isForced ? 0 : undefined,
                    workspace: reference.workspace,
                });
            } catch (error) {
                options.onParseFailure(error);
                const failure =
                    error instanceof ExternalStatusCliError
                        ? error
                        : new ExternalStatusCliError('linear', 'other', String(error));
                firstError ??= projectStatusCliError('linear', failure.kind, {
                    retryAt: failure.retryAt,
                    subject: reference.identifier,
                });
                return { identifier: reference.identifier };
            }
        }),
    );
    return { issues, error: firstError };
}

/**
 * The status bar's Linear chip: the branch's issues from every source that is already paid for, with only the leading
 * one resolved.
 *
 * The chip renders one issue and counts the remainder, so resolving the tail would spend a CLI query per refresh on a
 * title and a state colour nothing draws. A failed lookup degrades to the bare identifier rather than surfacing a
 * provider error: the status bar has no room to explain one, and the Status panel already reports Linear outages
 * properly.
 */
export async function loadOverviewLinearIssues(
    store: LinearIssueStore,
    cwd: string,
    sources: {
        branch: string;
        conversation: readonly TranscriptLinearReference[];
        pullRequestBody?: string;
    },
    deadlineMs = OVERVIEW_LINEAR_DEADLINE_MS,
): Promise<ProjectStatusOverviewLinearIssue[]> {
    const startedAt = performance.now();
    const remaining = (): number => Math.max(0, deadlineMs - (performance.now() - startedAt));
    let teamKeys: ReadonlySet<string> = new Set<string>();
    if (requiresTeamKeys(sources.branch, sources.conversation)) {
        // An allow-list still loading is "unknown", which admits no low-precision marker: the same narrowing an
        // unavailable CLI already gets.
        const outcome = await settleWithin(store.allowedTeamKeys(cwd), remaining());
        if (outcome.settled && 'value' in outcome) teamKeys = outcome.value;
    }
    const candidates = collectLinearCandidates({ ...sources, teamKeys });
    if (candidates.length === 0) return [];
    const [lead, ...rest] = candidates;
    let resolved: ProjectStatusLinearIssue = { identifier: lead.identifier };
    // A failure or a missed deadline degrades to the identifier; the store remembers the failure (or the late result),
    // so the next poll neither respawns the CLI nor waits again.
    const outcome = await settleWithin(
        store.issue({
            cwd,
            identifier: lead.identifier,
            // Only the pull request stated its identifier on purpose; a branch name or a transcript marker must stay
            // out of the structured log.
            isStated: lead.source === 'pull-request',
            workspace: lead.workspace,
        }),
        remaining(),
    );
    if (outcome.settled && 'value' in outcome) resolved = outcome.value;
    return [
        { ...resolved, source: lead.source },
        ...rest.map((candidate) => ({
            identifier: candidate.identifier,
            source: candidate.source,
        })),
    ];
}
