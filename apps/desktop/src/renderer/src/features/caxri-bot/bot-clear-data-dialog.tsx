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
import { hasLearnedMemory, isMemoryStillInConversation } from './bot-clear-data';
import { BotClearDataOption } from './bot-clear-data-option';
import { BotClearDataTasks } from './bot-clear-data-tasks';
import { botAgentName } from './bot-data-commands';
import { closeBotClearData, useBotDialogsStore } from './bot-dialogs-store';
import type { BotClearDataState } from './hooks/use-bot-clear-data';
import { useBotClearData } from './hooks/use-bot-clear-data';

/**
 * Clear Caxri Bot Data: a browser-style list of what Caxri Bot keeps, each with its size, ticked one by one. Only Caxri
 * Bot-owned data is offered; Sessions, their Terminals, and the user's repositories are never touched. Desktop Main
 * asks the native destructive confirmation before anything goes. The body mounts per open, so every open re-reads the
 * sizes and starts from the default selection.
 */
export function BotClearDataDialog() {
    const requestId = useBotDialogsStore((state) => state.clearDataRequestId);
    return (
        <Dialog
            open={requestId !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) closeBotClearData();
            }}
        >
            <DialogContent className="bot-clear-data-dialog grid max-h-[calc(100vh-48px)] w-[min(560px,calc(100vw-48px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
                {requestId !== undefined && <ClearDataBody key={requestId} />}
            </DialogContent>
        </Dialog>
    );
}

function ClearDataBody() {
    const { t } = useTranslation();
    const state = useBotClearData();
    const { counts, data, selection, summary } = state;
    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('caxriBot.clearData.title')}</DialogTitle>
                <DialogDescription>{t('caxriBot.clearData.description')}</DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto px-4 py-3">
                {summary.isError ? (
                    <Alert variant="danger" className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">{t('caxriBot.clearData.loadFailed')}</span>
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
                    <LoadingSkeleton variant="list" label={t('caxriBot.clearData.loading')} />
                ) : (
                    <ClearDataOptions state={state} />
                )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
                <Button variant="ghost" onClick={() => closeBotClearData()}>
                    {t('common.cancel')}
                </Button>
                <Button
                    aria-busy={state.isSubmitting}
                    className="bot-clear-data-submit"
                    disabled={!state.request || state.isSubmitting}
                    onClick={() => {
                        void state.submit();
                    }}
                >
                    {state.isSubmitting && <Spinner />}
                    {t('caxriBot.clearData.submit')}
                </Button>
            </div>
        </>
    );
}

/**
 * The loaded list: one option per kind of Caxri Bot data, and the warning when cleared memory stays in the
 * conversation.
 */
function ClearDataOptions({ state }: { state: BotClearDataState }) {
    const { t } = useTranslation();
    const { counts, data, selection } = state;
    if (!data || !selection || !counts) return null;
    const agent = botAgentName(data.conversation.agent);
    return (
        <div className="grid gap-1">
            <BotClearDataOption
                id="tasks"
                title={t('caxriBot.clearData.tasks')}
                description={t('caxriBot.clearData.tasksDescription')}
                meta={t('caxriBot.clearData.tasksMeta', {
                    open: counts.open,
                    closed: counts.closed,
                })}
                isChecked={selection.tasks}
                isDisabled={counts.all === 0}
                onCheckedChange={(tasks) => state.update({ tasks })}
            >
                {selection.tasks && <BotClearDataTasks state={state} />}
            </BotClearDataOption>
            <BotClearDataOption
                id="taskFiles"
                title={t('caxriBot.clearData.taskFiles')}
                description={t('caxriBot.clearData.taskFilesDescription')}
                meta={t(
                    data.taskFiles.count === 1
                        ? 'caxriBot.clearData.taskFilesMetaOne'
                        : 'caxriBot.clearData.taskFilesMeta',
                    {
                        count: data.taskFiles.count,
                        size: formatBytes(data.taskFiles.bytes),
                    },
                )}
                isChecked={selection.taskFiles}
                isDisabled={data.taskFiles.count === 0}
                onCheckedChange={(taskFiles) => state.update({ taskFiles })}
            />
            <BotClearDataOption
                id="inbox"
                title={t('caxriBot.window.needsYou')}
                description={t('caxriBot.clearData.inboxDescription')}
                meta={t('caxriBot.clearData.inboxMeta', data.inbox)}
                isChecked={selection.inbox}
                isDisabled={data.inbox.open + data.inbox.closed === 0}
                onCheckedChange={(inbox) => state.update({ inbox })}
            />
            <BotClearDataOption
                id="memory"
                title={t('caxriBot.clearData.memory')}
                description={t('caxriBot.clearData.memoryDescription')}
                meta={t(
                    hasLearnedMemory(data)
                        ? 'caxriBot.clearData.memoryLearned'
                        : 'caxriBot.clearData.memoryEmpty',
                )}
                isChecked={selection.memory}
                isDisabled={!hasLearnedMemory(data)}
                onCheckedChange={(memory) => state.update({ memory })}
            />
            <BotClearDataOption
                id="instructions"
                title={t('caxriBot.clearData.instructions')}
                description={t(
                    selection.memory
                        ? 'caxriBot.clearData.instructionsWithMemory'
                        : 'caxriBot.clearData.instructionsDescription',
                )}
                meta="AGENTS.md"
                isChecked={selection.instructions || selection.memory}
                isDisabled={selection.memory}
                onCheckedChange={(instructions) => state.update({ instructions })}
            />
            <BotClearDataOption
                id="conversation"
                title={t('caxriBot.clearData.conversation')}
                description={t('caxriBot.clearData.conversationDescription', {
                    agent,
                })}
                meta={data.conversation.isBound ? agent : t('caxriBot.clearData.conversationNone')}
                isChecked={selection.conversation}
                isDisabled={!data.conversation.isBound}
                onCheckedChange={(conversation) => state.update({ conversation })}
            />
            {isMemoryStillInConversation(selection, data) && (
                <Alert variant="warning" className="bot-clear-data-still-known mt-1">
                    {t('caxriBot.clearData.stillInConversation', { agent })}
                </Alert>
            )}
        </div>
    );
}
