import { Buffer } from 'node:buffer';

import {
    agentProviderSchema,
    identifierSchema,
    MAX_TERMINAL_INPUT_LENGTH,
    mobileTerminalWheelLinesSchema,
    serverCredentialTokenSchema,
    serverProcessIdentitySchema,
    terminalRecordSchema,
    terminalResourceUsageSchema,
    terminalSnapshotSchema,
} from '@caxri/protocol';
import { z } from 'zod';

import { observationContextSchema } from '../observability/context-schema';
import { isJsonWithinByteLimit } from './json-byte-length';
import {
    outputRecoverySettingsSchema,
    terminalColorsSchema,
    terminalGridSizeSchema,
    terminalLaunchPlanSchema,
} from './launch-plan-schema';

export const TERMINAL_HOST_PROTOCOL_VERSION = 5 as const;
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
    z
        .object({
            method: z.literal('terminal.observer.scroll'),
            params: z
                .object({
                    col: z.number().int().min(1).max(1_000),
                    lines: mobileTerminalWheelLinesSchema,
                    row: z.number().int().min(1).max(1_000),
                })
                .strict(),
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
    /**
     * `persistSnapshot: true` is a restart barrier and `false` discards a failed launch. Both keep the Terminal's
     * generation baseline because Server Core may relaunch the same ID; permanent closure is `terminal.retire`.
     */
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
            method: z.literal('terminal.configure'),
            params: z
                .object({
                    provider: agentProviderSchema.optional(),
                    settings: outputRecoverySettingsSchema.optional(),
                    colors: terminalColorsSchema.optional(),
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
    /**
     * Permanent closure. Server-scoped because Server Core may no longer hold a live identity (the PTY exited naturally
     * or a launch was discarded) while this Host still retains the ID's generation baseline; the ID is never reused, so
     * no PTY generation can make the request stale.
     */
    z
        .object({
            method: z.literal('terminal.retire'),
            params: z.object({ terminalId: identifierSchema }).strict(),
        })
        .strict(),
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
            reason: z.enum(['resize', 'overflow']),
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

export type TerminalHostCapability = z.infer<typeof terminalHostCapabilitySchema>;
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
    'terminal.observer.scroll': z.object({ accepted: z.boolean() }).strict(),
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
    'terminal.configure': z.object({ configured: z.literal(true) }).strict(),
    'terminal.detachAll': z.object({ detached: z.literal(true) }).strict(),
    'terminal.retire': z.object({ retired: z.literal(true) }).strict(),
    'terminal.runningCount': z.object({ count: z.number().int().nonnegative() }).strict(),
} as const satisfies Record<TerminalHostRequest['method'], z.ZodType>;

export function isTerminalHostResult(
    method: TerminalHostRequest['method'],
    value: unknown,
): boolean {
    return terminalHostResultSchemas[method].safeParse(value).success;
}

/**
 * Checks every Terminal Host IPC message in both directions, so it measures the JSON size without building the JSON
 * text (see `isJsonWithinByteLimit`).
 */
export function isBoundedTerminalHostMessage(value: unknown): boolean {
    return isJsonWithinByteLimit(value, MAX_TERMINAL_HOST_MESSAGE_BYTES);
}
