import type { CaxriMethod, CaxriMethodDescription } from '@caxri/protocol';
import { describeCaxriMethod } from '@caxri/protocol';

export const CLI_GROUPS = [
    { name: 'host', summary: 'Inspect and control the profile Host.' },
    { name: 'desktop', summary: 'Inspect and focus the Desktop client.' },
    { name: 'project', summary: 'Manage added Projects.' },
    { name: 'session', summary: 'Manage Project Sessions.' },
    { name: 'terminal', summary: 'Inspect and control Terminals.' },
    { name: 'settings', summary: 'Read and update shared settings.' },
    { name: 'logs', summary: 'Follow structured Host logs.' },
    { name: 'events', summary: 'Watch recoverable typed Host events.' },
    { name: 'diagnostics', summary: 'Inspect redacted diagnostics.' },
    { name: 'agent', summary: 'Use generation-scoped Agent endpoints.' },
    { name: 'commander', summary: 'Coordinate Agents across Projects from the Agent Commander.' },
    { name: 'skills', summary: 'Inspect and install Caxri Agent skills.' },
] as const;

export interface LocalCommandDefinition {
    confirmation?: string;
    kind: 'local';
    mutates?: boolean;
    parseParams(tokens: readonly string[]): unknown;
    path: readonly [string, ...string[]];
    summary: string;
    usage?: string;
}

export interface RemoteCommandDefinition {
    confirmation?: string;
    /**
     * Owner confirmation is separate from the Server's explicit generation-scoped Agent grant.
     */
    ownerConfirmation?: string;
    kind: 'remote';
    method: CaxriMethod;
    mutates?(parameters: unknown): boolean;
    parseParams(tokens: readonly string[]): unknown;
    path: readonly [string, ...string[]];
    requiresAgentEndpoint?: boolean;
    requiresServerVersionMatch?: boolean;
    requiresHumanOwner?: boolean;
    summary: string;
    quietKey?: string;
    stream?: 'events' | 'logs';
    usage?: string;
}

export type CliCommandDefinition = LocalCommandDefinition | RemoteCommandDefinition;

interface CliCommandDescription {
    capabilities?: readonly string[];
    effect?: string;
    idempotency?: string;
    kind: 'local' | 'remote';
    method?: string;
    owner?: string;
    paramsSchema?: Record<string, unknown>;
    path: readonly string[];
    resultSchema?: Record<string, unknown>;
    summary: string;
    usage?: string;
}

export function describeCliCommand(command: CliCommandDefinition): CliCommandDescription {
    if (command.kind === 'local')
        return {
            kind: command.kind,
            path: command.path,
            summary: command.summary,
            ...(command.usage && { usage: command.usage }),
        };
    const method: CaxriMethodDescription = describeCaxriMethod(command.method);
    return {
        ...method,
        capabilities: method.capabilities,
        kind: 'remote',
        path: command.path,
        summary: command.summary,
        ...(command.usage && { usage: command.usage }),
    };
}
