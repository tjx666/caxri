import { join, resolve } from 'node:path';

import type { AgentEnvironment } from '../../contract';

export function resolveCodexHome(environment: AgentEnvironment): string {
    // `||` is deliberate: an empty override is not a usable configuration root.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is invalid here
    return resolve(environment.variables.CODEX_HOME || join(environment.homeDirectory, '.codex'));
}

export function resolveCodexStateDirectories(environment: AgentEnvironment): string[] {
    const codexHome = resolveCodexHome(environment);
    const sqliteHome = environment.variables.CODEX_SQLITE_HOME;
    return [...(sqliteHome ? [resolve(sqliteHome)] : []), join(codexHome, 'sqlite'), codexHome];
}
