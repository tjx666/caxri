// eslint-disable-next-line unicorn/name-replacements -- `application.ts` is the CLI composition root's documented name (see project-architecture: the package root remains the composition root — application, environment, output, selectors); renaming it would contradict that architecture contract.
import { homedir } from 'node:os';
import process from 'node:process';

import { executeSkillCommand } from '@caxri/agent-skills';
import type { ServerLaunchOptions } from '@caxri/client/supervise';
import { connectToServer, ensureServer } from '@caxri/client/supervise';
import type {
    AgentContextResult,
    AgentEndpointSummary,
    CaxriMethod,
    LogQueryResult,
    ObservableEventRecovery,
    ProtocolWelcome,
} from '@caxri/protocol';
import { CaxriError, describeCaxriMethod, methods } from '@caxri/protocol';

import type { CliCommandDefinition, ParsedCliArguments, RemoteCommandDefinition } from './commands';
import {
    CLI_COMMANDS,
    CLI_GROUPS,
    describeCliCommand,
    findCliCommand,
    parseCliArguments,
} from './commands';
import type {
    AgentEndpointCredential,
    CliAutomation,
    DelegationClientCredential,
} from './environment';
import {
    detectAutomation,
    resolveAgentEndpointCredential,
    resolveCliProfile,
    resolveDelegationClientCredential,
    resolvePackagedServerLaunch,
} from './environment';
import type { CliOutputMode } from './output';
import {
    exitCodeFor,
    formatEndpointReference,
    hasQuietIds,
    normalizeCliError,
    quietLines,
    renderHumanValue,
    stableJson,
} from './output';
import { CLI_PROTOCOL_VERSION, CLI_VERSION } from './version';

export interface CliIo {
    stderrIsTTY: boolean;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    writeStderr(text: string): void;
    writeStdout(text: string): void;
}

export interface CliServerClient {
    close: () => void;
    serverVersion?: string;
    request: (method: CaxriMethod, parameters: unknown) => Promise<unknown>;
    requestWithId: (id: string, method: CaxriMethod, parameters: unknown) => Promise<unknown>;
    welcome: ProtocolWelcome;
}

export interface CliConnectOptions {
    credential?: AgentEndpointCredential | DelegationClientCredential;
    profilePath: string;
    signal?: AbortSignal;
    timeoutMs: number;
}

