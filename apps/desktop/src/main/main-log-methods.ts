import { join } from 'node:path';

import type { MainRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { shell } from 'electron';

type LogRequest = Extract<MainRequest, { method: 'diagnostics.revealExport' | 'logs.reveal' }>;

/**
 * What Main remembers between log-related requests.
 */
export interface MainLogState {
    /**
     * Where the last diagnostics export landed, so "Reveal in Finder" never has to accept a path from the Renderer.
     */
    lastDiagnosticsExportPath?: string;
}

export function isLogRequest(request: MainRequest): request is LogRequest {
    return request.method === 'logs.reveal' || request.method === 'diagnostics.revealExport';
}

/**
 * Shows Caxri's own log folder or the last exported diagnostics bundle in Finder. Answered by Main from its own profile
 * and memory, so both work while Server Core is down, which is when a user most needs the logs.
 */
export async function handleLogRequest(
    request: LogRequest,
    userDataPath: string,
    state: MainLogState,
): Promise<null> {
    if (request.method === 'diagnostics.revealExport') {
        if (!state.lastDiagnosticsExportPath)
            throw new CaxriError('NOT_FOUND', 'No diagnostics bundle has been exported yet');
        shell.showItemInFolder(state.lastDiagnosticsExportPath);
        return null;
    }
    const failure = await shell.openPath(join(userDataPath, 'logs'));
    if (failure) throw new CaxriError('IO', failure);
    return null;
}
