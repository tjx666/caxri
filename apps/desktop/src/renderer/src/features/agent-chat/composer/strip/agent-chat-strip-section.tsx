import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import { ChevronRight } from 'lucide-react';

import { DisclosureMotion } from '../../../../components/disclosure-motion';
import { cn } from '../../../../lib/utilities';
import { agentChatChevronMotion } from '../../transcript/agent-chat-disclosure';
import type { AgentChatStripSection as AgentChatStripSectionName } from './agent-chat-strip-folds';
import {
    toggleAgentChatStripFold,
    useIsAgentChatStripSectionCollapsed,
} from './agent-chat-strip-folds';

/**
 * One collapsible section of the composer strip (the plan, background work): a 32px header naming the section that
 * folds and unfolds the list under it, and the list itself. The header is the toggle; `actions` sit after it outside
 * the toggle, and the chevron trails them at the header's right edge so it lines up whether or not a section has
 * actions. The chevron is a pointer-only target (`tabIndex={-1}`) that hands focus to the toggle, so keyboard users
 * meet one fold control. Collapsed, the header still says what matters (`summary`, `meta`), so folding never hides that
 * work is running. Only a fold the user makes animates: a section that appears with its work renders still, like every
 * other strip row.
 */
export function AgentChatStripSection({
    actions,
    ariaLabel,
    children,
    count,
    glyph,
    label,
    meta,
    section,
    summary,
    terminalId,
}: {
    actions?: ReactNode;
    /**
     * The toggle's accessible name when the visible header says less than it should (the plan's current step).
     */
    ariaLabel?: string;
    children: ReactNode;
    /**
     * How many items the section holds, right after its label (`Background work 3`).
     */
    count?: number;
    glyph: ReactNode;
    label: string;
    meta: ReactNode;
    section: AgentChatStripSectionName;
    /**
     * Shown after the label only while the section is collapsed.
     */
    summary?: ReactNode;
    terminalId: string;
}) {
    const isCollapsed = useIsAgentChatStripSectionCollapsed(terminalId, section);
    const [hasToggled, setToggled] = useState(false);
    const bodyId = useId();
    const toggleReference = useRef<HTMLButtonElement>(null);
    const toggle = (): void => {
        setToggled(true);
        toggleAgentChatStripFold(terminalId, section);
    };
    return (
        <section
            aria-label={label}
            className="border-0 border-b border-solid border-border"
            data-agent-chat-composer-strip-row=""
            data-agent-chat-strip-section={section}
        >
            <div className="flex h-8 items-center gap-1 px-1.5 text-[12px] text-muted">
                <button
                    aria-controls={bodyId}
                    aria-expanded={!isCollapsed}
                    aria-label={ariaLabel}
                    data-agent-chat-strip-fold=""
                    className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 text-left text-muted hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                    ref={toggleReference}
                    type="button"
                    onClick={toggle}
                >
                    {glyph}
                    <span className="shrink-0 text-foreground">{label}</span>
                    {count !== undefined && <span className="shrink-0 tabular-nums">{count}</span>}
                    {isCollapsed && summary && <span className="min-w-0 truncate">{summary}</span>}
                    <span className="ml-auto shrink-0 pl-1 tabular-nums">{meta}</span>
                </button>
                {actions}
                <button
                    aria-hidden="true"
                    className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground"
                    tabIndex={-1}
                    type="button"
                    onClick={() => {
                        toggleReference.current?.focus();
                        toggle();
                    }}
                >
                    <ChevronRight
                        className={cn(
                            'size-3.5',
                            agentChatChevronMotion(!isCollapsed),
                            !isCollapsed && 'rotate-90',
                        )}
                    />
                </button>
            </div>
            <DisclosureMotion
                animate={hasToggled}
                expanded={!isCollapsed}
                id={bodyId}
                kind={`agent-chat-strip-${section}`}
            >
                <div className="px-1 pb-1.5">{children}</div>
            </DisclosureMotion>
        </section>
    );
}
