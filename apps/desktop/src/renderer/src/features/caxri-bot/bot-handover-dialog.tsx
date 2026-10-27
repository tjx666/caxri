import type { KeyboardEvent } from 'react';

import { formatShortcut, MAX_BOT_HANDOVER_BATCH } from '@caxri/protocol';
import { Search } from 'lucide-react';

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
import { Input } from '../../components/ui/input';
import { Kbd } from '../../components/ui/kbd';
import { Spinner } from '../../components/ui/spinner';
import { Textarea } from '../../components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import { isImeComposing } from '../../lib/ime';
import { handoverRejectionLabelKeys } from './bot-handover';
import { BotHandoverList } from './bot-handover-list';
import { closeBotHandover, useBotHandoverStore } from './bot-handover-store';
import type { HandoverTab } from './hooks/use-bot-handover-picker';
import { useBotHandoverPicker } from './hooks/use-bot-handover-picker';

const SUBMIT_SHORTCUT = 'cmd+enter';

/**
 * Hands Sessions, or Agent conversations started outside Caxri, to Caxri Bot in one batch. Mounted in both windows: the
 * Workbench opens it from a Session's menu with that Session selected, the Caxri Bot window from its title bar. The
 * body mounts per open (see `ArchivedSessionsDialog`), so each open starts from its own request.
 */
