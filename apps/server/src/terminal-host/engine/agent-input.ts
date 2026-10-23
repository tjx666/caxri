import { Buffer } from 'node:buffer';

import { assertE2EAgentInput, readE2EAgentPolicy } from '@caxri/system';
import type * as pty from 'node-pty';

import type { LiveTerminal } from './types';

export interface AgentInputHandoff {
    ready: Promise<void>;
    resumeAfterDrain(): void;
    closeOnLostDrain(): void;
}

export function noOpAgentInputHandoff(): AgentInputHandoff {
    return { ready: Promise.resolve(), resumeAfterDrain: () => {}, closeOnLostDrain: () => {} };
}

export function writeAgentInputWithCompletion(
    live: LiveTerminal | undefined,
    quiescedInput: ReadonlySet<LiveTerminal>,
    data: string | Buffer,
    scheduleMetric: (live: LiveTerminal) => void,
): Promise<boolean> {
    if (!live || quiescedInput.has(live) || !live.process.writeWithCompletion)
        return Promise.resolve(false);
    if (live.record.provider) assertE2EAgentInput(readE2EAgentPolicy(), live.record.provider);
    live.metricInputBytes += Buffer.isBuffer(data)
        ? data.byteLength
        : Buffer.byteLength(data, 'utf8');
    live.throughput.firstInputAt ??= Date.now();
    scheduleMetric(live);
    return live.process.writeWithCompletion(data);
}

/**
 * Capture one PTY generation before awaiting a write callback or acknowledging the launcher.
 */
export function quiesceAgentInput(
    terminalId: string,
    current: (terminalId: string) => LiveTerminal | undefined,
    quiescedInput: Set<LiveTerminal>,
    close: (terminalId: string) => void,
): AgentInputHandoff {
    const live = current(terminalId);
    if (!live) return noOpAgentInputHandoff();
    quiescedInput.add(live);
    let ready: Promise<void>;
    try {
        ready = live.process.quiesceInput?.() ?? Promise.resolve();
    } catch {
        if (current(terminalId) === live) close(terminalId);
        ready = Promise.resolve();
    }
    return {
        ready,
        resumeAfterDrain: () => {
            if (current(terminalId) === live) live.process.resumeInput?.();
            quiescedInput.delete(live);
        },
        closeOnLostDrain: () => {
            if (current(terminalId) === live) close(terminalId);
            quiescedInput.delete(live);
        },
    };
}

/**
 * Do not close or recycle the PTY master descriptor while an fs.write callback still owns it.
 */
export function stopTerminalAfterInputQuiescence(live: LiveTerminal, shouldDestroy: boolean): void {
    const ready = live.process.quiesceInput?.() ?? Promise.resolve();
    void ready
        .then(() => {
            live.process.kill();
            if (shouldDestroy) (live.process as pty.IPty & { destroy?: () => void }).destroy?.();
        })
        .catch(() => {
            // Keep the PTY alive if an in-flight write cannot be proven settled.
        });
}
