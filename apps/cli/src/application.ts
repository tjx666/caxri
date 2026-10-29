// eslint-disable-next-line unicorn/name-replacements -- `application.ts` is the CLI composition root's documented name (see project-architecture: the package root remains the composition root of application, environment, output, and selectors); renaming it would contradict that architecture contract.
import { homedir } from 'node:os';
import process from 'node:process';

import { executeSkillCommand } from '@caxri/agent-skills';
import type { ServerLaunchOptions } from '@caxri/client/supervise';
import { connectToServer, ensureServer } from '@caxri/client/supervise';
import type {
    CaxriMethod,
    LogQueryResult,
    ObservableEventRecovery,
    ProtocolWelcome,
} from '@caxri/protocol';
import { CaxriError, methods } from '@caxri/protocol';

import type { ParsedCliArguments, RemoteCommandDefinition } from './commands';
import {
    assertCommandTimeout,
    assertMethodOffered,
    CLI_GROUPS,
    findCliCommand,
    parseCliArguments,
    resolveGenericRequest,
    validateRequestParameters,
    withCommandTimeout,
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
import { commandHelp, groupHelp, renderHelp, topLevelHelp } from './help';
import { humanLocal, humanRemote, localResult } from './local-output';
import type { CliOutputMode } from './output';
import {
    exitCodeFor,
    hasQuietIds,
    isProfileSelectionSatisfied,
    normalizeCliError,
    profileCommandHint,
    quietLines,
    renderHumanValue,
    stableJson,
    withNextStep,
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
    /**
     * Supplies stdin text for `caxri request <method> --params -`; defaults to the process stdin.
     */
    readStdin?: () => Promise<string>;
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
                    'No Caxri Server is running; automated and Endpoint invocations cannot start one implicitly',
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

async function readProcessStdin(): Promise<string> {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) {
        text += chunk as string;
        if (text.length > 1_048_576)
            throw new CaxriError('VALIDATION', '--params from stdin exceeds 1 MiB');
    }
    return text;
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
        if (selected.kind === 'local' && selected.path[0] !== 'request') {
            assertCommandTimeout(parsed.timeoutMs);
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
                                'The Caxri Server does not support Agent Endpoint context',
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
        const generic =
            selected.path[0] === 'request'
                ? await resolveGenericRequest(parsed.tokens.slice(selected.path.length), {
                      isTTY: io.stdinIsTTY,
                      read: options.readStdin ?? readProcessStdin,
                  })
                : undefined;
        const command = generic?.command ?? remoteCommand(parsed.tokens);
        const parameters = withCommandTimeout(
            command.method,
            generic
                ? generic.parameters
                : await command.parseParams(parsed.tokens.slice(command.path.length)),
            parsed.timeoutMs,
        );
        if (generic) validateRequestParameters(command.method, parameters);
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
        if (
            isMutates &&
            !endpointCredential &&
            !isProfileSelectionSatisfied({
                automation,
                io,
                profileFlag: parsed.profile,
                profileSource: profile.source,
            })
        )
            throw new CaxriError(
                'VALIDATION',
                `Mutation commands need an explicit --profile outside an interactive terminal. Run: ${profileCommandHint(argv, profile.path)}`,
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
                'This command requires the CLI version bundled with the active Caxri Server',
                { cliVersion: CLI_VERSION, hostVersion: client.serverVersion ?? 'unknown' },
            );
        if (generic) assertMethodOffered(command.method, client.welcome);
        else if (!client.welcome.commands.includes(command.method))
            throw new CaxriError(
                'CONFLICT',
                `The Caxri Server does not support command ${command.method}`,
            );
        if (command.stream)
            return await streamRemote(command, parameters, client, mode, io, options);
        if (command.run) {
            const connected = client;
            return await command.run({
                cwd: options.cwd ?? process.cwd(),
                environment,
                json: mode === 'json',
                parameters,
                request: (method, methodParameters) => connected.request(method, methodParameters),
                ...(options.signal && { signal: options.signal }),
                writeStderr: (text) => io.writeStderr(text),
                writeStdout: (text) => io.writeStdout(text),
            });
        }
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
        const wire = withNextStep(
            normalizeCliError(error, options.home ?? environment.HOME ?? homedir()),
        );
        if (mode === 'json') io.writeStderr(`${stableJson(wire)}\n`);
        else io.writeStderr(`${wire.code}: ${wire.message}\n`);
        return exitCodeFor(wire);
    } finally {
        options.signal?.removeEventListener('abort', abort);
        client?.close();
    }
}
