import { Buffer } from 'node:buffer';

import {
    agentProviderSchema,
    identifierSchema,
    MAX_TERMINAL_INPUT_LENGTH,
    pathSchema,
    serverCredentialTokenSchema,
    serverProcessIdentitySchema,
    terminalRecordSchema,
    terminalResourceUsageSchema,
    terminalSnapshotSchema,
} from '@caxri/protocol';
import { isSecretMatch } from '@caxri/system';
import { z } from 'zod';

import { observationContextSchema } from '../observability/context-schema';

export const TERMINAL_HOST_PROTOCOL_VERSION = 4 as const;
export const MAX_TERMINAL_HOST_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_AGENT_SUBMIT_TEXT_BYTES = 16 * 1024;
const MAX_TERMINAL_HOST_OUTPUT_CHARACTERS = 256 * 1024;

export function isValidAgentSubmitText(text: string): boolean {
    if (
        text.length === 0 ||
        Buffer.byteLength(text, 'utf8') > MAX_AGENT_SUBMIT_TEXT_BYTES ||
        Buffer.from(text, 'utf8').toString('utf8') !== text
    )
        return false;
    for (const character of text) {
        const code = character.codePointAt(0)!;
        if (code === 9 || code === 10) continue;
        if (code < 32 || (code >= 127 && code <= 159)) return false;
    }
    return true;
}

const ptyGenerationSchema = z.number().int().positive();
const attachmentIdSchema = identifierSchema;
const observerIdSchema = identifierSchema;
const leaseHolderIdSchema = z.string().min(1).max(400);
const terminalHostCapabilitySchema = z.enum([
    'host.lifecycle',
    'terminal.agent.input',
    'terminal.input',
    'terminal.inspect',
    'terminal.lifecycle',
    'terminal.lease',
    'terminal.mobile.input',
    'terminal.observe',
    'terminal.view',
]);

const serverScopeSchema = z
    .object({
        scope: z.literal('server'),
        capability: terminalHostCapabilitySchema,
    })
    .strict();

const terminalScopeSchema = z
    .object({
        scope: z.literal('terminal'),
        capability: terminalHostCapabilitySchema,
        sessionId: identifierSchema,
        terminalId: identifierSchema,
        ptyGeneration: ptyGenerationSchema,
        attachmentId: attachmentIdSchema.optional(),
    })
    .strict();

const terminalHostScopeSchema = z.discriminatedUnion('scope', [
    serverScopeSchema,
    terminalScopeSchema,
]);

const terminalGridSizeSchema = z
    .object({
        cols: z.number().int().positive().max(10_000),
        rows: z.number().int().positive().max(10_000),
    })
    .strict();

const environmentSchema = z
    .record(z.string().min(1).max(256), z.string().max(64 * 1024))
    .refine((environment) => Object.keys(environment).length <= 512, {
        message: 'Terminal launch environment exceeds 512 entries',
    });
const terminalArgumentsSchema = z.array(z.string().max(16_384)).max(256);

const nodeSignalSchema = z.enum([
    'SIGABRT',
    'SIGALRM',
    'SIGBUS',
    'SIGCHLD',
    'SIGCONT',
    'SIGFPE',
    'SIGHUP',
    'SIGILL',
    'SIGINFO',
    'SIGINT',
    'SIGIO',
    'SIGIOT',
    'SIGKILL',
    'SIGLOST',
    'SIGPIPE',
    'SIGPOLL',
    'SIGPROF',
    'SIGPWR',
    'SIGQUIT',
    'SIGSEGV',
    'SIGSTKFLT',
    'SIGSTOP',
    'SIGSYS',
    'SIGTERM',
    'SIGTRAP',
    'SIGTSTP',
    'SIGTTIN',
    'SIGTTOU',
    'SIGURG',
    'SIGUNUSED',
    'SIGUSR1',
    'SIGUSR2',
    'SIGVTALRM',
    'SIGWINCH',
    'SIGXCPU',
    'SIGXFSZ',
    'SIGBREAK',
]);

