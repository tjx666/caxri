import { useState } from 'react';

import type { BotDataSummary } from '@caxri/protocol';
import type { UseQueryResult } from '@tanstack/react-query';

import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { useCaxriQuery } from '../../../queries/client';
import type { BotClearDataSelection, BotTaskCounts } from '../bot-clear-data';
import {
    botClearDataRequest,
    botTaskCounts,
    defaultBotClearDataSelection,
} from '../bot-clear-data';
import { clearBotData } from '../bot-data-commands';

export interface BotClearDataState {
    counts?: BotTaskCounts;
    isSubmitting: boolean;
    /**
     * The request the current selection stands for; `undefined` while it would clear nothing.
     */
    request: ReturnType<typeof botClearDataRequest>;
    selection?: BotClearDataSelection;
    summary: UseQueryResult<BotDataSummary>;
    data?: BotDataSummary;
    update: (patch: Partial<BotClearDataSelection>) => void;
    toggleTask: (taskId: string, isChecked: boolean) => void;
    submit: () => Promise<void>;
}

/**
 * The Clear Caxri Bot Data dialog's selection and submission. The summary is read fresh on every open (the dialog body
 * mounts per request), and the selection starts from its default once the summary lands.
 */
export function useBotClearData(): BotClearDataState {
    const summary = useCaxriQuery('bot.data', {}, { staleTime: 0, gcTime: 0 });
    const { data } = summary;
    const [edited, setEdited] = useState<BotClearDataSelection>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const selection = edited ?? (data && defaultBotClearDataSelection(data));
    const counts = data && botTaskCounts(data);
    const request = selection && counts && botClearDataRequest(selection, counts);
    const update = (patch: Partial<BotClearDataSelection>): void => {
        if (selection) setEdited({ ...selection, ...patch });
    };
    return {
        counts,
        data,
        isSubmitting,
        request,
        selection,
        summary,
        update,
        toggleTask: (taskId, isChecked) => {
            if (!selection) return;
            const chosenTaskIds = new Set(selection.chosenTaskIds);
            if (isChecked) chosenTaskIds.add(taskId);
            else chosenTaskIds.delete(taskId);
            update({ chosenTaskIds });
        },
        submit: async () => {
            if (!request || isSubmitting) return;
            setIsSubmitting(true);
            await awaitThenCleanup(clearBotData(request), () => setIsSubmitting(false));
        },
    };
}
