import {
    CaxriError,
    describeCaxriMethod,
    logQueryParamsSchema,
    settingsPatchChangeSchema,
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
    { name: 'events', summary: 'Watch recoverable typed Host events.' },
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
    mutates?(params: unknown): boolean;
    parseParams(tokens: readonly string[]): unknown;
    path: readonly [CliGroupName, string];
    summary: string;
    quietKey?: string;
    stream?: 'events' | 'logs';
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

function selectorQuery(
    tokens: readonly string[],
    mode: 'list' | 'show',
    scope?: { flag: string; key: 'projectId' | 'sessionId' },
): Record<string, unknown> {
    const positional: string[] = [];
    let scopeValue: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (scope && token === scope.flag) {
            const value = tokens[index + 1];
            if (!value || value.startsWith('--'))
                throw new CaxriError('VALIDATION', `${scope.flag} requires a value`);
            if (scopeValue)
                throw new CaxriError('VALIDATION', `${scope.flag} may be provided only once`);
            scopeValue = value;
            index += 1;
        } else if (token.startsWith('--')) {
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=')[0]}`);
        } else positional.push(token);
    }
    if (mode === 'list' && positional.length > 0)
        throw new CaxriError('VALIDATION', `Unexpected argument: ${positional[0]}`);
    if (mode === 'show' && positional.length !== 1)
        throw new CaxriError('VALIDATION', 'show requires exactly one ID or name');
    return {
        mode,
        ...(mode === 'show' ? { selector: positional[0] } : {}),
        ...(scope && scopeValue ? { [scope.key]: scopeValue } : {}),
    };
}

function settingPatch(tokens: readonly string[], forceDryRun: boolean): Record<string, unknown> {
    const changes: unknown[] = [];
    let dryRun = forceDryRun;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--dry-run' && !forceDryRun) {
            dryRun = true;
            continue;
        }
        if (token !== '--set')
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=')[0]}`);
        const assignment = tokens[index + 1];
        if (!assignment || assignment.startsWith('--'))
            throw new CaxriError('VALIDATION', '--set requires key=value');
        const separator = assignment.indexOf('=');
        if (separator < 1) throw new CaxriError('VALIDATION', '--set requires key=value');
        const key = assignment.slice(0, separator);
        const source = assignment.slice(separator + 1);
        let value: unknown;
        try {
            value = JSON.parse(source) as unknown;
        } catch {
            value = source;
        }
        changes.push(settingsPatchChangeSchema.parse({ key, value }));
        index += 1;
    }
    if (changes.length === 0)
        throw new CaxriError('VALIDATION', 'At least one --set key=value is required');
    return { changes, dryRun };
}

