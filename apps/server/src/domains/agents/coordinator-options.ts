import type { AgentProvider } from '@caxri/protocol';

import type { AgentLifecycleSignal } from './hooks/contract';
import type { SessionActivityTransition } from './session-activity-log';

export interface AgentCoordinatorOptions {
    /**
     * A delivered `SIGINT` (Agent Endpoint control) interrupted the launch's turn. Keyboard Escape is observed through
     * Terminal input instead.
     */
    onSignalInterrupt?: (terminalId: string) => void;
    onLifecycleApplied?: (signal: AgentLifecycleSignal) => void;
    /**
     * A Session's durable activity state changed, from a hook or a probe.
     */
    onSessionActivityChanged?: (transition: SessionActivityTransition) => void;
    /**
     * Trailing delay before Agent Terminal output refreshes durable Agent metadata.
     */
    refreshDelayMs?: number;
    /**
     * Safety bound for a lost `PostCompact` signal. Production uses five minutes; tests may shorten it.
     */
    compactionTimeoutMs?: number;
    runningWatchdogIntervalMs?: number;
    /**
     * Window of missing evidence a hook turn survives before recovery releases it. Production uses two minutes; focused
     * Electron coverage shortens it through `agents/e2e-options.ts`.
     */
    unknownRecoveryMs?: number;
    detectForegroundAgent?: (shellPid: number) => Promise<AgentProvider | undefined>;
    /**
     * Delay between bounded foreground-process retries. Production uses one second; tests may shorten it.
     */
    shellProcessProbeIntervalMs?: number;
}
