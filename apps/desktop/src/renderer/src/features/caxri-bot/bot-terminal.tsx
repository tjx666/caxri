import type { DragEvent } from 'react';

import { isChatTerminal } from '@caxri/protocol';

import { SurfaceErrorBoundary } from '../../components/surface-error-boundary';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { useTerminal } from '../../stores/selectors';
import { describeFailure } from '../../stores/toasts';
import { AgentChatTerminalContent } from '../agent-chat/tasks/agent-chat-terminal-content';
import { didPasteDropIntoTerminal, isTerminalPasteDrag } from '../terminal/terminal-drop';
import { TerminalPane } from '../terminal/terminal-pane';
import { useCaxriBotStore } from './bot-client';
import type { CaxriBotStatus } from './hooks/use-caxri-bot';

/**
 * Caxri Bot's own Terminal, rendered by the ordinary Terminal pane, or the ordinary Chat pane once the user switched it
 * to Chat, against Caxri Bot-scoped snapshot. It mounts only once `bot.ensure` resolved, because Main admits
 * `terminal.*` and the Chat pane's `agentChat.*` requests for this Terminal only after it saw that reply. A Chat
 * accepts its own drops in the composer, and offers neither "Fork from here" nor "Use as Project default": a fork would
 * open a Session in the hidden Caxri Bot Project and select it in a window that has no Workbench, and Main's Caxri Bot
 * policy refuses both `agentChat.fork` and Project writes here.
 *
 * The Workbench accepts drops on its pane surface, which this window does not mount, so Caxri Bot accepts them here:
 * files from Finder, most often a screenshot for Caxri Bot to hand on, and Workbench Files entries, Editor tabs, or
 * Projects insert their paths while the Terminal runs.
 */
export function BotTerminal({ onRetry, status }: { onRetry: () => void; status: CaxriBotStatus }) {
    const { t } = useTranslation();
    const terminalId = useCaxriBotStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    if (status.kind === 'error')
        return (
            <div
                role="alert"
                className="bot-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted"
            >
                <span className="text-danger">{t('caxriBot.terminal.couldNotStart')}</span>
                <span className="max-w-[460px] text-xs">
                    {t('caxriBot.terminal.couldNotStartHint')}
                </span>
                {/* The raw failure stays available as a secondary detail for a bug report, never as the headline. */}
                <span className="max-w-[460px] text-[11px] break-words select-text">
                    {t('caxriBot.terminal.failureDetail', {
                        message: describeFailure(
                            status.error,
                            t('caxriBot.terminal.startFailed'),
                            t,
                        ),
                    })}
                </span>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!terminal || status.kind === 'loading')
        return (
            <div className="bot-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-muted">
                <Spinner />
                <span>{t('caxriBot.terminal.starting')}</span>
            </div>
        );
    if (isChatTerminal(terminal))
        return (
            <SurfaceErrorBoundary resetKey={terminal.id} scope="chat">
                <AgentChatTerminalContent
                    ariaLabel={t('caxriBot.terminal.ariaLabel', { title: terminal.title })}
                    host="bot"
                    isShown
                    key={terminal.id}
                    terminal={terminal}
                />
            </SurfaceErrorBoundary>
        );
    const canAcceptDrop = (event: DragEvent<HTMLElement>): boolean => {
        if (terminal.lastProcessState !== 'running' || !isTerminalPasteDrag(event)) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        return true;
    };
    return (
        <div
            className="bot-terminal-drop h-full"
            onDragEnter={canAcceptDrop}
            onDragOver={canAcceptDrop}
            onDrop={(event) => {
                if (canAcceptDrop(event)) didPasteDropIntoTerminal(event, terminal);
            }}
        >
            <TerminalPane
                active
                ariaLabel={t('caxriBot.terminal.ariaLabel', { title: terminal.title })}
                isPaneVisible
                terminalId={terminal.id}
            />
        </div>
    );
}
