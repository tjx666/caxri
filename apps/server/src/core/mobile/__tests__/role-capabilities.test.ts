import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CaxriMethod, MobileDeviceRole } from '@caxri/protocol';
import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { mobileCapabilitiesByRole } from '../gateway/role-capabilities';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

describe('mobile role capabilities', () => {
    it('grant every capability a role-allowed gateway method requires', () => {
        const roles: MobileDeviceRole[] = ['view', 'reply', 'control'];
        const missing = roles.flatMap((role) =>
            (Object.keys(methods) as CaxriMethod[])
                .filter((method) => isMobileGatewayMethodAllowedForRole(role, method))
                .flatMap((method) =>
                    methods[method].requiredCapabilities
                        .filter(
                            (capability) =>
                                !(mobileCapabilitiesByRole[role] as readonly string[]).includes(
                                    capability,
                                ),
                        )
                        .map((capability) => `${role}:${method}:${capability}`),
                ),
        );
        expect(missing).toEqual([]);
    });

    it("never allow the owner-only Delegated Sessions reads, which carry other Sessions' results", () => {
        for (const role of ['view', 'reply', 'control'] as const)
            for (const method of [
                'agent.delegation.sessions',
                'agent.delegation.statuses',
                'agent.delegation.retryOptions',
                'agent.delegation.retry',
                'agent.delegation.cancelScheduledRetry',
                'agent.delegation.questionAnswer',
                'agent.delegation.questionDetail',
            ] as const)
                expect(isMobileGatewayMethodAllowedForRole(role, method)).toBe(false);
    });

    it('match the per-role grants table in docs/mobile/authorization.md', async () => {
        const document = await readFile(
            join(import.meta.dirname, '../../../../../../docs/mobile/authorization.md'),
            'utf8',
        );
        /**
         * The backticked method names in one role's table row, with `a.{b,c}` expanded to `a.b` and `a.c`.
         */
        const documented = (role: MobileDeviceRole): string[] => {
            const row = document.split('\n').find((line) => line.startsWith(`| \`${role}\``));
            return (row ?? '')
                .matchAll(/`([\w.]+)(?:\{([\w,]+)\})?`/gu)
                .toArray()
                .slice(1)
                .flatMap(([, prefix, members]) =>
                    members ? members.split(',').map((member) => `${prefix}${member}`) : [prefix],
                )
                .toSorted((left, right) => left.localeCompare(right));
        };
        const granted = (role: MobileDeviceRole) =>
            (Object.keys(methods) as CaxriMethod[]).filter((method) =>
                isMobileGatewayMethodAllowedForRole(role, method),
            );
        const added = (role: MobileDeviceRole, preceding?: MobileDeviceRole) =>
            granted(role)
                .filter((method) => !preceding || !granted(preceding).includes(method))
                .toSorted((left, right) => left.localeCompare(right));

        expect(documented('view')).toEqual(added('view'));
        expect(documented('reply')).toEqual(added('reply', 'view'));
        expect(documented('control')).toEqual(added('control', 'reply'));
    });
});
