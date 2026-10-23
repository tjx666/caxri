import { formatBytes } from '@caxri/utils';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Alert } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { hasLearnedMemory, isMemoryStillInConversation } from './commander-clear-data';
import { CommanderClearDataOption } from './commander-clear-data-option';
import { CommanderClearDataTasks } from './commander-clear-data-tasks';
import { commanderAgentName } from './commander-data-commands';
import { closeCommanderClearData, useCommanderDialogsStore } from './commander-dialogs-store';
import type { CommanderClearDataState } from './hooks/use-commander-clear-data';
import { useCommanderClearData } from './hooks/use-commander-clear-data';

/**
 * Clear Commander Data: a browser-style list of what the Commander keeps, each with its size, ticked one by one. Only
 * Commander-owned data is offered; Sessions, their Terminals, and the user's repositories are never touched. Desktop
 * Main asks the native destructive confirmation before anything goes. The body mounts per open, so every open re-reads
 * the sizes and starts from the default selection.
 */
export function CommanderClearDataDialog() {
    const requestId = useCommanderDialogsStore((state) => state.clearDataRequestId);
    return (
        <Dialog
            open={requestId !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) closeCommanderClearData();
            }}
        >
            <DialogContent className="commander-clear-data-dialog grid max-h-[calc(100vh-48px)] w-[min(560px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
                {requestId !== undefined && <ClearDataBody key={requestId} />}
            </DialogContent>
        </Dialog>
    );
}

function ClearDataBody() {
    const { t } = useTranslation();
    const state = useCommanderClearData();
    const { counts, data, selection, summary } = state;
    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('agentCommander.clearData.title')}</DialogTitle>
                <DialogDescription>{t('agentCommander.clearData.description')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto px-4 py-3">
                {summary.isError ? (
                    <Alert variant="danger" className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                            {t('agentCommander.clearData.loadFailed')}
                        </span>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                                // Fire-and-forget: a failed retry lands back in this same error state.
                                void summary.refetch();
                            }}
                        >
                            {t('common.retry')}
                        </Button>
                    </Alert>
                ) : !data || !selection || !counts ? (
                    <LoadingSkeleton variant="list" label={t('agentCommander.clearData.loading')} />
                ) : (
                    <ClearDataOptions state={state} />
                )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                <Button variant="ghost" onClick={() => closeCommanderClearData()}>
                    {t('common.cancel')}
                </Button>
                <Button
                    aria-busy={state.isSubmitting}
                    className="commander-clear-data-submit"
                    disabled={!state.request || state.isSubmitting}
                    onClick={() => {
                        void state.submit();
                    }}
                >
                    {state.isSubmitting && <Spinner />}
                    {t('agentCommander.clearData.submit')}
                </Button>
            </div>
        </>
    );
}

/**
 * The loaded list: one option per kind of Commander data, and the warning when cleared memory stays in the
 * conversation.
 */
function ClearDataOptions({ state }: { state: CommanderClearDataState }) {
    const { t } = useTranslation();
    const { counts, data, selection } = state;
    if (!data || !selection || !counts) return null;
    const agent = commanderAgentName(data.conversation.agent);
    return (
        <div className="grid gap-1">
            <CommanderClearDataOption
                id="tasks"
                title={t('agentCommander.clearData.tasks')}
                description={t('agentCommander.clearData.tasksDescription')}
                meta={t('agentCommander.clearData.tasksMeta', {
                    open: counts.open,
                    closed: counts.closed,
                })}
                isChecked={selection.tasks}
                isDisabled={counts.all === 0}
                onCheckedChange={(tasks) => state.update({ tasks })}
            >
                {selection.tasks && <CommanderClearDataTasks state={state} />}
            </CommanderClearDataOption>
            <CommanderClearDataOption
                id="taskFiles"
                title={t('agentCommander.clearData.taskFiles')}
                description={t('agentCommander.clearData.taskFilesDescription')}
                meta={t(
                    data.taskFiles.count === 1
                        ? 'agentCommander.clearData.taskFilesMetaOne'
                        : 'agentCommander.clearData.taskFilesMeta',
                    {
                        count: data.taskFiles.count,
                        size: formatBytes(data.taskFiles.bytes),
                    },
                )}
                isChecked={selection.taskFiles}
                isDisabled={data.taskFiles.count === 0}
                onCheckedChange={(taskFiles) => state.update({ taskFiles })}
            />
            <CommanderClearDataOption
                id="inbox"
                title={t('agentCommander.window.needsYou')}
                description={t('agentCommander.clearData.inboxDescription')}
                meta={t('agentCommander.clearData.inboxMeta', data.inbox)}
                isChecked={selection.inbox}
                isDisabled={data.inbox.open + data.inbox.closed === 0}
                onCheckedChange={(inbox) => state.update({ inbox })}
            />
            <CommanderClearDataOption
                id="memory"
                title={t('agentCommander.clearData.memory')}
                description={t('agentCommander.clearData.memoryDescription')}
                meta={t(
                    hasLearnedMemory(data)
                        ? 'agentCommander.clearData.memoryLearned'
                        : 'agentCommander.clearData.memoryEmpty',
                )}
                isChecked={selection.memory}
                isDisabled={!hasLearnedMemory(data)}
                onCheckedChange={(memory) => state.update({ memory })}
            />
            <CommanderClearDataOption
                id="instructions"
                title={t('agentCommander.clearData.instructions')}
                description={t(
                    selection.memory
                        ? 'agentCommander.clearData.instructionsWithMemory'
                        : 'agentCommander.clearData.instructionsDescription',
                )}
                meta="AGENTS.md"
                isChecked={selection.instructions || selection.memory}
                isDisabled={selection.memory}
                onCheckedChange={(instructions) => state.update({ instructions })}
            />
            <CommanderClearDataOption
                id="conversation"
                title={t('agentCommander.clearData.conversation')}
                description={t('agentCommander.clearData.conversationDescription', {
                    agent,
                })}
                meta={
                    data.conversation.isBound
                        ? agent
                        : t('agentCommander.clearData.conversationNone')
                }
                isChecked={selection.conversation}
                isDisabled={!data.conversation.isBound}
                onCheckedChange={(conversation) => state.update({ conversation })}
            />
            {isMemoryStillInConversation(selection, data) && (
                <Alert variant="warning" className="commander-clear-data-still-known mt-1">
                    {t('agentCommander.clearData.stillInConversation', { agent })}
                </Alert>
            )}
        </div>
    );
}
