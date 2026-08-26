import type { HostMethod } from '@caxri/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { HostForwardedMethod, HostHandledMethod } from '../host-methods';
import { hostForwardedMethods } from '../host-methods';

describe('Host dispatch exhaustiveness', () => {
    it('splits every host-owned method into handled or explicitly forwarded', () => {
        type Unclassified = Exclude<HostMethod, HostHandledMethod | HostForwardedMethod>;
        expectTypeOf<Unclassified>().toEqualTypeOf<never>();
        expect(hostForwardedMethods).toContain('app.bootstrap');
        expect(hostForwardedMethods).not.toContain('host.status');
    });

    it('treats an omitted Host-handled method as a leftover that cannot be forwarded', () => {
        type IncompleteHandled = Exclude<HostHandledMethod, 'host.status'>;
        type Leftover = Exclude<HostMethod, IncompleteHandled | HostForwardedMethod>;
        expectTypeOf<Leftover>().toEqualTypeOf<'host.status'>();
    });
});
