import {
    CircleAlert,
    Gauge,
    LoaderCircle,
    MemoryStick,
    Pause,
    Workflow,
    ZapOff,
} from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { cn } from '../../lib/utilities';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { confirmTerminalRendererSwitch } from '../terminal/terminal-renderer-actions';
import {
    terminalRendererIndicator,
    useTerminalRendererStatus,
} from '../terminal/terminal-renderer-status';
import { StatusInfo } from './status-info';
import { StatusItem } from './status-item';

const openProcessExplorer = (): void => executeCommand('processExplorer.open');

/**
 * The status bar's right side while a Terminal owns the active tab: renderer fallback, OSC progress, and the two live
 * process metrics.
 */
export function ActiveTerminalStatus({
    showChildProcessCount,
    showMemory,
    terminalId,
}: {
    /**
     * Priority-hidden first as the status bar narrows (see `chip-priority.ts`): both metrics duplicate a live reading
     * already available in Process Explorer, so hiding them loses no information the user cannot get elsewhere.
     */
    showChildProcessCount: boolean;
    showMemory: boolean;
    terminalId: string;
}) {
    const progress = useTerminalProgress(terminalId);
    const renderer = terminalRendererIndicator(useTerminalRendererStatus(terminalId));
    const rendererAction = renderer?.action;
    const usage = usePolledQuery(
        'terminal.resources',
        { terminalId },
        { label: 'terminal.resources', intervalMs: 2_000, staleTime: 1_000, retry: false },
    ).data;
    if (!usage && !progress && !renderer) return null;
    const childLabel = usage
        ? `${usage.childProcessCount} ${usage.childProcessCount === 1 ? 'child process' : 'child processes'}`
        : undefined;
    const ProgressIcon =
        progress?.kind === 'error'
            ? CircleAlert
            : progress?.kind === 'paused'
              ? Pause
              : progress?.kind === 'indeterminate'
                ? LoaderCircle
                : Gauge;
    return (
        <>
            {/**
             * The chip becomes a button exactly when the fallback is reversible from here — GPU acceleration turned off in Settings
             * — so the sentence explaining the slowdown is also the way out of it. Every other fallback reason stays a read-only
             * reading, because writing the preference again would not restore WebGL.
             */}
            {renderer &&
                (rendererAction ? (
                    <StatusItem
                        ariaLabel={renderer.ariaLabel}
                        className="statusbar-terminal-renderer text-warning"
                        icon={ZapOff}
                        title={renderer.title}
                        onClick={() => {
                            // eslint-disable-next-line no-void -- intentional floating-promise discard, confirmTerminalRendererSwitch() reports its own errors via tryCommand
                            void confirmTerminalRendererSwitch(rendererAction);
                        }}
                    >
                        {renderer.label}
                    </StatusItem>
                ) : (
                    <StatusInfo
                        ariaLabel={renderer.ariaLabel}
                        className="statusbar-terminal-renderer text-warning"
                        icon={ZapOff}
                        title={renderer.title}
                    >
                        {renderer.label}
                    </StatusInfo>
                ))}
            {progress && (
                <StatusInfo
                    ariaLabel={terminalProgressAriaLabel(progress)}
                    className={cn(
                        'statusbar-terminal-progress tabular-nums',
                        /**
                         * `--accent` is reserved for the one focused pane/tab (DESIGN.md principle 2). This badge
                         * renders for every Terminal with progress, not just the active one, so a background process
                         * must not borrow the accent color — only the genuinely exceptional states (`error`/`paused`)
                         * get a status color here; the common "normal" case stays neutral.
                         */
                        progress.kind === 'normal' && 'text-muted',
                        progress.kind === 'error' && 'text-danger',
                        progress.kind === 'paused' && 'text-warning',
                    )}
                    icon={ProgressIcon}
                    title={terminalProgressAriaLabel(progress)}
                >
                    {terminalProgressLabel(progress)}
                </StatusInfo>
            )}
            {/**
             * Deliberately informational-only, not the primary entry point: "Open Process Explorer" already lives in the native
             * Help menu and the Command Palette (`processExplorer.open` in `shared/commands.ts`), so it stays reachable regardless
             * of the active tab. Duplicating it as an always-present status-bar button would compete with those two discoverable
             * routes for a diagnostic tool most users open rarely; instead this chip earns its place by doubling as a live memory
             * reading for the active Terminal; clicking it is a convenience shortcut, not a required affordance, which is why it is
             * allowed to disappear on editor/diff tabs where there is no Terminal metric to show.
             */}
            {usage && showMemory && (
                <StatusItem
                    ariaLabel={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                    icon={MemoryStick}
                    title={`Open Process Explorer — Terminal memory: ${usage.memoryMb} MB`}
                    onClick={openProcessExplorer}
                >
                    {usage.memoryMb} MB
                </StatusItem>
            )}
            {usage && childLabel && showChildProcessCount && (
                <StatusItem
                    ariaLabel={`Open Process Explorer — Terminal: ${childLabel}`}
                    icon={Workflow}
                    title={`Open Process Explorer — Terminal: ${childLabel}`}
                    onClick={openProcessExplorer}
                >
                    {usage.childProcessCount}
                </StatusItem>
            )}
        </>
    );
}
