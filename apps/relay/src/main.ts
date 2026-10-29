import process from 'node:process';

import { relayConfigFromEnvironment } from './config';
import { RelayServer } from './server';

/**
 * Container and CLI entrypoint. The single `relay.listening` line is the readiness contract for tests and scripts that
 * start the Relay on an ephemeral port.
 */
const config = relayConfigFromEnvironment(process.env);
const relay = new RelayServer(config, { log: (line) => process.stdout.write(`${line}\n`) });
const port = await relay.listen();
process.stdout.write(`${JSON.stringify({ event: 'relay.listening', port })}\n`);

/**
 * The first SIGTERM or SIGINT closes every socket with `shutting-down`; the process then exits 0 on its own because the
 * listener was the only handle keeping it alive. A second signal of the other kind still has its default effect.
 */
await new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
});
await relay.close();
