import type { TerminalExecutionLaunch } from '../../domains/terminal';
import type { TerminalHostRequest } from '../../terminal-host/protocol';

/**
 * Projects a Core launch onto the private `terminal.start` plan. Only the allowlisted fields cross the process
 * boundary; `initialSize` is the grid of the Renderer view already attached when the launch is sent.
 */
export function terminalStartRequest(
    input: TerminalExecutionLaunch,
    initialSize: { cols: number; rows: number } | undefined,
): Extract<TerminalHostRequest, { method: 'terminal.start' }> {
    return {
        method: 'terminal.start',
        params: {
            record: input.record,
            executable: input.executable,
            args: input.args,
            environment: input.environment as Record<string, string>,
            ...(input.agent && {
                agent: {
                    launchId: input.agent.launchId,
                    provider: input.agent.provider,
                    executable: input.agent.executable,
                    args: input.agent.args,
                    environment: input.agent.environment as Record<string, string>,
                },
            }),
            ...(input.initialSnapshot && { initialSnapshot: input.initialSnapshot }),
            ...(initialSize && { initialSize }),
            ...(input.outputRecovery && { outputRecovery: input.outputRecovery }),
            ...(input.colors && {
                colors: {
                    background: input.colors.background,
                    foreground: input.colors.foreground,
                },
            }),
        },
    };
}
