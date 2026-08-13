const nonExpiringRuntimeMethods = new Set(['agent.message.wait', 'files.copy', 'files.write']);

/**
 * Copy/save lack a durable completion journal, while Agent Inbox wait carries its own validated
 * long-poll deadline. Their transports must wait for the authoritative result instead of racing a
 * second generic timer.
 */
export function isNonExpiringRuntimeMethod(method: string): boolean {
    return nonExpiringRuntimeMethods.has(method);
}
