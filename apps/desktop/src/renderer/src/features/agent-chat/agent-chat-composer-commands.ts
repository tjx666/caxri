/**
 * The composer controls a keyboard command can reach: the model picker, the permission menu, and the plan mode toggle.
 */
export type AgentChatComposerCommand = 'changeModel' | 'changePermissionMode' | 'togglePlanMode';

/**
 * Each mounted Chat composer registers the controls its provider offers, keyed by Terminal id, so a command reaches the
 * live menu with a direct call. A control registers only while it renders, which is what gates the commands: a provider
 * without a model list, permission levels, or plan mode, a Terminal surface, and any other tab have nothing here, so
 * the shortcut falls through and the palette hides the command. Only one pane owns a given Terminal at a time, so one
 * handler per command and Terminal is enough.
 */
const handlers = new Map<string, Map<AgentChatComposerCommand, () => void>>();

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
    return () => {
        const current = handlers.get(terminalId);
        if (current?.get(command) !== run) return;
        current.delete(command);
        if (current.size === 0) handlers.delete(terminalId);
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
