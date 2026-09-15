import type { AgentDelegationSettings, AgentLaunchSettings, AgentProvider } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentDispatchService } from '../agent-dispatch';
import type { CaxriDatabase } from '../db';
import type { DelegationTranscriptReader } from './collection';

/**
 * Everything the delegation service borrows from the rest of the Server. Terminal reads and writes stay optional so a
 * test or a headless caller can construct the service without a Terminal host.
 */
export interface AgentDelegationServiceOptions extends DelegationTranscriptReader {
    database: CaxriDatabase;
    dispatch: Pick<AgentDispatchService, 'start'> & Partial<Pick<AgentDispatchService, 'resume'>>;
    userDataPath: string;
    /**
     * Optional for the same reason the Terminal callbacks are: a unit test constructs this service without the Server
     * around it. The composed Server always passes one, so a real refused admission is always recorded.
     */
    logger?: StructuredLogger;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    delegationSettings?(): AgentDelegationSettings;
    verifyLaunch(launch: AgentLaunchSettings, provider: AgentProvider): Promise<void>;
    dimensions?(terminalId: string): { cols: number; rows: number } | undefined;
    inputEpoch?(terminalId: string): number;
    currentLaunchId?(terminalId: string): string | undefined;
    isIdle?(terminalId: string, launchId: string, turnId: string): boolean;
    /**
     * Writes to one exact Agent launch. The return value is the synchronous admission; for a Terminal with no Renderer
     * attachment that answer is provisional, and `onDelivered` reports what the Terminal Host actually did.
     */
    write?(
        terminalId: string,
        launchId: string,
        data: string,
        onDelivered?: (wasAccepted: boolean) => void,
    ): boolean;
    submissionTimeoutMs?: number;
    now?: () => number;
}
