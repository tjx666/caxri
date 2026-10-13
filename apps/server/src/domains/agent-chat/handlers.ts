import type { DomainHandlers } from '../domain-services';
import type { createSessionCreator } from '../session';
import { readChatImage } from './chat-images';
import type { AgentChatService } from './service';
import type { AgentChatServiceOptions } from './service-options';

/**
 * Core methods a Client uses to read and drive a Chat Terminal. `records` locates the provider's on-disk record, which
 * `agentChat.readImage` reads without the service or a provider process; `createSessionForProject` opens a fork.
 *
 * Every message, command, rewind, and interrupt a Client sends is human input: it takes a delegated Chat over from its
 * task, like typing into a PTY Agent. `AgentChatService.send` records that for a message itself; the other handlers
 * record it here. Answering an approval request is not human input.
 */
export function createAgentChatHandlers(
    agentChat: AgentChatService,
    records: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'> & {
        createSessionForProject: ReturnType<typeof createSessionCreator>;
    },
): Pick<
    DomainHandlers,
    | 'agentChat.configure'
    | 'agentChat.fork'
    | 'agentChat.interrupt'
    | 'agentChat.read'
    | 'agentChat.readContext'
    | 'agentChat.readHistory'
    | 'agentChat.readImage'
    | 'agentChat.readTask'
    | 'agentChat.removeQueued'
    | 'agentChat.respond'
    | 'agentChat.resumeQueue'
    | 'agentChat.rewind'
    | 'agentChat.restoreFiles'
    | 'agentChat.runCommand'
    | 'agentChat.send'
    | 'agentChat.sendQueuedNow'
    | 'agentChat.stopTask'
    | 'agentChat.takeQueued'
> {
    return {
        'agentChat.read': ({ terminalId }) => agentChat.read(terminalId),
        'agentChat.send': async ({ terminalId, text, images, delivery }) => {
            await agentChat.send(terminalId, { text, ...(images && { images }) }, delivery);
            return null;
        },
        'agentChat.rewind': async ({ terminalId, itemId, restoreFiles, text, images }) => {
            agentChat.delegation.observeHumanInput(terminalId);
            await agentChat.rewind(terminalId, {
                itemId,
                restoreFiles,
                message: { text, ...(images && { images }) },
            });
            return null;
        },
        'agentChat.fork': ({ terminalId, itemId }) =>
            agentChat.fork(
                terminalId,
                itemId,
                async ({ projectId, provider, cwd, agentSessionId, sourceTerminalId }) => {
                    const created = await records.createSessionForProject(
                        projectId,
                        provider,
                        // The Client selects it once the fork's composer draft is in place.
                        'preserve',
                        undefined,
                        'chat',
                        { cwd, agentSessionId, sourceTerminalId },
                    );
                    return { sessionId: created.session.id, terminalId: created.terminal!.id };
                },
            ),
        'agentChat.restoreFiles': async ({ terminalId, itemId }) => {
            await agentChat.restoreFiles(terminalId, itemId);
            return null;
        },
        'agentChat.runCommand': async ({ terminalId, name, arguments: arguments_ }) => {
            agentChat.delegation.observeHumanInput(terminalId);
            await agentChat.runCommand(terminalId, name, arguments_);
            return null;
        },
        'agentChat.configure': async ({
            terminalId,
            model,
            effort,
            ultracode,
            fast,
            permissionMode,
            planMode,
        }) => {
            if (
                model !== undefined ||
                effort !== undefined ||
                ultracode !== undefined ||
                fast !== undefined
            )
                await agentChat.configure(terminalId, {
                    ...(model !== undefined && { model }),
                    ...(effort !== undefined && { effort }),
                    ...(ultracode !== undefined && { ultracode }),
                    ...(fast !== undefined && { fast }),
                });
            if (permissionMode !== undefined || planMode !== undefined)
                await agentChat.setPermission(terminalId, {
                    ...(permissionMode !== undefined && { permissionMode }),
                    ...(planMode !== undefined && { planMode }),
                });
            return null;
        },
        'agentChat.interrupt': async ({ terminalId }) => {
            agentChat.delegation.observeHumanInput(terminalId);
            await agentChat.interrupt(terminalId);
            return null;
        },
        'agentChat.respond': ({ terminalId, requestId, response }) => {
            agentChat.respond(terminalId, requestId, response);
            return null;
        },
        'agentChat.readImage': ({ terminalId, itemId, index }) =>
            readChatImage(records, terminalId, itemId, index),
        'agentChat.readHistory': ({ terminalId, beforeItemId }) =>
            agentChat.readHistory(terminalId, beforeItemId),
        'agentChat.readTask': ({ terminalId, taskId }) => agentChat.readTask(terminalId, taskId),
        'agentChat.readContext': ({ terminalId }) => agentChat.readContext(terminalId),
        'agentChat.stopTask': async ({ terminalId, taskId }) => {
            await agentChat.stopTask(terminalId, taskId);
            return null;
        },
        'agentChat.removeQueued': ({ terminalId, id }) => {
            agentChat.removeQueued(terminalId, id);
            return null;
        },
        'agentChat.takeQueued': ({ terminalId, id }) => agentChat.takeQueued(terminalId, id),
        'agentChat.sendQueuedNow': async ({ terminalId, id }) => {
            agentChat.delegation.observeHumanInput(terminalId);
            await agentChat.sendQueuedNow(terminalId, id);
            return null;
        },
        'agentChat.resumeQueue': ({ terminalId }) => {
            agentChat.resumeQueue(terminalId);
            return null;
        },
    };
}
