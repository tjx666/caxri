import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import { startHostApplication } from './index';

const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');

const version = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
const commit = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
process.env.CAXRI_APP_VERSION = version;
process.env.CAXRI_GIT_COMMIT = commit;
const logger = new StructuredLogger(join(userDataPath, 'logs'), 'host', 'info');
const processErrorMonitor = installProcessErrorMonitor({ processName: 'host' });
processErrorMonitor.attach(logger);

const application = await startHostApplication({
    agentHooksPath: process.env.CAXRI_AGENT_HOOKS_PATH,
    commit,
    executable: process.execPath,
    runtimePath: join(dirname(fileURLToPath(import.meta.url)), 'runtime.js'),
    userDataPath,
    version,
});

let signalReceived = false;
const stopForSignal = (signal: NodeJS.Signals): void => {
    if (signalReceived) return;
    signalReceived = true;
    void application.stop(signal).finally(() => process.exit(0));
};
process.once('SIGINT', stopForSignal);
process.once('SIGTERM', stopForSignal);
