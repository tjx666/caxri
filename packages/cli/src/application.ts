import { homedir } from 'node:os';

import {
    CaxriError,
    describeCaxriMethod,
    methods,
    type CaxriMethod,
    type ProtocolWelcome,
} from '@caxri/protocol';

import { connectToHost } from './host-client';
import { parseCliArguments, type ParsedCliArguments } from './arguments';
import {
    CLI_COMMANDS,
    CLI_GROUPS,
    describeCliCommand,
    findCliCommand,
    type CliCommandDefinition,
    type RemoteCommandDefinition,
} from './command-catalog';
import { detectAutomation, resolveCliProfile, type CliAutomation } from './environment';
import {
    exitCodeFor,
    normalizeCliError,
    quietLines,
    renderHumanValue,
    stableJson,
    type CliOutputMode,
} from './output';
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
    welcome: ProtocolWelcome;
}

export interface CliConnectOptions {
    profilePath: string;
    signal?: AbortSignal;
    timeoutMs: number;
}

export interface RunCliOptions {
    confirm?: (message: string) => Promise<boolean>;
    connect?: (options: CliConnectOptions) => Promise<CliHostClient>;
    environment?: NodeJS.ProcessEnv;
    home?: string;
    io?: CliIo;
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
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
        commands: CLI_COMMANDS.filter((command) => command.kind === 'local').map((command) => ({
            name: command.path.join(' '),
            summary: command.summary,
        })),
        groups: CLI_GROUPS,
        options: [
            '--json',
            '--quiet',
            '--profile <absolute-path>',
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
            (command) => command.path.length === 2 && command.path[0] === group,
        ).map((command) => ({
            name: command.path[1],
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
    return {
        automation: options.automation,
        cliVersion: CLI_VERSION,
        outputMode: options.mode,
        profileSource: options.profileSource,
        protocolVersion: CLI_PROTOCOL_VERSION,
    };
}

function humanLocal(command: CliCommandDefinition, value: unknown): string {
    if (command.path[0] !== 'capabilities') return `${renderHumanValue(value)}\n`;
    return [
        `Caxri CLI ${CLI_VERSION} (protocol ${CLI_PROTOCOL_VERSION})`,
        `${CLI_GROUPS.length} command groups`,
        `${CLI_COMMANDS.length} registered CLI commands`,
        '',
    ].join('\n');
}

function remoteCommand(tokens: readonly string[]): RemoteCommandDefinition {
    const command = findCliCommand(tokens);
    if (!command || command.kind !== 'remote')
        throw new CaxriError('VALIDATION', `Unknown command: ${tokens.slice(0, 2).join(' ')}`);
    return command;
}

async function confirmMutation(
    command: RemoteCommandDefinition,
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
        if (selected.kind === 'local') {
            if (parsed.tokens.length !== selected.path.length)
                throw new CaxriError('VALIDATION', `Unexpected argument: ${parsed.tokens[1]}`);
            const value = localResult(selected, {
                automation,
                mode,
                profileSource: profile.source,
            });
            const output =
                mode === 'quiet' && selected.path[0] === 'capabilities'
                    ? (Object.keys(methods) as CaxriMethod[]).map((id) => ({ id }))
                    : value;
            writeSuccess(io, mode, output, humanLocal(selected, value));
            return 0;
        }
        const command = remoteCommand(parsed.tokens);
        const params = command.parseParams(parsed.tokens.slice(command.path.length));
        if (methods[command.method].effect !== 'read' && !parsed.profile)
            throw new CaxriError(
                'VALIDATION',
                'Mutation commands require an explicit --profile Host selector',
            );
        await confirmMutation(command, parsed, automation, options, io);
        const connect =
            options.connect ??
            ((connection: CliConnectOptions) =>
                connectToHost(connection.profilePath, connection.timeoutMs));
        client = await connect({
            profilePath: profile.path,
            signal: options.signal,
            timeoutMs: parsed.timeoutMs,
        });
        if (options.signal?.aborted) return 130;
        if (!client.welcome.commands.includes(command.method))
            throw new CaxriError(
                'CONFLICT',
                `The Caxri Host does not support command ${command.method}`,
            );
        const result = await client.request(command.method, params);
        if (options.signal?.aborted) return 130;
        writeSuccess(io, mode, result);
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
