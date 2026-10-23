import { useState } from 'react';

import type { AgentChatEditedFile } from '@caxri/protocol';
import { LoaderCircle, Redo2, Undo2 } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import {
    agentChatUndoKey,
    redoAgentChatTurn,
    undoAgentChatTurn,
    useAgentChatUndoStore,
} from './agent-chat-undo-commands';

const ACTION_CLASS_NAME =
    'shrink-0 gap-1 text-[12px] text-muted enabled:not-aria-disabled:hover:text-foreground';

/**
 * The turn-changes card's Undo: it reverts the turn's edits, shows a spinner while that runs, and reads `Undone` once
 * it succeeded. A partial turn or a truncated diff withholds it, and its tooltip names why. Once undone, a ghost Redo
 * sits beside `Undone` for as long as this window still holds what the Undo replaced, so taking it back does not depend
 * on catching the success toast. Both lead with their glyph, as Review beside them does.
 */
export function AgentChatTurnUndoButton({
    displayPath,
    files,
    isPartial,
    sessionId,
    turnId,
}: {
    displayPath: (path: string) => string;
    files: readonly AgentChatEditedFile[];
    isPartial: boolean;
    sessionId: string;
    turnId: string;
}) {
    const { t } = useTranslation();
    const undoStatus = useAgentChatUndoStore(
        (state) => state.turns[agentChatUndoKey(sessionId, turnId)],
    );
    const canRedo = useAgentChatUndoStore(
        (state) => state.redo[agentChatUndoKey(sessionId, turnId)] !== undefined,
    );
    const [isRedoing, setRedoing] = useState(false);
    if (undoStatus === 'undone') {
        return (
            <>
                <span className="shrink-0 text-[12px] text-muted">
                    {t('agentChat.undo.undone')}
                </span>
                {canRedo && (
                    <Tooltip content={t('agentChat.redo.tooltip')}>
                        <Button
                            aria-busy={isRedoing || undefined}
                            aria-disabled={isRedoing}
                            className={ACTION_CLASS_NAME}
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                if (isRedoing) return;
                                setRedoing(true);
                                void redoAgentChatTurn({ sessionId, turnId }).finally(() =>
                                    setRedoing(false),
                                );
                            }}
                        >
                            {isRedoing ? (
                                <LoaderCircle
                                    aria-hidden="true"
                                    className="size-3.5 motion-safe:animate-spin"
                                />
                            ) : (
                                <Redo2 aria-hidden="true" className="size-3.5" />
                            )}
                            {t('agentChat.redo.button')}
                        </Button>
                    </Tooltip>
                )}
            </>
        );
    }
    const undoBlocker = isPartial
        ? 'agentChat.undo.partialTurnTooltip'
        : files.some((file) => file.truncated)
          ? 'agentChat.undo.truncatedTooltip'
          : undefined;
    const isUnavailable = undoBlocker !== undefined || undoStatus === 'undoing';
    return (
        <Tooltip content={t(undoBlocker ?? 'agentChat.undo.tooltip')}>
            <Button
                aria-disabled={isUnavailable}
                className={ACTION_CLASS_NAME}
                size="sm"
                variant="ghost"
                onClick={() => {
                    if (isUnavailable) return;
                    void undoAgentChatTurn({ sessionId, turnId, files, displayPath });
                }}
            >
                {undoStatus === 'undoing' ? (
                    <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 motion-safe:animate-spin"
                    />
                ) : (
                    <Undo2 aria-hidden="true" className="size-3.5" />
                )}
                {t('agentChat.undo.button')}
            </Button>
        </Tooltip>
    );
}
