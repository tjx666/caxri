import {
    agentProviderIds,
    CaxriError,
    logQueryParametersSchema,
    settingsPatchChangeSchema,
} from '@caxri/protocol';

import { COMMANDER_COMMANDS } from './commander';
import { DELEGATION_COMMANDS } from './delegation';
import { DELEGATION_ACCESS_COMMANDS } from './delegation-access';
import { DELEGATION_IMPORT_COMMAND } from './delegation-import';
import { RECORD_COMMANDS } from './records';
import { rejectOptions } from './reject-options';
import { SKILL_COMMANDS } from './skills';
import type { CliCommandDefinition } from './types';

export {
    CLI_GROUPS,
    type CliCommandDefinition,
    describeCliCommand,
    type RemoteCommandDefinition,
} from './types';

function booleanFlag(
    tokens: readonly string[],
    flag: string,
    key: string,
): Record<string, boolean> {
    if (tokens.length === 0) return { [key]: false };
    if (tokens.length === 1 && tokens[0] === flag) return { [key]: true };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=', 1)[0]}`);
}

function desktopTarget(
    tokens: readonly string[],
    options: { launchByDefault: boolean },
): Record<string, unknown> {
    const positional: string[] = [];
    let isLaunchIfNeeded = options.launchByDefault;
    let sessionId: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--launch' || token === '--no-launch') {
            isLaunchIfNeeded = token === '--launch';
            continue;
        }
        if (token === '--session') {
            const value = tokens[index + 1];
            if (!value || value.startsWith('--'))
                throw new CaxriError('VALIDATION', '--session requires a value');
            if (sessionId)
                throw new CaxriError('VALIDATION', '--session may be provided only once');
            sessionId = value;
            index += 1;
            continue;
        }
        if (token.startsWith('--'))
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        positional.push(token);
    }
    if (positional.length !== 1)
        throw new CaxriError('VALIDATION', 'Desktop commands require exactly one path');
    return {
        path: positional[0],
        launchIfNeeded: isLaunchIfNeeded,
        ...(sessionId && { sessionId }),
    };
}

function settingPatch(tokens: readonly string[], isForceDryRun: boolean): Record<string, unknown> {
    const changes: unknown[] = [];
    let isDryRun = isForceDryRun;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--dry-run' && !isForceDryRun) {
            isDryRun = true;
            continue;
        }
        if (token !== '--set')
            throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
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
    return { changes, dryRun: isDryRun };
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
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${token} requires a value`);
        result[key] = key === 'limit' ? Number(value) : value;
        index += 1;
    }
    return logQueryParametersSchema.parse(result);
}

function eventRecovery(tokens: readonly string[]): Record<string, number> {
    if (tokens.length === 0) return { afterCursor: 0 };
    if (tokens.length !== 2 || tokens[0] !== '--after')
        throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=', 1)[0]}`);
    const afterCursor = Number(tokens[1]);
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
        throw new CaxriError('VALIDATION', '--after must be a non-negative integer cursor');
    return { afterCursor };
}

function endpointReference(source: string | undefined) {
    const [hostId, endpointId, generationSource, ...extra] = source?.split(':') ?? [];
    const generation = Number(generationSource);
    if (
        !hostId ||
        !endpointId ||
        extra.length > 0 ||
        !Number.isSafeInteger(generation) ||
        generation < 1
    )
        throw new CaxriError(
            'VALIDATION',
            'Endpoint ref must be <host-id>:<endpoint-id>:<generation>',
        );
    return { hostId, endpointId, generation };
}

function agentGrant(tokens: readonly string[]): Record<string, unknown> {
    if (tokens.length < 2)
        throw new CaxriError('VALIDATION', 'agent grant requires an Endpoint ref and policy');
    const result: Record<string, unknown> = {
        endpoint: endpointReference(tokens[0]),
        policy: tokens[1],
    };
    if (tokens.length > 2) {
        if (tokens.length !== 4 || tokens[2] !== '--ttl-ms')
            throw new CaxriError('VALIDATION', `Unknown option: ${tokens[2]}`);
        result.ttlMs = Number(tokens[3]);
    }
    return result;
}

