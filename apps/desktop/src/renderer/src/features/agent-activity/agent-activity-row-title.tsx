import { cn } from '../../lib/utilities';
import type { SessionRenameController } from '../primary-sidebar/hooks/use-session-rename';
import { SessionRenameInput } from '../primary-sidebar/session-rename-input';

export function AgentActivityRowTitle({
    isRenaming,
    sessionId,
    sessionRename,
    title,
}: {
    isRenaming: boolean;
    sessionId: string;
    sessionRename: SessionRenameController;
    title: string;
}) {
    return (
        <span className={cn('min-w-0 text-xs text-foreground', isRenaming ? 'flex' : 'truncate')}>
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
                />
            ) : (
                title
            )}
        </span>
    );
}
