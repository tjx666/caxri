import { isTerminalResourceUsageHigh, TERMINAL_RESOURCE_ALERT_THRESHOLDS } from '@caxri/protocol';
import {
    CircleAlert,
    Hourglass,
    LoaderCircle,
    MemoryStick,
    Pause,
    Workflow,
    ZapOff,
} from 'lucide-react';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { executeCommand } from '../../commands/execute';
import { StructuredTooltip } from '../../components/structured-tooltip';
import { formatCpuPercent, formatMemoryMb } from '../../lib/resource-usage-format';
import { cn } from '../../lib/utilities';
import { openHardwareAccelerationSettings } from '../gpu/gpu-commands';
import { useIsHardwareAccelerationOff } from '../gpu/use-is-hardware-acceleration-off';
import {
    terminalProgressAriaLabel,
    terminalProgressLabel,
    useTerminalProgress,
} from '../terminal/terminal-progress';
import { confirmTerminalRendererSwitch } from '../terminal/terminal-renderer-commands';
import {
    terminalRendererIndicator,
    useTerminalRendererStatus,
} from '../terminal/terminal-renderer-status';
import { AgentThroughputStatus } from './agent-throughput-status';
import { AgentUsageStatus } from './agent-usage-status';
import { StatusInfo } from './status-info';
import { PriorityChipSlot, StatusItem } from './status-item';

const openProcessExplorer = (): void => executeCommand('processExplorer.open');

/**
 * Settled fallbacks offer enabling GPU acceleration, an explicit retry, or (when this window has no GPU at all) the
 * Settings row that owns hardware acceleration. An automatic recovery already in progress stays informational so clicks
 * cannot multiply pending attempts.
 */
function TerminalRendererStatus({ terminalId }: { terminalId: string }) {
    const renderer = terminalRendererIndicator(useTerminalRendererStatus(terminalId), {
        isHardwareAccelerationOff: useIsHardwareAccelerationOff(),
    });
    if (!renderer) return null;
    const shared = {
        ariaLabel: renderer.ariaLabel,
        className: 'statusbar-terminal-renderer text-warning',
        icon: <ZapOff />,
        title: renderer.title,
    };
    const action = renderer.action;
    if (!action) return <StatusInfo {...shared}>{renderer.label}</StatusInfo>;
    return (
        <StatusItem
            {...shared}
            onClick={() => {
                if ('opensSettings' in action) {
                    openHardwareAccelerationSettings();
                    return;
                }
                // eslint-disable-next-line no-void -- intentional floating-promise discard, confirmTerminalRendererSwitch() reports its own errors via tryCommand
                void confirmTerminalRendererSwitch(action, terminalId);
            }}
        >
            {renderer.label}
        </StatusItem>
    );
}

/**
 * `normal` progress takes an hourglass rather than a gauge: the gauge is the Agent output-speed chip's glyph, and the
 * two chips sit side by side on an Agent Terminal.
 */
const progressIcons = {
    error: CircleAlert,
    indeterminate: LoaderCircle,
    normal: Hourglass,
    paused: Pause,
} as const;

/**
 * `--accent` is reserved for the one focused pane/tab (DESIGN.md principle 2). This badge renders for every Terminal
 * with progress, not just the active one, so a background process must not borrow the accent color: only the genuinely
 * exceptional states (`error`/`paused`) get a status color here; the common "normal" case stays neutral.
 */
const progressColors = {
    error: 'text-danger',
    indeterminate: undefined,
    normal: 'text-muted',
    paused: 'text-warning',
} as const;

function TerminalProgressStatus({ terminalId }: { terminalId: string }) {
    const progress = useTerminalProgress(terminalId);
    if (!progress) return null;
    const label = terminalProgressAriaLabel(progress);
    const ProgressIcon = progressIcons[progress.kind];
    return (
        <StatusInfo
            ariaLabel={label}
            className={cn(
                'statusbar-terminal-progress tabular-nums',
                progressColors[progress.kind],
            )}
            icon={<ProgressIcon />}
            title={label}
        >
            {terminalProgressLabel(progress)}
        </StatusInfo>
    );
}

/**
 * Deliberately informational-only, not the primary entry point: "Open Process Explorer" already lives in the native
 * Help menu and the Command Palette (`processExplorer.open` in `shared/commands.ts`), so it stays reachable regardless
 * of the active tab. Duplicating it as an always-present status-bar button would compete with those two discoverable
 * routes for a diagnostic tool most users open rarely; instead this chip earns its place by doubling as a live memory
 * reading for the active Terminal; clicking it is a convenience shortcut, not a required affordance, which is why it is
 * allowed to disappear on editor/diff tabs where there is no Terminal metric to show.
 */