function namedOptions(
    tokens: readonly string[],
    allowed: ReadonlyMap<string, string>,
    required: readonly string[],
): Partial<Record<string, string>> {
    // Partial (not Record<string, string>): keys are populated incrementally below, so the runtime
    // shape genuinely allows `undefined` until the `required` loop validates presence.
    const result: Partial<Record<string, string>> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const flag = tokens[index];
        const key = allowed.get(flag);
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${flag.split('=', 1)[0]}`);
        if (result[key] !== undefined)
            throw new CaxriError('VALIDATION', `${flag} may be provided only once`);
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${flag} requires a value`);
        result[key] = value;
        index += 1;
    }
    for (const key of required) {
        if (result[key] === undefined)
            throw new CaxriError(
                'VALIDATION',
                `--${key.replaceAll(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`,
            );
    }
    return result;
}

function agentMessage(tokens: readonly string[], isReply: boolean): Record<string, unknown> {
    let isWake = false;
    const valueTokens: string[] = [];
    for (const token of tokens) {
        if (token === '--wake') {
            if (isWake) throw new CaxriError('VALIDATION', '--wake may be provided only once');
            isWake = true;
        } else valueTokens.push(token);
    }
    const options = namedOptions(
        valueTokens,
        new Map([
            ['--to', 'to'],
            ['--body', 'body'],
            ['--reply-to', 'replyTo'],
            ['--ttl-ms', 'ttlMs'],
        ]),
        isReply ? ['to', 'body', 'replyTo'] : ['to', 'body'],
    );
    if (!isReply && options.replyTo !== undefined)
        throw new CaxriError('VALIDATION', '--reply-to is valid only for agent message reply');
    if (isReply && isWake)
        throw new CaxriError('VALIDATION', '--wake is valid only for agent message send');
    return {
        to: endpointReference(options.to),
        body: options.body,
        ...(options.replyTo && { replyTo: options.replyTo }),
        ...(options.ttlMs && { ttlMs: Number(options.ttlMs) }),
        ...(isWake && { wake: true }),
    };
}

function dispatchTarget(tokens: readonly string[], isResume: boolean): Record<string, unknown> {
    const options = namedOptions(
        tokens,
        new Map([
            ['--project', 'projectId'],
            ['--session', 'sessionId'],
            ['--provider', 'provider'],
            ['--terminal', 'terminalId'],
            ['--provider-session', 'providerSessionId'],
        ]),
        isResume
            ? ['projectId', 'sessionId', 'terminalId', 'providerSessionId']
            : ['projectId', 'sessionId', 'provider'],
    );
    if (isResume && options.provider !== undefined)
        throw new CaxriError('VALIDATION', '--provider is valid only for agent dispatch start');
    if (!isResume && (options.terminalId !== undefined || options.providerSessionId !== undefined))
        throw new CaxriError(
            'VALIDATION',
            '--terminal and --provider-session are valid only for agent dispatch resume',
        );
    return options;
}

function dispatchWait(tokens: readonly string[]): Record<string, unknown> {
    const positional: string[] = [];
    let afterRevision = 0;
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== '--after-revision') {
            positional.push(tokens[index]);
            continue;
        }
        const value = Number(tokens[index + 1]);
        if (!Number.isSafeInteger(value) || value < 0)
            throw new CaxriError('VALIDATION', '--after-revision requires a non-negative integer');
        afterRevision = value;
        index += 1;
    }
    if (positional.length !== 1)
        throw new CaxriError('VALIDATION', 'agent dispatch wait requires one dispatch ID');
    return { dispatchId: positional[0], afterRevision };
}

function terminalSend(tokens: readonly string[]): Record<string, unknown> {
    let isEnter = false;
    const valueTokens: string[] = [];
    for (const token of tokens) {
        if (token === '--enter') {
            if (isEnter) throw new CaxriError('VALIDATION', '--enter may be provided only once');
            isEnter = true;
        } else valueTokens.push(token);
    }
    const options = namedOptions(
        valueTokens,
        new Map([
            ['--terminal', 'terminalId'],
            ['--text', 'text'],
        ]),
        ['terminalId', 'text'],
    );
    return { ...options, enter: isEnter };
}

