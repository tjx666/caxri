import type { KeyboardEvent } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { Skeleton } from '../../../components/ui/skeleton';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatRailMark } from './agent-chat-rail-marks';
import {
    agentChatRailActiveTick,
    agentChatRailFocusStep,
    agentChatRailSampleIndices,
    isAgentChatMessageRailShown,
} from './agent-chat-rail-marks';
import { useAgentChatRailCapacity } from './hooks/use-agent-chat-rail-capacity';
import { useAgentChatRailPanel } from './hooks/use-agent-chat-rail-panel';

/**
 * One tick on the rail. It only draws: the list the rail opens on hover is what a pointer or the keyboard acts on.
 */
const RailTick = memo(({ isActive, width }: { isActive: boolean; width: number }) => (
    <div className="flex h-3 min-h-1.5 shrink items-center justify-end">
        <span
            className={cn('block h-0.5 rounded-full', isActive ? 'bg-foreground' : 'bg-muted/40')}
            style={{ width }}
        />
    </div>
));

/**
 * One row of the rail's list: the message's first words, right-aligned against a dash as long as its tick.
 */
const RailRow = memo(
    ({
        id,
        isActive,
        isReady,
        isTabStop,
        position,
        preview,
        width,
        onFocusRow,
        onJump,
    }: {
        id: string;
        isActive: boolean;
        isReady: boolean;
        /**
         * The one row Tab reaches; arrow keys move focus among the rest.
         */
        isTabStop: boolean;
        position: number;
        preview: string;
        width: number;
        onFocusRow: (position: number) => void;
        onJump: (id: string) => void;
    }) => {
        const { t } = useTranslation();
        return (
            <button
                aria-current={isActive ? 'location' : undefined}
                aria-label={
                    isReady
                        ? t('agentChat.rail.goToMessage', { preview })
                        : t('agentChat.rail.loadingPreview')
                }
                className="group/row flex h-7.5 w-full shrink-0 cursor-pointer items-center justify-end gap-2.5 rounded-md border-0 bg-transparent px-3 text-right outline-none hover:bg-[var(--selection)] focus-visible:bg-[var(--selection)]"
                data-agent-chat-rail-row={id}
                tabIndex={isTabStop ? 0 : -1}
                type="button"
                onClick={() => onJump(id)}
                onFocus={() => onFocusRow(position)}
                // A pointer jump leaves focus where it was, so the list it closes keeps no focused row behind.
                onPointerDown={(event) => event.preventDefault()}
            >
                {isReady ? (
                    <span
                        className={cn(
                            'min-w-0 truncate text-[13px]',
                            isActive
                                ? 'font-medium text-foreground'
                                : 'text-muted group-hover/row:text-foreground group-focus-visible/row:text-foreground',
                        )}
                    >
                        {preview}
                    </span>
                ) : (
                    <Skeleton className="h-2.5 w-32" />
                )}
                <span
                    aria-hidden="true"
                    className={cn(
                        'block h-0.5 shrink-0 rounded-full',
                        isActive ? 'bg-foreground' : 'bg-muted/40',
                    )}
                    style={{ width }}
                />
            </button>
        );
    },
);

/**
 * A column of ticks at the Chat's right edge, one per user message, modeled on LobeHub's chat minimap. Each tick is as
 * long as its message is long, so the rail sketches the conversation's shape, and the tick for the message being read
 * is dark while the rest stay faint. Resting the pointer on the rail, or Tabbing into it, opens one list of every
 * message in place of the ticks: each row is the message's first words beside a dash as long as its tick, the one being
 * read in medium weight, and clicking a row (or Enter) jumps there. A conversation with one message has nowhere to
 * jump, so the rail appears from the second; a narrow Chat's transcript then widens its padding past the rail so
 * content never runs under the ticks, while a wide Chat's centering margin already clears them. The list is one Tab
 * stop: ArrowUp and ArrowDown (Home, End) move among its rows and Escape closes it. Ticks shrink together when a long
 * conversation would overflow the view, down to 6px each; past that each tick stands for a stretch of the conversation,
 * so the rail never scrolls. The list keeps every row and scrolls instead.
 */
