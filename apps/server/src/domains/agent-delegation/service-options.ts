import type {
    AgentDelegationSettings,
    AgentLaunchSettings,
    AgentProvider,
    AgentTranscript,
} from '@caxri/protocol';

import type { AgentDispatchService } from '../agent-dispatch';
import type { DelegationTranscriptBatch } from '../agents';
import type { CaxriDatabase } from '../db';

/**
 * Everything the delegation service borrows from the rest of the Server. Terminal reads and writes stay optional so a
 * test or a headless caller can construct the service without a Terminal host.
 */
export interface AgentDelegationServiceOptions {
    database: CaxriDatabase;
    dispatch: Pick<AgentDispatchService, 'start'> & Partial<Pick<AgentDispatchService, 'resume'>>;
    userDataPath: string;
    launchSettings(provider: AgentProvider): AgentLaunchSettings;
    delegationSettings?(): AgentDelegationSettings;
    verifyLaunch(launch: AgentLaunchSettings, provider: AgentProvider): Promise<void>;
    readTranscript(terminalId: string): Promise<AgentTranscript | null>;
    readNativeTranscript?(
        terminalId: string,
        sessionId: string,
        offset: number | undefined,
        turnId: string | undefined,
    ): Promise<DelegationTranscriptBatch>;
    dimensions?(terminalId: string): { cols: number; rows: number } | undefined;
    inputEpoch?(terminalId: string): number;
    currentLaunchId?(terminalId: string): string | undefined;
    isIdle?(terminalId: string, launchId: string, turnId: string): boolean;
    write?(terminalId: string, launchId: string, data: string): boolean;
    submissionTimeoutMs?: number;
    now?: () => number;
}
