import type { ReactNode } from 'react';

import { cn } from '../../../../lib/utilities';

/**
 * The trailing 24px column of a Background work row: the row's status glyph, which its one action (Stop while it runs,
 * Dismiss once it failed) replaces while the pointer or focus is on the row, so a list of running work reads as a
 * column of spinners rather than a column of buttons. The action stays in the tab order while hidden (opacity, not
 * `display`), so a keyboard user reaches it and focusing it reveals it. The row's `li` carries `group/row`.
 */
export function AgentChatStripRowSlot({ action, glyph }: { action?: ReactNode; glyph: ReactNode }) {
    return (
        <span className="relative flex size-6 shrink-0 items-center justify-center">
            <span
                className={cn(
                    'flex items-center justify-center',
                    action !== undefined &&
                        'group-focus-within/row:invisible group-hover/row:invisible',
                )}
            >
                {glyph}
            </span>
            {action !== undefined && (
                <span className="absolute inset-0 flex items-center justify-center opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
                    {action}
                </span>
            )}
        </span>
    );
}
