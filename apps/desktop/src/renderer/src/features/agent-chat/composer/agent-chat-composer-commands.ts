import { notifyListeners } from '@caxri/utils';

/**
 * The composer controls a command can reach: the model picker, the permission menu, the plan mode toggle, the side
 * chat, and sending the message (used by the turn review's "Back to Chat and Send").
 */
export type AgentChatComposerCommand =
    'changeModel' | 'changePermissionMode' | 'openSideChat' | 'send' | 'togglePlanMode';

/**
 * Each mounted Chat composer registers the controls its provider offers, keyed by Terminal id, so a command reaches the
 * live menu with a direct call. A control registers only while it renders, which is what gates the commands: a provider
 * without a model list, permission levels, or plan mode, a Terminal surface, and any other tab have nothing here, so
 * the shortcut falls through and the palette hides the command. Only one pane owns a given Terminal at a time, so one
 * handler per command and Terminal is enough.
 */
const handlers = new Map<string, Map<AgentChatComposerCommand, () => void>>();

/**
 * Notified whenever a control registers or leaves, so a surface that lists the commands (the composer's `/` menu) can
 * follow a control that mounts after it, such as the model picker once the first snapshot arrives.
 */
const listeners = new Set<() => void>();

function notifyAgentChatComposerCommandsChanged(): void {
    notifyListeners(listeners, undefined);
}

/**
 * Subscribes to registrations, in the shape `useSyncExternalStore` expects.
 */
export function subscribeAgentChatComposerCommands(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function registerAgentChatComposerCommand(
    terminalId: string,
    command: AgentChatComposerCommand,
    run: () => void,
): () => void {
    let commands = handlers.get(terminalId);
    if (!commands) {
        commands = new Map();
        handlers.set(terminalId, commands);
    }
    commands.set(command, run);
    notifyAgentChatComposerCommandsChanged();
    return () => {
        const current = handlers.get(terminalId);
        if (current?.get(command) !== run) return;
        current.delete(command);
        if (current.size === 0) handlers.delete(terminalId);
        notifyAgentChatComposerCommandsChanged();
    };
}

export function canRunAgentChatComposerCommand(
    terminalId: string | undefined,
    command: AgentChatComposerCommand,
): boolean {
    return terminalId !== undefined && handlers.get(terminalId)?.has(command) === true;
}

export function runAgentChatComposerCommand(
    terminalId: string | undefined,
    command: AgentChatComposerCommand,
): void {
    if (terminalId !== undefined) handlers.get(terminalId)?.get(command)?.();
}

/**
 * Runs `command` as soon as the Chat's composer registers it, for a caller that has just brought the Chat forward and
 * so may run before its composer mounted. Gives up after `timeoutMs`: a composer that never registers the command (a
 * blocked send, a Terminal surface) means there is nothing to send. Returns the cancel.
 */
export function runAgentChatComposerCommandWhenReady(
    terminalId: string,
    command: AgentChatComposerCommand,
    timeoutMs = 1_500,
): () => void {
    const deadline = Date.now() + timeoutMs;
    let frame = 0;
    const attempt = (): void => {
        if (canRunAgentChatComposerCommand(terminalId, command)) {
            runAgentChatComposerCommand(terminalId, command);
            return;
        }
        if (Date.now() < deadline) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
}

/**
 * Where a composer menu a command opened returns focus when it closes: the element that had it when the command ran,
 * normally the composer's input, so the user keeps typing where they were. A menu opened by its trigger keeps Base UI's
 * default of returning to the trigger (`true`), as does a command run from a surface that is gone by then, such as the
 * command palette's input.
 */
export function agentChatCommandFinalFocus(focusedWhenRun: Element | null): HTMLElement | true {
    if (
        focusedWhenRun?.isConnected &&
        focusedWhenRun !== focusedWhenRun.ownerDocument.body &&
        'focus' in focusedWhenRun
    )
        return focusedWhenRun as HTMLElement;
    return true;
}
