import type { KeyboardEvent } from 'react';

import { formatShortcut } from '@caxri/protocol';
import { Search } from 'lucide-react';

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
import { handoverRejectionLabelKeys } from './commander-handover';
import { CommanderHandoverList } from './commander-handover-list';
import { closeCommanderHandover, useCommanderHandoverStore } from './commander-handover-store';
import type { HandoverTab } from './hooks/use-commander-handover-picker';
import { useCommanderHandoverPicker } from './hooks/use-commander-handover-picker';

const SUBMIT_SHORTCUT = 'cmd+enter';

/**
 * Hands Sessions, or Agent conversations started outside Caxri, to the Agent Commander in one batch. Mounted in both
 * windows: the Workbench opens it from a Session's menu with that Session selected, the Commander window from its title
 * bar. The body mounts per open (see `ArchivedSessionsDialog`), so each open starts from its own request.
 */
export function CommanderHandoverDialog({ isFromWorkbench }: { isFromWorkbench: boolean }) {
    const request = useCommanderHandoverStore((state) => state.request);
    return (
        <Dialog
            open={request !== undefined}
            onOpenChange={(isOpen) => {
                if (!isOpen) closeCommanderHandover();
            }}
        >
            <DialogContent className="commander-handover-dialog grid h-[min(720px,calc(100vh-48px))] w-[min(760px,calc(100vw-48px))] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
                {request && (
                    <HandoverDialogBody
                        key={request.id}
                        isFromWorkbench={isFromWorkbench}
                        initialSessionIds={request.sessionIds}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function HandoverDialogBody({
    isFromWorkbench,
    initialSessionIds,
}: {
    isFromWorkbench: boolean;
    initialSessionIds: readonly string[];
}) {
    const { t } = useTranslation();
    const picker = useCommanderHandoverPicker({
        isFromWorkbench,
        initialSessionIds,
        onDone: closeCommanderHandover,
    });
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        // eslint-disable-next-line no-void -- the submission reports its own failures through a toast
        void picker.submit();
    };
    return (
        <div className="contents" onKeyDown={onKeyDown}>
            <DialogHeader>
                <DialogTitle>{t('agentCommander.handover.title')}</DialogTitle>
                <DialogDescription>{t('agentCommander.handover.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 border-b border-border px-4 pb-3">
                <ToggleGroup
                    aria-label={t('agentCommander.handover.sourceLabel')}
                    value={[picker.tab]}
                    onValueChange={(next: HandoverTab[]) => {
                        const picked = next.at(0);
                        if (picked) picker.setTab(picked);
                    }}
                >
                    <ToggleGroupItem value="sessions" className="commander-handover-tab-sessions">
                        {t('agentCommander.handover.sessionsTab')}
                        <span className="tabular-nums opacity-70">{picker.tabCounts.sessions}</span>
                    </ToggleGroupItem>
                    <ToggleGroupItem
                        value="conversations"
                        className="commander-handover-tab-conversations"
                    >
                        {t('agentCommander.handover.conversationsTab')}
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
                        className="commander-handover-search pl-8"
                        placeholder={t(
                            picker.tab === 'sessions'
                                ? 'agentCommander.handover.searchSessions'
                                : 'agentCommander.handover.searchConversations',
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
                {picker.refused.length > 0 && (
                    <Alert variant="warning" className="commander-handover-refused">
                        {picker.refused
                            .map(({ count, reason }) =>
                                t('agentCommander.handover.refusedLine', {
                                    count,
                                    reason: t(handoverRejectionLabelKeys[reason]),
                                }),
                            )
                            .join('\n')}
                    </Alert>
                )}
                {picker.selectedMayBeOpenCount > 0 && (
                    <Alert variant="warning">{t('agentCommander.handover.mayBeOpenWarning')}</Alert>
                )}
                <Textarea
                    aria-label={t('agentCommander.handover.noteLabel')}
                    className="commander-handover-note min-h-14"
                    maxLength={2_000}
                    placeholder={t('agentCommander.handover.notePlaceholder')}
                    rows={2}
                    value={picker.note}
                    onChange={(event) => picker.setNote(event.target.value)}
                />
                <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-[11px] text-muted">
                        {t('agentCommander.handover.takeBackHint')}
                    </span>
                    <span className="text-[11px] text-muted tabular-nums" aria-live="polite">
                        {t('agentCommander.handover.selectedCount', {
                            count: picker.selectedCount,
                        })}
                    </span>
                    <Button variant="ghost" onClick={closeCommanderHandover}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        className="commander-handover-submit"
                        disabled={picker.selectedCount === 0 || picker.isSubmitting}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- the submission reports its own failures through a toast
                            void picker.submit();
                        }}
                    >
                        {t('agentCommander.handover.submit')}
                        <Kbd size="compact">{formatShortcut(SUBMIT_SHORTCUT)}</Kbd>
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * The current tab's candidates, or why there are none: still loading, failed, nothing to offer, or nothing matching.
 */
function HandoverCandidates({ picker }: { picker: ReturnType<typeof useCommanderHandoverPicker> }) {
    const { t } = useTranslation();
    const isSessions = picker.tab === 'sessions';
    const source = isSessions ? picker.board : picker.conversations;
    if (source.isPending)
        return (
            <div className="grid min-h-40 place-items-center text-[12px] text-muted">
                <span className="flex items-center gap-2">
                    <Spinner />
                    {t(
                        isSessions
                            ? 'agentCommander.handover.loadingSessions'
                            : 'agentCommander.handover.loadingConversations',
                    )}
                </span>
            </div>
        );
    if (source.isError)
        return <Alert variant="danger">{t('agentCommander.handover.loadFailed')}</Alert>;
    if (picker.groups.length === 0)
        return (
            <div className="grid min-h-40 place-items-center rounded border border-dashed border-border p-6 text-center text-[12px] text-muted">
                {t(
                    picker.query.trim()
                        ? 'agentCommander.handover.noMatches'
                        : isSessions
                          ? 'agentCommander.handover.noSessions'
                          : 'agentCommander.handover.noConversations',
                )}
            </div>
        );
    return (
        <CommanderHandoverList
            groups={picker.groups}
            now={source.dataUpdatedAt}
            selection={picker.selection}
            onToggle={picker.toggle}
        />
    );
}
