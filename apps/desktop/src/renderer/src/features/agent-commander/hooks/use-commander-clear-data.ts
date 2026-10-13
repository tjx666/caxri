import { useState } from 'react';

import type { CommanderDataSummary } from '@caxri/protocol';
import type { UseQueryResult } from '@tanstack/react-query';

import { useCaxriQuery } from '../../../queries/client';
import type { CommanderClearDataSelection, CommanderTaskCounts } from '../commander-clear-data';
import {
    commanderClearDataRequest,
    commanderTaskCounts,
    defaultCommanderClearDataSelection,
} from '../commander-clear-data';
import { clearCommanderData } from '../commander-data-commands';

export interface CommanderClearDataState {
    counts?: CommanderTaskCounts;
    isSubmitting: boolean;
    /**
     * The request the current selection stands for; `undefined` while it would clear nothing.
     */
    request: ReturnType<typeof commanderClearDataRequest>;
    selection?: CommanderClearDataSelection;
    summary: UseQueryResult<CommanderDataSummary>;
    data?: CommanderDataSummary;
    update: (patch: Partial<CommanderClearDataSelection>) => void;
    toggleTask: (taskId: string, isChecked: boolean) => void;
    submit: () => Promise<void>;
}

/**
 * The Clear Commander Data dialog's selection and submission. The summary is read fresh on every open (the dialog body
 * mounts per request), and the selection starts from its default once the summary lands.
 */
export function useCommanderClearData(): CommanderClearDataState {
    const summary = useCaxriQuery('commander.data', {}, { staleTime: 0, gcTime: 0 });
    const { data } = summary;
    const [edited, setEdited] = useState<CommanderClearDataSelection>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const selection = edited ?? (data && defaultCommanderClearDataSelection(data));
    const counts = data && commanderTaskCounts(data);
    const request = selection && counts && commanderClearDataRequest(selection, counts);
    const update = (patch: Partial<CommanderClearDataSelection>): void => {
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
            try {
                await clearCommanderData(request);
            } finally {
                setIsSubmitting(false);
            }
        },
    };
}
