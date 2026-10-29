import { memo } from 'react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { useTranslation } from '../../i18n';
import { describeFailure } from '../../stores/toasts';
import type { BotBoardScope } from './bot-board';
import { botBoardRowsInScope, botBoardSections } from './bot-board';
import { BotBoardItem } from './bot-board-item';
import { setBotBoardScope, useBotBoardUiStore } from './bot-board-store';
import { BotHandoverEmptyAction } from './bot-handover-empty-action';

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
const MemoizedBotBoardItem = memo(BotBoardItem);

/**
 * Caxri Bot's own Sessions, or every Workbench Session, grouped by what they need in the Activity view's order.
 * Read-only: a row hands its Session to the Workbench window rather than acting on it here.
 */
export function BotBoardView() {
    const { t } = useTranslation();
    const scope = useBotBoardUiStore((state) => state.scope);
    const board = usePolledQuery('bot.board', undefined, {
        intervalMs: BOARD_POLL_INTERVAL_MS,
        label: 'Caxri Bot board',
    });
    const { data } = board;
    /**
     * A failed poll keeps the last board on screen; only a board that never loaded shows its failure.
     */
    if (!data && board.isError)
        return (
            <div className="bot-board-status flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                <span>{describeFailure(board.error, t('caxriBot.board.loadFailed'), t)}</span>
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
                className="bot-board-status min-h-0 flex-1 py-1"
                label={t('caxriBot.board.loading')}
            />
        );
    const sections = botBoardSections(botBoardRowsInScope(data.rows, scope), t);
    return (
        <>
            <BotBoardScopeBar
                allCount={data.rows.length}
                botCount={data.rows.filter((row) => row.botSession).length}
                onScopeChange={setBotBoardScope}
                scope={scope}
            />
            {sections.length === 0 ? (
                <div className="bot-board-empty flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted">
                    <span>
                        {t(scope === 'bot' ? 'caxriBot.board.emptyBot' : 'caxriBot.board.emptyAll')}
                    </span>
                    {scope === 'bot' && <BotHandoverEmptyAction />}
                </div>
            ) : (
                <div className="bot-board min-h-0 flex-1 overflow-auto p-2">
                    {sections.map((section) => (
                        <section
                            key={section.id}
                            aria-labelledby={`bot-board-${section.id}`}
                            className="bot-board-section mt-2 first:mt-0"
                            data-bot-group={section.id}
                        >
                            <h2
                                id={`bot-board-${section.id}`}
                                className="bot-board-heading m-0 flex items-center gap-1.5 px-2 pb-1 text-[11px] font-medium text-muted"
                            >
                                {section.label} · {section.rows.length}
                            </h2>
                            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                                {section.rows.map((row) => (
                                    <MemoizedBotBoardItem
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
 * Switches between Caxri Bot's own Sessions and every Workbench Session. Each option carries its count, so the default
 * scope never hides that other Sessions exist; the accessible name starts with the visible label and count
 * (label-in-name), then says what the option covers.
 */
function BotBoardScopeBar({
    allCount,
    botCount,
    onScopeChange,
    scope,
}: {
    allCount: number;
    botCount: number;
    onScopeChange: (scope: BotBoardScope) => void;
    scope: BotBoardScope;
}) {
    const { t } = useTranslation();
    return (
        <div className="bot-board-scope flex flex-none items-center px-3 pt-2 pb-1">
            <ToggleGroup
                aria-label={t('caxriBot.board.scopeLabel')}
                value={[scope]}
                onValueChange={(next: BotBoardScope[]) => {
                    // Pressing the active item unpresses it; the board always shows one scope.
                    const picked = next.at(0);
                    if (picked) onScopeChange(picked);
                }}
            >
                <ToggleGroupItem
                    value="bot"
                    aria-label={t('caxriBot.board.scopeBotLabel', {
                        count: botCount,
                    })}
                >
                    {t('caxriBot.board.scopeBot')}
                    <span className="tabular-nums opacity-70">· {botCount}</span>
                </ToggleGroupItem>
                <ToggleGroupItem
                    value="all"
                    aria-label={t('caxriBot.board.scopeAllLabel', { count: allCount })}
                >
                    {t('caxriBot.board.scopeAll')}
                    <span className="tabular-nums opacity-70">· {allCount}</span>
                </ToggleGroupItem>
            </ToggleGroup>
        </div>
    );
}
