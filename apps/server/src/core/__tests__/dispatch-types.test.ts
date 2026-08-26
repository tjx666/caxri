import type { HostMethod } from '@caxri/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CoreForwardedMethod, CoreHandledMethod } from '../core-methods';
import { coreForwardedMethods } from '../core-methods';

describe('Host dispatch exhaustiveness', () => {
    it('splits every host-owned method into handled or explicitly forwarded', () => {
        type Unclassified = Exclude<HostMethod, CoreHandledMethod | CoreForwardedMethod>;
        expectTypeOf<Unclassified>().toEqualTypeOf<never>();
        expect(coreForwardedMethods).toContain('app.bootstrap');
        expect(coreForwardedMethods).not.toContain('host.status');
    });

    it('treats an omitted Host-handled method as a leftover that cannot be forwarded', () => {
        type IncompleteHandled = Exclude<CoreHandledMethod, 'host.status'>;
        type Leftover = Exclude<HostMethod, IncompleteHandled | CoreForwardedMethod>;
        expectTypeOf<Leftover>().toEqualTypeOf<'host.status'>();
    });
});
