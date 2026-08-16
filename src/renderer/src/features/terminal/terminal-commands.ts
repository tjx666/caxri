import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';

export type TerminalCommandNavigationDirection = 'next' | 'previous';

export interface TerminalCommandStatus {
    commandCount: number;
    completedCount: number;
    lastExitStatus?: number;
}

interface TerminalCommandColors {
    failed: string;
    prompt: string;
    running: string;
    succeeded: string;
}

interface CommandBoundary {
    decoration?: IDecoration;
    finishMarker?: IMarker;
    startMarker: IMarker;
    status?: number;
}

const MAX_RETAINED_COMMANDS = 1_000;

function opaqueColor(color: string): string {
    return color.slice(0, 7);
}

/**
 * Maps explicit OSC 133/633 lifecycle controls to content-free xterm markers. It never inspects or retains command
 * text, prompt text, or output, and unsupported protocol fields are ignored.
 */
export class TerminalCommandTracker {
    private readonly commands: CommandBoundary[] = [];
    private readonly protocolDisposables: IDisposable[];
    private navigationIndex: number | undefined;
    private promptDecoration: IDecoration | undefined;
    private promptMarker: IMarker | undefined;
    private running: CommandBoundary | undefined;

    constructor(
        private readonly terminal: Terminal,
        private readonly colors: TerminalCommandColors,
        private readonly publish: (status: TerminalCommandStatus) => void,
    ) {
        this.protocolDisposables = [133, 633].map((protocol) =>
            terminal.parser.registerOscHandler(protocol, (data) => this.handle(data)),
        );
        this.publishStatus();
    }

    private handle(data: string): boolean {
        if (data.length > 64) return false;
        if (data === 'A') {
            this.startPrompt();
            return true;
        }
        if (data === 'B') return true;
        if (data === 'C') {
            this.startCommand();
            return true;
        }
        if (data === 'D' || data.startsWith('D;')) {
            this.finishCommand(data);
            return true;
        }
        return false;
    }

    private startPrompt(): void {
        this.promptDecoration?.dispose();
        this.promptMarker?.dispose();
        this.promptMarker = this.terminal.registerMarker();
        this.promptDecoration = this.promptMarker
            ? this.decorate(this.promptMarker, 'prompt', this.colors.prompt)
            : undefined;
    }

    private startCommand(): void {
        if (this.running) return;
        this.pruneDisposedCommands();
        this.pruneExcessCommands();
        const marker = this.promptMarker ?? this.terminal.registerMarker();
        if (!marker) return;
        this.promptDecoration?.dispose();
        this.promptDecoration = undefined;
        const command: CommandBoundary = {
            decoration: this.decorate(marker, 'running', this.colors.running),
            startMarker: marker,
        };
        this.commands.push(command);
        this.running = command;
        this.promptMarker = undefined;
        this.navigationIndex = undefined;
        this.publishStatus();
    }

    /**
     * Xterm disposes markers as their scrollback lines are trimmed. Release our matching decoration references before
     * adding another boundary so a long-running shell stays bounded.
     */
    private pruneDisposedCommands(): void {
        for (let index = this.commands.length - 1; index >= 0; index -= 1) {
            const command = this.commands[index];
            if (!command?.startMarker.isDisposed && command?.startMarker.line !== -1) continue;
            this.disposeCommand(command);
            this.commands.splice(index, 1);
        }
    }

    /**
     * OSC controls can repeat without advancing the screen, so xterm may never trim their markers. Enforce an
     * independent cap before retaining another command boundary.
     */
    private pruneExcessCommands(): void {
        while (this.commands.length >= MAX_RETAINED_COMMANDS) {
            const command = this.commands.shift();
            if (command) this.disposeCommand(command);
        }
    }

    private disposeCommand(command: CommandBoundary): void {
        command.decoration?.dispose();
        command.finishMarker?.dispose();
        command.startMarker.dispose();
    }

    private finishCommand(data: string): void {
        const command = this.running;
        if (!command) return;
        const statusSource = data.split(';', 3)[1];
        const status =
            statusSource && /^-?\d{1,10}$/u.test(statusSource) ? Number(statusSource) : 0;
        if (!Number.isSafeInteger(status)) return;
        command.status = status;
        command.finishMarker = this.terminal.registerMarker();
        command.decoration?.dispose();
        command.decoration = this.decorate(
            command.startMarker,
            status === 0 ? 'succeeded' : 'failed',
            status === 0 ? this.colors.succeeded : this.colors.failed,
            status,
        );
        this.running = undefined;
        this.publishStatus();
    }

    private decorate(
        marker: IMarker,
        phase: 'failed' | 'prompt' | 'running' | 'succeeded',
        color: string,
        exitStatus?: number,
    ): IDecoration | undefined {
        const decoration = this.terminal.registerDecoration({
            backgroundColor: opaqueColor(color),
            marker,
            width: 1,
        });
        decoration?.onRender((element) => {
            element.classList.add('terminal-command-decoration');
            element.dataset.terminalCommandPhase = phase;
            if (exitStatus !== undefined)
                element.dataset.terminalCommandExitStatus = String(exitStatus);
        });
        return decoration;
    }

    private publishStatus(): void {
        const completed = this.commands.filter(({ status }) => status !== undefined);
        this.publish({
            commandCount: this.commands.length,
            completedCount: completed.length,
            ...(completed.at(-1)?.status !== undefined && {
                lastExitStatus: completed.at(-1)!.status,
            }),
        });
    }

    dispose(): void {
        for (const disposable of this.protocolDisposables) disposable.dispose();
        this.promptDecoration?.dispose();
        this.promptMarker?.dispose();
        for (const command of this.commands) {
            command.decoration?.dispose();
            command.finishMarker?.dispose();
            command.startMarker.dispose();
        }
        this.commands.length = 0;
        this.promptDecoration = undefined;
        this.promptMarker = undefined;
        this.running = undefined;
    }

    navigate(direction: TerminalCommandNavigationDirection): boolean {
        const commands = this.commands.filter(({ startMarker }) => startMarker.line >= 0);
        if (commands.length === 0) return false;
        if (this.navigationIndex === undefined)
            this.navigationIndex = direction === 'previous' ? commands.length - 1 : 0;
        else
            this.navigationIndex = Math.min(
                commands.length - 1,
                Math.max(0, this.navigationIndex + (direction === 'previous' ? -1 : 1)),
            );
        const command = commands[this.navigationIndex];
        if (!command) return false;
        this.terminal.scrollToLine(command.startMarker.line);
        return true;
    }
}

export function formatTerminalCommandCompletionStatus(exitStatus: number): string {
    return exitStatus === 0
        ? 'Command completed successfully.'
        : `Command failed with exit status ${exitStatus}.`;
}

const navigationHandlers = new Map<
    string,
    (direction: TerminalCommandNavigationDirection) => boolean
>();

export function registerTerminalCommandNavigation(
    terminalId: string,
    canNavigate: (direction: TerminalCommandNavigationDirection) => boolean,
): () => void {
    navigationHandlers.set(terminalId, canNavigate);
    return () => {
        if (navigationHandlers.get(terminalId) === canNavigate)
            navigationHandlers.delete(terminalId);
    };
}

export function didNavigateTerminalCommand(
    terminalId: string,
    direction: TerminalCommandNavigationDirection,
): boolean {
    return navigationHandlers.get(terminalId)?.(direction) ?? false;
}
