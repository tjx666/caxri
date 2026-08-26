import { join } from 'node:path';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';

import type { TerminalExecutionPort } from '../../domains/terminal';
import { RemoteTerminalExecution } from './execution';
import { TerminalHostSupervisor } from './supervisor';

export interface CreateTerminalExecutionOptions {
    appVersion: string;
    buildId: string;
    commit: string;
    executable?: string;
    logger: StructuredLogger;
    override?: TerminalExecutionPort;
    serverId: string;
    terminalHostPath?: string;
    userDataPath: string;
}

/**
 * Composes the Core-owned supervisor and process-backed Terminal execution adapter.
 */
export function createTerminalExecution(
    options: CreateTerminalExecutionOptions,
): TerminalExecutionPort {
    if (options.override) return options.override;
    const supervisor = new TerminalHostSupervisor({
        appVersion: options.appVersion,
        buildId: options.buildId,
        commit: options.commit,
        executable: options.executable,
        logger: options.logger,
        serverId: options.serverId,
        terminalHostPath:
            options.terminalHostPath ?? join(process.cwd(), 'out/main/terminal-host.js'),
        userDataPath: options.userDataPath,
    });
    return new RemoteTerminalExecution(supervisor, options.logger);
}