export interface RunCliOptions {
    confirm?: (message: string) => Promise<boolean>;
    connect?: (options: CliConnectOptions) => Promise<CliServerClient>;
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    home?: string;
    io?: CliIo;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface CliServerConnectorOptions {
    automation: CliAutomation;
    connectExisting?: (options: CliConnectOptions) => Promise<CliServerClient>;
    serverLaunch?: ServerLaunchOptions;
    startServer?: (
        options: CliConnectOptions,
        launch: ServerLaunchOptions,
    ) => Promise<CliServerClient>;
}

/**
 * Keeps packaged Server startup exclusive to an interactive human/operator invocation.
 */
export function createCliServerConnector(options: CliServerConnectorOptions) {
    const connectExisting =
        options.connectExisting ??
        ((connection: CliConnectOptions) =>
            connectToServer(
                connection.profilePath,
                connection.timeoutMs,
                connection.credential ?? { kind: 'operator' },
            ));
    const startServer =
        options.startServer ??
        ((connection: CliConnectOptions, launch: ServerLaunchOptions) =>
            ensureServer(connection.profilePath, launch, connection.timeoutMs));
    return async (connection: CliConnectOptions): Promise<CliServerClient> => {
        if (
            options.automation === 'human' &&
            options.serverLaunch &&
            connection.credential === undefined
        ) {
            return startServer(connection, options.serverLaunch);
        }
        try {
            return await connectExisting(connection);
        } catch (error) {
            if (
                (options.automation !== 'human' || connection.credential !== undefined) &&
                error instanceof CaxriError &&
                error.code === 'NOT_FOUND'
            ) {
                throw new CaxriError(
                    'UNAVAILABLE',
                    'No Caxri Host is running; automated and Endpoint invocations cannot start one implicitly',
                );
            }
            throw error;
        }
    };
}

const defaultIo: CliIo = {
    stderrIsTTY: process.stderr.isTTY,
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
};

function outputMode(parsed: ParsedCliArguments, automation: CliAutomation): CliOutputMode {
    if (parsed.quiet) return 'quiet';
    if (automation !== 'human' || parsed.json) return 'json';
    return 'human';
}

function fallbackOutputMode(argv: readonly string[], automation: CliAutomation): CliOutputMode {
    if (argv.includes('--quiet')) return 'quiet';
    if (automation !== 'human' || argv.includes('--json')) return 'json';
    return 'human';
}

function topLevelHelp() {
    const commands: Array<{ name: string; summary: string }> = [];
    for (const command of CLI_COMMANDS) {
        if (command.path.length !== 1) continue;
        commands.push({ name: command.path.join(' '), summary: command.summary });
    }
    return {
        usage: 'caxri <command> [options]',
        commands,
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
    const commands: Array<{ name: string; summary: string; usage?: string }> = [];
    for (const command of CLI_COMMANDS) {
        if (command.path.length < 2 || command.path[0] !== group) continue;
        commands.push({
            name: command.path.slice(1).join(' '),
            summary: command.summary,
            ...('usage' in command && command.usage && { usage: command.usage }),
        });
    }
    return {
        usage: `caxri ${group} <command>`,
        summary: definition.summary,
        commands,
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
        lines.push(
            '',
            `Method: ${value.method}`,
            `Effect: ${value.effect}`,
            `Capabilities: ${value.capabilities?.join(', ') ?? ''}`,
        );
    }
    return `${lines.join('\n')}\n`;
}

function writeSuccess(
    io: CliIo,
    mode: CliOutputMode,
    value: unknown,
    human?: string,
    quietIdKey?: string,
): void {
    if (mode === 'json') {
        io.writeStdout(`${stableJson(value)}\n`);
        return;
    }
    if (mode === 'quiet') {
        io.writeStdout(`${quietLines(value, quietIdKey).join('\n')}\n`);
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
    initialParameters: unknown,
    client: CliServerClient,
    mode: CliOutputMode,
    io: CliIo,
    options: RunCliOptions,
): Promise<number> {
    if (mode === 'quiet')
        throw new CaxriError('VALIDATION', 'Streaming commands do not support quiet output');
    const wait = options.wait ?? defaultWait;
    let parameters = initialParameters as Record<string, unknown>;
    let lastOutputAt = Date.now();
    let logPollDelayMs = 250;
    while (!options.signal?.aborted) {
        // eslint-disable-next-line no-await-in-loop -- each poll's next request depends on the previous response's cursor/pagination state; the loop is an intentional sequential stream.
        const result = await client.request(command.method, parameters);
        let isLogPageWasEmpty = false;
        if (command.stream === 'logs') {
            const page = result as LogQueryResult;
            for (const record of page.records) writeStreamValue(io, mode, record);
            if (page.gap) io.writeStderr('Warning: log cursor gap detected.\n');
            isLogPageWasEmpty = page.records.length === 0;
            if (!isLogPageWasEmpty) {
                lastOutputAt = Date.now();
                logPollDelayMs = 250;
            }
            if (page.nextCursor) parameters = { ...parameters, afterCursor: page.nextCursor };
        } else {
            const recovery = result as ObservableEventRecovery;
            if (recovery.kind === 'events') {
                for (const event of recovery.events) writeStreamValue(io, mode, event);
                if (recovery.events.length > 0) lastOutputAt = Date.now();
            } else {
                writeStreamValue(io, mode, recovery);
                lastOutputAt = Date.now();
            }
            parameters = { afterCursor: recovery.cursor };
        }
        if (Date.now() - lastOutputAt >= 30_000) {
            io.writeStderr('keepalive\n');
            lastOutputAt = Date.now();
        }
        // eslint-disable-next-line no-await-in-loop -- the poll delay must elapse before the next iteration requests again; the loop is an intentional sequential stream.
        await wait(command.stream === 'logs' ? logPollDelayMs : 250, options.signal);
        if (isLogPageWasEmpty && command.stream === 'logs')
            logPollDelayMs = Math.min(logPollDelayMs * 2, 2_000);
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

function isSkillContentValue(value: unknown): value is { content: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'content') === 'string'
    );
}

function humanLocal(command: CliCommandDefinition, value: unknown): string {
    if (command.path[0] === 'skills' && command.path[1] === 'get' && isSkillContentValue(value))
        return `${value.content.trimEnd()}\n`;
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

function humanAgentEndpoint(endpoint: AgentEndpointSummary): string {
    const lines = [
        `${endpoint.name} (${endpoint.provider})`,
        `Endpoint: ${formatEndpointReference(endpoint.ref)}`,
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
    if (value === null || typeof value !== 'object' || command.method !== 'agent.list')
        return undefined;
    const agents = (value as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return undefined;
    return `${agents.map((agent) => humanAgentEndpoint(agent as AgentEndpointSummary)).join('\n\n')}\n`;
}

function remoteCommand(tokens: readonly string[]): RemoteCommandDefinition {
    const command = findCliCommand(tokens);
    if (command?.kind !== 'remote')
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

/**
 * Executes one bounded CLI invocation and returns a stable process exit code.
 */
export async function runCli(
    argv: readonly string[],
    options: RunCliOptions = {},
): Promise<number> {
    const environment = options.environment ?? {};
    const automation = detectAutomation(environment);
    const io = options.io ?? defaultIo;
    let mode = fallbackOutputMode(argv, automation);
    let client: CliServerClient | undefined;
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
        const managedCredential = resolveAgentEndpointCredential(environment);
        const externalCredential = resolveDelegationClientCredential(environment);
        if (managedCredential && externalCredential)
            throw new CaxriError(
                'VALIDATION',
                'Managed and external Agent credentials cannot be combined',
            );
        const endpointCredential = managedCredential ?? externalCredential;
        const resourcesPath = (process as unknown as { resourcesPath?: unknown }).resourcesPath;
        const serverLaunch = resolvePackagedServerLaunch({
            environment,
            executable: process.execPath,
            home: options.home,
            platform: options.platform,
            resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined,
            runAsNode: environment.ELECTRON_RUN_AS_NODE,
            scriptPath: process.argv[1],
        });
        const connect =
            options.connect ??
            createCliServerConnector({
                automation,
                ...(serverLaunch && { serverLaunch }),
            });
        if (selected.kind === 'local') {
            const parameters = selected.parseParams(parsed.tokens.slice(selected.path.length));
            if (selected.mutates) await confirmMutation(selected, parsed, automation, options, io);
            const home = options.home ?? environment.HOME ?? homedir();
            let value =
                selected.path[0] === 'skills'
                    ? // `.at()` (unlike index access on a `[string, ...string[]]` tuple) types the
                      // result as `string | undefined`, matching the real runtime possibility that
                      // a `skills` command path is exactly one segment long.
                      await executeSkillCommand(selected.path.at(1) ?? '', parameters, {
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
                    // `client.request` is untyped (`Promise<unknown>`); an explicit object-shaped
                    // cast lets the conditional spread below narrow past `unknown`.
                    const host = client.welcome.commands.includes('host.status')
                        ? ((await client.request('host.status', {})) as Record<string, unknown>)
                        : undefined;
                    value = {
                        capabilities: client.welcome.capabilities,
                        cliVersion: CLI_VERSION,
                        commands: client.welcome.commands,
                        ...(host && { host }),
                        principal: client.welcome.principal,
                        protocolVersion: client.welcome.protocolVersion,
                        status: 'ready',
                    };
                } else if (selected.path[0] === 'agent-context') {
                    if (client.welcome.principal.kind === 'delegation-client') {
                        value = {
                            principal: client.welcome.principal,
                            capabilities: client.welcome.capabilities,
                            commands: client.welcome.commands,
                        };
                    } else {
                        if (!client.welcome.commands.includes('agent.context'))
                            throw new CaxriError(
                                'CONFLICT',
                                'The Caxri Host does not support Agent Endpoint context',
                            );
                        value = await client.request('agent.context', {});
                    }
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
        let parameters = await command.parseParams(parsed.tokens.slice(command.path.length));
        /**
         * Pull/lifecycle waits map `--timeout` to long poll; connect timing may be split.
         */
        if (command.method === 'agent.message.wait') parameters = { timeoutMs: parsed.timeoutMs };
        else if (
            command.method === 'agent.dispatch.wait' ||
            command.method === 'agent.delegation.wait'
        )
            parameters = { ...(parameters as object), timeoutMs: parsed.timeoutMs };
        if (endpointCredential?.kind !== 'agent' && command.requiresAgentEndpoint)
            throw new CaxriError(
                'FORBIDDEN',
                'This command requires a directly managed Caxri Agent Endpoint credential',
            );
        if ((endpointCredential || automation !== 'human') && command.requiresHumanOwner)
            throw new CaxriError(
                'FORBIDDEN',
                'This command requires the authenticated human profile owner',
            );
        const isMutates =
            methods[command.method].effect !== 'read' && (command.mutates?.(parameters) ?? true);
        /**
         * Quiet output is read only after the request ran, so a mutation whose result has no stable ID would report
         * `VALIDATION` for work that already happened and invite a retry that repeats it. Refuse it up front instead.
         */
        if (
            mode === 'quiet' &&
            isMutates &&
            !hasQuietIds(methods[command.method].result, command.quietKey, command.quietIdKey)
        )
            throw new CaxriError(
                'VALIDATION',
                'This command has no stable ID to print with --quiet; use --json',
            );
        if (isMutates && !endpointCredential && !parsed.profile)
            throw new CaxriError(
                'VALIDATION',
                'Mutation commands require an explicit --profile Host selector',
            );
        if (isMutates)
            await confirmMutation(
                {
                    confirmation: endpointCredential
                        ? command.confirmation
                        : (command.ownerConfirmation ?? command.confirmation),
                },
                parsed,
                automation,
                options,
                io,
            );
        client = await connect({
            ...(endpointCredential && { credential: endpointCredential }),
            profilePath: profile.path,
            signal: options.signal,
            timeoutMs: parsed.connectTimeoutMs,
        });
        if (options.signal?.aborted) return 130;
        if (command.requiresServerVersionMatch && client.serverVersion !== CLI_VERSION)
            throw new CaxriError(
                'CONFLICT',
                'This command requires the CLI version bundled with the active Caxri Host',
                { cliVersion: CLI_VERSION, hostVersion: client.serverVersion ?? 'unknown' },
            );
        if (!client.welcome.commands.includes(command.method))
            throw new CaxriError(
                'CONFLICT',
                `The Caxri Host does not support command ${command.method}`,
            );
        if (command.stream)
            return await streamRemote(command, parameters, client, mode, io, options);
        const result = parsed.requestId
            ? await client.requestWithId(parsed.requestId, command.method, parameters)
            : await client.request(command.method, parameters);
        if (options.signal?.aborted) return 130;
        writeSuccess(
            io,
            mode,
            mode === 'quiet' ? quietProjection(command, result) : result,
            humanRemote(command, result),
            command.quietIdKey,
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
