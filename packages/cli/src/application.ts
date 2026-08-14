import { homedir } from 'node:os';

import {
    CaxriError,
    describeCaxriMethod,
    methods,
    type LogQueryResult,
    type ObservableEventRecovery,
    type AgentContextResult,
    type AgentEndpointSummary,
    type CaxriMethod,
    type ProtocolWelcome,
} from '@caxri/protocol';

import { connectToHost, ensureHost, type HostLaunchOptions } from './host-client';
import { parseCliArguments, type ParsedCliArguments } from './arguments';
import {
    CLI_COMMANDS,
    CLI_GROUPS,
    describeCliCommand,
    findCliCommand,
    type CliCommandDefinition,
    type RemoteCommandDefinition,
} from './command-catalog';
import {
    detectAutomation,
    resolveAgentEndpointCredential,
    resolveCliProfile,
    resolvePackagedHostLaunch,
    type AgentEndpointCredential,
    type CliAutomation,
} from './environment';
import {
    exitCodeFor,
    normalizeCliError,
    quietLines,
    renderHumanValue,
    stableJson,
    type CliOutputMode,
} from './output';
import { executeSkillCommand } from './skills';
import { CLI_PROTOCOL_VERSION, CLI_VERSION } from './version';

export interface CliIo {
    stderrIsTTY: boolean;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    writeStderr(text: string): void;
    writeStdout(text: string): void;
}

export interface CliHostClient {
    close: () => void;
    request: (method: CaxriMethod, params: unknown) => Promise<unknown>;
    requestWithId: (id: string, method: CaxriMethod, params: unknown) => Promise<unknown>;
    welcome: ProtocolWelcome;
}

export interface CliConnectOptions {
    credential?: AgentEndpointCredential;
    profilePath: string;
    signal?: AbortSignal;
    timeoutMs: number;
}

