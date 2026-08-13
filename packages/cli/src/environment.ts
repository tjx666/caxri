import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

export type CliAutomation = 'agent' | 'ci' | 'human';

function enabled(value: string | undefined): boolean {
    return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function detectAutomation(environment: NodeJS.ProcessEnv): CliAutomation {
    if (enabled(environment.CI) || enabled(environment.GITHUB_ACTIONS)) return 'ci';
    if (
        enabled(environment.CODEX_THREAD_ID) ||
        enabled(environment.CLAUDECODE) ||
        enabled(environment.CLAUDE_CODE_ENTRYPOINT)
    )
        return 'agent';
    return 'human';
}

export interface ResolvedProfile {
    path: string;
    source: 'argument' | 'environment' | 'default';
}

function defaultProfilePath(
    platform: NodeJS.Platform,
    home: string,
    environment: NodeJS.ProcessEnv,
): string {
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Caxri');
    if (platform === 'win32') return join(environment.APPDATA ?? home, 'Caxri');
    return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'Caxri');
}

export function resolveCliProfile(options: {
    environment: NodeJS.ProcessEnv;
    explicit?: string;
    home?: string;
    platform?: NodeJS.Platform;
}): ResolvedProfile {
    const environmentPath = options.environment.CAXRI_USER_DATA_DIR;
    const selected = options.explicit ?? environmentPath;
    if (selected !== undefined) {
        if (!isAbsolute(selected))
            throw new CaxriError('VALIDATION', 'The profile selector must be an absolute path');
        return { path: selected, source: options.explicit ? 'argument' : 'environment' };
    }
    return {
        path: defaultProfilePath(
            options.platform ?? process.platform,
            options.home ?? homedir(),
            options.environment,
        ),
        source: 'default',
    };
}
