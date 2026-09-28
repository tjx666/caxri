import type { TerminalSnapshot } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { TerminalHostRequestEnvelope } from './protocol';

export interface TerminalStopResult {
    snapshot: TerminalSnapshot | null;
    stopped: true;
}

interface InFlightStop {
    isPersistingSnapshot: boolean;
    result: Promise<TerminalStopResult>;
}

/**
 * The part of a Terminal Host identity that `terminal.stop` seals and tracks.
 */
export interface StoppableTerminalIdentity {
    agentLaunchId?: string;
    record: { id: string };
    running: boolean;
    /**
     * Set when `terminal.stop` is admitted and never cleared; see `TerminalHostAuthority.terminal`. While it is set and
     * `running` is still true, the stop is waiting to reach the PTY.
     */
    sealed?: true;
    /**
     * The admitted stop still in flight for this generation. A repeated stop with the same snapshot policy joins it, so
     * concurrent restart barriers share one final snapshot instead of the later one finding the PTY already gone.
     */
    stopping?: InFlightStop;
}

export interface GenerationStopContext {
    agentLauncher?: { cancel(terminalId: string, launchId: string): Promise<boolean> };
    colors: Map<string, unknown>;
    engine: {
        close(terminalId: string): void;
        restartBarrier(terminalId: string): Promise<TerminalSnapshot> | undefined;
    };
    identities: Map<string, StoppableTerminalIdentity>;
    logger: StructuredLogger;
}

async function settle(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
    } catch {
        // The requester of that promise receives and reports its failure.
    }
}

async function forgetWhenSettled(
    identity: StoppableTerminalIdentity,
    stopping: InFlightStop,
): Promise<void> {
    await settle(stopping.result);
    if (identity.stopping === stopping) delete identity.stopping;
}

/**
 * A stop must reach the PTY even when cancellation fails: ending the PTY ends the Agent child with it, while a sealed
 * generation that never stops would refuse every later reservation of its Terminal.
 */
async function cancelStoppingAgent(
    context: GenerationStopContext,
    envelope: TerminalHostRequestEnvelope,
    identity: StoppableTerminalIdentity,
): Promise<void> {
    if (!identity.agentLaunchId) return;
    try {
        await context.agentLauncher?.cancel(identity.record.id, identity.agentLaunchId);
    } catch (error) {
        context.logger.write('warn', logEventCatalog.terminalHost.error, {
            correlationId: envelope.id,
            context: envelope.observation,
            fields: {
                method: envelope.request.method,
                phase: 'agent-cancel',
                terminalId: identity.record.id,
                errorType: error instanceof Error ? error.name : typeof error,
            },
        });
    }
}

/**
 * Engine and map operations are keyed by Terminal ID, so act only while the ID still names this generation. The seal
 * refuses a reservation until `running` drops, which leaves natural exit, retirement, and Host shutdown as the only
 * ways the identity can leave the map during the wait; each of them already disposed of this PTY, and a generation
 * reserved after that must stay untouched.
 */
async function runSealedStop(
    context: GenerationStopContext,
    envelope: TerminalHostRequestEnvelope,
    identity: StoppableTerminalIdentity,
    isPersistingSnapshot: boolean,
    previous?: Promise<TerminalStopResult>,
): Promise<TerminalStopResult> {
    if (previous) await settle(previous);
    await cancelStoppingAgent(context, envelope, identity);
    const terminalId = identity.record.id;
    if (context.identities.get(terminalId) !== identity) {
        identity.running = false;
        return { snapshot: null, stopped: true };
    }
    const capture = isPersistingSnapshot ? context.engine.restartBarrier(terminalId) : undefined;
    if (!isPersistingSnapshot) {
        context.engine.close(terminalId);
        context.identities.delete(terminalId);
        context.colors.delete(terminalId);
    }
    identity.running = false;
    return { snapshot: capture ? await capture : null, stopped: true };
}

/**
 * Runs an admitted `terminal.stop`. It seals the generation synchronously, before the first await: Agent cancellation
 * can wait for the Agent's exit or its grace period, and the Host authorizes every request that arrives meanwhile
 * against this identity concurrently, so without the seal keystrokes, resizes, and signals would still reach the PTY
 * this stop is about to end. A stop with the other snapshot policy runs after the one in flight settles, then acts on
 * whatever that one left behind.
 */
export function stopTerminalGeneration(
    context: GenerationStopContext,
    envelope: TerminalHostRequestEnvelope,
    identity: StoppableTerminalIdentity,
    isPersistingSnapshot: boolean,
): Promise<TerminalStopResult> {
    identity.sealed = true;
    const inFlight = identity.stopping;
    if (inFlight?.isPersistingSnapshot === isPersistingSnapshot) return inFlight.result;
    const stopping: InFlightStop = {
        isPersistingSnapshot,
        result: runSealedStop(context, envelope, identity, isPersistingSnapshot, inFlight?.result),
    };
    identity.stopping = stopping;
    // eslint-disable-next-line no-void -- The requester awaits `stopping.result`; this only forgets it once settled.
    void forgetWhenSettled(identity, stopping);
    return stopping.result;
}