export interface RunCliOptions {
    confirm?: (message: string) => Promise<boolean>;
    connect?: (options: CliConnectOptions) => Promise<CliHostClient>;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    home?: string;
    io?: CliIo;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface CliHostConnectorOptions {
    automation: CliAutomation;
    connectExisting?: (options: CliConnectOptions) => Promise<CliHostClient>;
    hostLaunch?: HostLaunchOptions;
    startHost?: (options: CliConnectOptions, launch: HostLaunchOptions) => Promise<CliHostClient>;
}

/** Keeps packaged Host startup exclusive to an interactive human/operator invocation. */
export function createCliHostConnector(options: CliHostConnectorOptions) {
    const connectExisting =
        options.connectExisting ??
        ((connection: CliConnectOptions) =>
            connectToHost(
                connection.profilePath,
                connection.timeoutMs,
                connection.credential ?? { kind: 'operator' },
            ));
    const startHost =
        options.startHost ??
        ((connection: CliConnectOptions, launch: HostLaunchOptions) =>
            ensureHost(connection.profilePath, launch, connection.timeoutMs));
    return async (connection: CliConnectOptions): Promise<CliHostClient> => {
        if (
            options.automation === 'human' &&
            options.hostLaunch &&
            connection.credential === undefined
        ) {
            return startHost(connection, options.hostLaunch);
        }
        try {
            return await connectExisting(connection);
        } catch (error) {
            if (
                options.automation !== 'human' &&
                error instanceof CaxriError &&
                error.code === 'NOT_FOUND'
            ) {
                throw new CaxriError(
                    'UNAVAILABLE',
                    'No Caxri Host is running; Agent and CI invocations cannot start one implicitly',
                );
            }
            throw error;
        }
    };
}

const defaultIo: CliIo = {
    stderrIsTTY: Boolean(process.stderr.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
};

function outputMode(parsed: ParsedCliArguments, automation: CliAutomation): CliOutputMode {
    if (parsed.quiet) return 'quiet';
    if (parsed.json || automation !== 'human') return 'json';
    return 'human';
}

function fallbackOutputMode(argv: readonly string[], automation: CliAutomation): CliOutputMode {
    if (argv.includes('--quiet')) return 'quiet';
    if (argv.includes('--json') || automation !== 'human') return 'json';
    return 'human';
}

function topLevelHelp() {
    return {
        usage: 'caxri <command> [options]',
        commands: CLI_COMMANDS.filter((command) => command.path.length === 1).map((command) => ({
            name: command.path.join(' '),
            summary: command.summary,
        })),
        groups: CLI_GROUPS,
        options: [
            '--json',
            '--quiet',
            '--profile <absolute-path>',
            '--request-id <id>',
            '--connect-timeout <milliseconds>',
            '--timeout <milliseconds>',
            '--yes',
            '--help',
            '--version',
        ],
    };
}

function groupHelp(group: string) {
    const definition = CLI_GROUPS.find((candidate) => candidate.name === group);
    if (!definition) throw new CaxriError('VALIDATION', `Unknown command group: ${group}`);
    return {
        usage: `caxri ${group} <command>`,
        summary: definition.summary,
        commands: CLI_COMMANDS.filter(
            (command) => command.path.length >= 2 && command.path[0] === group,
        ).map((command) => ({
            name: command.path.slice(1).join(' '),
            summary: command.summary,
            ...('usage' in command && command.usage ? { usage: command.usage } : {}),
        })),
    };
}

function commandHelp(command: CliCommandDefinition) {
    return {
        usage: `caxri ${command.path.join(' ')}${'usage' in command && command.usage ? ` ${command.usage}` : ''}`,
        ...describeCliCommand(command),
    };
}

function renderHelp(
    value:
        | ReturnType<typeof topLevelHelp>
        | ReturnType<typeof groupHelp>
        | ReturnType<typeof commandHelp>,
): string {
    const lines = [`Usage: ${value.usage}`];
    if ('summary' in value && value.summary) lines.push('', value.summary);
    if ('groups' in value) {
        lines.push('', 'Groups:');
        for (const group of value.groups) lines.push(`  ${group.name.padEnd(12)} ${group.summary}`);
    }
    if ('commands' in value && value.commands.length > 0) {
        lines.push('', 'Commands:');
        for (const command of value.commands)
            lines.push(
                `  ${`${command.name}${'usage' in command && command.usage ? ` ${command.usage}` : ''}`.padEnd(24)} ${command.summary}`,
            );
    }
    if ('options' in value) {
        lines.push('', 'Global options:');
        for (const option of value.options) lines.push(`  ${option}`);
    }
    if ('method' in value && value.method) {
        lines.push('', `Method: ${value.method}`, `Effect: ${value.effect}`);
        lines.push(`Capabilities: ${value.capabilities?.join(', ') ?? ''}`);
    }
    return `${lines.join('\n')}\n`;
}

function writeSuccess(io: CliIo, mode: CliOutputMode, value: unknown, human?: string): void {
    if (mode === 'json') {
        io.writeStdout(`${stableJson(value)}\n`);
        return;
    }
    if (mode === 'quiet') {
        io.writeStdout(`${quietLines(value).join('\n')}\n`);
        return;
    }
    io.writeStdout(human ?? `${renderHumanValue(value)}\n`);
}

function quietProjection(command: RemoteCommandDefinition, value: unknown): unknown {
    if (!command.quietKey) return value;
    if (typeof value !== 'object' || value === null) return value;
    return Reflect.get(value, command.quietKey);
}

function writeStreamValue(io: CliIo, mode: CliOutputMode, value: unknown): void {
    if (mode === 'quiet')
        throw new CaxriError('VALIDATION', 'Streaming commands do not support quiet output');
    io.writeStdout(mode === 'json' ? `${stableJson(value)}\n` : `${renderHumanValue(value)}\n`);
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(finish, milliseconds);
        function finish(): void {
            signal?.removeEventListener('abort', finish);
            clearTimeout(timer);
            resolve();
        }
        signal?.addEventListener('abort', finish, { once: true });
    });
}

async function streamRemote(
    command: RemoteCommandDefinition,
    initialParams: unknown,
    client: CliHostClient,
    mode: CliOutputMode,
    io: CliIo,
    options: RunCliOptions,
): Promise<number> {
    if (mode === 'quiet')
        throw new CaxriError('VALIDATION', 'Streaming commands do not support quiet output');
    const wait = options.wait ?? defaultWait;
    let params = initialParams as Record<string, unknown>;
    let lastOutputAt = Date.now();
    while (!options.signal?.aborted) {
        const result = await client.request(command.method, params);
        if (command.stream === 'logs') {
            const page = result as LogQueryResult;
            for (const record of page.records) writeStreamValue(io, mode, record);
            if (page.gap) io.writeStderr('Warning: log cursor gap detected.\n');
            if (page.records.length > 0) lastOutputAt = Date.now();
            if (page.nextCursor) params = { ...params, afterCursor: page.nextCursor };
        } else {
            const recovery = result as ObservableEventRecovery;
            if (recovery.kind === 'events') {
                for (const event of recovery.events) writeStreamValue(io, mode, event);
                if (recovery.events.length > 0) lastOutputAt = Date.now();
            } else {
                writeStreamValue(io, mode, recovery);
                lastOutputAt = Date.now();
            }
            params = { afterCursor: recovery.cursor };
        }
        if (Date.now() - lastOutputAt >= 30_000) {
            io.writeStderr('keepalive\n');
            lastOutputAt = Date.now();
        }
        await wait(250, options.signal);
    }
    return 130;
}

