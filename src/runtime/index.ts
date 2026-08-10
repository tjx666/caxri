import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeEvent } from '../shared/ipc/events';
import { StructuredLogger } from '../shared/node/logger';
import { createRuntime } from './bootstrap';
import { createDispatcher, type RuntimeRequestEnvelope } from './dispatch';

const bootStartedAt = performance.now();
const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');
const fileOperationsHelperPath = process.env.CAXRI_FILE_OPS_HELPER;
if (!fileOperationsHelperPath) throw new Error('CAXRI_FILE_OPS_HELPER is required');
const logDirectory = process.env.CAXRI_LOG_DIRECTORY ?? join(userDataPath, 'logs');
const parentPort = process.parentPort;
if (!parentPort) throw new Error('Caxri Runtime must run as an Electron utilityProcess');

await mkdir(userDataPath, { recursive: true });
const logger = new StructuredLogger(
    logDirectory,
    'runtime',
    process.env.CAXRI_LOG_LEVEL === 'info' ? 'info' : 'debug',
);
const runtime = await createRuntime({
    userDataPath,
    fileOperationsHelperPath,
    logger,
    send: (event: RuntimeEvent) => parentPort.postMessage(event),
});
const dispatch = createDispatcher(runtime.handlers, logger);

parentPort.on('message', (event) => {
    void (async () => {
        const envelope = event.data as RuntimeRequestEnvelope;
        parentPort.postMessage(await dispatch(envelope));
        /** Shutdown acknowledges before exiting so Main observes an ordered termination. */
        if (envelope.method === 'runtime.shutdown') setTimeout(() => process.exit(0), 10);
    })();
});

logger.write('info', 'runtime.ready', {
    durationMs: performance.now() - bootStartedAt,
    fields: { pid: process.pid },
});
parentPort.postMessage({
    event: 'runtime.status',
    payload: { status: 'ready', restartCount: 0 },
} satisfies RuntimeEvent);
