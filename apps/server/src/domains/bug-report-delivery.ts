import type { AgentChatImageInput } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, isChatTerminal } from '@caxri/protocol';

import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import { assertPtyTerminal } from './pty-guard';
import type { TerminalManager } from './terminal';

interface BugReportDeliveryHandlerOptions {
    agentChat: Pick<AgentChatService, 'send'>;
    database: CaxriDatabase;
    terminals: Pick<TerminalManager, 'agentProcessId' | 'write'>;
}

/**
 * Delivers a bug report to the Agent that was running when the report was captured. A PTY Agent receives it through the
 * same bracketed-paste path the human Terminal input takes, so Markdown newlines in the report survive as one paste
 * instead of one line per `\r`; an Agent Chat receives it as one message, starting the Chat if it is idle.
 */
export function createBugReportDeliveryHandler({
    agentChat,
    database,
    terminals,
}: BugReportDeliveryHandlerOptions): Pick<DomainHandlers, 'bugReport.deliver'> {
    const sendToChat = async (
        terminalId: string,
        text: string,
        images: AgentChatImageInput[] | undefined,
    ): Promise<null> => {
        await agentChat.send(terminalId, { text, images });
        return null;
    };
    return {
        'bugReport.deliver': ({ images, pasteImage, report, sessionId, terminalId }) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
            if (terminal.sessionId !== sessionId)
                throw new CaxriError(
                    'CONFLICT',
                    'The selected Agent no longer belongs to this Session',
                );
            if (!terminal.provider)
                throw new CaxriError(
                    'CONFLICT',
                    'Bug reports can only be sent to an Agent Terminal',
                );
            if (isChatTerminal(terminal)) {
                if (
                    images?.length &&
                    !agentProviderCatalog[terminal.provider].capabilities.chatImages
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'The selected Agent does not support screenshot delivery',
                    );
                // Only the Chat path is asynchronous; the PTY path keeps throwing synchronously before any write.
                return sendToChat(terminalId, report, images);
            }
            assertPtyTerminal(terminal);
            if (images?.length)
                throw new CaxriError('VALIDATION', 'Image attachments require an Agent Chat');
            if (
                terminal.lastProcessState !== 'running' ||
                terminal.lastAgentProcessState !== 'running' ||
                terminals.agentProcessId(terminalId) === undefined
            )
                throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            if (pasteImage) {
                const imageInput = agentProviderCatalog[terminal.provider].imageInput;
                if (!imageInput)
                    throw new CaxriError(
                        'CONFLICT',
                        'The selected Agent does not support screenshot delivery',
                    );
                if (!terminals.write(terminalId, imageInput.terminalInput))
                    throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            }
            /**
             * Bracketed paste keeps Markdown newlines inside one Agent prompt; the validated report cannot contain
             * control characters capable of terminating the paste sequence.
             */
            if (!terminals.write(terminalId, `\u{1B}[200~${report}\u{1B}[201~\r`))
                throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            return null;
        },
    };
}