function TerminalUsageStatus({
    showChildProcessCount,
    showMemory,
    terminalId,
}: {
    showChildProcessCount: boolean;
    showMemory: boolean;
    terminalId: string;
}) {
    const usage = usePolledQuery(
        'terminal.resources',
        { terminalId },
        { label: 'terminal.resources', intervalMs: 2_000, staleTime: 1_000, retry: false },
    ).data;
    if (!usage) return null;
    const childLabel = `${usage.childProcessCount} ${usage.childProcessCount === 1 ? 'child process' : 'child processes'}`;
    const memoryLabel = formatMemoryMb(usage.memoryMb);
    const cpuLabel = formatCpuPercent(usage.cpuPercent);
    /**
     * The same thresholds Server Core alerts on, so the chip turns red exactly when a resource alert would be justified
     * for this Terminal, without waiting for the alert's consecutive-sample confirmation.
     */
    const isHigh = isTerminalResourceUsageHigh(usage);
    return (
        <>
            {showMemory && (
                <PriorityChipSlot chip="memory">
                    <StatusItem
                        ariaLabel={`Open Process Explorer — Terminal memory: ${memoryLabel}${isHigh ? ', high resource use' : ''}`}
                        className={cn(isHigh && 'text-danger')}
                        icon={<MemoryStick />}
                        title={
                            <StructuredTooltip
                                title={
                                    isHigh
                                        ? `High resource use: ${memoryLabel}, ${cpuLabel} CPU`
                                        : `Terminal memory: ${memoryLabel}`
                                }
                                notes={[
                                    `Resident memory of this Terminal's whole process tree; CPU ${cpuLabel}`,
                                    ...(isHigh
                                        ? [
                                              `Above ${formatMemoryMb(TERMINAL_RESOURCE_ALERT_THRESHOLDS.memoryMb)} memory or ${TERMINAL_RESOURCE_ALERT_THRESHOLDS.cpuPercent}% CPU`,
                                          ]
                                        : []),
                                ]}
                                hint="Click to open Process Explorer"
                            />
                        }
                        onClick={openProcessExplorer}
                    >
                        {memoryLabel}
                    </StatusItem>
                </PriorityChipSlot>
            )}
            {showChildProcessCount && (
                <PriorityChipSlot chip="childProcessCount">
                    <StatusItem
                        ariaLabel={`Open Process Explorer — Terminal: ${childLabel}`}
                        icon={<Workflow />}
                        title={
                            <StructuredTooltip
                                title={childLabel}
                                notes={['Running under this Terminal']}
                                hint="Click to open Process Explorer"
                            />
                        }
                        onClick={openProcessExplorer}
                    >
                        {usage.childProcessCount}
                    </StatusItem>
                </PriorityChipSlot>
            )}
        </>
    );
}

/**
 * The status bar's right side while a Terminal owns the active tab: renderer fallback, OSC progress, the hosted Agent's
 * output speed and conversation usage, and the two live process metrics. Each chip owns its own data and renders
 * nothing when it has none, so this composition holds no conditions of its own.
 */
export function ActiveTerminalStatus({
    showAgentThroughput,
    showAgentUsage,
    showChildProcessCount,
    showMemory,
    terminalId,
}: {
    showAgentThroughput: boolean;
    showAgentUsage: boolean;
    /**
     * Priority-hidden first as the status bar narrows (see `chip-priority.ts`): both metrics duplicate a live reading
     * already available in Process Explorer, so hiding them loses no information the user cannot get elsewhere.
     */
    showChildProcessCount: boolean;
    showMemory: boolean;
    terminalId: string;
}) {
    return (
        <>
            <TerminalRendererStatus terminalId={terminalId} />
            <TerminalProgressStatus terminalId={terminalId} />
            {showAgentThroughput && (
                <PriorityChipSlot chip="agentThroughput">
                    <AgentThroughputStatus terminalId={terminalId} />
                </PriorityChipSlot>
            )}
            {showAgentUsage && (
                <PriorityChipSlot chip="agentUsage">
                    <AgentUsageStatus terminalId={terminalId} />
                </PriorityChipSlot>
            )}
            <TerminalUsageStatus
                showChildProcessCount={showChildProcessCount}
                showMemory={showMemory}
                terminalId={terminalId}
            />
        </>
    );
}
