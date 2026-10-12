import { disposeAllThenRethrow } from '@caxri/utils';
import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';

import { translate } from '../../i18n';

export type TerminalCommandNavigationDirection = 'next' | 'previous';

export interface TerminalCommandStatus {
    commandCount: number;
    completedCount: number;
    lastExitStatus?: number;
}

interface TerminalCommandColors {
    failed: string;
    running: string;
    succeeded: string;
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Dark-theme fallbacks used only until the active theme resolves a usable hex `--danger` / `--success` value (e.g. the
 * first frame before the theme store hydrates).
 */
const FALLBACK_FAILED_COLOR = '#ff5555';
const FALLBACK_SUCCEEDED_COLOR = '#50fa7b';

/**
 * VS Code registers a distinct `terminalCommandDecoration.errorBackground` / `successBackground` per theme (dark,
 * light, high-contrast) rather than one fixed hex; deriving these from the active theme's `--danger` / `--success`
 * tokens is the faithful token-driven equivalent: every imported theme gets matching gutter colors instead of one color
 * baked in for every theme.
 */
export function terminalCommandDecorationFailedColor(danger: string | undefined): string {
    return danger && HEX_COLOR_PATTERN.test(danger) ? danger : FALLBACK_FAILED_COLOR;
}

export function terminalCommandDecorationSucceededColor(success: string | undefined): string {
    return success && HEX_COLOR_PATTERN.test(success) ? success : FALLBACK_SUCCEEDED_COLOR;
}

/**
 * VS Code's `terminalCommandDecoration.defaultBackground`: the terminal foreground at 25% alpha, so the running/unknown
 * placeholder stays subtle on any theme. Falls back to VS Code's dark-theme value when the theme has no usable hex
 * foreground.
 */
export function terminalCommandDecorationDefaultColor(foreground: string | undefined): string {
    return foreground && HEX_COLOR_PATTERN.test(foreground) ? `${foreground}40` : '#ffffff40';
}

/**
 * Hover copy for the command decoration's `title` tooltip. Exit status is only meaningful once a command has finished,
 * so a running command never claims an exit code.
 */
export function terminalCommandDecorationTooltip(
    phase: 'failed' | 'running' | 'succeeded',
    exitStatus?: number,
): string {
    if (phase === 'running') return translate('terminal.command.running');
    if (phase === 'succeeded') return translate('terminal.command.succeeded');
    return exitStatus === undefined
        ? translate('terminal.command.failedUnknown')
        : translate('terminal.command.failed', { exitStatus });
}

interface CommandBoundary {
    decoration?: IDecoration;
    finishMarker?: IMarker;
    startMarker: IMarker;
    status?: number;
}

const MAX_RETAINED_COMMANDS = 1_000;

/**
 * VS Code's decoration glyph metrics (`DecorationStyles` in its decorationAddon): a 16px icon pulled left of column 0
 * into the terminal's reserved gutter.
 */
const DECORATION_WIDTH_PX = 16;
const DECORATION_MARGIN_LEFT_PX = -17;

/**
 * Maps explicit OSC 133/633 lifecycle controls to content-free xterm markers. It never inspects or retains command
 * text, prompt text, or output, and unsupported protocol fields are ignored.
 */
export class TerminalCommandTracker {
    private readonly commands: CommandBoundary[] = [];
    private readonly protocolDisposables: IDisposable[];
    private navigationIndex: number | undefined;
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

    /**
     * VS Code shows no decoration for a prompt that has not executed a command yet; the marker is still retained so the
     * next `OSC 133;C` can anchor its decoration at the prompt line.
     */
    private startPrompt(): void {
        this.promptMarker?.dispose();
        this.promptMarker = this.terminal.registerMarker();
    }

    private startCommand(): void {
        if (this.running) return;
        this.pruneDisposedCommands();
        this.pruneExcessCommands();
        const marker = this.promptMarker ?? this.terminal.registerMarker();
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
            if (!command.startMarker.isDisposed && command.startMarker.line !== -1) continue;
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

    /**
     * VS Code-style command decoration: a 16px glyph in the terminal's left gutter, drawn by CSS from the phase data
     * attribute (hollow circle while running, filled circle on success, cross on failure). The element accepts pointer
     * events only so its native `title` can show the command's exit status on hover; it has no click handler, so it
     * never steals focus or intercepts a click intended for the terminal underneath.
     */
    private decorate(
        marker: IMarker,
        phase: 'failed' | 'running' | 'succeeded',
        color: string,
        exitStatus?: number,
    ): IDecoration | undefined {
        const decoration = this.terminal.registerDecoration({ marker, width: 1 });
        decoration?.onRender((element) => {
            element.classList.add('terminal-command-decoration');
            element.dataset.terminalCommandPhase = phase;
            element.style.color = color;
            element.style.marginLeft = `${DECORATION_MARGIN_LEFT_PX}px`;
            element.style.width = `${DECORATION_WIDTH_PX}px`;
            element.title = terminalCommandDecorationTooltip(phase, exitStatus);
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

    /**
     * Releases the OSC handlers, prompt marker, and every command's markers and decoration through one isolated
     * `disposeAllThenRethrow`, so a throwing xterm `dispose()` cannot leave a later OSC handler registered. State is
     * reset before the rethrow so a failed teardown still leaves the tracker empty.
     */
    dispose(): void {
        const disposables: IDisposable[] = [...this.protocolDisposables];
        if (this.promptMarker) disposables.push(this.promptMarker);
        for (const { decoration, finishMarker, startMarker } of this.commands) {
            if (decoration) disposables.push(decoration);
            if (finishMarker) disposables.push(finishMarker);
            disposables.push(startMarker);
        }
        this.commands.length = 0;
        this.promptMarker = undefined;
        this.running = undefined;
        disposeAllThenRethrow(disposables);
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
        this.terminal.scrollToLine(command.startMarker.line);
        return true;
    }
}

export function formatTerminalCommandCompletionStatus(exitStatus: number): string {
    return exitStatus === 0
        ? translate('terminal.command.completedAnnouncement')
        : translate('terminal.command.failedAnnouncement', { exitStatus });
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
