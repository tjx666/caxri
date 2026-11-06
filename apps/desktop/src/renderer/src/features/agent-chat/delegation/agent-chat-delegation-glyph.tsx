import { CircleQuestionMark, CircleX, Clock } from 'lucide-react';

import type { DelegationGlyph } from '../../delegation/delegation-copy';
import { BackgroundArc, RunningArc } from '../../primary-sidebar/running-arc';

/**
 * A delegated task's state in the sidebar's shapes: the running arc, the slow dotted ring for a task asking the Agent
 * that delegated it, an amber question mark for a task that needs the user, and a red cross for a failure, and a muted
 * clock for a failure whose scheduled retry is pending. Every other state (completed, stopped, taken over) draws
 * nothing, as a settled sidebar row does, but keeps the 14px slot so the rows' right edges line up. The slot is one
 * 20px text line tall so the glyph centers on a top-aligned row's first line, as the Agent icon on the left does.
 * `label` is the accessible name.
 */
export function AgentChatDelegationGlyph({
    glyph,
    label,
}: {
    glyph: DelegationGlyph;
    label: string;
}) {
    if (glyph === 'ordinary') return <span aria-hidden="true" className="h-5 w-3.5 flex-none" />;
    return (
        <span
            role="img"
            aria-label={label}
            className="flex h-5 w-3.5 flex-none items-center justify-center"
            data-agent-chat-delegation-glyph={glyph}
        >
            {glyph === 'running' && <RunningArc />}
            {glyph === 'asking' && (
                <span className="text-muted">
                    <BackgroundArc />
                </span>
            )}
            {glyph === 'needsInput' && (
                <CircleQuestionMark aria-hidden="true" className="size-3.5 text-warning" />
            )}
            {glyph === 'waiting' && <Clock aria-hidden="true" className="size-3.5 text-muted" />}
            {glyph === 'failed' && <CircleX aria-hidden="true" className="size-3.5 text-danger" />}
        </span>
    );
}
