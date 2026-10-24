import { useEffect, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { findAgentChatTask } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { publishAgentChatTaskLinks, withdrawAgentChatTaskLinks } from './agent-chat-task-links';
import type { AgentChatTaskPill } from './agent-chat-tasks';
import {
    agentChatTaskPill,
    agentChatTaskPillIds,
    agentChatTaskSheetPill,
} from './agent-chat-tasks';
import type { AgentChatController } from './use-agent-chat';
import { useAgentChatTaskStop } from './use-agent-chat-task-detail';

/**
 * The Chat's background work for the status row and its sheet: the pill the row's badge shows while anything runs
 * (`agentChatTaskPill`), whether the sheet is open, and what it lists. A saved copy has no pill, since its tasks may
 * have ended long ago. It also publishes the Chat's tasks for background command rows (`agent-chat-task-links.ts`), so
 * a row's detail can show the same live output.
 */
export const useAgentChatTaskSheet = ({
    chat,
    deviceRole,
    isConnected,
}: {
    chat: AgentChatController;
    deviceRole: 'view' | 'reply' | 'control' | null;
    isConnected: boolean;
}) => {
    const { savedAt, snapshot } = chat;
    const { t } = useTranslation();
    const terminalId = snapshot?.terminalId;
    const tasks = savedAt === undefined ? snapshot?.tasks : undefined;
    const canControl = deviceRole === 'control' && isConnected;
    const [isOpen, setOpen] = useState(false);
    const [openTask, setOpenTask] = useState<AgentChatTask | undefined>();
    const [listedKey, setListedKey] = useState('');
    const stopper = useAgentChatTaskStop(terminalId ?? '');

    useEffect(() => {
        if (terminalId !== undefined)
            publishAgentChatTaskLinks(terminalId, tasks ?? [], canControl);
    }, [canControl, tasks, terminalId]);
    useEffect(() => {
        if (terminalId === undefined) return;
        return () => withdrawAgentChatTaskLinks(terminalId);
    }, [terminalId]);

    const pill = agentChatTaskPill(savedAt === undefined ? snapshot : undefined, t);
    const pillIdsKey = agentChatTaskPillIds(pill).join('\n');
    // An open sheet remembers what it last listed, so a pill that drops to nothing leaves that list in place.
    if (isOpen && pillIdsKey && pillIdsKey !== listedKey) setListedKey(pillIdsKey);
    const sheetPill: AgentChatTaskPill | undefined = isOpen
        ? agentChatTaskSheetPill(pill, listedKey ? listedKey.split('\n') : [], tasks, t)
        : pill;
    // The open task follows the Chat's copy; one the phone's list no longer carries keeps its last known state.
    const shownTask = openTask && (findAgentChatTask(tasks, openTask.id) ?? openTask);
    return {
        canControl,
        close: (): void => {
            setOpen(false);
            setOpenTask(undefined);
            setListedKey('');
        },
        isOpen: isOpen && terminalId !== undefined,
        open: (): void => setOpen(true),
        openTask: (taskId: string): void => setOpenTask(findAgentChatTask(tasks, taskId)),
        backToList: (): void => setOpenTask(undefined),
        /**
         * Undefined without a terminal, since a task's detail and Stop are addressed through it.
         */
        pill: terminalId === undefined ? undefined : pill,
        sheetPill,
        shownTask,
        stopper,
        terminalId,
    };
};

export type AgentChatTaskSheetState = ReturnType<typeof useAgentChatTaskSheet>;
