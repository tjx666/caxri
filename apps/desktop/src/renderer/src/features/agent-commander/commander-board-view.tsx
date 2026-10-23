import { memo } from 'react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { useTranslation } from '../../i18n';
import { describeFailure } from '../../stores/toasts';
import type { CommanderBoardScope } from './commander-board';
import { commanderBoardRowsInScope, commanderBoardSections } from './commander-board';
import { CommanderBoardItem } from './commander-board-item';
import { setCommanderBoardScope, useCommanderBoardUiStore } from './commander-board-store';
import { CommanderHandoverEmptyAction } from './commander-handover-empty-action';

/**
 * The board polls on its own clock as well as on `state.changed`: pull request and CI state reach it from the Server's
 * cached snapshot, which refreshes without emitting a board event.
 */
const BOARD_POLL_INTERVAL_MS = 10_000;

/**
 * Memoized so a pull-request change renders only the rows it names: the patch keeps every other row's object and the
 * board's `generatedAt` (issue caxri#1411). A poll still renders every row, because its new `generatedAt` moves each
 * row's relative time.
 */
const MemoizedCommanderBoardItem = memo(CommanderBoardItem);

/**
 * The Commander's own Sessions, or every Workbench Session, grouped by what they need in the Activity view's order.
 * Read-only: a row hands its Session to the Workbench window rather than acting on it here.
 */
export function CommanderBoardView() {
    const { t } = useTranslation();
    const scope = useCommanderBoardUiStore((state) => state.scope);
    const board = usePolledQuery('commander.board', undefined, {
        intervalMs: BOARD_POLL_INTERVAL_MS,
        label: 'Agent Commander board',
    });
    const { data } = board;
    /**
     * A failed poll keeps the last board on screen; only a board that never loaded shows its failure.
     */
    if (!data && board.isError)
        return (
            <div className="commander-board-status flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                <span>{describeFailure(board.error, t('agentCommander.board.loadFailed'))}</span>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // Fire-and-forget: a failed retry lands back in this same error state.
                        void board.refetch();
                    }}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!data)
        return (
            <LoadingSkeleton
                variant="list"
                className="commander-board-status min-h-0 flex-1 py-1"
                label={t('agentCommander.board.loading')}
            />
        );
    const sections = commanderBoardSections(commanderBoardRowsInScope(data.rows, scope), t);
    return (
        <>
            <CommanderBoardScopeBar
                allCount={data.rows.length}
                commanderCount={data.rows.filter((row) => row.commanderSession).length}
                onScopeChange={setCommanderBoardScope}
                scope={scope}
            />
            {sections.length === 0 ? (
                <div className="commander-board-empty flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                    <span>
                        {t(
                            scope === 'commander'
                                ? 'agentCommander.board.emptyCommander'
                                : 'agentCommander.board.emptyAll',
                        )}
                    </span>
                    {scope === 'commander' && <CommanderHandoverEmptyAction />}
                </div>
            ) : (
                <div className="commander-board min-h-0 flex-1 overflow-auto p-2">
                    {sections.map((section) => (
                        <section
                            key={section.id}
                            aria-labelledby={`commander-board-${section.id}`}
                            className="commander-board-section mt-2 first:mt-0"
                            data-commander-group={section.id}
                        >
                            <h2
                                id={`commander-board-${section.id}`}
                                className="commander-board-heading m-0 flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-muted"
                            >
                                {section.label} · {section.rows.length}
                            </h2>
                            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                                {section.rows.map((row) => (
                                    <MemoizedCommanderBoardItem
                                        key={row.sessionId}
                                        now={data.generatedAt}
                                        row={row}
                                        showsOwnership={scope === 'all'}
                                    />
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </>
    );
}

/**
 * Switches between the Commander's own Sessions and every Workbench Session. Each option carries its count, so the
 * default scope never hides that other Sessions exist; the accessible name starts with the visible label and count
 * (label-in-name), then says what the option covers.
 */
function CommanderBoardScopeBar({
    allCount,
    commanderCount,
    onScopeChange,
    scope,
}: {
    allCount: number;
    commanderCount: number;
    onScopeChange: (scope: CommanderBoardScope) => void;
    scope: CommanderBoardScope;
}) {
    const { t } = useTranslation();
    return (
        <div className="commander-board-scope flex flex-none items-center px-3 pt-2 pb-1">
            <ToggleGroup
                aria-label={t('agentCommander.board.scopeLabel')}
                value={[scope]}
                onValueChange={(next: CommanderBoardScope[]) => {
                    // Pressing the active item unpresses it; the board always shows one scope.
                    const picked = next.at(0);
                    if (picked) onScopeChange(picked);
                }}
            >
                <ToggleGroupItem
                    value="commander"
                    aria-label={t('agentCommander.board.scopeCommanderLabel', {
                        count: commanderCount,
                    })}
                >
                    {t('agentCommander.board.scopeCommander')}
                    <span className="tabular-nums opacity-70">· {commanderCount}</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                    value="all"
                    aria-label={t('agentCommander.board.scopeAllLabel', { count: allCount })}
                >
                    {t('agentCommander.board.scopeAll')}
                    <span className="tabular-nums opacity-70">· {allCount}</span>
                </ToggleGroupItem>
            </ToggleGroup>
        </div>
    );
}
