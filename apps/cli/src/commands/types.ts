import type { CaxriMethod, CaxriMethodDescription } from '@caxri/protocol';
import { describeCaxriMethod } from '@caxri/protocol';

export const CLI_GROUPS = [
    { name: 'host', summary: 'Inspect and control the profile Server.' },
    { name: 'desktop', summary: 'Inspect and focus the Desktop client.' },
    { name: 'project', summary: 'Manage added Projects.' },
    { name: 'session', summary: 'Manage Project Sessions.' },
    { name: 'terminal', summary: 'Inspect and control Terminals.' },
    { name: 'settings', summary: 'Read and update shared settings.' },
    { name: 'logs', summary: 'Follow structured Server logs.' },
    { name: 'events', summary: 'Watch recoverable typed Server events.' },
    { name: 'diagnostics', summary: 'Inspect redacted diagnostics.' },
    { name: 'agent', summary: 'Use generation-scoped Agent endpoints.' },
    { name: 'bot', summary: 'Coordinate Agents across Projects from Caxri Bot.' },
    { name: 'secret', summary: 'Use the secrets the user saved for Agents.' },
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
    /**
     * The result field holding the entries `--quiet` prints, when the result is not itself the entry or entry list.
     */
    quietKey?: string;
    /**
     * The entry field `--quiet` prints, when the entry's stable ID is not `id` (for example a board row's `sessionId`,
     * or an Agent Endpoint's `ref`, printed as the reference `agent` commands accept). `catalog.test.ts` checks every
     * declared pair against the method's result schema, because a quiet read that fails after a mutation already ran
     * reports failure for work that happened.
     */
    quietIdKey?: string;
    stream?: 'events' | 'logs';
    /**
     * Replaces the single `method` request with a command-owned flow, such as a poll loop or a child process, and
     * returns the process exit code. `method` still declares the first request, its capability, and its effect.
     */
    run?(context: RemoteCommandRunContext): Promise<number>;
    usage?: string;
}

/**
 * What a command-owned flow (`RemoteCommandDefinition.run`) receives once the connection is open.
 */
export interface RemoteCommandRunContext {
    cwd: string;
    environment: NodeJS.ProcessEnv;
    json: boolean;
    parameters: unknown;
    request(method: CaxriMethod, parameters: unknown): Promise<unknown>;
    signal?: AbortSignal;
    writeStderr(text: string): void;
    writeStdout(text: string): void;
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
