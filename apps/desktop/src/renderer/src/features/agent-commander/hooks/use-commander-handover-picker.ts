import { useMemo, useState } from 'react';

import type { CommanderHandoverRejection } from '@caxri/protocol';
import { MAX_COMMANDER_HANDOVER_BATCH } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { useCaxriQuery } from '../../../queries/client';
import type { HandoverCandidateGroup, HandoverSummary } from '../commander-handover';
import {
    handoverConversationGroups,
    handoverRequestEntries,
    handoverSessionGroups,
} from '../commander-handover';
import { handOverToCommander } from '../commander-handover-commands';
import type { ToggleCandidates } from '../commander-handover-list';

export type HandoverTab = 'sessions' | 'conversations';

const NO_GROUPS: HandoverCandidateGroup[] = [];
const NO_REFUSALS: ReadonlyMap<string, CommanderHandoverRejection> = new Map();

/**
 * State behind the hand-over picker: the two candidate lists, one selection across both tabs, the shared note, and the
 * submission. Search narrows what the list shows, never what stays selected, so switching tabs or clearing the search
 * keeps every pick.
 *
 * A partly refused request leaves the refused entries selected where they were, each with its reason, so the user can
 * fix or deselect them and submit again; accepted ones leave the list once the board refreshes.
 */
export function useCommanderHandoverPicker({
    isFromWorkbench,
    initialSessionIds,
    isOpen,
    onDone,
}: {
    isFromWorkbench: boolean;
    initialSessionIds: readonly string[];
    /**
     * Whether the dialog that owns this picker is still open, asked when an answer arrives.
     */
    isOpen: () => boolean;
    onDone: () => void;
}) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<HandoverTab>('sessions');
    const [query, setQuery] = useState('');
    const [note, setNote] = useState('');
    const [selection, setSelection] = useState<ReadonlySet<string>>(
        () => new Set(initialSessionIds),
    );
    const [isSubmitting, setSubmitting] = useState(false);
    const [outcome, setOutcome] = useState<
        Pick<HandoverSummary, 'accepted' | 'rejected' | 'rejectedByKey'> | undefined
    >();
    const refusedByKey = outcome?.rejectedByKey ?? NO_REFUSALS;
    const board = useCaxriQuery('commander.board', undefined);
    /**
     * Discovery reads the Agent CLIs' own history folders, so it waits until the user opens its tab.
     */
    const [hasOpenedConversations, setOpenedConversations] = useState(false);
    const conversations = useCaxriQuery('commander.conversations', undefined, {
        enabled: hasOpenedConversations,
        staleTime: 30_000,
    });
    const untitled = t('agentCommander.handover.untitledConversation');
    const rows = board.data?.rows;
    const projects = board.data?.projects;
    const conversationList = conversations.data?.conversations;
    const refusedKeys = useMemo(() => new Set(refusedByKey.keys()), [refusedByKey]);
    const sessionGroups = useMemo(
        () => (rows ? handoverSessionGroups(rows, query, refusedKeys) : NO_GROUPS),
        [query, refusedKeys, rows],
    );
    const conversationGroups = useMemo(
        () =>
            conversationList && projects
                ? handoverConversationGroups(conversationList, projects, query, untitled)
                : NO_GROUPS,
        [conversationList, projects, query, untitled],
    );
    /**
     * Every candidate regardless of the search, so a pick the search now hides is still handed over.
     */
    const allCandidates = useMemo(
        () =>
            [
                ...(rows ? handoverSessionGroups(rows, '', refusedKeys) : NO_GROUPS),
                ...(conversationList && projects
                    ? handoverConversationGroups(conversationList, projects, '', untitled)
                    : NO_GROUPS),
            ].flatMap((group) => group.candidates),
        [conversationList, projects, refusedKeys, rows, untitled],
    );
    const selected = allCandidates.filter((candidate) => selection.has(candidate.key));
    const toggle: ToggleCandidates = (keys, isChecked) => {
        setSelection((previous) => {
            const next = new Set(previous);
            for (const key of keys)
                if (isChecked) next.add(key);
                else next.delete(key);
            return next;
        });
    };
    const changeTab = (next: HandoverTab): void => {
        setTab(next);
        if (next === 'conversations') setOpenedConversations(true);
    };
    /**
     * How many entries past the Server's per-request cap are selected; submitting is blocked until it is zero.
     */
    const overLimitCount = Math.max(0, selected.length - MAX_COMMANDER_HANDOVER_BATCH);
    const submit = async (): Promise<void> => {
        if (isSubmitting || selected.length === 0 || overLimitCount > 0) return;
        setSubmitting(true);
        const summary: HandoverSummary | undefined = await awaitThenCleanup(
            handOverToCommander(
                { ...handoverRequestEntries(selection, allCandidates), note },
                { isFromWorkbench, isReportedInPlace: isOpen },
            ),
            () => setSubmitting(false),
        );
        if (!summary) return;
        if (summary.rejected.length === 0) {
            onDone();
            return;
        }
        // Accepted entries leave the lists once the board refreshes; what stays selected is what the Commander refused.
        setOutcome(summary);
        setSelection(new Set(summary.rejectedByKey.keys()));
    };
    return {
        board,
        conversations,
        groups: tab === 'sessions' ? sessionGroups : conversationGroups,
        isSubmitting,
        note,
        overLimitCount,
        outcome,
        query,
        refusedByKey,
        selectedCount: selected.length,
        selectedMayBeOpenCount: selected.filter((candidate) => candidate.mayBeOpen).length,
        selection,
        setNote,
        setQuery,
        setTab: changeTab,
        submit,
        tab,
        tabCounts: {
            sessions: allCandidates.filter((candidate) => candidate.sessionId).length,
            conversations: conversationList?.length,
        },
        toggle,
    };
}
