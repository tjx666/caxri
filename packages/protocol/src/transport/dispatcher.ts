import { z } from 'zod';

import type { CaxriRequest } from '../registry/methods.js';
import { commandRecoveryFor, methods } from '../registry/methods.js';
import type {
    DurableCommandReceiptStore,
    StoredProtocolCommandReceipt,
} from './command-receipts.js';
import { CaxriError, toWireError } from './errors.js';
import type { ProtocolFeature } from './identity.js';
import { protocolConnectionIdentitySchema } from './identity.js';
import type { CommandOwner, MethodSpec } from './method-spec.js';
import type { CommandExecutionContext } from './principal.js';
import { capabilitySchema, hasRequiredCapabilities, principalSchema } from './principal.js';
import type { CommandReplyEnvelope } from './transport.js';
import {
    commandReplyEnvelopeSchema,
    parseCaxriResult,
    requestEnvelopeSchema,
} from './transport.js';
import type { ProtocolWelcome } from './version.js';
import {
    CAXRI_PROTOCOL_VERSION,
    negotiateProtocolVersion,
    protocolHelloSchema,
    protocolWelcomeSchema,
} from './version.js';

export interface CommandInvocation {
    /**
     * Persists a successful result inside an adapter-owned structural transaction. Adapters must call this only after
     * their effect and content-free changefeed records are ready to commit.
     */
    persistDurableResult?(result: unknown): void;
    requestId: string;
}

export interface CommandAdapter {
    invoke(
        request: CaxriRequest,
        context: CommandExecutionContext,
        invocation: CommandInvocation,
    ): unknown;
    isAvailable?(): boolean;
}

export interface CommandDispatcherOptions {
    desktop?: CommandAdapter;
    durableReceipts?: DurableCommandReceiptStore;
    features?: readonly ProtocolFeature[];
    server: CommandAdapter;
    maximumReceipts?: number;
    observeDurableReceipt?(observation: DurableReceiptObservation): void;
}

export interface DurableReceiptObservation {
    durationMs: number;
    method: keyof typeof methods;
    outcome: 'hit' | 'miss' | 'stored' | 'failed';
    phase: 'lookup' | 'store';
}

interface CommandDispatchAdmission {
    reply: Promise<CommandReplyEnvelope>;
}

export interface CommandDispatcher {
    (envelope: unknown, context: CommandExecutionContext): Promise<CommandReplyEnvelope>;
    /**
     * Resolves once validation, idempotency admission, and adapter invocation have happened, while the authoritative
     * reply remains independently awaitable.
     */
    admit(envelope: unknown, context: CommandExecutionContext): Promise<CommandDispatchAdmission>;
}

interface Receipt {
    fingerprint: string;
    method: string;
    settled: boolean;
    reply: Promise<CommandReplyEnvelope>;
}

const contextSchema = z.object({
    principal: principalSchema,
    capabilities: z.array(capabilitySchema).max(64),
    connection: protocolConnectionIdentitySchema.optional(),
});

function receiptKey(
    context: CommandExecutionContext,
    requestId: string,
    isDurable: boolean,
): string {
    if (isDurable)
        return `durable:${context.connection!.stateEpoch}:${context.connection!.clientId}:${requestId}`;
    const { principal } = context;
    let generation = '';
    switch (principal.kind) {
        case 'agent':
        case 'delegation-client':
        case 'desktop':
        case 'paired-device':
            generation = `:${principal.generation}`;
            break;
        default:
            break;
    }
    return `${principal.kind}:${principal.id}${generation}:${requestId}`;
}

function adapterFor(owner: CommandOwner, options: CommandDispatcherOptions): CommandAdapter {
    const adapter = owner === 'server' ? options.server : options.desktop;
    if (!adapter || adapter.isAvailable?.() === false)
        throw new CaxriError(
            'UNAVAILABLE',
            `${owner === 'desktop' ? 'Desktop' : 'Host'} is unavailable`,
        );
    return adapter;
}

function isAdapterAvailable(owner: CommandOwner, options: CommandDispatcherOptions): boolean {
    const adapter = owner === 'server' ? options.server : options.desktop;
    return Boolean(adapter && adapter.isAvailable?.() !== false);
}

function successfulReply(
    id: string,
    request: CaxriRequest,
    context: CommandExecutionContext,
    result: unknown,
): CommandReplyEnvelope {
    const spec: MethodSpec = methods[request.method];
    const projected = spec.projectResult ? spec.projectResult(result, context.principal) : result;
    return reply(id, parseCaxriResult(request.method, projected));
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    if (typeof value !== 'object' || value === null || !('then' in value)) return false;
    return typeof value.then === 'function';
}

