import { Buffer } from 'node:buffer';

import {
    identifierSchema,
    pathSchema,
    serverCredentialTokenSchema,
    serverProcessIdentitySchema,
    terminalRecordSchema,
    terminalSnapshotSchema,
} from '@caxri/protocol';
import { isSecretMatch } from '@caxri/system';
import { z } from 'zod';

const TERMINAL_HOST_PROTOCOL_VERSION = 1 as const;
export const MAX_TERMINAL_HOST_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_HOST_OUTPUT_CHARACTERS = 256 * 1024;

const ptyGenerationSchema = z.number().int().positive();
const attachmentIdSchema = identifierSchema;
const terminalHostCapabilitySchema = z.enum([
    'host.lifecycle',
    'terminal.input',
    'terminal.inspect',
    'terminal.lifecycle',
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
        args: z.array(z.string().max(16_384)).max(256),
        environment: environmentSchema,
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
    z.object({ method: z.literal('terminal.start'), params: terminalLaunchPlanSchema }).strict(),
    z
        .object({
            method: z.literal('terminal.input'),
            params: z.object({ data: z.string().max(65_536) }).strict(),
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
    z.object({ method: z.literal('terminal.snapshot'), params: z.object({}).strict() }).strict(),
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
            params: z.object({ settings: outputRecoverySettingsSchema.optional() }).strict(),
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
        serverId: serverProcessIdentitySchema,
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
            serverId: serverProcessIdentitySchema,
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
            event: z.literal('terminal.activity'),
            identity: terminalEventIdentitySchema,
            processId: z.number().int().positive(),
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
            status: z.enum(['recovered', 'rate-limited']),
        })
        .strict(),
]);

export const terminalHostMessageSchema = z.union([
    terminalHostReplyEnvelopeSchema,
    terminalHostEventEnvelopeSchema,
]);

type TerminalHostCapability = z.infer<typeof terminalHostCapabilitySchema>;
type TerminalHostRequest = z.infer<typeof terminalHostRequestSchema>;
export type TerminalHostRequestEnvelope = z.infer<typeof terminalHostRequestEnvelopeSchema>;

const requiredCapabilities = {
    'host.initialize': 'host.lifecycle',
    'host.shutdown': 'host.lifecycle',
    'terminal.start': 'terminal.lifecycle',
    'terminal.input': 'terminal.input',
    'terminal.resize': 'terminal.view',
    'terminal.attach': 'terminal.view',
    'terminal.detach': 'terminal.view',
    'terminal.snapshot': 'terminal.view',
    'terminal.stop': 'terminal.lifecycle',
    'terminal.reassign': 'terminal.lifecycle',
    'terminal.resources': 'terminal.inspect',
    'terminal.recovery.configure': 'terminal.lifecycle',
    'terminal.detachAll': 'terminal.view',
    'terminal.runningCount': 'terminal.inspect',
} as const satisfies Record<TerminalHostRequest['method'], TerminalHostCapability>;

export interface TerminalHostAuthority {
    credential: string;
    serverId: string;
    launchGeneration(terminalId: string): number;
    terminal(terminalId: string):
        | {
              sessionId: string;
              ptyGeneration: number;
              attachmentId?: string;
          }
        | undefined;
}

export type TerminalHostAuthorizationFailure =
    | 'credential'
    | 'server'
    | 'capability'
    | 'scope'
    | 'terminal'
    | 'session'
    | 'generation'
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
    if (envelope.serverId !== authority.serverId) return { ok: false, reason: 'server' };
    const requiredCapability = requiredCapabilities[envelope.request.method];
    if (envelope.scope.capability !== requiredCapability)
        return { ok: false, reason: 'capability' };

    const isTerminalMethod =
        envelope.request.method.startsWith('terminal.') &&
        !['terminal.detachAll', 'terminal.runningCount'].includes(envelope.request.method);
    if (!isTerminalMethod)
        return envelope.scope.scope === 'server' ? { ok: true } : { ok: false, reason: 'scope' };
    if (envelope.scope.scope !== 'terminal') return { ok: false, reason: 'scope' };

    if (envelope.request.method === 'terminal.start') {
        const record = envelope.request.params.record;
        if (record.id !== envelope.scope.terminalId) return { ok: false, reason: 'terminal' };
        if (record.sessionId !== envelope.scope.sessionId) return { ok: false, reason: 'session' };
        if (envelope.scope.ptyGeneration !== authority.launchGeneration(record.id))
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
