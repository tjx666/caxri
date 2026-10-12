import type { AgentChatEditedFile } from '@caxri/protocol';
import { LoaderCircle, Undo2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import {
    agentChatUndoKey,
    undoAgentChatTurn,
    useAgentChatUndoStore,
} from './agent-chat-undo-commands';

/**
 * The turn-changes card's Undo: it reverts the turn's edits, shows a spinner while that runs, and reads `Undone` once
 * it succeeded. A partial turn or a truncated diff withholds it, and its tooltip names why.
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
    if (undoStatus === 'undone') {
        return (
            <span className="shrink-0 text-[12px] text-muted">{t('agentChat.undo.undone')}</span>
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
                className="shrink-0 gap-1 text-[12px] text-muted enabled:not-aria-disabled:hover:text-foreground"
                size="sm"
                variant="ghost"
                onClick={() => {
                    if (isUnavailable) return;
                    // eslint-disable-next-line no-void -- undoAgentChatTurn reports failures through tryCommand
                    void undoAgentChatTurn({ sessionId, turnId, files, displayPath });
                }}
            >
                {t('agentChat.undo.button')}
                {undoStatus === 'undoing' ? (
                    <LoaderCircle
                        aria-hidden="true"
                        className="size-3.5 motion-safe:animate-spin"
                    />
                ) : (
                    <Undo2 aria-hidden="true" className="size-3.5" />
                )}
            </Button>
        </Tooltip>
    );
}
