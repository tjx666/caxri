import type { LucideIcon } from 'lucide-react';
import { GitFork, History, LoaderCircle, Pencil } from 'lucide-react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { useAgentChatEdit } from '../hooks/use-agent-chat-edit';

const ACTION_BUTTON_CLASS =
    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted aria-busy:cursor-progress aria-busy:opacity-100';

/**
 * One rewind action in a user message's hover row: hidden when the message does not offer it (`availability`
 * `undefined`), disabled with the reason as its tooltip while it cannot run, busy with a spinner and `busyReason` while
 * the message's own run of it is in flight, and labeled by `label` otherwise. Disabled through `aria-disabled` rather
 * than the native attribute, which would drop the button from the tab order and keep its reason tooltip from opening on
 * hover or focus.
 */
function RewindActionButton({
    availability,
    busyReason,
    icon: Icon,
    isBusy = false,
    label,
    onClick,
}: {
    availability: string | null | undefined;
    busyReason?: string;
    icon: LucideIcon;
    isBusy?: boolean;
    label: string;
    onClick: () => void;
}) {
    if (availability === undefined) return null;
    const isDisabled = availability !== null || isBusy;
    return (
        <Tooltip content={availability ?? (isBusy ? busyReason : undefined) ?? label}>
            <button
                aria-busy={isBusy || undefined}
                aria-disabled={isDisabled || undefined}
                aria-label={label}
                className={ACTION_BUTTON_CLASS}
                type="button"
                onClick={() => {
                    if (!isDisabled) onClick();
                }}
            >
                {isBusy ? (
                    <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 motion-safe:animate-spin"
                    />
                ) : (
                    <Icon aria-hidden="true" className="size-3.5" />
                )}
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
    isRestoring,
    text,
    onFork,
}: {
    id: string;
    isForking: boolean;
    isRestoring: boolean;
    text: string;
    onFork: () => void;
}) {
    const { t } = useTranslation();
    const edit = useAgentChatEdit();
    if (!edit) return null;
    const { fork, restore } = edit;
    return (
        <>
            {/* A pencil, as the queued message's Edit uses: the action changes the message; the rewind is its
                consequence, which the edit banner and the replace-turns confirmation name. */}
            <RewindActionButton
                availability={edit.availability(id)}
                icon={Pencil}
                label={t('agentChat.message.editFromHere')}
                onClick={() => edit.startEdit(id, text)}
            />
            {/* `isForking` and `isRestoring` are owned by the message so its context menu shares them: no second run
                while one is in flight. */}
            {fork && (
                <RewindActionButton
                    availability={fork.availability(id)}
                    busyReason={t('agentChat.userMenu.forkOpening')}
                    icon={GitFork}
                    isBusy={isForking}
                    label={t('agentChat.message.forkFromHere')}
                    onClick={onFork}
                />
            )}
            {restore && (
                <RewindActionButton
                    availability={restore.availability(id)}
                    busyReason={t('agentChat.undo.restoringCode')}
                    icon={History}
                    isBusy={isRestoring}
                    label={t('agentChat.message.restoreCodeToHere')}
                    onClick={() => restore.run(id)}
                />
            )}
        </>
    );
}
