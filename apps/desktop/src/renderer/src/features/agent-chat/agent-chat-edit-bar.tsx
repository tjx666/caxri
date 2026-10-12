import { useId } from 'react';

import { Pencil, X } from 'lucide-react';

import { Checkbox } from '../../components/ui/checkbox';
import { Tooltip } from '../../components/ui/tooltip';
import { agentChatEditCaption } from './agent-chat-edit';

/**
 * The composer's first row while "Edit from here" is in progress, in the activity bar's shape: how much of the
 * conversation sending replaces, whether it also reverts the files those turns changed, and Cancel. Its tooltip names
 * Escape only while Escape cancels: during a running turn Escape stops the turn instead (`agentChatEscapeAction`). A
 * provider that cannot restore files keeps the choice visible but disabled, with the reason on hover, so the user
 * learns why only the conversation rewinds. Renders nothing while no edit is in progress (`edit` is `undefined`).
 */
export function AgentChatEditBar({ edit }: { edit: AgentChatEditBarProperties | undefined }) {
    if (!edit) return null;
    return <EditBar {...edit} />;
}

export interface AgentChatEditBarProperties {
    /**
     * The key that cancels the edit right now, shown in Cancel's tooltip; `undefined` while Escape stops a running
     * turn.
     */
    cancelShortcut: 'escape' | undefined;
    /**
     * Why the provider cannot revert files, or `undefined` when it can.
     */
    filesUnsupportedReason: string | undefined;
    removedTurns: number;
    shouldRestoreFiles: boolean;
    onCancel: () => void;
    onRestoreFilesChange: (shouldRestoreFiles: boolean) => void;
}

function EditBar({
    cancelShortcut,
    filesUnsupportedReason,
    removedTurns,
    shouldRestoreFiles,
    onCancel,
    onRestoreFilesChange,
}: AgentChatEditBarProperties) {
    const checkboxId = useId();
    const isFilesDisabled = filesUnsupportedReason !== undefined;
    return (
        <div
            className="flex h-8 min-w-0 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
            data-agent-chat-edit-bar=""
        >
            <Pencil aria-hidden className="size-3.5 shrink-0 text-accent" />
            <span className="min-w-0 truncate" role="status">
                {agentChatEditCaption(removedTurns)}
            </span>
            <Tooltip content={filesUnsupportedReason} disabled={!isFilesDisabled}>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <Checkbox
                        checked={shouldRestoreFiles && !isFilesDisabled}
                        disabled={isFilesDisabled}
                        id={checkboxId}
                        onCheckedChange={(checked) => onRestoreFilesChange(checked)}
                    />
                    <label
                        className={
                            isFilesDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                        }
                        htmlFor={checkboxId}
                    >
                        Also revert file changes
                    </label>
                </span>
            </Tooltip>
            <Tooltip content="Cancel edit" shortcut={cancelShortcut}>
                <button
                    aria-label="Cancel edit"
                    className="-mr-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                    type="button"
                    onClick={onCancel}
                >
                    <X className="size-3.5" />
                </button>
            </Tooltip>
        </div>
    );
}
