import {
    extensionViewOperationMetadata,
    isExtensionViewOperationName,
} from '../registry/view-methods.js';

const nonExpiringServerOperations = new Set([
    'agent.dispatch.wait',
    'agent.dispatch.waitInternal',
    'agent.delegation.wait',
    'agent.delegation.waitInternal',
    'agent.message.wait',
    'agent.secret.wait',
    'agent.secret.waitInternal',
    'bot.clearData',
    'files.create',
    'files.copy',
    'files.rename',
    'files.move',
    'files.operation.cancel',
    'files.operation.acknowledge',
    'files.trash',
    'files.write',
    'git.discard.apply',
    'terminal.input',
]);

const nonExpiringViewOperations = new Set(['git.sync', 'git.discard', 'git.mergePullRequest']);

/**
 * Durable Files mutations, save/copy, and the destructive applies that follow a native confirmation (Git discard, and
 * Clear Caxri Bot Data, which may queue behind a Caxri Bot switch and then restart Caxri Bot) lack a safe retry
 * boundary, while Agent Inbox, dispatch, delegation, and secret-request waits carry their own validated long-poll
 * deadlines: a client timer on the same deadline starts first and would always turn the wait's timeout result into a
 * transport error. Terminal input is bounded by both its public payload and private Host request deadlines. Their
 * transports must wait for the authoritative result instead of racing a second generic timer.
 */
export function isNonExpiringServerOperation(method: string): boolean {
    return nonExpiringServerOperations.has(method);
}

/**
 * Provider actions may cross an authoritative mutation or native-confirmation boundary, so an outer Host timer must not
 * abandon them and invite a duplicate retry. The provider's cancellation and revision fences still apply.
 */
export function isNonExpiringViewOperation(operation: string): boolean {
    return (
        nonExpiringViewOperations.has(operation) ||
        (isExtensionViewOperationName(operation) &&
            extensionViewOperationMetadata[operation].lifetime === 'non-expiring')
    );
}
