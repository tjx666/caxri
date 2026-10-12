import { useMemo, useState } from 'react';

import { useTranslation } from '../../../i18n';
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

/**
 * State behind the hand-over picker: the two candidate lists, one selection across both tabs, the shared note, and the
 * submission. Search narrows what the list shows, never what stays selected, so switching tabs or clearing the search
 * keeps every pick.
 */
export function useCommanderHandoverPicker({
    isFromWorkbench,
    initialSessionIds,
    onDone,
}: {
    isFromWorkbench: boolean;
    initialSessionIds: readonly string[];
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
    const [refused, setRefused] = useState<HandoverSummary['rejected']>([]);
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
    const sessionGroups = useMemo(
        () => (rows ? handoverSessionGroups(rows, query) : NO_GROUPS),
        [query, rows],
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
                ...(rows ? handoverSessionGroups(rows, '') : NO_GROUPS),
                ...(conversationList && projects
                    ? handoverConversationGroups(conversationList, projects, '', untitled)
                    : NO_GROUPS),
            ].flatMap((group) => group.candidates),
        [conversationList, projects, rows, untitled],
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
    const submit = async (): Promise<void> => {
        if (isSubmitting || selected.length === 0) return;
        setSubmitting(true);
        let summary: HandoverSummary | undefined;
        try {
            summary = await handOverToCommander(
                { ...handoverRequestEntries(selection, allCandidates), note },
                { isFromWorkbench },
            );
        } finally {
            setSubmitting(false);
        }
        if (!summary) return;
        if (summary.rejected.length === 0) {
            onDone();
            return;
        }
        // Accepted entries leave the lists once the board refreshes; what stays is what the Commander refused.
        setRefused(summary.rejected);
        setSelection(new Set());
    };
    return {
        board,
        conversations,
        groups: tab === 'sessions' ? sessionGroups : conversationGroups,
        isSubmitting,
        note,
        query,
        refused,
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
