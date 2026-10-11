import type { DragEvent } from 'react';

import { isChatTerminal } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTerminal } from '../../stores/selectors';
import { AgentChatTerminalContent } from '../agent-chat/agent-chat-terminal-content';
import { didPasteDropIntoTerminal, isTerminalPasteDrag } from '../terminal/terminal-drop';
import { TerminalPane } from '../terminal/terminal-pane';
import { useAgentCommanderStore } from './commander-client';
import type { AgentCommanderStatus } from './hooks/use-agent-commander';

/**
 * The Commander's own Terminal, rendered by the ordinary Terminal pane, or the ordinary Chat pane once the user
 * switched it to Chat, against the Commander-scoped snapshot. It mounts only once `commander.ensure` resolved, because
 * Main admits `terminal.*` and the Chat pane's `agentChat.*` requests for this Terminal only after it saw that reply. A
 * Chat accepts its own drops in the composer, and offers neither "Fork from here" nor "Use as Project default": a fork
 * would open a Session in the hidden Commander Project and select it in a window that has no Workbench, and Main's
 * Commander policy refuses both `agentChat.fork` and Project writes here.
 *
 * The Workbench accepts drops on its pane surface, which this window does not mount, so the Commander accepts them
 * here: files from Finder, most often a screenshot for the Commander to hand on, and Workbench Files entries, Editor
 * tabs, or Projects insert their paths while the Terminal runs.
 */
export function CommanderTerminal({
    onRetry,
    status,
}: {
    onRetry: () => void;
    status: AgentCommanderStatus;
}) {
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    if (status.kind === 'error')
        return (
            <div
                role="alert"
                className="commander-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted"
            >
                <span className="text-foreground">Agent Commander could not start.</span>
                <span className="max-w-[460px] text-xs">{status.message}</span>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                    Retry
                </Button>
            </div>
        );
    if (!terminal || status.kind === 'loading')
        return (
            <div className="commander-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-muted">
                <Spinner />
                <span>Starting Agent Commander…</span>
            </div>
        );
    if (isChatTerminal(terminal))
        return (
            <AgentChatTerminalContent
                ariaLabel={`Agent Commander: ${terminal.title}`}
                host="commander"
                isShown
                key={terminal.id}
                terminal={terminal}
            />
        );
    const canAcceptDrop = (event: DragEvent<HTMLElement>): boolean => {
        if (terminal.lastProcessState !== 'running' || !isTerminalPasteDrag(event)) return false;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        return true;
    };
    return (
        <div
            className="commander-terminal-drop h-full"
            onDragEnter={canAcceptDrop}
            onDragOver={canAcceptDrop}
            onDrop={(event) => {
                if (canAcceptDrop(event)) didPasteDropIntoTerminal(event, terminal);
            }}
        >
            <TerminalPane
                active
                ariaLabel={`Agent Commander: ${terminal.title}`}
                isPaneVisible
                terminalId={terminal.id}
            />
        </div>
    );
}
