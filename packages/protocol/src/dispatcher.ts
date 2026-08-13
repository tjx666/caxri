import { z } from 'zod';

import { CaxriError, toWireError } from './errors.js';
import { methods, type CaxriRequest, type CommandOwner, type MethodSpec } from './methods.js';
import {
    capabilitySchema,
    hasRequiredCapabilities,
    principalSchema,
    type CommandExecutionContext,
} from './principal.js';
import {
    commandReplyEnvelopeSchema,
    parseCaxriResult,
    requestEnvelopeSchema,
    type CommandReplyEnvelope,
} from './transport.js';
import {
    CAXRI_PROTOCOL_VERSION,
    negotiateProtocolVersion,
    protocolHelloSchema,
    protocolWelcomeSchema,
    type ProtocolWelcome,
} from './version.js';

export interface CommandAdapter {
    invoke(
        request: CaxriRequest,
        context: CommandExecutionContext,
        invocation: { requestId: string },
    ): unknown;
    isAvailable?(): boolean;
}

export interface CommandDispatcherOptions {
    desktop?: CommandAdapter;
    host: CommandAdapter;
    maximumReceipts?: number;
}

export type CommandDispatcher = (
    envelope: unknown,
    context: CommandExecutionContext,
) => Promise<CommandReplyEnvelope>;

interface Receipt {
    fingerprint: string;
    method: string;
    settled: boolean;
    reply: Promise<CommandReplyEnvelope>;
}

const contextSchema = z.object({
    principal: principalSchema,
    capabilities: z.array(capabilitySchema).max(64),
});

function principalReceiptKey(context: CommandExecutionContext, requestId: string): string {
    const { principal } = context;
    const generation =
        principal.kind === 'agent' || principal.kind === 'desktop'
            ? `:${principal.generation}`
            : '';
    return `${principal.kind}:${principal.id}${generation}:${requestId}`;
}

function adapterFor(owner: CommandOwner, options: CommandDispatcherOptions): CommandAdapter {
    const adapter = owner === 'host' ? options.host : options.desktop;
    if (!adapter || adapter.isAvailable?.() === false)
        throw new CaxriError(
            'UNAVAILABLE',
            `${owner === 'desktop' ? 'Desktop' : 'Host'} is unavailable`,
        );
    return adapter;
}

function adapterAvailable(owner: CommandOwner, options: CommandDispatcherOptions): boolean {
    const adapter = owner === 'host' ? options.host : options.desktop;
    return Boolean(adapter && adapter.isAvailable?.() !== false);
}

/** Produces the authenticated, capability-filtered welcome shared by every transport adapter. */
export function createProtocolWelcome(
    options: CommandDispatcherOptions,
    rawHello: unknown,
    rawContext: CommandExecutionContext,
): ProtocolWelcome {
    const hello = protocolHelloSchema.parse(rawHello);
    const context = contextSchema.parse(rawContext) as CommandExecutionContext;
    const commands = (Object.keys(methods) as Array<keyof typeof methods>).filter((method) => {
        const spec = methods[method];
        return (
            adapterAvailable(spec.owner, options) &&
            hasRequiredCapabilities(context, spec.requiredCapabilities)
        );
    });
    return protocolWelcomeSchema.parse({
        protocolVersion: negotiateProtocolVersion(hello.supportedVersions),
        principal: context.principal,
        capabilities: context.capabilities,
        commands,
    });
}

async function requestFingerprint(method: string, params: unknown): Promise<string> {
    const source = new TextEncoder().encode(JSON.stringify([method, params]));
    const digest = await crypto.subtle.digest('SHA-256', source);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Echoes a valid request ID even when another envelope field fails validation. */
export function requestIdFromEnvelope(envelope: unknown): string | null {
    const parsed = z.object({ id: requestEnvelopeSchema.shape.id }).safeParse(envelope);
    return parsed.success ? parsed.data.id : null;
}

function reply(id: string, result: unknown): CommandReplyEnvelope {
    return commandReplyEnvelopeSchema.parse({
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id,
        ok: true,
        result,
    });
}

function errorReply(id: string | null, error: unknown): CommandReplyEnvelope {
    return commandReplyEnvelopeSchema.parse({
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        id,
        ok: false,
        error: toWireError(error),
    });
}

/**
 * Executes the canonical command registry for Electron, in-memory tests, UDS, or future adapters.
 * Authentication remains transport-owned; this boundary validates the resulting principal and
 * capabilities before routing to exactly one application handler.
 */
export function createCommandDispatcher(options: CommandDispatcherOptions): CommandDispatcher {
    const maximumReceipts = options.maximumReceipts ?? 1_024;
    if (!Number.isInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 4_096)
        throw new CaxriError('VALIDATION', 'Receipt capacity must be between 1 and 4096');
    const receipts = new Map<string, Receipt>();

    function admitReceipt(): void {
        if (receipts.size < maximumReceipts) return;
        const settled = [...receipts].find(([, value]) => value.settled);
        if (!settled)
            throw new CaxriError('CAPACITY', 'Too many idempotent commands are in flight');
        receipts.delete(settled[0]);
    }

    async function execute(
        id: string,
        request: CaxriRequest,
        context: CommandExecutionContext,
    ): Promise<CommandReplyEnvelope> {
        const spec: MethodSpec = methods[request.method];
        if (!hasRequiredCapabilities(context, spec.requiredCapabilities))
            throw new CaxriError('FORBIDDEN', `Missing capability for ${request.method}`);
        const adapter = adapterFor(spec.owner, options);
        const result = await adapter.invoke(request, context, { requestId: id });
        const projected = spec.projectResult
            ? spec.projectResult(result, context.principal)
            : result;
        return reply(id, parseCaxriResult(request.method, projected));
    }

    return async (rawEnvelope, rawContext) => {
        const requestId = requestIdFromEnvelope(rawEnvelope);
        try {
            const envelope = requestEnvelopeSchema.parse(rawEnvelope);
            negotiateProtocolVersion([envelope.protocolVersion]);
            const context = contextSchema.parse(rawContext) as CommandExecutionContext;
            const request = {
                method: envelope.method,
                params: methods[envelope.method].params.parse(envelope.params),
            } as CaxriRequest;
            const spec = methods[request.method];
            if (spec.idempotency === 'none') return await execute(envelope.id, request, context);

            const key = principalReceiptKey(context, envelope.id);
            const fingerprint = await requestFingerprint(request.method, request.params);
            const existing = receipts.get(key);
            if (existing) {
                if (existing.method !== request.method || existing.fingerprint !== fingerprint)
                    throw new CaxriError(
                        'VALIDATION',
                        'A request ID cannot be reused for different command input',
                    );
                return await existing.reply;
            }

            admitReceipt();
            const receipt: Receipt = {
                fingerprint,
                method: request.method,
                settled: false,
                reply: execute(envelope.id, request, context)
                    .catch((error: unknown) => errorReply(envelope.id, error))
                    .finally(() => {
                        const current = receipts.get(key);
                        if (current) current.settled = true;
                    }),
            };
            receipts.set(key, receipt);
            return await receipt.reply;
        } catch (error) {
            return errorReply(requestId, error);
        }
    };
}
