import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeEvent } from '../shared/ipc/events';
import { StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import { createRuntime } from './bootstrap';
/** Runtime domains expose public root barrels by architecture contract; deep imports are rejected
 * by `src/runtime/__tests__/structure.test.ts`. */
// oxlint-disable-next-line react-doctor/no-barrel-import
import {
    RuntimeAgentEndpointControlClient,
    RuntimeAgentEndpointLifecycle,
} from './agent-endpoints';
import { createDispatcher, type RuntimeRequestEnvelope } from './dispatch';
import { createRuntimeParentPort } from './port';

const bootStartedAt = performance.now();
let runtimeLogger: StructuredLogger | undefined;
const createBootstrapLogger = (): StructuredLogger | undefined => {
    const bootstrapUserDataPath = process.env.CAXRI_USER_DATA_PATH;
    const bootstrapLogDirectory =
        process.env.CAXRI_LOG_DIRECTORY ??
        (bootstrapUserDataPath ? join(bootstrapUserDataPath, 'logs') : undefined);
    if (!bootstrapLogDirectory) return undefined;
    return (runtimeLogger ??= new StructuredLogger(
        bootstrapLogDirectory,
        'runtime',
        process.env.CAXRI_LOG_LEVEL === 'info' ? 'info' : 'debug',
    ));
};
const processErrorMonitor = installProcessErrorMonitor({
    bootstrapWriter: createBootstrapLogger,
    processName: 'runtime',
});
const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');
const parentPort = createRuntimeParentPort(process);
const agentEndpointControl = new RuntimeAgentEndpointControlClient(parentPort);
const agentEndpoints = new RuntimeAgentEndpointLifecycle(agentEndpointControl, userDataPath);

await mkdir(userDataPath, { recursive: true });
const logger = runtimeLogger ?? createBootstrapLogger();
if (!logger) throw new Error('CAXRI_LOG_DIRECTORY is required');
processErrorMonitor.attach(logger);
const runtime = await createRuntime({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    userDataPath,
    logger,
    agentEndpoints,
    send: (event: RuntimeEvent) => parentPort.send(event),
});
const dispatch = createDispatcher(runtime.handlers, logger);

/** A Host crash closes Node IPC; the Runtime must not survive as an orphan SQLite/PTY owner. */
const closeOrphanedRuntime = (): void => {
    void runtime.close().finally(() => process.exit(0));
};
parentPort.onDisconnect?.(closeOrphanedRuntime);
if (!parentPort.connected()) closeOrphanedRuntime();

parentPort.onMessage((message) => {
    if (agentEndpointControl.handleMessage(message)) return;
    void (async () => {
        const envelope = message as RuntimeRequestEnvelope;
        parentPort.send(await dispatch(envelope));
        /** Shutdown acknowledges before exiting so Main observes an ordered termination. */
        if (envelope.method === 'runtime.shutdown') setTimeout(() => process.exit(0), 10);
    })();
});

logger.write('info', 'runtime.ready', {
    durationMs: performance.now() - bootStartedAt,
    fields: { pid: process.pid },
});
parentPort.send({
    event: 'runtime.status',
    payload: { status: 'ready', restartCount: 0 },
} satisfies RuntimeEvent);
