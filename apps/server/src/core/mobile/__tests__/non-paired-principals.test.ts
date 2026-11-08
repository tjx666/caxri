import type { CaxriMethod, CommandExecutionContext, Principal } from '@caxri/protocol';
import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isMobileControlRequest } from '../access-controller-contract';
import { openSessionController } from './session-requests.fixture';

/**
 * Owner-facing `mobile.*` methods that the controller itself does not refuse for a non-paired principal: each declares
 * the `desktop` capability, which Server Core's capability gate withholds from every principal except Desktop before
 * the request reaches `invokeControl`. The list is explicit so a new method is phone-facing (and must refuse a
 * non-paired principal) unless someone deliberately adds it here and gives it the `desktop` capability.
 *
 * - `mobile.access.*`: turn remote access on or off and read its status.
 * - `mobile.pairing.create`: mint a pairing link (checked against the owner's visible Projects, not a device grant).
 * - `mobile.device.list`: list paired devices.
 * - `mobile.device.revoke`: owner revoke; applied through the `mobile.device.revoke.apply` operation, not
 *   `invokeControl`.
 */
const ownerFacingMethods: readonly string[] = [
    'mobile.access.status',
    'mobile.access.enable',
    'mobile.access.disable',
    'mobile.pairing.create',
    'mobile.device.list',
    'mobile.device.revoke',
];

/**
 * `mobile.*` methods that are reachable by a non-paired principal on purpose, mapped to the capability that gates them.
 * Each is a CLI-facing command, not a phone call; the controller does not refuse them, so the declared capability is
 * the only gate and the test pins it.
 *
 * - `mobile.dashboard`: the Session home, which `invokeMobileDashboardRequest` documents as readable by Desktop's own
 *   principal too, scoped by that principal's own Project visibility (`mobile.session.show` still requires a device).
 * - `mobile.deviceAction.targets|openUrl|exec`: the CLI/Agent commands that push a link or Termux command to a phone; an
 *   Agent needs an explicit `devices.control` grant (`docs/mobile/device-actions.md`).
 */
const cliFacingMethods: Readonly<Record<string, string>> = {
    'mobile.dashboard': 'sessions.read',
    'mobile.deviceAction.targets': 'devices.control',
    'mobile.deviceAction.openUrl': 'devices.control',
    'mobile.deviceAction.exec': 'devices.control',
};

/**
 * Principals that can hold the capabilities phone-facing methods declare (`sessions.read`, `projects.write`,
 * `terminals.steer`, ...) without being a paired device.
 */
const nonPairedPrincipals: readonly Principal[] = [
    { kind: 'human-cli', id: 'human-cli-1' },
    {
        kind: 'agent',
        id: 'agent-1',
        endpointId: 'endpoint-1',
        generation: 1,
        projectIds: ['project-1'],
    },
    {
        kind: 'extension',
        id: 'extension-1',
        extensionId: 'extension.example',
        generation: 1,
        projectIds: ['project-1'],
    },
];

const mobileMethods = (Object.keys(methods) as CaxriMethod[]).filter((method) =>
    method.startsWith('mobile.'),
);

describe('MobileAccessController with non-paired principals', () => {
    it('keeps the owner-facing exception list exactly the methods that require the desktop capability', () => {
        const desktopOnly = mobileMethods.filter((method) =>
            (methods[method].requiredCapabilities as readonly string[]).includes('desktop'),
        );
        expect(desktopOnly.toSorted((a, b) => a.localeCompare(b))).toEqual(
            ownerFacingMethods.toSorted((a, b) => a.localeCompare(b)),
        );
    });

    it('gates each CLI-facing exception by its declared capability', () => {
        for (const [method, capability] of Object.entries(cliFacingMethods))
            expect(methods[method as CaxriMethod].requiredCapabilities).toEqual([capability]);
    });

    it('refuses every phone-facing mobile.* method for a human CLI, Agent, or extension principal', async () => {
        const { controller, domainService } = await openSessionController();
        try {
            const leaked: string[] = [];
            for (const method of mobileMethods) {
                if (ownerFacingMethods.includes(method) || method in cliFacingMethods) continue;
                for (const principal of nonPairedPrincipals) {
                    // Minimal params: a FORBIDDEN must arise before any parameter is read.
                    const request = { method, params: {} } as unknown as Parameters<
                        typeof controller.invokeControl
                    >[0];
                    expect(isMobileControlRequest(request)).toBe(true);
                    const context: CommandExecutionContext = { capabilities: [], principal };
                    let outcome = 'resolved';
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential keeps a failure attributable to one method
                        await controller.invokeControl(request, context, domainService);
                    } catch (error: unknown) {
                        outcome = (error as { code?: string }).code ?? String(error);
                    }
                    if (outcome !== 'FORBIDDEN')
                        leaked.push(`${principal.kind}:${method}:${outcome}`);
                }
            }
            expect(leaked).toEqual([]);
        } finally {
            await controller.close();
        }
    });
});