export function AgentChatMessageRail({
    activeIndex,
    marks,
    onJump,
}: {
    activeIndex: number;
    marks: readonly AgentChatRailMark[];
    onJump: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [column, setColumn] = useState<HTMLElement | null>(null);
    const list = useRef<HTMLDivElement>(null);
    const capacity = useAgentChatRailCapacity(column);
    const indices = useMemo(
        () => agentChatRailSampleIndices(marks.length, capacity),
        [capacity, marks.length],
    );
    const panel = useAgentChatRailPanel();
    /**
     * The row keyboard focus last moved to while inside the list; outside it, Tab lands on the row being read.
     */
    const [focusedRow, setFocusedRow] = useState<number>();
    useEffect(() => {
        if (!panel.isOpen) return;
        // Open on the message being read, however far down a long list it is.
        list.current
            ?.querySelector('[aria-current="location"]')
            ?.scrollIntoView({ block: 'nearest' });
    }, [panel.isOpen]);
    if (!isAgentChatMessageRailShown(marks)) return null;
    const activeTick = agentChatRailActiveTick(indices, activeIndex);
    const tabStop =
        focusedRow !== undefined && focusedRow < marks.length
            ? focusedRow
            : activeIndex === -1
              ? marks.length - 1
              : activeIndex;
    const jump = (id: string): void => {
        onJump(id);
        if (!list.current?.contains(document.activeElement)) panel.close();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            panel.close();
            (document.activeElement as HTMLElement | null)?.blur();
            return;
        }
        const next = agentChatRailFocusStep(tabStop, marks.length, event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    };
    return (
        <nav
            aria-label={t('agentChat.rail.label')}
            className="pointer-events-none absolute inset-y-12 right-3 z-10 flex items-center"
            data-agent-chat-message-rail=""
            ref={setColumn}
        >
            {/* Not positioned, so the list below centers on the whole column rather than on the ticks. */}
            <div
                className="pointer-events-auto flex max-h-full flex-col items-end"
                onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') panel.pointerEnter();
                }}
                onPointerLeave={(event) => {
                    if (event.pointerType === 'mouse') panel.pointerLeave();
                }}
            >
                <div
                    aria-hidden="true"
                    className={cn(
                        'flex max-h-full flex-col items-end transition-opacity duration-(--motion-overlay-enter) motion-reduce:transition-none',
                        panel.isOpen && 'opacity-0',
                    )}
                    data-agent-chat-rail-ticks=""
                >
                    {indices.map((index, position) => (
                        <RailTick
                            isActive={position === activeTick}
                            key={marks[index].id}
                            width={marks[index].width}
                        />
                    ))}
                </div>
                <div
                    className={cn(
                        'absolute top-1/2 right-0 flex max-h-full w-max max-w-90 min-w-60 origin-right -translate-y-1/2 [scrollbar-width:thin] flex-col overflow-y-auto rounded-md bg-elevated p-1 shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] transition-[opacity,scale] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-reduce:transition-none',
                        panel.isOpen ? 'scale-100' : 'pointer-events-none scale-96 opacity-0',
                    )}
                    data-agent-chat-rail-list=""
                    data-state={panel.isOpen ? 'open' : 'closed'}
                    ref={list}
                    onBlur={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget)) return;
                        setFocusedRow(undefined);
                        panel.setKeyboardOpen(false);
                    }}
                    onFocus={(event) => {
                        // Only keyboard focus opens the list; a pointer row press never takes focus.
                        if (event.target.matches(':focus-visible')) panel.setKeyboardOpen(true);
                    }}
                    onKeyDown={onKeyDown}
                >
                    {marks.map((mark, position) => (
                        <RailRow
                            id={mark.id}
                            isActive={position === activeIndex}
                            isReady={mark.isReady}
                            isTabStop={position === tabStop}
                            key={mark.id}
                            position={position}
                            preview={mark.preview}
                            width={mark.width}
                            onFocusRow={setFocusedRow}
                            onJump={jump}
                        />
                    ))}
                </div>
            </div>
        </nav>
    );
}
