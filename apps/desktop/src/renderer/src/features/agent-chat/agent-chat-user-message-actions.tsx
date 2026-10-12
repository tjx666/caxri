import type { LucideIcon } from 'lucide-react';
import { GitFork, History, Pencil } from 'lucide-react';

import { Tooltip } from '../../components/ui/tooltip';
import { useAgentChatEdit } from './hooks/use-agent-chat-edit';

const ACTION_BUTTON_CLASS =
    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted';

/**
 * One rewind action in a user message's hover row: hidden when the message does not offer it (`availability`
 * `undefined`), disabled with the reason as its tooltip while it cannot run, and labeled by `label` otherwise.
 */
function RewindActionButton({
    availability,
    icon: Icon,
    isBusy = false,
    label,
    onClick,
}: {
    availability: string | null | undefined;
    icon: LucideIcon;
    isBusy?: boolean;
    label: string;
    onClick: () => void;
}) {
    if (availability === undefined) return null;
    return (
        <Tooltip content={availability ?? label}>
            <button
                aria-label={label}
                className={ACTION_BUTTON_CLASS}
                disabled={availability !== null || isBusy}
                type="button"
                onClick={onClick}
            >
                <Icon className="size-3.5" />
            </button>
        </Tooltip>
    );
}

/**
 * A user message's rewind actions in its hover row: Edit from Here, Fork from Here, and Restore Code to Here, each
 * rendered only when the Chat offers it for this message. The message's right-click menu offers the same three.
 */
export function AgentChatUserMessageActions({
    id,
    isForking,
    text,
    onFork,
}: {
    id: string;
    isForking: boolean;
    text: string;
    onFork: () => void;
}) {
    const edit = useAgentChatEdit();
    if (!edit) return null;
    const { restore } = edit;
    return (
        <>
            {/* A pencil, as the queued message's Edit uses: the action changes the message; the rewind is its
                consequence, which the edit banner and the replace-turns confirmation name. */}
            <RewindActionButton
                availability={edit.availability(id)}
                icon={Pencil}
                label="Edit from here"
                onClick={() => edit.startEdit(id, text)}
            />
            {/* `isForking` is owned by the message so its context menu shares it: no second fork while one opens. */}
            <RewindActionButton
                availability={edit.forkAvailability(id)}
                icon={GitFork}
                isBusy={isForking}
                label="Fork from here"
                onClick={onFork}
            />
            {restore && (
                <RewindActionButton
                    availability={restore.availability(id)}
                    icon={History}
                    label="Restore code to here"
                    onClick={() => restore.run(id)}
                />
            )}
        </>
    );
}
