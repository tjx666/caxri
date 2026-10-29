import type {
    BotBoard,
    BotBoardRow,
    BotConversation,
    BotConversationReference,
    BotHandoverRejection,
    BotHandoverResult,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { sessionTitleForDisplay } from '../session/session-title';

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
    conversation?: BotConversationReference;
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

function conversationCandidateKey(conversation: BotConversationReference): string {
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
 * The user's Sessions Caxri Bot does not manage yet, matching `query` by Session or Project title. `keep` names
 * Sessions to list even though Caxri Bot now manages them: the ones the last request refused, which the dialog keeps in
 * place beside their reason instead of letting them vanish when the board refreshes.
 */
export function handoverSessionGroups(
    rows: readonly BotBoardRow[],
    query: string,
    keep: ReadonlySet<string>,
    t: Translate,
): HandoverCandidateGroup[] {
    return groupCandidates(
        rows
            .filter(
                (row) =>
                    (!row.botSession || keep.has(row.sessionId)) &&
                    isMatch(query, row.sessionTitle, row.projectTitle),
            )
            .map((row) => ({
                group: { key: row.projectId, title: row.projectTitle },
                candidate: {
                    key: row.sessionId,
                    title: sessionTitleForDisplay(row.sessionTitle, t),
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
    conversations: readonly BotConversation[],
    projects: BotBoard['projects'],
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
): { sessionIds: string[]; conversations: BotConversationReference[] } {
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
 * What one hand-over request achieved: how many entries Caxri Bot took, how many of those it can only own (no
 * conversation to continue), and each refusal reason with its count, most frequent first.
 */
export interface HandoverSummary {
    accepted: number;
    ownershipOnly: number;
    rejected: Array<{ reason: BotHandoverRejection; count: number }>;
    /**
     * Each refused entry's reason by its picker key (the Session ID, or `provider:conversation`), so the dialog can
     * show the reason on the row itself.
     */
    rejectedByKey: Map<string, BotHandoverRejection>;
}

export function summarizeHandover(result: BotHandoverResult): HandoverSummary {
    const rejected = new Map<BotHandoverRejection, number>();
    const rejectedByKey = new Map<string, BotHandoverRejection>();
    let accepted = 0;
    let ownershipOnly = 0;
    for (const outcome of result.outcomes) {
        if (outcome.outcome === 'accepted') {
            accepted += 1;
            if (outcome.ownershipReason) ownershipOnly += 1;
            continue;
        }
        rejected.set(outcome.reason, (rejected.get(outcome.reason) ?? 0) + 1);
        const key =
            outcome.sessionId ??
            (outcome.conversation && conversationCandidateKey(outcome.conversation));
        // A duplicate names an entry that was also handled on its own; its first outcome is the one that counts.
        if (key && !rejectedByKey.has(key)) rejectedByKey.set(key, outcome.reason);
    }
    return {
        accepted,
        ownershipOnly,
        rejectedByKey,
        rejected: [...rejected]
            .map(([reason, count]) => ({ reason, count }))
            .toSorted((left, right) => right.count - left.count),
    };
}

/**
 * Why Caxri Bot refused an entry, in the user's words.
 */
export const handoverRejectionLabelKeys: Record<BotHandoverRejection, TranslationKey> = {
    already_managed: 'caxriBot.handover.rejection.alreadyManaged',
    bot_session: 'caxriBot.handover.rejection.botSession',
    bot_unavailable: 'caxriBot.handover.rejection.botUnavailable',
    conversation_bound: 'caxriBot.handover.rejection.conversationBound',
    conversation_missing: 'caxriBot.handover.rejection.conversationMissing',
    duplicate: 'caxriBot.handover.rejection.duplicate',
    ownership_capacity: 'caxriBot.handover.rejection.ownershipCapacity',
    project_unavailable: 'caxriBot.handover.rejection.projectUnavailable',
    session_archived: 'caxriBot.handover.rejection.sessionArchived',
    session_missing: 'caxriBot.handover.rejection.sessionMissing',
    task_capacity: 'caxriBot.handover.rejection.taskCapacity',
};
