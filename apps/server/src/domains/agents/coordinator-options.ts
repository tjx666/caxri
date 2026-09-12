import type { AgentProvider } from '@caxri/protocol';

import type { AgentLifecycleSignal } from './hooks/contract';

export interface AgentCoordinatorOptions {
    onLifecycleApplied?: (signal: AgentLifecycleSignal) => void;
    /**
     * Trailing delay before Agent Terminal output refreshes durable Agent metadata.
     */
    refreshDelayMs?: number;
    /**
     * Safety bound for a lost `PostCompact` signal. Production uses five minutes; tests may shorten it.
     */
    compactionTimeoutMs?: number;
    runningWatchdogIntervalMs?: number;
    detectForegroundAgent?: (shellPid: number) => Promise<AgentProvider | undefined>;
    /**
     * Delay between bounded foreground-process retries. Production uses one second; tests may shorten it.
     */
    shellProcessProbeIntervalMs?: number;
}
