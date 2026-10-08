import process from 'node:process';

/**
 * Environment key carrying the Acceptance-only Extension Host fault sequence. It lives here because the Acceptance
 * launcher, Desktop Main, and Server Core's Extension Host supervisor must agree on one spelling; a second copy would
 * silently drop the sequence and turn a planned Acceptance case into an unexplained pass.
 */
export const EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY = 'CAXRI_E2E_EXTENSION_HOST_FAULTS';

/**
 * The closed set of Extension Host protocol rejections an Acceptance case may reproduce. Each value is exactly one
 * logged rejection reason, so the injected failure and the diagnostic under test cannot drift apart.
 */
export const extensionHostProtocolFaults = [
    'parent-envelope',
    'child-envelope',
    'reply-result',
] as const;

export type ExtensionHostProtocolFault = (typeof extensionHostProtocolFaults)[number];

/**
 * The Acceptance cases allowed to reproduce Extension Host protocol rejections, and the only place that list lives. The
 * launcher imports it to decide whether to pass the fault sequence; an unlisted case runs an ordinary Host, so its
 * diagnostics check would pass without ever exercising a rejection.
 */
export const acceptanceExtensionHostFaultCaseIds: ReadonlySet<string> = new Set([
    'audit-extension-message-reasons',
]);

/**
 * The full sequence an admitted case reproduces: one rejection of each closed reason, in supervisor restart order.
 */
export const ACCEPTANCE_EXTENSION_HOST_FAULT_SEQUENCE = extensionHostProtocolFaults.join(',');

function isExtensionHostProtocolFault(value: string): value is ExtensionHostProtocolFault {
    return extensionHostProtocolFaults.includes(value as ExtensionHostProtocolFault);
}

/**
 * Resolves the ordered fault sequence the supervisor reproduces, one per successful Extension Host start.
 *
 * Fails closed in three ways: the sequence stays empty outside an E2E/Acceptance launch, any entry outside the closed
 * reason set discards the whole sequence rather than silently running a shorter one, and the value can only ever select
 * a reason: it never carries a payload, a path, or a command into the Host protocol.
 */
export function resolveExtensionHostProtocolFaults(
    environment: NodeJS.ProcessEnv = process.env,
): ExtensionHostProtocolFault[] {
    if (environment.CAXRI_E2E !== '1') return [];
    const requested = environment[EXTENSION_HOST_PROTOCOL_FAULT_ENVIRONMENT_KEY];
    if (requested === undefined || requested.trim() === '') return [];
    const faults: ExtensionHostProtocolFault[] = [];
    for (const entry of requested.split(',')) {
        const kind = entry.trim();
        if (!isExtensionHostProtocolFault(kind)) return [];
        faults.push(kind);
    }
    return faults;
}
