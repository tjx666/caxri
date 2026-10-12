import type {
    CommanderBoard,
    CommanderBoardRow,
    CommanderConversation,
    CommanderConversationReference,
    CommanderHandoverRejection,
    CommanderHandoverResult,
} from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * One row of the hand-over picker: a Workbench Session or an Agent conversation started outside Caxri.
 */
export interface HandoverCandidate {
    /**
     * Stable selection key: the Session ID, or `provider:conversation` for a conversation.
     */
    key: string;
    title: string;
    agentKind: string;
    updatedAt: number;
    sessionId?: string;
    conversation?: CommanderConversationReference;
    /**
     * Another process may still have the conversation open; handing it over then forks it.
     */
    mayBeOpen?: boolean;
}

/**
 * Candidates under one heading: an existing Project, or for a conversation in no visible Project, the folder that
 * handing it over adds as a new Project.
 */
export interface HandoverCandidateGroup {
    key: string;
    title: string;
    /**
     * Set when handing a conversation of this group over adds this folder as a Project.
     */
    newProjectRoot?: string;
    candidates: HandoverCandidate[];
}

function conversationCandidateKey(conversation: CommanderConversationReference): string {
    return `${conversation.provider}:${conversation.providerSessionId}`;
}

function isMatch(query: string, ...fields: Array<string | undefined>): boolean {
    const needle = query.trim().toLocaleLowerCase();
    return (
        needle.length === 0 ||
        fields.some((field) => field?.toLocaleLowerCase().includes(needle) === true)
    );
}

/**
 * Groups candidates in the order their newest member appears, newest first inside each group.
 */
function groupCandidates(
    entries: Array<{
        group: Omit<HandoverCandidateGroup, 'candidates'>;
        candidate: HandoverCandidate;
    }>,
): HandoverCandidateGroup[] {
    const groups = new Map<string, HandoverCandidateGroup>();
    const newestFirst = entries.toSorted(
        (left, right) => right.candidate.updatedAt - left.candidate.updatedAt,
    );
    for (const { candidate, group } of newestFirst) {
        const existing = groups.get(group.key);
        if (existing) existing.candidates.push(candidate);
        else groups.set(group.key, { ...group, candidates: [candidate] });
    }
    return groups.values().toArray();
}

/**
 * The user's Sessions the Commander does not manage yet, matching `query` by Session or Project title.
 */
export function handoverSessionGroups(
    rows: readonly CommanderBoardRow[],
    query: string,
): HandoverCandidateGroup[] {
    return groupCandidates(
        rows
            .filter(
                (row) =>
                    !row.commanderSession && isMatch(query, row.sessionTitle, row.projectTitle),
            )
            .map((row) => ({
                group: { key: row.projectId, title: row.projectTitle },
                candidate: {
                    key: row.sessionId,
                    title: row.sessionTitle,
                    agentKind: row.agent?.kind ?? 'shell',
                    updatedAt: row.lastActivityAt,
                    sessionId: row.sessionId,
                },
            })),
    );
}

/**
 * Agent conversations started outside Caxri, matching `query` by title, folder, or Project title. A conversation the
 * Server matched to no visible Project is grouped under its own folder, which handing it over adds as a Project.
 */
export function handoverConversationGroups(
    conversations: readonly CommanderConversation[],
    projects: CommanderBoard['projects'],
    query: string,
    untitled: string,
): HandoverCandidateGroup[] {
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return groupCandidates(
        conversations.flatMap((conversation) => {
            const project = conversation.projectId
                ? projectById.get(conversation.projectId)
                : undefined;
            if (!isMatch(query, conversation.title, conversation.cwd, project?.title)) return [];
            return [
                {
                    group: project
                        ? { key: project.id, title: project.title }
                        : {
                              key: `folder:${conversation.cwd}`,
                              title: conversation.cwd,
                              newProjectRoot: conversation.cwd,
                          },
                    candidate: {
                        key: conversationCandidateKey(conversation),
                        title: conversation.title ?? untitled,
                        agentKind: conversation.provider,
                        updatedAt: conversation.updatedAt,
                        conversation: {
                            provider: conversation.provider,
                            providerSessionId: conversation.providerSessionId,
                        },
                        mayBeOpen: conversation.mayBeOpen,
                    },
                },
            ];
        }),
    );
}

/**
 * Splits a selection into the request's two lists. Keys the current candidates no longer contain are dropped.
 */
export function handoverRequestEntries(
    selection: ReadonlySet<string>,
    candidates: readonly HandoverCandidate[],
): { sessionIds: string[]; conversations: CommanderConversationReference[] } {
    const selected = candidates.filter((candidate) => selection.has(candidate.key));
    return {
        sessionIds: selected.flatMap((candidate) =>
            candidate.sessionId ? [candidate.sessionId] : [],
        ),
        conversations: selected.flatMap((candidate) =>
            candidate.conversation ? [candidate.conversation] : [],
        ),
    };
}

/**
 * What one hand-over request achieved: how many entries the Commander took, how many of those it can only own (no
 * conversation to continue), and each refusal reason with its count, most frequent first.
 */
export interface HandoverSummary {
    accepted: number;
    ownershipOnly: number;
    rejected: Array<{ reason: CommanderHandoverRejection; count: number }>;
}

export function summarizeHandover(result: CommanderHandoverResult): HandoverSummary {
    const rejected = new Map<CommanderHandoverRejection, number>();
    let accepted = 0;
    let ownershipOnly = 0;
    for (const outcome of result.outcomes) {
        if (outcome.outcome === 'accepted') {
            accepted += 1;
            if (outcome.ownershipReason) ownershipOnly += 1;
        } else rejected.set(outcome.reason, (rejected.get(outcome.reason) ?? 0) + 1);
    }
    return {
        accepted,
        ownershipOnly,
        rejected: [...rejected]
            .map(([reason, count]) => ({ reason, count }))
            .toSorted((left, right) => right.count - left.count),
    };
}

/**
 * Why the Commander refused an entry, in the user's words.
 */
export const handoverRejectionLabelKeys: Record<CommanderHandoverRejection, TranslationKey> = {
    already_managed: 'agentCommander.handover.rejection.alreadyManaged',
    commander_session: 'agentCommander.handover.rejection.commanderSession',
    commander_unavailable: 'agentCommander.handover.rejection.commanderUnavailable',
    conversation_bound: 'agentCommander.handover.rejection.conversationBound',
    conversation_missing: 'agentCommander.handover.rejection.conversationMissing',
    duplicate: 'agentCommander.handover.rejection.duplicate',
    ownership_capacity: 'agentCommander.handover.rejection.ownershipCapacity',
    project_unavailable: 'agentCommander.handover.rejection.projectUnavailable',
    session_archived: 'agentCommander.handover.rejection.sessionArchived',
    session_missing: 'agentCommander.handover.rejection.sessionMissing',
    task_capacity: 'agentCommander.handover.rejection.taskCapacity',
};