/**
 * Produces the authenticated, capability-filtered welcome shared by every transport adapter.
 */
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
            isAdapterAvailable(spec.owner, options) &&
            hasRequiredCapabilities(context, spec.requiredCapabilities)
        );
    });
    const supportedFeatures = new Set(options.features);
    return protocolWelcomeSchema.parse({
        protocolVersion: negotiateProtocolVersion(hello.supportedVersions),
        principal: context.principal,
        capabilities: context.capabilities,
        commands,
        features: hello.features.filter((feature) => supportedFeatures.has(feature)),
        ...(context.connection && { connection: context.connection }),
    });
}

async function requestFingerprint(method: string, parameters: unknown): Promise<string> {
    const source = new TextEncoder().encode(JSON.stringify([method, parameters]));
    const digest = await crypto.subtle.digest('SHA-256', source);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Echoes a valid request ID even when another envelope field fails validation.
 */
export function requestIdFromEnvelope(envelope: unknown): string | null {
    const parsed = z.object({ id: requestEnvelopeSchema.shape.id }).safeParse(envelope);
    return parsed.success ? parsed.data.id : null;
}

/**
 * Best-effort method name for diagnostics, tolerant of envelopes that otherwise fail validation (unknown method,
 * malformed parameters, etc). Deliberately looser than {@link requestEnvelopeSchema}'s `method` shape, which rejects
 * anything that is not a recognized Caxri method: a log line about an unrecognized method still needs the method name
 * to be useful.
 */
export function methodFromEnvelope(envelope: unknown): string | null {
    const parsed = z.object({ method: z.string() }).safeParse(envelope);
    return parsed.success ? parsed.data.method : null;
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
 * Executes the canonical command registry for Electron, in-memory tests, WebSocket, or future adapters. Authentication
 * remains transport-owned; this boundary validates the resulting principal and capabilities before routing to exactly
 * one application handler.
 */
export function createCommandDispatcher(options: CommandDispatcherOptions): CommandDispatcher {
    const maximumReceipts = options.maximumReceipts ?? 1_024;
    if (!Number.isSafeInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 4_096)
        throw new CaxriError('VALIDATION', 'Receipt capacity must be between 1 and 4096');
    const receipts = new Map<string, Receipt>();
    const observeDurableReceipt = (observation: DurableReceiptObservation): void => {
        try {
            options.observeDurableReceipt?.(observation);
        } catch {
            // Observability is best-effort and must never change command admission or reply semantics.
        }
    };

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
        persistDurableResult?: (result: unknown) => void,
    ): Promise<CommandReplyEnvelope> {
        const spec: MethodSpec = methods[request.method];
        if (!hasRequiredCapabilities(context, spec.requiredCapabilities))
            throw new CaxriError('FORBIDDEN', `Missing capability for ${request.method}`);
        const adapter = adapterFor(spec.owner, options);
        const result = await adapter.invoke(request, context, {
            ...(persistDurableResult && { persistDurableResult }),
            requestId: id,
        });
        return successfulReply(id, request, context, result);
    }

    async function executeSafely(
        id: string,
        request: CaxriRequest,
        context: CommandExecutionContext,
        persistDurableResult?: (result: unknown) => void,
    ): Promise<CommandReplyEnvelope> {
        try {
            return await execute(id, request, context, persistDurableResult);
        } catch (error) {
            return errorReply(id, error);
        }
    }

    const admit: CommandDispatcher['admit'] = async (rawEnvelope, rawContext) => {
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
            if (spec.idempotency === 'none') {
                return { reply: executeSafely(envelope.id, request, context) };
            }

            const isDurable = Boolean(
                commandRecoveryFor(request.method) === 'durable' &&
                options.durableReceipts &&
                context.connection,
            );
            const key = receiptKey(context, envelope.id, isDurable);
            const fingerprint = await requestFingerprint(request.method, request.params);
            const existing = receipts.get(key);
            if (existing) {
                if (existing.method !== request.method || existing.fingerprint !== fingerprint)
                    throw new CaxriError(
                        'VALIDATION',
                        'A request ID cannot be reused for different command input',
                    );
                return { reply: existing.reply };
            }

            admitReceipt();
            const settleReply = async (): Promise<CommandReplyEnvelope> => {
                try {
                    if (isDurable) {
                        const connection = context.connection!;
                        const lookupStartedAt = performance.now();
                        let stored: StoredProtocolCommandReceipt | undefined;
                        try {
                            stored = await options.durableReceipts!.getReceipt(
                                connection.stateEpoch,
                                connection.clientId,
                                envelope.id,
                            );
                            observeDurableReceipt({
                                durationMs: performance.now() - lookupStartedAt,
                                method: request.method,
                                outcome: stored ? 'hit' : 'miss',
                                phase: 'lookup',
                            });
                        } catch (error) {
                            observeDurableReceipt({
                                durationMs: performance.now() - lookupStartedAt,
                                method: request.method,
                                outcome: 'failed',
                                phase: 'lookup',
                            });
                            throw error;
                        }
                        if (stored) {
                            if (
                                stored.method !== request.method ||
                                stored.requestFingerprint !== fingerprint
                            )
                                throw new CaxriError(
                                    'VALIDATION',
                                    'A request ID cannot be reused for different command input',
                                );
                            const storedReply = commandReplyEnvelopeSchema.parse(stored.reply);
                            if (storedReply.id !== envelope.id)
                                throw new CaxriError(
                                    'INTERNAL',
                                    'Durable command receipt identity does not match',
                                );
                            return storedReply;
                        }
                    }
                    const durablePersistence: {
                        reply?: CommandReplyEnvelope;
                        storedDuringExecution: boolean;
                    } = { storedDuringExecution: false };
                    const persistDurableResult = isDurable
                        ? (result: unknown): void => {
                              const connection = context.connection!;
                              const commandReply = successfulReply(
                                  envelope.id,
                                  request,
                                  context,
                                  result,
                              );
                              const storeStartedAt = performance.now();
                              try {
                                  const stored = options.durableReceipts!.saveReceipt({
                                      stateEpoch: connection.stateEpoch,
                                      clientId: connection.clientId,
                                      requestId: envelope.id,
                                      requestFingerprint: fingerprint,
                                      method: request.method,
                                      reply: commandReply,
                                      createdAt: Date.now(),
                                  });
                                  if (isPromiseLike(stored))
                                      throw new CaxriError(
                                          'INTERNAL',
                                          'Atomic command receipts require synchronous persistence',
                                      );
                                  durablePersistence.storedDuringExecution = true;
                                  durablePersistence.reply = commandReply;
                                  observeDurableReceipt({
                                      durationMs: performance.now() - storeStartedAt,
                                      method: request.method,
                                      outcome: 'stored',
                                      phase: 'store',
                                  });
                              } catch (error) {
                                  observeDurableReceipt({
                                      durationMs: performance.now() - storeStartedAt,
                                      method: request.method,
                                      outcome: 'failed',
                                      phase: 'store',
                                  });
                                  throw error;
                              }
                          }
                        : undefined;
                    const commandReply = await executeSafely(
                        envelope.id,
                        request,
                        context,
                        persistDurableResult,
                    );
                    if (isDurable && !durablePersistence.storedDuringExecution && commandReply.ok) {
                        const connection = context.connection!;
                        const storeStartedAt = performance.now();
                        try {
                            await options.durableReceipts!.saveReceipt({
                                stateEpoch: connection.stateEpoch,
                                clientId: connection.clientId,
                                requestId: envelope.id,
                                requestFingerprint: fingerprint,
                                method: request.method,
                                reply: commandReply,
                                createdAt: Date.now(),
                            });
                            observeDurableReceipt({
                                durationMs: performance.now() - storeStartedAt,
                                method: request.method,
                                outcome: 'stored',
                                phase: 'store',
                            });
                        } catch (error) {
                            observeDurableReceipt({
                                durationMs: performance.now() - storeStartedAt,
                                method: request.method,
                                outcome: 'failed',
                                phase: 'store',
                            });
                            throw error;
                        }
                    }
                    return durablePersistence.reply ?? commandReply;
                } catch (error) {
                    return errorReply(envelope.id, error);
                } finally {
                    const current = receipts.get(key);
                    if (current) current.settled = true;
                }
            };
            const receipt: Receipt = {
                fingerprint,
                method: request.method,
                settled: false,
                reply: settleReply(),
            };
            receipts.set(key, receipt);
            return { reply: receipt.reply };
        } catch (error) {
            return { reply: Promise.resolve(errorReply(requestId, error)) };
        }
    };
    const dispatch = async (
        rawEnvelope: unknown,
        rawContext: CommandExecutionContext,
    ): Promise<CommandReplyEnvelope> => {
        const admission = await admit(rawEnvelope, rawContext);
        return admission.reply;
    };
    dispatch.admit = admit;
    return dispatch;
}
