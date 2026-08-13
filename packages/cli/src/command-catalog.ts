import {
    CaxriError,
    describeCaxriMethod,
    type CaxriMethod,
    type CaxriMethodDescription,
} from '@caxri/protocol';

export const CLI_GROUPS = [
    { name: 'host', summary: 'Inspect and control the profile Host.' },
    { name: 'desktop', summary: 'Inspect and focus the Desktop client.' },
    { name: 'project', summary: 'Manage added Projects.' },
    { name: 'session', summary: 'Manage Project Sessions.' },
    { name: 'terminal', summary: 'Inspect and control Terminals.' },
    { name: 'settings', summary: 'Read and update shared settings.' },
    { name: 'logs', summary: 'Follow structured Host logs.' },
    { name: 'diagnostics', summary: 'Inspect redacted diagnostics.' },
    { name: 'agent', summary: 'Use generation-scoped Agent endpoints.' },
    { name: 'skills', summary: 'Inspect and install Caxri Agent skills.' },
] as const;

export type CliGroupName = (typeof CLI_GROUPS)[number]['name'];

interface LocalCommandDefinition {
    kind: 'local';
    path: readonly [string];
    summary: string;
}

export interface RemoteCommandDefinition {
    confirmation?: string;
    kind: 'remote';
    method: CaxriMethod;
    parseParams(tokens: readonly string[]): unknown;
    path: readonly [CliGroupName, string];
    summary: string;
    usage?: string;
}

export type CliCommandDefinition = LocalCommandDefinition | RemoteCommandDefinition;

function rejectOptions(tokens: readonly string[]): Record<string, never> {
    if (tokens.length > 0)
        throw new CaxriError('VALIDATION', `Unexpected argument: ${tokens[0].split('=')[0]}`);
    return {};
}

function booleanFlag(
    tokens: readonly string[],
    flag: string,
    key: string,
): Record<string, boolean> {
    if (tokens.length === 0) return { [key]: false };
    if (tokens.length === 1 && tokens[0] === flag) return { [key]: true };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=')[0]}`);
}

export const CLI_COMMANDS = [
    {
        kind: 'local',
        path: ['capabilities'],
        summary: 'Print local command and schema introspection without requiring a Host.',
    },
    {
        kind: 'local',
        path: ['agent-context'],
        summary: 'Print local automation and protocol context without requiring a Host.',
    },
    {
        kind: 'remote',
        path: ['host', 'status'],
        method: 'host.status',
        summary: 'Show the selected profile Host and Desktop status.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['host', 'stop'],
        method: 'host.stop',
        summary: 'Stop the selected profile Host and its Runtime.',
        confirmation: 'Stop this Caxri Host and terminate its live Terminals?',
        usage: '[--force]',
        parseParams: (tokens) => booleanFlag(tokens, '--force', 'confirmLivePtys'),
    },
    {
        kind: 'remote',
        path: ['desktop', 'status'],
        method: 'desktop.status',
        summary: 'Show whether a Desktop capability lease is available.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['desktop', 'focus'],
        method: 'desktop.focus',
        summary: 'Focus the current Desktop, optionally launching it first.',
        usage: '[--launch]',
        parseParams: (tokens) => booleanFlag(tokens, '--launch', 'launchIfNeeded'),
    },
] as const satisfies readonly CliCommandDefinition[];

export function findCliCommand(tokens: readonly string[]): CliCommandDefinition | undefined {
    return CLI_COMMANDS.find(
        (command) =>
            command.path.length <= tokens.length &&
            command.path.every((part, index) => tokens[index] === part),
    );
}

export interface CliCommandDescription {
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
}

export function describeCliCommand(command: CliCommandDefinition): CliCommandDescription {
    if (command.kind === 'local') return { ...command };
    const method: CaxriMethodDescription = describeCaxriMethod(command.method);
    return {
        ...method,
        capabilities: method.capabilities,
        kind: 'remote',
        path: command.path,
        summary: command.summary,
    };
}
