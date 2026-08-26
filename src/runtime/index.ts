import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { RuntimeEvent } from '@caxri/protocol';
import { runtimeCancelRequestSchema } from '@caxri/protocol';

import { startEventLoopMonitor } from '../shared/node/event-loop-monitor';
import { logEventCatalog, StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
/**
 * Runtime domains expose public root barrels by architecture contract; deep imports are rejected by
 * `src/runtime/__tests__/structure.test.ts`.
 */
// oxlint-disable-next-line react-doctor/no-barrel-import
import {
    RuntimeAgentEndpointControlClient,
    RuntimeAgentEndpointLifecycle,
} from './agent-endpoints';
import { createRuntime } from './bootstrap';
import type { RuntimeRequestEnvelope } from './dispatch';
import { createDispatcher } from './dispatch';
import { createRuntimeParentPort } from './port';
import { resolveE2ETerminalOutputFlushDelay } from './terminal';

const bootStartedAt = performance.now();
/**
 * Memoizes the bootstrap Logger behind a closure instead of a top-level `let` so the module scope never gets mutated
 * from inside a function; `getRuntimeLogger` exposes the memoized instance once created.
 */
function createLoggerFactory(): {
    createBootstrapLogger: () => StructuredLogger | undefined;
    getRuntimeLogger: () => StructuredLogger | undefined;
} {
    let runtimeLogger: StructuredLogger | undefined;
    return {
        createBootstrapLogger: () => {
            const bootstrapUserDataPath = process.env.CAXRI_USER_DATA_PATH;
            const bootstrapLogDirectory =
                process.env.CAXRI_LOG_DIRECTORY ??
                (bootstrapUserDataPath && join(bootstrapUserDataPath, 'logs'));
            if (!bootstrapLogDirectory) return;
            return (runtimeLogger ??= new StructuredLogger(
                bootstrapLogDirectory,
                'runtime',
                process.env.CAXRI_LOG_LEVEL === 'info' ? 'info' : 'debug',
            ));
        },
        getRuntimeLogger: () => runtimeLogger,
    };
}
const { createBootstrapLogger, getRuntimeLogger } = createLoggerFactory();
const processErrorMonitor = installProcessErrorMonitor({
    bootstrapWriter: createBootstrapLogger,
    processName: 'runtime',
});
const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');
const parentPort = createRuntimeParentPort(process);
const agentEndpointControl = new RuntimeAgentEndpointControlClient(parentPort);
const agentEndpoints = new RuntimeAgentEndpointLifecycle(agentEndpointControl, userDataPath);
const outputFlushDelayMs = resolveE2ETerminalOutputFlushDelay(process.env);

await mkdir(userDataPath, { recursive: true });
const logger = getRuntimeLogger() ?? createBootstrapLogger();
if (!logger) throw new Error('CAXRI_LOG_DIRECTORY is required');
processErrorMonitor.attach(logger);
startEventLoopMonitor(logger);
const runtime = await createRuntime({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    userDataPath,
    logger,
    agentEndpoints,
    send: (event: RuntimeEvent) => parentPort.send(event),
    ...(outputFlushDelayMs !== undefined && { terminal: { outputFlushMs: outputFlushDelayMs } }),
});
const dispatch = createDispatcher(runtime.handlers, logger, (context) =>
    runtime.validateRequestContext(context),
);

/**
 * A Host crash closes Node IPC; the Runtime must not survive as an orphan SQLite/PTY owner. This is a dedicated utility
 * process, so exiting here is the intended clean-shutdown/orphan-recovery path, not the CLI misuse
 * `unicorn/no-process-exit` normally guards against.
 */
const closeOrphanedRuntime = (): void => {
    // `parentPort.onDisconnect` takes a synchronous callback, so this cannot become `await`; the
    // `.catch()` only prevents an unhandled rejection, `finally` still exits either way.
    runtime
        .close()
        // eslint-disable-next-line unicorn/prefer-await -- sync callback signature, see comment above
        .catch(() => {})
        // eslint-disable-next-line unicorn/prefer-await, unicorn/no-process-exit -- Runtime utility-process shutdown, see comment above
        .finally(() => process.exit(0));
};
parentPort.onDisconnect?.(closeOrphanedRuntime);
if (!parentPort.connected()) closeOrphanedRuntime();

parentPort.onMessage((message) => {
    if (agentEndpointControl.handleMessage(message)) return;
    const cancellation = runtimeCancelRequestSchema.safeParse(message);
    if (cancellation.success) {
        dispatch.cancel(cancellation.data.id);
        return;
    }
    // `parentPort.onMessage` takes a synchronous callback, so this cannot become `await`; `dispatch`
    // already converts every handler fault into a wire response and never rejects, so `.catch()`
    // only prevents an unhandled-rejection warning for a truly unexpected failure.
    (async () => {
        const envelope = message as RuntimeRequestEnvelope;
        parentPort.send(await dispatch(envelope));
        /**
         * Shutdown acknowledges before exiting so Main observes an ordered termination.
         */
        // eslint-disable-next-line unicorn/no-process-exit -- Runtime utility-process shutdown, see comment above
        if (envelope.method === 'runtime.shutdown') setTimeout(() => process.exit(0), 10);
        // eslint-disable-next-line unicorn/prefer-await -- sync callback signature, see comment above
    })().catch(() => {});
});

logger.write('info', logEventCatalog.runtime.ready, {
    durationMs: performance.now() - bootStartedAt,
    fields: { pid: process.pid },
});
parentPort.send({
    event: 'runtime.status',
    payload: { status: 'ready', restartCount: 0 },
} satisfies RuntimeEvent);
