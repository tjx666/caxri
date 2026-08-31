const nonExpiringServerOperations = new Set([
    'agent.dispatch.waitInternal',
    'agent.message.wait',
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

const nonExpiringViewOperations = new Set(['source.action', 'git.sync', 'git.discard']);

/**
 * Durable Files mutations, save/copy, and Runtime-authorized destructive Git apply lack a safe retry boundary, while
 * Agent Inbox and dispatch waits carry their own validated long-poll deadlines. Terminal input is bounded by both its
 * public payload and private Host request deadlines. Their transports must wait for the authoritative result instead of
 * racing a second generic timer.
 */
export function isNonExpiringServerOperation(method: string): boolean {
    return nonExpiringServerOperations.has(method);
}

/**
 * Provider actions may cross an authoritative mutation or native-confirmation boundary, so an outer Host timer must not
 * abandon them and invite a duplicate retry. The provider's cancellation and revision fences still apply.
 */
export function isNonExpiringViewOperation(operation: string): boolean {
    return nonExpiringViewOperations.has(operation);
}
