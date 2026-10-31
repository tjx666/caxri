import { describe, expect, it } from 'vitest';

import { effectfulCommandRecovery } from '../../registry/method-types';
import {
    extensionViewOperationMetadata,
    extensionViewOperationNames,
} from '../../registry/view-methods';
import { isNonExpiringServerOperation, isNonExpiringViewOperation } from '../request-lifetime';

describe('isNonExpiringServerOperation', () => {
    it('allows the documented non-expiring methods', () => {
        for (const method of [
            'agent.dispatch.wait',
            'agent.dispatch.waitInternal',
            'agent.delegation.wait',
            'agent.delegation.waitInternal',
            'agent.message.wait',
        ])
            expect(isNonExpiringServerOperation(method)).toBe(true);
        for (const method of [
            'files.create',
            'files.copy',
            'files.rename',
            'files.move',
            'files.operation.cancel',
            'files.operation.acknowledge',
            'files.trash',
        ])
            expect(isNonExpiringServerOperation(method)).toBe(true);
        expect(isNonExpiringServerOperation('files.write')).toBe(true);
        expect(isNonExpiringServerOperation('git.discard.apply')).toBe(true);
        expect(isNonExpiringServerOperation('bot.clearData')).toBe(true);
        expect(isNonExpiringServerOperation('terminal.input')).toBe(true);
    });

    it('rejects representative expiring and unrelated methods', () => {
        expect(isNonExpiringServerOperation('agent.delegation.status')).toBe(false);
        expect(isNonExpiringServerOperation('agent.dispatch.start')).toBe(false);
        expect(isNonExpiringServerOperation('files.read')).toBe(false);
        expect(isNonExpiringServerOperation('terminal.send')).toBe(false);
        expect(isNonExpiringServerOperation('')).toBe(false);
    });
});

describe('isNonExpiringViewOperation', () => {
    it('derives view lifetimes from the shared operation policy', () => {
        for (const operation of extensionViewOperationNames)
            expect(isNonExpiringViewOperation(operation)).toBe(
                extensionViewOperationMetadata[operation].lifetime === 'non-expiring',
            );
        expect(isNonExpiringViewOperation('git.sync')).toBe(true);
        expect(isNonExpiringViewOperation('git.discard')).toBe(true);
        expect(isNonExpiringViewOperation('files.list')).toBe(false);
    });
});

/**
 * Durable effectful methods that are deliberately bounded by the generic request timeout: each completes in a bounded
 * local step (a database write, a queue insert, a spawn acknowledgement, or a native shell hand-off) and is safe to
 * retry or observe later. A new durable method must either join the non-expiring set or be added here with that
 * justification.
 */
const shortLivedDurableMethods = new Set<string>([
    'agent.control.interrupt',
    'agent.control.stop',
    'agent.delegation.create',
    'agent.delegation.stop',
    'agent.dispatch.resume',
    'agent.dispatch.start',
    'agent.grant',
    'agent.message.approve',
    'agent.message.deny',
    'agent.message.policy.set',
    'agent.message.reply',
    'agent.message.send',
    'agent.revoke',
    'agent.session.archive',
    'agent.session.rename',
    'agent.session.unarchive',
    'agentChat.bypassUsageGuard',
    'agentChat.continueInAgent',
    'agentChat.fork',
    'agentChat.openPathReference',
    'benchmark.cancel',
    'benchmark.delete',
    'benchmark.open',
    'benchmark.start',
    'bot.inbox.ack',
    'bot.inbox.add',
    'bot.inbox.dismiss',
    'bot.inbox.merge',
    'bot.inbox.reply',
    'bot.inbox.resolve',
    'bot.session.archive',
    'bot.session.create',
    'bot.session.handOver',
    'bot.session.takeBack',
    'bot.stop',
    'bot.task.create',
    'bot.task.update',
    'bugReport.send',
    'caxriBot.clearData',
    'caxriBot.open',
    'caxriBot.openSettings',
    'caxriBot.revealSession',
    'caxriBot.stop',
    'desktop.focus',
    'desktop.openFile',
    'desktop.openPath',
    'desktop.openProject',
    'editor.confirmDiscard',
    'external.open',
    'externalDocument.openWithDefaultApp',
    'externalDocument.reveal',
    'files.openWithDefaultApp',
    'files.reveal',
    'git.switchBranch',
    'mobile.agentChat.bypassUsageGuard',
    'mobile.agentChat.continueInAgent',
    'mobile.agentChat.dismissUsageNotice',
    'mobile.agentChat.fork',
    'mobile.botInbox.reply',
    'mobile.project.add',
    'mobile.pullRequest.merge',
    'mobile.session.archive',
    'mobile.session.create',
    'mobile.session.delete',
    'mobile.session.detach',
    'mobile.session.handOverToBot',
    'mobile.session.rename',
    'mobile.session.reopenConversation',
    'mobile.session.restartAgent',
    'mobile.session.restore',
    'mobile.session.resume',
    'mobile.session.setPinned',
    'mobile.session.takeBackFromBot',
    'mobile.terminal.switchSurface',
    'processExplorer.open',
    'project.add',
    'project.cancelCreate',
    'project.create',
    'project.hide',
    'project.openInEditor',
    'project.openRoot',
    'project.reorder',
    'project.setChatDefault',
    'project.setIcon',
    'requests.cancel',
    'session.archive',
    'session.authorizeWorkbenchRoot',
    'session.continueInWorktree',
    'session.create',
    'session.detach',
    'session.dismissWorkbenchCandidate',
    'session.enterAirplaneMode',
    'session.exitAirplaneMode',
    'session.importConversation',
    'session.markRead',
    'session.rename',
    'session.reopenConversation',
    'session.reorder',
    'session.reorderPinned',
    'session.resume',
    'session.select',
    'session.selectWorkbenchRoot',
    'session.setPinned',
    'session.unarchive',
    'session.unarchiveMany',
    'session.workbenchRoot.forgetEditorPath',
    'terminal.close',
    'terminal.create',
    'terminal.moveToNewSession',
    'terminal.restart',
    'terminal.send',
    'terminal.suspend',
    'terminal.switchSurface',
    'usage.dismissNotice',
    'viewContainers.cancelRequest',
    'viewContainers.executeCommand',
]);

describe('durable method request lifetime', () => {
    it('declares a lifetime for every durable effectful method', () => {
        const undeclared = Object.entries(effectfulCommandRecovery)
            .filter(([, recovery]) => recovery === 'durable')
            .map(([method]) => method)
            .filter(
                (method) =>
                    !isNonExpiringServerOperation(method) &&
                    !isNonExpiringViewOperation(method) &&
                    !shortLivedDurableMethods.has(method),
            );
        expect(undeclared).toEqual([]);
    });
});