export const CLI_COMMANDS = [
    ...DELEGATION_COMMANDS,
    ...COMMANDER_COMMANDS,
    ...DELEGATION_ACCESS_COMMANDS,
    DELEGATION_IMPORT_COMMAND,
    {
        kind: 'local',
        path: ['capabilities'],
        summary: 'Print local command and schema introspection without requiring a Host.',
        parseParams: rejectOptions,
    },
    {
        kind: 'local',
        path: ['agent-context'],
        summary: 'Print local automation and protocol context without requiring a Host.',
        parseParams: rejectOptions,
    },
    {
        kind: 'local',
        path: ['status'],
        summary: 'Negotiate with the selected Host and print principal-safe status.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['open'],
        method: 'desktop.openPath',
        summary: 'Open one added Project file or directory in Caxri Desktop.',
        usage: '<path> [--session <session-id>] [--no-launch]',
        confirmation: 'Open this Project path in Caxri Desktop?',
        parseParams: (tokens) => desktopTarget(tokens, { launchByDefault: true }),
    },
    {
        kind: 'remote',
        path: ['reveal'],
        method: 'files.reveal',
        summary: 'Reveal one added Project path through the authenticated Desktop.',
        usage: '<path> [--session <session-id>] [--launch]',
        confirmation: 'Reveal this Project path in Finder?',
        parseParams: (tokens) => desktopTarget(tokens, { launchByDefault: false }),
    },
    ...SKILL_COMMANDS,
    {
        kind: 'remote',
        path: ['agent', 'list'],
        method: 'agent.list',
        summary: 'List online Agent Endpoints visible to this principal.',
        parseParams: rejectOptions,
        quietKey: 'agents',
        quietIdKey: 'ref',
    },
    {
        kind: 'remote',
        path: ['agent', 'grants'],
        method: 'agent.grants',
        summary: 'List grants for one exact Agent Endpoint generation.',
        usage: '<host-id>:<endpoint-id>:<generation>',
        parseParams: (tokens) => {
            if (tokens.length !== 1)
                throw new CaxriError('VALIDATION', 'agent grants requires one Endpoint ref');
            return { endpoint: endpointReference(tokens[0]) };
        },
        quietKey: 'grants',
    },
    {
        kind: 'remote',
        path: ['agent', 'grant'],
        method: 'agent.grant',
        summary: 'Grant a bounded policy to one Agent Endpoint generation.',
        usage: '<host-id>:<endpoint-id>:<generation> <policy> [--ttl-ms <milliseconds>]',
        confirmation: 'Grant this policy to the selected Agent Endpoint generation?',
        parseParams: agentGrant,
    },
    {
        kind: 'remote',
        path: ['agent', 'revoke'],
        method: 'agent.revoke',
        summary: 'Revoke one generation-scoped Agent grant.',
        usage: '<host-id>:<endpoint-id>:<generation> <grant-id>',
        confirmation: 'Revoke this Agent Endpoint grant?',
        parseParams: (tokens) => {
            if (tokens.length !== 2)
                throw new CaxriError(
                    'VALIDATION',
                    'agent revoke requires an Endpoint ref and grant ID',
                );
            return { endpoint: endpointReference(tokens[0]), grantId: tokens[1] };
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'dispatch', 'start'],
        method: 'agent.dispatch.start',
        quietIdKey: 'dispatchId',
        summary: 'Start one fresh Agent conversation in an exact Project Session.',
        usage: `--project <project-id> --session <session-id> --provider <${agentProviderIds.join('|')}>`,
        confirmation: 'Start this Agent dispatch?',
        parseParams: (tokens) => dispatchTarget(tokens, false),
    },
    {
        kind: 'remote',
        path: ['agent', 'dispatch', 'resume'],
        method: 'agent.dispatch.resume',
        quietIdKey: 'dispatchId',
        summary: 'Resume one exactly bound Provider conversation in its Terminal.',
        usage: '--project <project-id> --session <session-id> --terminal <terminal-id> --provider-session <id>',
        confirmation: 'Resume this exact Agent dispatch target?',
        parseParams: (tokens) => dispatchTarget(tokens, true),
    },
    {
        kind: 'remote',
        path: ['agent', 'dispatch', 'status'],
        method: 'agent.dispatch.status',
        quietIdKey: 'dispatchId',
        summary: 'Read one durable Agent dispatch receipt.',
        usage: '<dispatch-id>',
        parseParams: (tokens) => {
            if (tokens.length !== 1)
                throw new CaxriError(
                    'VALIDATION',
                    'agent dispatch status requires one dispatch ID',
                );
            return { dispatchId: tokens[0] };
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'dispatch', 'wait'],
        method: 'agent.dispatch.wait',
        summary: 'Wait for a typed lifecycle change to one durable Agent dispatch.',
        usage: '<dispatch-id> [--after-revision <revision>] [--timeout <milliseconds>]',
        parseParams: dispatchWait,
    },
    {
        kind: 'remote',
        path: ['agent', 'control', 'interrupt'],
        method: 'agent.control.interrupt',
        summary: 'Interrupt one exact active Agent Endpoint generation.',
        usage: '<host-id>:<endpoint-id>:<generation>',
        confirmation: 'Interrupt this exact Agent generation?',
        parseParams: (tokens) => {
            if (tokens.length !== 1)
                throw new CaxriError(
                    'VALIDATION',
                    'agent control interrupt requires one Endpoint ref',
                );
            return { endpoint: endpointReference(tokens[0]) };
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'control', 'stop'],
        method: 'agent.control.stop',
        summary: 'Stop one exact active Agent Endpoint generation.',
        usage: '<host-id>:<endpoint-id>:<generation>',
        confirmation: 'Stop this exact Agent generation?',
        parseParams: (tokens) => {
            if (tokens.length !== 1)
                throw new CaxriError('VALIDATION', 'agent control stop requires one Endpoint ref');
            return { endpoint: endpointReference(tokens[0]) };
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'send'],
        method: 'agent.message.send',
        quietIdKey: 'messageId',
        summary: 'Send bounded inert text to one exact peer Agent generation.',
        usage: '--to <host-id>:<endpoint-id>:<generation> --body <text> [--ttl-ms <milliseconds>] [--wake]',
        parseParams: (tokens) => agentMessage(tokens, false),
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'wait'],
        method: 'agent.message.wait',
        summary: 'Wait for one FIFO peer message without treating it as terminal input.',
        usage: '[--timeout <milliseconds>]',
        parseParams: rejectOptions,
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'check'],
        method: 'agent.message.check',
        summary: 'Check once for a FIFO peer message without waiting.',
        parseParams: rejectOptions,
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'reply'],
        method: 'agent.message.reply',
        quietIdKey: 'messageId',
        summary: 'Reply to one delivered peer message and its exact sender generation.',
        usage: '--to <host-id>:<endpoint-id>:<generation> --reply-to <message-id> --body <text> [--ttl-ms <milliseconds>]',
        parseParams: (tokens) => agentMessage(tokens, true),
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'receipt'],
        method: 'agent.message.receipt',
        quietIdKey: 'messageId',
        summary: 'Read body-free delivery status for one sent peer message.',
        usage: '<message-id>',
        parseParams: (tokens) => {
            if (tokens.length !== 1)
                throw new CaxriError('VALIDATION', 'agent message receipt requires one message ID');
            return { messageId: tokens[0] };
        },
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'policy'],
        method: 'agent.message.policy.get',
        summary: 'Show this Agent generation inbound message policy.',
        parseParams: rejectOptions,
        requiresAgentEndpoint: true,
    },
    {
        kind: 'remote',
        path: ['agent', 'message', 'policy-set'],
        method: 'agent.message.policy.set',
        summary: 'Set this Agent generation inbound message policy.',
        usage: '<auto|accept|hold|refuse> [--hold-until-endpoint]',
        parseParams: (tokens) => {
            const policy = tokens[0];
            if (!policy)
                throw new CaxriError('VALIDATION', 'agent message policy-set requires a policy');
            const rest = tokens.slice(1);
            if (rest.length > 1 || (rest.length === 1 && rest[0] !== '--hold-until-endpoint'))
                throw new CaxriError('VALIDATION', `Unknown option: ${rest[0]}`);
            return {
                policy,
                heldRetention: rest[0] === '--hold-until-endpoint' ? 'endpoint' : 'approval-window',
            };
        },
        requiresAgentEndpoint: true,
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
    ...RECORD_COMMANDS,
    {
        kind: 'remote',
        path: ['terminal', 'send'],
        method: 'terminal.send',
        quietIdKey: 'terminalId',
        summary: 'Send bounded human input to a live Terminal; this is not a Peer Message.',
        usage: '--terminal <terminal-id> --text <text> [--enter]',
        confirmation: 'Send this human input to the selected Terminal?',
        parseParams: terminalSend,
        requiresHumanOwner: true,
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
        mutates: (parameters) =>
            typeof parameters === 'object' &&
            parameters !== null &&
            Reflect.get(parameters, 'dryRun') !== true,
        parseParams: (tokens) => settingPatch(tokens, false),
    },
    {
        kind: 'remote',
        path: ['logs', 'query'],
        method: 'logs.query',
        summary: 'Query a bounded page of structured log records (fields secret-redacted).',
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
