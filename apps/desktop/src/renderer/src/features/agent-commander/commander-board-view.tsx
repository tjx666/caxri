import { memo } from 'react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { usePolledQuery } from '../../hooks/use-polled-query';
import { describeFailure } from '../../stores/toasts';
import { commanderBoardSections } from './commander-board';
import { CommanderBoardItem } from './commander-board-item';

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
 * Every Workbench Session grouped by what it needs, in the Activity view's order. Read-only: a row hands its Session to
 * the Workbench window rather than acting on it here.
 */
export function CommanderBoardView() {
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
                <span>{describeFailure(board.error, 'Unable to load the board')}</span>
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                        // Fire-and-forget: a failed retry lands back in this same error state.
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                        void board.refetch();
                    }}
                >
                    Retry
                </Button>
            </div>
        );
    if (!data)
        return (
            <div className="commander-board-status flex min-h-0 flex-1 items-center justify-center p-6 text-muted">
                <Spinner />
            </div>
        );
    const sections = commanderBoardSections(data.rows);
    if (sections.length === 0)
        return (
            <div className="commander-board-empty flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-muted">
                No Sessions yet. Sessions from every Project appear here as their Agents work.
            </div>
        );
    return (
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
                        <span>{section.label}</span>
                        <span className="tabular-nums">{section.rows.length}</span>
                    </h2>
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                        {section.rows.map((row) => (
                            <MemoizedCommanderBoardItem
                                key={row.sessionId}
                                now={data.generatedAt}
                                row={row}
                            />
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}