function capabilities() {
    return {
        cliVersion: CLI_VERSION,
        protocolVersion: CLI_PROTOCOL_VERSION,
        groups: CLI_GROUPS,
        commands: CLI_COMMANDS.map(describeCliCommand),
        protocolMethods: (Object.keys(methods) as CaxriMethod[]).map(describeCaxriMethod),
    };
}

function localResult(
    command: CliCommandDefinition,
    options: {
        automation: CliAutomation;
        mode: CliOutputMode;
        profileSource: string;
    },
): unknown {
    if (command.path[0] === 'capabilities') return capabilities();
    if (command.path[0] === 'agent-context')
        return {
            status: 'unavailable',
            reason: 'endpoint-credential-missing',
            action: 'Run this command inside a directly managed Caxri Agent Terminal.',
            automation: options.automation,
            cliVersion: CLI_VERSION,
            outputMode: options.mode,
            profileSource: options.profileSource,
            protocolVersion: CLI_PROTOCOL_VERSION,
        };
    return {
        automation: options.automation,
        cliVersion: CLI_VERSION,
        outputMode: options.mode,
        profileSource: options.profileSource,
        protocolVersion: CLI_PROTOCOL_VERSION,
    };
}

function humanLocal(command: CliCommandDefinition, value: unknown): string {
    if (
        command.path[0] === 'skills' &&
        command.path[1] === 'get' &&
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'content') === 'string'
    )
        return `${String(Reflect.get(value, 'content')).trimEnd()}\n`;
    if (command.path[0] === 'agent-context' && isAgentContext(value))
        return humanAgentContext(value);
    if (command.path[0] !== 'capabilities') return `${renderHumanValue(value)}\n`;
    return [
        `Caxri CLI ${CLI_VERSION} (protocol ${CLI_PROTOCOL_VERSION})`,
        `${CLI_GROUPS.length} command groups`,
        `${CLI_COMMANDS.length} registered CLI commands`,
        '',
    ].join('\n');
}

const messagingActions: Record<AgentEndpointSummary['messaging']['nextAction'], string> = {
    use_pull: 'Use caxri agent message wait or check.',
    enable_integration: 'Enable peer messaging in Caxri Settings, then restart this Terminal.',
    install_provider: 'Install the configured Provider executable, then restart this Terminal.',
    upgrade_provider: 'Upgrade to a verified Provider version, then restart this Terminal.',
    fix_configuration: 'Review the Provider launch configuration, then restart this Terminal.',
    restart_terminal: 'Restart this Agent Terminal to restore the Caxri CLI adapter.',
    none: '',
};

function endpointRef(endpoint: AgentEndpointSummary): string {
    return `${endpoint.ref.hostId}:${endpoint.ref.endpointId}:${endpoint.ref.generation}`;
}

function humanAgentEndpoint(endpoint: AgentEndpointSummary): string {
    const lines = [
        `${endpoint.name} (${endpoint.provider})`,
        `Endpoint: ${endpointRef(endpoint)}`,
        `Project: ${endpoint.projectId}`,
        `Delivery: ${endpoint.messaging.deliveryMode}`,
        `Health: ${endpoint.messaging.health}`,
        `Reason: ${endpoint.messaging.reason}`,
    ];
    const action = messagingActions[endpoint.messaging.nextAction];
    if (action) lines.push(`Next: ${action}`);
    return lines.join('\n');
}

function isAgentContext(value: unknown): value is AgentContextResult {
    return (
        typeof value === 'object' &&
        value !== null &&
        Reflect.get(value, 'status') === 'active' &&
        typeof Reflect.get(value, 'endpoint') === 'object'
    );
}

