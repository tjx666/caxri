import type { AgentProvider, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { WatchHub } from '../../watch';
import type { AgentEnvironment } from '../contract';
import type { AgentLifecycleSignal, AgentSignalDecision } from './contract';
import type { HookExecutableDiscovery } from './executable-gate';
import type { HookWireAttention } from './server';

/**
 * What the composition root hands `AgentHookManager`: the environment it installs into and the callbacks that apply
 * each authenticated signal, attention request, and launch transition downstream.
 */
export interface AgentHookManagerOptions {
    /**
     * Resolves the provider CLI on this machine. Lifecycle hooks default to enabled, but a provider whose CLI is not
     * installed must not have Caxri write into its configuration directory or claim it in the shared profile registry:
     * the setting stays on, the installation simply waits for the CLI to appear.
     */
    discoverExecutable: HookExecutableDiscovery;
    environment: AgentEnvironment;
    logger: StructuredLogger;
    onAuthorityLost: (provider: AgentProvider) => void;
    onLaunchEnded: (terminalId: string) => void;
    onLaunchStarted: (terminalId: string, launchId: string) => void;
    onSignal: (signal: AgentLifecycleSignal) => AgentSignalDecision | Promise<AgentSignalDecision>;
    /**
     * Text an accepted signal hands back to the provider as hook context, which the bridge prints for `turnStarted`.
     */
    turnContext?: (signal: AgentLifecycleSignal) => string | undefined;
    onAttention?: (
        request: HookWireAttention,
        signal: AbortSignal,
    ) => Promise<{
        decision?: 'allow' | 'deny';
        answers?: Record<string, string>;
    } | null>;
    hookExecutable: string;
    /**
     * Per-provider schema version this instance writes as the provider-file ordering token, announces to the bridge,
     * and accepts on the socket. Production derives it from the registered provider adapters; the multi-build
     * integration test substitutes a sibling build's value so two instances with different versions share one file.
     */
    schemaVersions?: Partial<Record<AgentProvider, number>>;
    send: (event: ServerEvent) => void;
    sharedPath?: string;
    userDataPath: string;
    /**
     * Shared Server watch registry. Production passes the Server-wide hub; tests may omit it, in which case the manager
     * owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}
