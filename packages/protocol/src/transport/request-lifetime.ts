const nonExpiringRuntimeMethods = new Set([
    'agent.dispatch.waitInternal',
    'agent.message.wait',
    'files.copy',
    'files.write',
    'git.discard.apply',
]);

const nonExpiringViewOperations = new Set([
    'files.create',
    'files.copy',
    'files.rename',
    'files.move',
    'files.operation.cancel',
    'files.operation.acknowledge',
    'files.trash',
    'git.sync',
    'git.discard',
]);

/**
 * Copy/save and the Runtime-authorized destructive Git apply lack a safe retry boundary, while Agent Inbox and dispatch
 * waits carry their own validated long-poll deadlines. Their transports must wait for the authoritative result instead
 * of racing a second generic timer.
 */
export function isNonExpiringRuntimeMethod(method: string): boolean {
    return nonExpiringRuntimeMethods.has(method);
}

/**
 * Mutating view calls own durable completion (file journals or Git's authoritative mutation path), so an outer Host
 * timer must not abandon them and invite a duplicate retry.
 */
export function isNonExpiringViewOperation(operation: string): boolean {
    return nonExpiringViewOperations.has(operation);
}