export function BotHandoverDialog({ isFromWorkbench }: { isFromWorkbench: boolean }) {
    const request = useBotHandoverStore((state) => state.request);
    return (
        <Dialog
            open={request !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) closeBotHandover();
            }}
        >
            <DialogContent className="bot-handover-dialog grid h-[min(720px,calc(100vh-48px))] w-[min(760px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                {request && (
                    <HandoverDialogBody
                        key={request.id}
                        isFromWorkbench={isFromWorkbench}
                        initialSessionIds={request.sessionIds}
                        requestId={request.id}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function HandoverDialogBody({
    isFromWorkbench,
    initialSessionIds,
    requestId,
}: {
    isFromWorkbench: boolean;
    initialSessionIds: readonly string[];
    requestId: number;
}) {
    const { t } = useTranslation();
    const picker = useBotHandoverPicker({
        isFromWorkbench,
        initialSessionIds,
        // A reopened dialog is a new request: an answer for the closed one is no longer shown in place.
        isOpen: () => useBotHandoverStore.getState().request?.id === requestId,
        onDone: closeBotHandover,
    });
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (isImeComposing(event) || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey))
            return;
        event.preventDefault();
        void picker.submit();
    };
    return (
        <div className="contents" onKeyDown={onKeyDown}>
            <DialogHeader>
                <DialogTitle>{t('caxriBot.handover.title')}</DialogTitle>
                <DialogDescription>{t('caxriBot.handover.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 border-b border-border px-4 pb-3">
                <ToggleGroup
                    aria-label={t('caxriBot.handover.sourceLabel')}
                    value={[picker.tab]}
                    onValueChange={(next: HandoverTab[]) => {
                        const picked = next.at(0);
                        if (picked) picker.setTab(picked);
                    }}
                >
                    <ToggleGroupItem value="sessions" className="bot-handover-tab-sessions">
                        {t('caxriBot.handover.sessionsTab')}
                        <span className="tabular-nums opacity-70">{picker.tabCounts.sessions}</span>
                    </ToggleGroupItem>
                    <ToggleGroupItem
                        value="conversations"
                        className="bot-handover-tab-conversations"
                    >
                        {t('caxriBot.handover.conversationsTab')}
                        {picker.tabCounts.conversations !== undefined && (
                            <span className="tabular-nums opacity-70">
                                {picker.tabCounts.conversations}
                            </span>
                        )}
                    </ToggleGroupItem>
                </ToggleGroup>
                <span className="relative block">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
                        size={14}
                    />
                    <Input
                        autoFocus
                        aria-label={t('common.search')}
                        className="bot-handover-search pl-8"
                        placeholder={t(
                            picker.tab === 'sessions'
                                ? 'caxriBot.handover.searchSessions'
                                : 'caxriBot.handover.searchConversations',
                        )}
                        value={picker.query}
                        onChange={(event) => picker.setQuery(event.target.value)}
                    />
                </span>
            </div>
            <div className="min-h-0 overflow-auto p-4">
                <HandoverCandidates picker={picker} />
            </div>
            <div className="grid gap-2 border-t border-border px-4 py-3">
                {picker.outcome && picker.outcome.rejected.length > 0 && (
                    <Alert variant="warning" className="bot-handover-refused">
                        {picker.outcome.accepted > 0
                            ? t('caxriBot.handover.partlyAccepted', {
                                  accepted: picker.outcome.accepted,
                                  refused: picker.outcome.rejectedByKey.size,
                              })
                            : t('caxriBot.handover.noneAccepted', {
                                  reason: t(
                                      handoverRejectionLabelKeys[picker.outcome.rejected[0].reason],
                                  ),
                              })}
                    </Alert>
                )}
                {picker.overLimitCount > 0 && (
                    <Alert variant="warning" className="bot-handover-over-limit">
                        {t('caxriBot.handover.tooMany', {
                            max: MAX_BOT_HANDOVER_BATCH,
                            excess: picker.overLimitCount,
                        })}
                    </Alert>
                )}
                {picker.selectedMayBeOpenCount > 0 && (
                    <Alert variant="warning">{t('caxriBot.handover.mayBeOpenWarning')}</Alert>
                )}
                <Textarea
                    aria-label={t('caxriBot.handover.noteLabel')}
                    className="bot-handover-note min-h-14"
                    maxLength={2_000}
                    placeholder={t('caxriBot.handover.notePlaceholder')}
                    rows={2}
                    value={picker.note}
                    onChange={(event) => picker.setNote(event.target.value)}
                />
                <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-[11px] text-muted">
                        {t('caxriBot.handover.takeBackHint')}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums" aria-live="polite">
                        {t('caxriBot.handover.selectedCount', {
                            count: picker.selectedCount,
                        })}
                    </span>
                    <Button variant="ghost" onClick={closeBotHandover}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        aria-busy={picker.isSubmitting}
                        className="bot-handover-submit"
                        disabled={
                            picker.selectedCount === 0 ||
                            picker.overLimitCount > 0 ||
                            picker.isSubmitting
                        }
                        onClick={() => {
                            void picker.submit();
                        }}
                    >
                        {picker.isSubmitting ? (
                            <>
                                <Spinner />
                                {t('caxriBot.handover.submitting')}
                            </>
                        ) : (
                            <>
                                {t('caxriBot.handover.submit')}
                                <Kbd size="compact">{formatShortcut(SUBMIT_SHORTCUT)}</Kbd>
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * The current tab's candidates, or why there are none: still loading, failed, nothing to offer, or nothing matching.
 * The Sessions tab waits on a board read and draws the rows it is about to show; the conversation search keeps its
 * Spinner because its copy tells the user which Agent histories it is reading, which can take a moment.
 */
function HandoverCandidates({ picker }: { picker: ReturnType<typeof useBotHandoverPicker> }) {
    const { t } = useTranslation();
    const isSessions = picker.tab === 'sessions';
    const source = isSessions ? picker.board : picker.conversations;
    if (isSessions && source.isPending)
        return (
            <LoadingSkeleton
                variant="list"
                className="bot-handover-loading"
                label={t('caxriBot.handover.loadingSessions')}
            />
        );
    if (source.isPending)
        return (
            <div className="grid min-h-40 place-items-center text-[12px] text-muted">
                <span className="flex items-center gap-2">
                    <Spinner />
                    {t('caxriBot.handover.loadingConversations')}
                </span>
            </div>
        );
    if (source.isError)
        return (
            <Alert variant="danger" className="bot-handover-load-failed flex items-center gap-3">
                <span className="min-w-0 flex-1">{t('caxriBot.handover.loadFailed')}</span>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // Fire-and-forget: a failed retry lands back in this same error state.
                        void source.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </Alert>
        );
    if (picker.groups.length === 0)
        return (
            <div className="grid min-h-40 place-items-center rounded-md border border-dashed border-border p-6 text-center text-[12px] text-muted">
                {t(
                    picker.query.trim()
                        ? 'caxriBot.handover.noMatches'
                        : isSessions
                          ? 'caxriBot.handover.noSessions'
                          : 'caxriBot.handover.noConversations',
                )}
            </div>
        );
    return (
        <BotHandoverList
            groups={picker.groups}
            now={source.dataUpdatedAt}
            refusedByKey={picker.refusedByKey}
            selection={picker.selection}
            onToggle={picker.toggle}
        />
    );
}
