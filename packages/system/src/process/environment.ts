import process from 'node:process';

import { INHERITED_PROCESS_ENVIRONMENT_KEYS } from '@caxri/protocol';

/**
 * Retains explicit launch context without copying unrelated application credentials. The key list is shared with the
 * Server Core launcher in `@caxri/client`, so whatever this function promises a child it can only hand down if the
 * launcher forwarded it first.
 */
export function safeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_PROCESS_ENVIRONMENT_KEYS) {
        if (source[key] !== undefined) environment[key] = source[key];
    }
    return environment;
}