function humanAgentContext(value: AgentContextResult): string {
    return `${humanAgentEndpoint(value.endpoint)}\nCapabilities: ${value.capabilities.join(', ')}\n`;
}

function humanRemote(command: RemoteCommandDefinition, value: unknown): string | undefined {
    if (command.method !== 'agent.list' || typeof value !== 'object' || value === null)
        return undefined;
    const agents = (value as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return undefined;
    return `${agents.map((agent) => humanAgentEndpoint(agent as AgentEndpointSummary)).join('\n\n')}\n`;
}

function remoteCommand(tokens: readonly string[]): RemoteCommandDefinition {
    const command = findCliCommand(tokens);
    if (!command || command.kind !== 'remote')
        throw new CaxriError('VALIDATION', `Unknown command: ${tokens.slice(0, 2).join(' ')}`);
    return command;
}

async function confirmMutation(
    command: { confirmation?: string },
    parsed: ParsedCliArguments,
    automation: CliAutomation,
    options: RunCliOptions,
    io: CliIo,
): Promise<void> {
    if (!command.confirmation || parsed.yes) return;
    if (automation !== 'human' || !io.stdinIsTTY)
        throw new CaxriError(
            'VALIDATION',
            'Non-interactive mutations require explicit --yes confirmation',
        );
    if (!options.confirm)
        throw new CaxriError('INTERNAL', 'Interactive confirmation is unavailable');
    if (!(await options.confirm(command.confirmation)))
        throw new CaxriError('FORBIDDEN', 'Command canceled');
}

/** Executes one bounded CLI invocation and returns a stable process exit code. */
export async function runCli(
    argv: readonly string[],
    options: RunCliOptions = {},
): Promise<number> {
    const environment = options.environment ?? {};
    const automation = detectAutomation(environment);
    const io = options.io ?? defaultIo;
    let mode = fallbackOutputMode(argv, automation);
    let client: CliHostClient | undefined;
    const abort = (): void => client?.close();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
        const parsed = parseCliArguments(argv);
        mode = outputMode(parsed, automation);
        if (options.signal?.aborted) return 130;
        if (parsed.version) {
            const value = { cliVersion: CLI_VERSION, protocolVersion: CLI_PROTOCOL_VERSION };
            writeSuccess(
                io,
                mode,
                value,
                `caxri ${CLI_VERSION} (protocol ${CLI_PROTOCOL_VERSION})\n`,
            );
            return 0;
        }
        if (parsed.tokens.length === 0) {
            if (mode === 'quiet')
                throw new CaxriError('VALIDATION', 'Help is unavailable in quiet mode');
            const value = topLevelHelp();
            writeSuccess(io, mode, value, renderHelp(value));
            return 0;
        }
        const group = CLI_GROUPS.find((candidate) => candidate.name === parsed.tokens[0]);
        const selected = findCliCommand(parsed.tokens);
        if (parsed.help || (group && parsed.tokens.length === 1)) {
            if (mode === 'quiet')
                throw new CaxriError('VALIDATION', 'Help is unavailable in quiet mode');
            const value = selected ? commandHelp(selected) : groupHelp(parsed.tokens[0]);
            writeSuccess(io, mode, value, renderHelp(value));
            return 0;
        }
        if (!selected && group) throw new CaxriError('VALIDATION', `Unknown ${group.name} command`);
        if (!selected) throw new CaxriError('VALIDATION', `Unknown command: ${parsed.tokens[0]}`);
        const profile = resolveCliProfile({
            environment,
            explicit: parsed.profile,
            home: options.home,
            platform: options.platform,
        });
        const endpointCredential = resolveAgentEndpointCredential(environment);
        const resourcesPath = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
        const hostLaunch = resolvePackagedHostLaunch({
            executable: process.execPath,
            resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined,
            runAsNode: environment.ELECTRON_RUN_AS_NODE,
            scriptPath: process.argv[1],
        });
        const connect =
            options.connect ??
            createCliHostConnector({
                automation,
                ...(hostLaunch ? { hostLaunch } : {}),
            });
        if (selected.kind === 'local') {
            const params = selected.parseParams(parsed.tokens.slice(selected.path.length));
            if (selected.mutates) await confirmMutation(selected, parsed, automation, options, io);
            const home = options.home ?? environment.HOME ?? homedir();
            let value =
                selected.path[0] === 'skills'
                    ? await executeSkillCommand(selected.path[1] ?? '', params, {
                          cwd: options.cwd ?? process.cwd(),
                          environment,
                          home,
                      })
                    : localResult(selected, {
                          automation,
                          mode,
                          profileSource: profile.source,
                      });
            if (
                selected.path[0] === 'status' ||
                (endpointCredential &&
                    (selected.path[0] === 'agent-context' || selected.path[0] === 'capabilities'))
            ) {
                client = await connect({
                    credential: endpointCredential,
                    profilePath: profile.path,
                    signal: options.signal,
                    timeoutMs: parsed.connectTimeoutMs,
                });
                if (selected.path[0] === 'status') {
                    const host = client.welcome.commands.includes('host.status')
                        ? await client.request('host.status', {})
                        : undefined;
                    value = {
                        capabilities: client.welcome.capabilities,
                        cliVersion: CLI_VERSION,
                        commands: client.welcome.commands,
                        ...(host ? { host } : {}),
                        principal: client.welcome.principal,
                        protocolVersion: client.welcome.protocolVersion,
                        status: 'ready',
                    };
                } else if (selected.path[0] === 'agent-context') {
                    if (!client.welcome.commands.includes('agent.context'))
                        throw new CaxriError(
                            'CONFLICT',
                            'The Caxri Host does not support Agent Endpoint context',
                        );
                    value = await client.request('agent.context', {});
                } else {
                    value = {
                        ...(value as Record<string, unknown>),
                        endpoint: {
                            principal: client.welcome.principal,
                            capabilities: client.welcome.capabilities,
                            commands: client.welcome.commands,
                        },
                    };
                }
            }
            const output =
                mode === 'quiet' && selected.path[0] === 'capabilities'
                    ? (Object.keys(methods) as CaxriMethod[]).map((id) => ({ id }))
                    : value;
            writeSuccess(io, mode, output, humanLocal(selected, value));
            return 0;
        }
        const command = remoteCommand(parsed.tokens);
        let params = command.parseParams(parsed.tokens.slice(command.path.length));
        /** Pull/lifecycle waits map `--timeout` to long poll; connect timing may be split. */
        if (command.method === 'agent.message.wait') params = { timeoutMs: parsed.timeoutMs };
        if (command.method === 'agent.dispatch.wait')
            params = { ...(params as object), timeoutMs: parsed.timeoutMs };
        if (command.requiresAgentEndpoint && !endpointCredential)
            throw new CaxriError(
                'FORBIDDEN',
                'This command requires a directly managed Caxri Agent Endpoint credential',
            );
        if (command.requiresHumanOwner && endpointCredential)
            throw new CaxriError(
                'FORBIDDEN',
                'This command requires the authenticated human profile owner',
            );
        const mutates =
            methods[command.method].effect !== 'read' && (command.mutates?.(params) ?? true);
        if (mutates && !parsed.profile && !endpointCredential)
            throw new CaxriError(
                'VALIDATION',
                'Mutation commands require an explicit --profile Host selector',
            );
        if (mutates) await confirmMutation(command, parsed, automation, options, io);
        client = await connect({
            ...(endpointCredential ? { credential: endpointCredential } : {}),
            profilePath: profile.path,
            signal: options.signal,
            timeoutMs: parsed.connectTimeoutMs,
        });
        if (options.signal?.aborted) return 130;
        if (!client.welcome.commands.includes(command.method))
            throw new CaxriError(
                'CONFLICT',
                `The Caxri Host does not support command ${command.method}`,
            );
        if (command.stream) return await streamRemote(command, params, client, mode, io, options);
        const result = parsed.requestId
            ? await client.requestWithId(parsed.requestId, command.method, params)
            : await client.request(command.method, params);
        if (options.signal?.aborted) return 130;
        writeSuccess(
            io,
            mode,
            mode === 'quiet' ? quietProjection(command, result) : result,
            humanRemote(command, result),
        );
        return 0;
    } catch (error) {
        if (options.signal?.aborted) return 130;
        const wire = normalizeCliError(error, options.home ?? environment.HOME ?? homedir());
        if (mode === 'json') io.writeStderr(`${stableJson(wire)}\n`);
        else io.writeStderr(`${wire.code}: ${wire.message}\n`);
        return exitCodeFor(wire);
    } finally {
        options.signal?.removeEventListener('abort', abort);
        client?.close();
    }
}
