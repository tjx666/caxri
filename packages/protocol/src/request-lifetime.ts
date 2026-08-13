const nonExpiringRuntimeMethods = new Set([
    'agent.dispatch.waitInternal',
    'agent.message.wait',
    'files.copy',
    'files.write',
]);

/**
 * Copy/save lack a durable completion journal, while Agent Inbox and dispatch waits carry their own
 * validated long-poll deadlines. Their transports must wait for the authoritative result instead
 * of racing a second generic timer.
 */
export function isNonExpiringRuntimeMethod(method: string): boolean {
    return nonExpiringRuntimeMethods.has(method);
}
