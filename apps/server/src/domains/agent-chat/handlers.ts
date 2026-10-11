import type { DomainHandlers } from '../domain-services';
import type { createSessionCreator } from '../session';
import { readChatImage } from './chat-images';
import type { AgentChatService } from './service';
import type { AgentChatServiceOptions } from './service-options';

/**
 * Core methods a Client uses to read and drive a Chat Terminal. `records` locates the provider's on-disk record, which
 * `agentChat.readImage` reads without the service or a provider process; `createSessionForProject` opens a fork.
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
> {
    return {
        'agentChat.read': ({ terminalId }) => agentChat.read(terminalId),
        'agentChat.send': async ({ terminalId, text, images, delivery }) => {
            await agentChat.send(terminalId, { text, ...(images && { images }) }, delivery);
            return null;
        },
        'agentChat.rewind': async ({ terminalId, itemId, restoreFiles, text, images }) => {
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
                async ({ projectId, provider, cwd, agentSessionId }) => {
                    const created = await records.createSessionForProject(
                        projectId,
                        provider,
                        // The Client selects it once the fork's composer draft is in place.
                        'preserve',
                        undefined,
                        'chat',
                        { cwd, agentSessionId },
                    );
                    return { sessionId: created.session.id, terminalId: created.terminal!.id };
                },
            ),
        'agentChat.restoreFiles': async ({ terminalId, itemId }) => {
            await agentChat.restoreFiles(terminalId, itemId);
            return null;
        },
        'agentChat.runCommand': async ({ terminalId, name, arguments: arguments_ }) => {
            await agentChat.runCommand(terminalId, name, arguments_);
            return null;
        },
        'agentChat.configure': async ({
            terminalId,
            model,
            effort,
            ultracode,
            permissionMode,
            planMode,
        }) => {
            if (model !== undefined || effort !== undefined || ultracode !== undefined)
                await agentChat.configure(terminalId, {
                    ...(model !== undefined && { model }),
                    ...(effort !== undefined && { effort }),
                    ...(ultracode !== undefined && { ultracode }),
                });
            if (permissionMode !== undefined || planMode !== undefined)
                await agentChat.setPermission(terminalId, {
                    ...(permissionMode !== undefined && { permissionMode }),
                    ...(planMode !== undefined && { planMode }),
                });
            return null;
        },
        'agentChat.interrupt': async ({ terminalId }) => {
            await agentChat.interrupt(terminalId);
            return null;
        },
        'agentChat.respond': ({ terminalId, requestId, response }) => {
            agentChat.respond(terminalId, requestId, response);
            return null;
        },
        'agentChat.readImage': ({ terminalId, itemId, index }) =>
            readChatImage(records, terminalId, itemId, index),
        'agentChat.readTask': ({ terminalId, taskId }) => agentChat.readTask(terminalId, taskId),
        'agentChat.stopTask': async ({ terminalId, taskId }) => {
            await agentChat.stopTask(terminalId, taskId);
            return null;
        },
        'agentChat.removeQueued': ({ terminalId, id }) => {
            agentChat.removeQueued(terminalId, id);
            return null;
        },
        'agentChat.sendQueuedNow': async ({ terminalId, id }) => {
            await agentChat.sendQueuedNow(terminalId, id);
            return null;
        },
        'agentChat.resumeQueue': ({ terminalId }) => {
            agentChat.resumeQueue(terminalId);
            return null;
        },
    };
}