const outputRecoverySettingsSchema = z
    .object({
        enabled: z.boolean(),
        patterns: z.array(z.string().max(8_192)).max(100),
        settleDelayMs: z.number().int().nonnegative().max(60_000),
        continueDelayMs: z.number().int().nonnegative().max(60_000),
    })
    .strict();

const terminalLaunchPlanSchema = z
    .object({
        record: terminalRecordSchema,
        executable: pathSchema,
        args: terminalArgumentsSchema,
        environment: environmentSchema,
        agent: z
            .object({
                launchId: identifierSchema,
                provider: agentProviderSchema,
                executable: pathSchema,
                args: terminalArgumentsSchema,
                environment: environmentSchema,
            })
            .strict()
            .optional(),
        initialSnapshot: terminalSnapshotSchema.optional(),
        initialSize: terminalGridSizeSchema.optional(),
        outputRecovery: outputRecoverySettingsSchema.optional(),
        colors: z
            .object({
                background: z.string().min(1).max(100),
                foreground: z.string().min(1).max(100),
            })
            .strict()
            .optional(),
    })
    .strict();

const terminalRequestSchemas = [
    z.object({ method: z.literal('terminal.reserve'), params: terminalRecordSchema }).strict(),
    z.object({ method: z.literal('terminal.start'), params: terminalLaunchPlanSchema }).strict(),
    z
        .object({
            method: z.literal('terminal.input'),
            params: z
                .object({
                    data: z.string().max(MAX_TERMINAL_INPUT_LENGTH),
                    encoding: z.literal('binary').optional(),
                    expectedAgentLaunchId: identifierSchema.optional(),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.agent.input'),
            params: z
                .object({
                    data: z.string().max(65_536),
                    launchId: identifierSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.agent.submit'),
            params: z
                .object({
                    text: z.string().refine(isValidAgentSubmitText),
                    launchId: identifierSchema,
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.resize'),
            params: terminalGridSizeSchema,
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.attach'),
            params: z
                .object({
                    attachmentId: attachmentIdSchema,
                    size: terminalGridSizeSchema.optional(),
                })
                .strict(),
        })
        .strict(),
    z.object({ method: z.literal('terminal.detach'), params: z.object({}).strict() }).strict(),
    z
        .object({
            method: z.literal('terminal.observe'),
            params: z.object({ observerId: observerIdSchema }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.unobserve'),
            params: z.object({ observerId: observerIdSchema }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.takeOver'),
            params: z
                .object({
                    holderId: leaseHolderIdSchema,
                    size: terminalGridSizeSchema,
                    timeoutMs: z.number().int().min(1_000).max(60_000),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.renewTakeOver'),
            params: z
                .object({
                    holderId: leaseHolderIdSchema,
                    timeoutMs: z.number().int().min(1_000).max(60_000),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.releaseTakeOver'),
            params: z.object({ holderId: leaseHolderIdSchema }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.observer.input'),
            params: z.object({ data: z.string().max(MAX_TERMINAL_INPUT_LENGTH) }).strict(),
        })
        .strict(),
    z.object({ method: z.literal('terminal.snapshot'), params: z.object({}).strict() }).strict(),
    z
        .object({
            method: z.literal('terminal.textTail'),
            params: z.object({ maximumCharacters: z.number().int().min(1).max(65_536) }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.waitForAttachedSize'),
            params: z.object({ timeoutMs: z.number().int().positive().max(60_000) }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.signal'),
            params: z
                .object({
                    expectedProcessId: z.number().int().positive(),
                    signal: z.enum(['SIGINT', 'SIGHUP']),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.agent.signal'),
            params: z
                .object({
                    launchId: identifierSchema,
                    signal: z.enum(['SIGINT', 'SIGHUP']),
                })
                .strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.stop'),
            params: z.object({ persistSnapshot: z.boolean() }).strict(),
        })
        .strict(),
    z
        .object({
            method: z.literal('terminal.reassign'),
            params: z.object({ sessionId: identifierSchema }).strict(),
        })
        .strict(),
    z.object({ method: z.literal('terminal.resources'), params: z.object({}).strict() }).strict(),
    z
        .object({
            method: z.literal('terminal.recovery.configure'),
            params: z
                .object({
                    provider: agentProviderSchema.optional(),
                    settings: outputRecoverySettingsSchema.optional(),
                })
                .strict(),
        })
        .strict(),
] as const;

const serverRequestSchemas = [
    z
        .object({
            method: z.literal('host.initialize'),
            params: z
                .object({
                    appVersion: z.string().min(1).max(100),
                    buildId: z.string().min(1).max(200),
                    commit: z.string().min(1).max(100),
                })
                .strict(),
        })
        .strict(),
    z.object({ method: z.literal('host.shutdown'), params: z.object({}).strict() }).strict(),
    z.object({ method: z.literal('terminal.detachAll'), params: z.object({}).strict() }).strict(),
    z
        .object({
            method: z.literal('terminal.runningCount'),
            params: z.object({ sessionId: identifierSchema.optional() }).strict(),
        })
        .strict(),
] as const;

const terminalHostRequestSchema = z.discriminatedUnion('method', [
    ...terminalRequestSchemas,
    ...serverRequestSchemas,
]);

export const terminalHostRequestEnvelopeSchema = z
    .object({
        type: z.literal('request'),
        protocolVersion: z.literal(TERMINAL_HOST_PROTOCOL_VERSION),
        id: identifierSchema,
        credential: serverCredentialTokenSchema,
        bootId: serverProcessIdentitySchema,
        observation: observationContextSchema.optional(),
        scope: terminalHostScopeSchema,
        request: terminalHostRequestSchema,
    })
    .strict();

const terminalHostErrorSchema = z
    .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_048),
    })
    .strict();

const terminalHostReplyEnvelopeSchema = z.discriminatedUnion('ok', [
    z
        .object({
            type: z.literal('reply'),
            id: identifierSchema,
            ok: z.literal(true),
            result: z.unknown(),
        })
        .strict(),
    z
        .object({
            type: z.literal('reply'),
            id: identifierSchema,
            ok: z.literal(false),
            error: terminalHostErrorSchema,
        })
        .strict(),
]);

const terminalEventIdentitySchema = terminalScopeSchema.omit({ capability: true });

const terminalHostEventEnvelopeSchema = z.discriminatedUnion('event', [
    z
        .object({
            type: z.literal('event'),
            event: z.literal('host.ready'),
            bootId: serverProcessIdentitySchema,
            protocolVersion: z.literal(TERMINAL_HOST_PROTOCOL_VERSION),
            appVersion: z.string().min(1).max(100),
            buildId: z.string().min(1).max(200),
            commit: z.string().min(1).max(100),
            pid: z.number().int().positive(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.output'),
            identity: terminalEventIdentitySchema.extend({ attachmentId: attachmentIdSchema }),
            data: z.string().max(MAX_TERMINAL_HOST_OUTPUT_CHARACTERS),
            droppedBytes: z.number().int().nonnegative().optional(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.observer.output'),
            identity: terminalEventIdentitySchema,
            sequence: z.number().int().nonnegative(),
            data: z.string().max(MAX_TERMINAL_HOST_OUTPUT_CHARACTERS),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.observer.gap'),
            identity: terminalEventIdentitySchema,
            sequence: z.number().int().nonnegative(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.exit'),
            identity: terminalEventIdentitySchema,
            exitCode: z.number().int(),
            signal: z.number().int().optional(),
            snapshot: terminalSnapshotSchema.optional(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.agent.started'),
            identity: terminalEventIdentitySchema,
            launchId: identifierSchema,
            processId: z.number().int().positive(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.agent.exit'),
            identity: terminalEventIdentitySchema,
            launchId: identifierSchema,
            exitCode: z.number().int().nullable(),
            signal: nodeSignalSchema.optional(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.activity'),
            identity: terminalEventIdentitySchema,
            processId: z.number().int().positive(),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.sizeOwnership'),
            identity: terminalEventIdentitySchema,
            owner: z.enum(['desktop', 'mobile']),
            cols: terminalGridSizeSchema.shape.cols,
            rows: terminalGridSizeSchema.shape.rows,
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.title'),
            identity: terminalEventIdentitySchema,
            title: z.string().min(1).max(200),
        })
        .strict(),
    z
        .object({
            type: z.literal('event'),
            event: z.literal('terminal.outputRecovery'),
            identity: terminalEventIdentitySchema,
            provider: agentProviderSchema,
            status: z.enum(['recovered', 'rate-limited']),
        })
        .strict(),
]);

export const terminalHostMessageSchema = z.union([
    terminalHostReplyEnvelopeSchema,
    terminalHostEventEnvelopeSchema,
]);

type TerminalHostCapability = z.infer<typeof terminalHostCapabilitySchema>;
export type TerminalHostRequest = z.infer<typeof terminalHostRequestSchema>;
export type TerminalHostRequestEnvelope = z.infer<typeof terminalHostRequestEnvelopeSchema>;
export type TerminalHostMessage = z.infer<typeof terminalHostMessageSchema>;
export type TerminalHostScope = z.infer<typeof terminalHostScopeSchema>;
export type TerminalShutdownFailure = z.infer<typeof terminalShutdownFailureSchema>;

/**
 * Reported when `host.shutdown` could not capture one Terminal's final snapshot (e.g. the parser barrier rejected).
 * Server Core uses this instead of a generic "omitted" message so the per-terminal rejection stays actionable.
 */
const terminalShutdownFailureSchema = z
    .object({ terminalId: identifierSchema, error: z.string().max(4_096) })
    .strict();

const terminalHostResultSchemas = {
    'host.initialize': z.object({ initialized: z.literal(true) }).strict(),
    'host.shutdown': z
        .object({
            stopped: z.literal(true),
            snapshots: z.array(terminalSnapshotSchema),
            /**
             * Additive field: absent or empty when every live Terminal's snapshot capture succeeded. One rejected
             * capture no longer discards every other Terminal's snapshot (see `TerminalHostRuntime.dispatch`).
             */
            failures: z.array(terminalShutdownFailureSchema).optional(),
        })
        .strict(),
    'terminal.reserve': z.object({ reserved: z.literal(true) }).strict(),
    'terminal.start': z.object({ processId: z.number().int().positive() }).strict(),
    'terminal.agent.input': z.object({ accepted: z.boolean() }).strict(),
    'terminal.agent.submit': z
        .object({ outcome: z.enum(['accepted', 'rejected', 'unknown']) })
        .strict(),
    'terminal.input': z.object({ accepted: z.boolean() }).strict(),
    'terminal.resize': z.object({ accepted: z.boolean() }).strict(),
    'terminal.attach': z
        .object({ snapshot: terminalSnapshotSchema.nullable(), wasAttached: z.boolean() })
        .strict(),
    'terminal.detach': z.object({ detached: z.literal(true) }).strict(),
    'terminal.observe': z
        .object({
            snapshot: terminalSnapshotSchema.nullable(),
            nextSequence: z.number().int().nonnegative(),
        })
        .strict(),
    'terminal.unobserve': z.object({ detached: z.literal(true) }).strict(),
    'terminal.takeOver': z.object({ expiresAt: z.number().int().positive() }).strict(),
    'terminal.renewTakeOver': z.object({ expiresAt: z.number().int().positive() }).strict(),
    'terminal.releaseTakeOver': z.object({ released: z.literal(true) }).strict(),
    'terminal.observer.input': z.object({ accepted: z.boolean() }).strict(),
    'terminal.snapshot': z.object({ snapshot: terminalSnapshotSchema.nullable() }).strict(),
    'terminal.textTail': z.object({ tail: z.string().max(65_536).nullable() }).strict(),
    'terminal.waitForAttachedSize': z.object({ attached: z.literal(true) }).strict(),
    'terminal.signal': z.object({ accepted: z.boolean() }).strict(),
    'terminal.agent.signal': z.object({ accepted: z.boolean() }).strict(),
    'terminal.stop': z
        .object({ snapshot: terminalSnapshotSchema.nullable(), stopped: z.literal(true) })
        .strict(),
    'terminal.reassign': z.object({ reassigned: z.literal(true) }).strict(),
    'terminal.resources': z.object({ resources: terminalResourceUsageSchema.nullable() }).strict(),
    'terminal.recovery.configure': z.object({ configured: z.literal(true) }).strict(),
    'terminal.detachAll': z.object({ detached: z.literal(true) }).strict(),
    'terminal.runningCount': z.object({ count: z.number().int().nonnegative() }).strict(),
} as const satisfies Record<TerminalHostRequest['method'], z.ZodType>;

export function isTerminalHostResult(
    method: TerminalHostRequest['method'],
    value: unknown,
): boolean {
    return terminalHostResultSchemas[method].safeParse(value).success;
}

const requiredCapabilities = {
    'host.initialize': 'host.lifecycle',
    'host.shutdown': 'host.lifecycle',
    'terminal.reserve': 'terminal.lifecycle',
    'terminal.start': 'terminal.lifecycle',
    'terminal.agent.input': 'terminal.agent.input',
    'terminal.agent.submit': 'terminal.agent.input',
    'terminal.input': 'terminal.input',
    'terminal.resize': 'terminal.view',
    'terminal.attach': 'terminal.view',
    'terminal.detach': 'terminal.view',
    'terminal.observe': 'terminal.observe',
    'terminal.unobserve': 'terminal.observe',
    'terminal.takeOver': 'terminal.lease',
    'terminal.renewTakeOver': 'terminal.lease',
    'terminal.releaseTakeOver': 'terminal.lease',
    'terminal.observer.input': 'terminal.mobile.input',
    'terminal.snapshot': 'terminal.view',
    'terminal.textTail': 'terminal.inspect',
    'terminal.waitForAttachedSize': 'terminal.view',
    'terminal.signal': 'terminal.lifecycle',
    'terminal.agent.signal': 'terminal.lifecycle',
    'terminal.stop': 'terminal.lifecycle',
    'terminal.reassign': 'terminal.lifecycle',
    'terminal.resources': 'terminal.inspect',
    'terminal.recovery.configure': 'terminal.lifecycle',
    'terminal.detachAll': 'terminal.view',
    'terminal.runningCount': 'terminal.inspect',
} as const satisfies Record<TerminalHostRequest['method'], TerminalHostCapability>;

export interface TerminalHostAuthority {
    bootId: string;
    credential: string;
    /**
     * Undefined means this fresh Host has no generation baseline and may accept Core's first positive generation.
     */
    launchGeneration(terminalId: string): number | undefined;
    terminal(terminalId: string):
        | {
              sessionId: string;
              ptyGeneration: number;
              attachmentId?: string;
              agentLaunchId?: string;
              agentProcessId?: number;
              running?: boolean;
          }
        | undefined;
}

export type TerminalHostAuthorizationFailure =
    | 'credential'
    | 'boot'
    | 'capability'
    | 'scope'
    | 'terminal'
    | 'session'
    | 'generation'
    | 'agent'
    | 'attachment';

/**
 * Applies the private fail-closed identity contract after structural parsing. The caller deliberately receives only a
 * reason code: credentials and peer-supplied identities must never enter logs or replies.
 */
export function authorizeTerminalHostRequest(
    envelope: TerminalHostRequestEnvelope,
    authority: TerminalHostAuthority,
): { ok: true } | { ok: false; reason: TerminalHostAuthorizationFailure } {
    if (!isSecretMatch(envelope.credential, authority.credential))
        return { ok: false, reason: 'credential' };
    if (envelope.bootId !== authority.bootId) return { ok: false, reason: 'boot' };
    const requiredCapability = requiredCapabilities[envelope.request.method];
    if (envelope.scope.capability !== requiredCapability)
        return { ok: false, reason: 'capability' };

    const isTerminalMethod =
        envelope.request.method.startsWith('terminal.') &&
        !['terminal.detachAll', 'terminal.runningCount'].includes(envelope.request.method);
    if (!isTerminalMethod)
        return envelope.scope.scope === 'server' ? { ok: true } : { ok: false, reason: 'scope' };
    if (envelope.scope.scope !== 'terminal') return { ok: false, reason: 'scope' };

    if (
        envelope.request.method === 'terminal.start' ||
        envelope.request.method === 'terminal.reserve'
    ) {
        const record =
            envelope.request.method === 'terminal.start'
                ? envelope.request.params.record
                : envelope.request.params;
        if (record.id !== envelope.scope.terminalId) return { ok: false, reason: 'terminal' };
        if (record.sessionId !== envelope.scope.sessionId) return { ok: false, reason: 'session' };
        const current = authority.terminal(record.id);
        const isReservedStart =
            envelope.request.method === 'terminal.start' &&
            current?.running === false &&
            current.sessionId === record.sessionId &&
            current.ptyGeneration === envelope.scope.ptyGeneration;
        const expectedGeneration = authority.launchGeneration(record.id);
        if (
            !isReservedStart &&
            expectedGeneration !== undefined &&
            envelope.scope.ptyGeneration !== expectedGeneration
        )
            return { ok: false, reason: 'generation' };
        if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
        return { ok: true };
    }

    const current = authority.terminal(envelope.scope.terminalId);
    if (!current) return { ok: false, reason: 'terminal' };
    if (current.sessionId !== envelope.scope.sessionId) return { ok: false, reason: 'session' };
    if (current.ptyGeneration !== envelope.scope.ptyGeneration)
        return { ok: false, reason: 'generation' };

    if (envelope.request.method === 'terminal.attach') {
        return envelope.scope.attachmentId === envelope.request.params.attachmentId
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    }
    if (
        envelope.request.method === 'terminal.agent.input' ||
        envelope.request.method === 'terminal.agent.submit'
    ) {
        if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
        return current.running &&
            current.agentLaunchId === envelope.request.params.launchId &&
            (envelope.request.method !== 'terminal.agent.submit' ||
                current.agentProcessId !== undefined)
            ? { ok: true }
            : { ok: false, reason: 'agent' };
    }
    if (
        [
            'terminal.observe',
            'terminal.unobserve',
            'terminal.takeOver',
            'terminal.renewTakeOver',
            'terminal.releaseTakeOver',
            'terminal.observer.input',
        ].includes(envelope.request.method)
    )
        return envelope.scope.attachmentId === undefined && current.running
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    if (
        ['terminal.input', 'terminal.resize', 'terminal.detach'].includes(envelope.request.method)
    ) {
        return envelope.scope.attachmentId !== undefined &&
            envelope.scope.attachmentId === current.attachmentId
            ? { ok: true }
            : { ok: false, reason: 'attachment' };
    }
    if (envelope.scope.attachmentId !== undefined) return { ok: false, reason: 'attachment' };
    return { ok: true };
}

export function isBoundedTerminalHostMessage(value: unknown): boolean {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_TERMINAL_HOST_MESSAGE_BYTES;
    } catch {
        return false;
    }
}
