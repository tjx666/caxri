import type { ReactNode } from 'react';
import { useId, useState } from 'react';

import { ChevronRight, CircleStop, CircleX } from 'lucide-react';

import { DisclosureMotion } from '../../components/disclosure-motion';
import { cn } from '../../lib/utilities';
import { agentChatChevronMotion } from './agent-chat-disclosure';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { agentChatTurnTone } from './agent-chat-timeline';

/**
 * A finished turn's work and commentary behind one `Worked for 2m 1s` row with a hairline, so the prompt and the final
 * reply read as one exchange. A failed or stopped turn carries its tone in the glyph and the words, so a turn that did
 * not finish is not read as one that did. Expanded, it renders the folded entries exactly as they looked while the turn
 * ran.
 */
export function AgentChatTurnFold({
    entry,
    renderEntry,
}: {
    entry: Extract<AgentChatTimelineEntry, { kind: 'turn' }>;
    renderEntry: (entry: Exclude<AgentChatTimelineEntry, { kind: 'turn' }>) => ReactNode;
}) {
    const [isExpanded, setExpanded] = useState(false);
    const detailId = useId();
    const tone = agentChatTurnTone(entry.status);
    const ToneIcon = tone === 'danger' ? CircleX : CircleStop;
    return (
        <div className="text-[12px] leading-5">
            <button
                aria-controls={detailId}
                aria-expanded={isExpanded}
                className={cn(
                    'flex w-full min-w-0 cursor-pointer items-center gap-2 border-0 border-b border-solid border-border bg-transparent px-0 pt-0.5 pb-1.5 text-left focus-visible:outline focus-visible:outline-accent',
                    tone === 'danger'
                        ? 'text-danger'
                        : tone === 'warning'
                          ? 'text-warning'
                          : 'text-muted hover:text-foreground',
                )}
                type="button"
                onClick={() => setExpanded((value) => !value)}
            >
                {tone && <ToneIcon aria-hidden="true" className="size-3.5 shrink-0" />}
                <span>{entry.label}</span>
                <ChevronRight
                    aria-hidden="true"
                    className={cn(
                        'size-3.5 shrink-0',
                        agentChatChevronMotion(isExpanded),
                        isExpanded && 'rotate-90',
                    )}
                />
            </button>
            <DisclosureMotion animate expanded={isExpanded} id={detailId} kind="agent-chat-turn">
                <div className="mt-3 flex flex-col gap-3">
                    {entry.entries.map((child) => renderEntry(child))}
                </div>
            </DisclosureMotion>
        </div>
    );
}
