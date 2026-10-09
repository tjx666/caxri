import type { RefObject } from 'react';

import { cn } from '../../lib/utilities';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import { SessionRenameInput } from '../primary-sidebar/session-rename-input';

export function AgentActivityRowTitle({
    isRenaming,
    onTitleHoverChange,
    sessionId,
    sessionRename,
    textReference,
    title,
    viewportReference,
}: {
    isRenaming: boolean;
    /**
     * The title's own hover state, distinct from the row's roving keyboard focus: `agent-activity-row-trigger.tsx` owns
     * the row-level focus half of the same `useSessionTitleScroll` reveal.
     */
    onTitleHoverChange: (isHovered: boolean) => void;
    sessionId: string;
    sessionRename: SessionRenameController;
    textReference: RefObject<HTMLSpanElement | null>;
    title: string;
    viewportReference: RefObject<HTMLElement | null>;
}) {
    return (
        <span
            className={cn('min-w-0 text-xs text-foreground', isRenaming ? 'flex' : 'overflow-fade')}
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
                    onSuggest={() => sessionRename.suggestRename(sessionId, title, sessionId)}
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
