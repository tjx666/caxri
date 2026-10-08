import type {
    AcceptanceSource,
    ProjectStatusAcceptance,
    ProjectStatusError,
    ProjectStatusOverviewAcceptance,
} from '@caxri/protocol';

import type { AcceptanceReference } from '../acceptance-link';
import { acceptanceUrl, findAcceptanceLinks } from '../acceptance-link';
import type { AcceptanceStore } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import { projectStatusCliError } from './external';

/**
 * How many reports one branch may lead with. The status bar renders the first and counts the rest; a branch delivering
 * more than a handful of acceptance reports is better read in the Status panel.
 */
const MAX_CANDIDATES = 4;

export interface AcceptanceCandidate extends AcceptanceReference {
    source: AcceptanceSource;
}

export interface AcceptanceCandidateInput {
    /**
     * Links this Session's conversation named, most recent first.
     */
    conversation?: readonly AcceptanceReference[];
    pullRequestBody?: string;
}

/**
 * Collects the acceptance reports a branch is plausibly delivering against, most authoritative first.
 *
 * Both sources carry a full URL, so unlike the Linear collector there is no precision gate to apply: the only question
 * is order. A pull request body states the link on purpose and wins its position; the conversation fills in what the
 * pull request did not say, or answers for a branch that has no pull request yet.
 *
 * The first mention of a report wins: a conversation that repeats what the pull request already linked does not produce
 * a second entry, and does not demote the statement the pull request made. A round pinned by the winning mention is the
 * round that is reported: pasting a link with `?turn=2` is how somebody says which round they mean.
 */
export function collectAcceptanceCandidates(
    input: AcceptanceCandidateInput,
): AcceptanceCandidate[] {
    const candidates: AcceptanceCandidate[] = [];
    const seen = new Set<string>();
    const add = (reference: AcceptanceReference, source: AcceptanceSource): void => {
        if (seen.has(reference.id) || candidates.length >= MAX_CANDIDATES) return;
        seen.add(reference.id);
        candidates.push({ ...reference, source });
    };
    const stated = input.pullRequestBody ? findAcceptanceLinks(input.pullRequestBody) : [];
    const mentioned = input.conversation ?? [];
    for (const reference of stated) add(reference, 'pull-request');
    for (const reference of mentioned) add(reference, 'conversation');
    return candidates;
}

/**
 * The Status panel's acceptance rows: every report the pull request body deliberately links, resolved in full, with the
 * first provider failure reported so the panel can render it.
 */
export async function loadPullRequestAcceptances(
    store: AcceptanceStore,
    cwd: string,
    body: string,
    options: { isForced: boolean; onParseFailure: (error: unknown) => void },
): Promise<{ acceptances: ProjectStatusAcceptance[]; error?: ProjectStatusError }> {
    const references = collectAcceptanceCandidates({ pullRequestBody: body });
    if (references.length === 0) return { acceptances: [] };
    let firstError: ProjectStatusError | undefined;
    const acceptances = await Promise.all(
        references.map(async (reference): Promise<ProjectStatusAcceptance> => {
            try {
                return await store.report({
                    cwd,
                    id: reference.id,
                    // An explicit user refresh must reach the provider; an automatic revalidation may reuse the record.
                    maxAgeMs: options.isForced ? 0 : undefined,
                    round: reference.round,
                });
            } catch (error) {
                options.onParseFailure(error);
                const failure =
                    error instanceof ExternalStatusCliError
                        ? error
                        : new ExternalStatusCliError('lh', 'other', String(error));
                firstError ??= projectStatusCliError('lh', failure.kind, {
                    retryAt: failure.retryAt,
                    // Deliberately not the report id: it names one customer's private acceptance record, and the
                    // subject travels into a persisted `warn` record.
                    subject: 'acceptance report',
                });
                return unresolved(reference);
            }
        }),
    );
    return { acceptances, error: firstError };
}

/**
 * The status bar's acceptance chip: the branch's reports from every source already paid for, with only the leading one
 * resolved.
 *
 * The chip renders one report and counts the remainder, so resolving the tail would spend a CLI query per refresh on a
 * verdict nothing draws. A failed lookup degrades to the bare link rather than surfacing a provider error: the status
 * bar has no room to explain one, and the Status panel already reports provider outages properly.
 */
export async function loadOverviewAcceptances(
    store: AcceptanceStore,
    cwd: string,
    sources: {
        conversation: readonly AcceptanceReference[];
        pullRequestBody?: string;
    },
): Promise<ProjectStatusOverviewAcceptance[]> {
    const candidates = collectAcceptanceCandidates(sources);
    if (candidates.length === 0) return [];
    const [lead, ...rest] = candidates;
    let resolved = unresolved(lead);
    try {
        resolved = await store.report({ cwd, id: lead.id, round: lead.round });
    } catch {
        // Degrade to the link; the store has already remembered the failure, so the next poll does not respawn the CLI.
    }
    return [
        { ...resolved, source: lead.source },
        ...rest.map((candidate) => ({ ...unresolved(candidate), source: candidate.source })),
    ];
}

/**
 * A report Caxri recognized but has not read. The link is still worth rendering: it is the whole reason the user pasted
 * it, and it stays correct whether or not the CLI is installed.
 */
function unresolved(reference: AcceptanceReference): ProjectStatusAcceptance {
    return {
        id: reference.id,
        // Not `neutral`: nothing about this report has been read, and `neutral` is a state a resolved report reaches.
        state: 'unknown',
        url: acceptanceUrl(reference.id, reference.round),
        ...(reference.round && { round: reference.round }),
    };
}