function logQuery(tokens: readonly string[]): Record<string, unknown> {
    const keys = new Map([
        ['--after', 'afterCursor'],
        ['--correlation-id', 'correlationId'],
        ['--event', 'event'],
        ['--level', 'level'],
        ['--limit', 'limit'],
        ['--process', 'process'],
        ['--since', 'since'],
    ]);
    const result: Record<string, unknown> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const key = keys.get(token);
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=')[0]}`);
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${token} requires a value`);
        result[key] = key === 'limit' ? Number(value) : value;
        index += 1;
    }
    return logQueryParamsSchema.parse(result);
}

function eventRecovery(tokens: readonly string[]): Record<string, number> {
    if (tokens.length === 0) return { afterCursor: 0 };
    if (tokens.length !== 2 || tokens[0] !== '--after')
        throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=')[0]}`);
    const afterCursor = Number(tokens[1]);
    if (!Number.isInteger(afterCursor) || afterCursor < 0)
        throw new CaxriError('VALIDATION', '--after must be a non-negative integer cursor');
    return { afterCursor };
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
    {
        kind: 'remote',
        path: ['project', 'list'],
        method: 'project.query',
        summary: 'List Projects visible to the authenticated principal.',
        parseParams: (tokens) => selectorQuery(tokens, 'list'),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['project', 'show'],
        method: 'project.query',
        summary: 'Show one exact Project by opaque ID or unambiguous name.',
        usage: '<id-or-name>',
        parseParams: (tokens) => selectorQuery(tokens, 'show'),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['project', 'current'],
        method: 'project.query',
        summary: 'Show the current Project for this profile.',
        parseParams: (tokens) => ({ ...rejectOptions(tokens), mode: 'current' }),
        quietKey: 'projects',
    },
    {
        kind: 'remote',
        path: ['session', 'list'],
        method: 'session.query',
        summary: 'List Sessions, optionally scoped to one Project ID.',
        usage: '[--project <project-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'list', { flag: '--project', key: 'projectId' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['session', 'show'],
        method: 'session.query',
        summary: 'Show one exact Session by opaque ID or unambiguous name.',
        usage: '<id-or-name> [--project <project-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'show', { flag: '--project', key: 'projectId' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['session', 'current'],
        method: 'session.query',
        summary: 'Show the current Session for this profile.',
        parseParams: (tokens) => ({ ...rejectOptions(tokens), mode: 'current' }),
        quietKey: 'sessions',
    },
    {
        kind: 'remote',
        path: ['terminal', 'list'],
        method: 'terminal.query',
        summary: 'List Terminals, optionally scoped to one Session ID.',
        usage: '[--session <session-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'list', { flag: '--session', key: 'sessionId' }),
        quietKey: 'terminals',
    },
    {
        kind: 'remote',
        path: ['terminal', 'show'],
        method: 'terminal.query',
        summary: 'Show one exact Terminal by opaque ID or unambiguous title.',
        usage: '<id-or-title> [--session <session-id>]',
        parseParams: (tokens) =>
            selectorQuery(tokens, 'show', { flag: '--session', key: 'sessionId' }),
        quietKey: 'terminals',
    },
    {
        kind: 'remote',
        path: ['settings', 'get'],
        method: 'settings.inspect',
        summary: 'Show the allowlisted shared Settings projection.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['settings', 'validate'],
        method: 'settings.patch',
        summary: 'Validate a field-bounded Settings patch without writing it.',
        usage: '--set <key=value> [--set <key=value> ...]',
        mutates: () => false,
        parseParams: (tokens) => settingPatch(tokens, true),
    },
    {
        kind: 'remote',
        path: ['settings', 'patch'],
        method: 'settings.patch',
        summary: 'Atomically apply a field-bounded shared Settings patch.',
        usage: '--set <key=value> [--set <key=value> ...] [--dry-run]',
        confirmation: 'Apply this Settings patch to the selected Caxri profile?',
        mutates: (params) =>
            typeof params === 'object' && params !== null && Reflect.get(params, 'dryRun') !== true,
        parseParams: (tokens) => settingPatch(tokens, false),
    },
    {
        kind: 'remote',
        path: ['logs', 'query'],
        method: 'logs.query',
        summary: 'Query a bounded page of allowlisted structured log metadata.',
        usage: '[--after <cursor>] [--since <ISO-time>] [--process <name>] [--level <level>] [--event <name>] [--correlation-id <id>] [--limit <1-100>]',
        parseParams: logQuery,
        quietKey: 'records',
    },
    {
        kind: 'remote',
        path: ['logs', 'follow'],
        method: 'logs.query',
        summary: 'Follow bounded structured log pages until interrupted.',
        usage: '[query filters]',
        parseParams: logQuery,
        stream: 'logs',
    },
    {
        kind: 'remote',
        path: ['diagnostics', 'snapshot'],
        method: 'diagnostics.snapshot',
        summary: 'Show a content-free diagnostic snapshot.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['events', 'watch'],
        method: 'events.query',
        summary: 'Watch bounded recoverable typed events until interrupted.',
        usage: '[--after <cursor>]',
        parseParams: eventRecovery,
        stream: 'events',
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
