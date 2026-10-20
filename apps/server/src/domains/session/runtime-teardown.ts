import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import type {
    TerminalManager,
    TerminalRestoreSupervisor,
    TerminalSuspensionService,
} from '../terminal';

/**
 * The per-Session runtime owners `createSessionRuntimeForgetter` retires when a Session is deleted or archived.
 */
interface SessionRuntimeTeardownParts {
    agentChat: Pick<AgentChatService, 'closeSession'>;
    agentRuntime: {
        automaticNaming: { forgetSession(sessionId: string): void };
        coordinator: Pick<AgentCoordinator, 'forgetSession'>;
        revokeAutoAllow(sessionId: string, reason: 'sessionDeleted'): unknown;
        sessionRenames: { forgetSession(sessionId: string): void };
    };
    terminalRestores: Pick<TerminalRestoreSupervisor, 'forget'>;
    terminals: Pick<TerminalManager, 'terminateSession'>;
    terminalSuspension: Pick<TerminalSuspensionService, 'forgetSession'>;
    transcripts: { forgetSession(sessionId: string): void };
}

/**
 * Builds the teardown that drops every in-memory runtime owner for one Session.
 */
export function createSessionRuntimeForgetter(
    parts: SessionRuntimeTeardownParts,
): (sessionId: string) => void {
    return (sessionId) => {
        // Retire naming before resetting its revision fence or removing the Session's database identity.
        parts.agentRuntime.automaticNaming.forgetSession(sessionId);
        parts.agentRuntime.sessionRenames.forgetSession(sessionId);
        parts.terminalRestores.forget(sessionId);
        parts.terminalSuspension.forgetSession(sessionId);
        parts.agentRuntime.coordinator.forgetSession(sessionId);
        parts.transcripts.forgetSession(sessionId);
        parts.terminals.terminateSession(sessionId);
        // eslint-disable-next-line no-void -- Session teardown is synchronous; provider exit completes on its own.
        void parts.agentChat.closeSession(sessionId);
        parts.agentRuntime.revokeAutoAllow(sessionId, 'sessionDeleted'); // Archive keeps it (caxri#1295).
    };
}
