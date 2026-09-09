import { isAbsolute, join } from 'node:path';

import type { AgentEnvironment } from '../../contract';

export function grokHome(environment: AgentEnvironment): string {
    const configured = environment.variables.GROK_HOME;
    return configured
        ? isAbsolute(configured)
            ? configured
            : join(environment.homeDirectory, configured)
        : join(environment.homeDirectory, '.grok');
}
