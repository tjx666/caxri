import type { ReactNode, RefObject } from 'react';

import { cn } from '../../lib/utilities';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import { SessionRenameInput } from '../primary-sidebar/session-rename-input';

export function AgentActivityRowTitle({
    canSuggest,
    isRenaming,
    isUnread,
    onTitleHoverChange,
    rowId,
    sessionId,
    sessionRename,
    status,
    textReference,
    title,
    viewportReference,
}: {
    /**
     * Whether the Session has a primary Agent conversation for `Rename with AI` to name.
     */
    canSuggest: boolean;
    isRenaming: boolean;
    /**
     * The Session has not been read yet; its title is set heavier, which tells it apart from a read Needs attention row
     * that carries the same glyph.
     */
    isUnread: boolean;
    /**
     * The title's own hover state, distinct from the row's roving keyboard focus: `agent-activity-row-trigger.tsx` owns
     * the row-level focus half of the same `useSessionTitleScroll` reveal.
     */
    onTitleHoverChange: (isHovered: boolean) => void;
    rowId: string;
    sessionId: string;
    sessionRename: SessionRenameController;
    /**
     * The Session's lifecycle glyph, leading the title. It collapses to nothing for a settled Session, and the line's
     * gap only applies between rendered boxes, so an Idle title starts at the row's edge.
     */
    status?: ReactNode;
    textReference: RefObject<HTMLSpanElement | null>;
    title: string;
    viewportReference: RefObject<HTMLElement | null>;
}) {
    return (
        <span className="agent-activity-title-line flex min-w-0 items-center gap-1.5">
            {status}
            <AgentActivityRowTitleText
                canSuggest={canSuggest}
                isRenaming={isRenaming}
                isUnread={isUnread}
                onTitleHoverChange={onTitleHoverChange}
                rowId={rowId}
                sessionId={sessionId}
                sessionRename={sessionRename}
                textReference={textReference}
                title={title}
                viewportReference={viewportReference}
            />
        </span>
    );
}

function AgentActivityRowTitleText({
    canSuggest,
    isRenaming,
    isUnread,
    onTitleHoverChange,
    rowId,
    sessionId,
    sessionRename,
    textReference,
    title,
    viewportReference,
}: Omit<Parameters<typeof AgentActivityRowTitle>[0], 'status'>) {
    return (
        <span
            className={cn(
                'min-w-0 flex-1 text-xs text-foreground',
                isRenaming ? 'flex' : 'overflow-fade',
                isUnread && 'font-medium',
            )}
        >
            {isRenaming ? (
                <SessionRenameInput
                    sessionId={sessionId}
                    title={title}
                    error={sessionRename.renameError}
                    value={sessionRename.renameValue}
                    focusInput={sessionRename.focusRenameInput}
                    onBlur={sessionRename.blurRename}
                    onChange={sessionRename.onRenameValueChange}
                    onCommit={sessionRename.commitRename}
                    onCancel={sessionRename.cancelRename}
                    onSuggest={() => sessionRename.suggestRename(sessionId, title, rowId)}
                    canSuggest={canSuggest}
                    suggesting={sessionRename.renameSuggestingSessionId === sessionId}
                />
            ) : (
                <span
                    ref={viewportReference}
                    className="block max-w-full overflow-hidden whitespace-nowrap"
                    onPointerEnter={() => onTitleHoverChange(true)}
                    onPointerLeave={() => onTitleHoverChange(false)}
                >
                    <span ref={textReference} className="block w-max max-w-full">
                        {title}
                    </span>
                </span>
            )}
        </span>
    );
}
