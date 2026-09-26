import type { CaxriMethod, MobileDeviceRole } from '@caxri/protocol';
import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../access-controller';
import { mobileCapabilitiesByRole } from '../gateway/role-capabilities';

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
});
