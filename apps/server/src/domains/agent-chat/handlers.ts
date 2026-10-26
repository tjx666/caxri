import { CaxriError } from '@caxri/protocol';

import type { DomainHandlers } from '../domain-services';
import type { createSessionCreator } from '../session';
import { readChatImage } from './chat-images';
import type { AgentChatService } from './service';
import type { AgentChatServiceOptions } from './service-options';
import { readWaitingChats } from './waiting/chat-waiting';

/**
 * Core methods a Client uses to read and drive a Chat Terminal. `records` locates the provider's on-disk record, which
 * `agentChat.readImage` reads without the service or a provider process; `createSessionForProject` opens a fork.
 *
 * Every message, command, rewind, interrupt, and released queue a Client sends is human input: it takes a delegated
 * Chat over from its task, like typing into a PTY Agent. `AgentChatService.send` records that for a message itself; the
 * other handlers record it here. Answering an approval request is not human input.
 */
export function createAgentChatHandlers(
    agentChat: AgentChatService,
    records: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'> & {
        createSessionForProject: ReturnType<typeof createSessionCreator>;
    },
): Pick<
    DomainHandlers,
    | 'agentChat.askSideQuestion'
    | 'agentChat.configure'
    | 'agentChat.continuationTargets'
    | 'agentChat.continueInAgent'
    | 'agentChat.generateHandoff'
    | 'agentChat.fork'
    | 'agentChat.interrupt'
    | 'agentChat.pendingRequests'
    | 'agentChat.previewRestoreFiles'
    | 'agentChat.read'
    | 'agentChat.readContext'
    | 'agentChat.readHistory'
    | 'agentChat.readImage'
    | 'agentChat.readTask'
    | 'agentChat.editQueued'
    | 'agentChat.removeQueued'
    | 'agentChat.restoreQueued'
    | 'agentChat.respond'
    | 'agentChat.resumeQueue'
    | 'agentChat.rewind'
    | 'agentChat.restoreFiles'
    | 'agentChat.runCommand'
    | 'agentChat.send'
    | 'agentChat.sendQueuedNow'
    | 'agentChat.stopTask'
    | 'agentChat.takeQueued'
    | 'agentChat.usageLimitWait'
> {
    const usage = () => {
        const { usage: continuation } = agentChat.states;
        if (!continuation) throw new CaxriError('UNAVAILABLE', 'Agent continuation is unavailable');
        return continuation;
    };
    return {
        'agentChat.askSideQuestion': ({ terminalId, question, history }) =>
            agentChat.askSideQuestion(terminalId, question, history),
        'agentChat.continuationTargets': async ({ terminalId }) => ({
            targets: await usage().targets(terminalId),
        }),
        'agentChat.continueInAgent': ({ terminalId, provider, turnId }) => {
            agentChat.states.usageLimitWaits?.cancel(terminalId, 'continuedElsewhere');
            return usage().continueIn(terminalId, provider, turnId);
        },
        /**
         * "Continue now" is the user continuing the Chat, so it takes a delegated Chat over like a message; the wait
         * ends first, so that human input does not cancel it as a message would.
         */
        'agentChat.usageLimitWait': async ({ terminalId, turnId, action }) => {
            const waits = agentChat.states.usageLimitWaits;
            if (!waits)
                throw new CaxriError('UNAVAILABLE', 'Automatic continuation is unavailable');
            if (action === 'cancel') {
                waits.cancel(terminalId, 'cancelled', turnId);
                return null;
            }
            await waits.continueNow(terminalId, turnId, () =>
                agentChat.delegation.observeHumanInput(terminalId),
            );
            return null;
        },
        'agentChat.generateHandoff': ({ terminalId }) => {
            usage().generateHandoff(terminalId);
            return null;
        },
        'agentChat.read': ({ terminalId }) => agentChat.read(terminalId),
        'agentChat.pendingRequests': () => ({
            chats: readWaitingChats(
                Array.from(agentChat.states.terminalIds(), (terminalId) => {
                    const state = agentChat.states.get(terminalId)!;
                    return {
                        terminalId,
                        snapshot: state.projection.snapshot,
                        isOpen: state.session?.isOpen === true,
                    };
                }),
                (terminalId) => records.database.getTerminal(terminalId)?.sessionId,
            ),
        }),
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
        'agentChat.previewRestoreFiles': ({ terminalId, itemId }) =>
            agentChat.previewRestoreFiles(terminalId, itemId),
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
        'agentChat.readHistory': ({ terminalId, beforeItemId, taskId }) =>
            agentChat.readHistory(terminalId, beforeItemId, taskId),
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
        'agentChat.restoreQueued': ({ terminalId, id }) => {
            agentChat.restoreQueued(terminalId, id);
            return null;
        },
        'agentChat.editQueued': ({ terminalId, id, text }) => {
            agentChat.editQueued(terminalId, id, text);
            return null;
        },
        'agentChat.takeQueued': ({ terminalId, id }) => agentChat.takeQueued(terminalId, id),
        'agentChat.sendQueuedNow': async ({ terminalId, id }) => {
            agentChat.delegation.observeHumanInput(terminalId);
            await agentChat.sendQueuedNow(terminalId, id);
            return null;
        },
        /**
         * Releasing paused queued messages sends them, so it takes the Chat over like `sendQueuedNow`. Delivery runs on
         * the send chain, so recording it after the synchronous resume still precedes the messages.
         */
        'agentChat.resumeQueue': ({ terminalId }) => {
            if (agentChat.resumeQueue(terminalId))
                agentChat.delegation.observeHumanInput(terminalId);
            return null;
        },
    };
}
