import type { ServerMethod } from '@caxri/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CoreForwardedMethod, CoreHandledMethod } from '../core-methods';
import { coreForwardedMethods } from '../core-methods';

describe('Host dispatch exhaustiveness', () => {
    it('splits every server-owned method into handled or explicitly forwarded', () => {
        type Unclassified = Exclude<ServerMethod, CoreHandledMethod | CoreForwardedMethod>;
        expectTypeOf<Unclassified>().toEqualTypeOf<never>();
        expect(coreForwardedMethods).toContain('app.bootstrap');
        expect(coreForwardedMethods).not.toContain('host.status');
    });

    it('treats an omitted Host-handled method as a leftover that cannot be forwarded', () => {
        type IncompleteHandled = Exclude<CoreHandledMethod, 'host.status'>;
        type Leftover = Exclude<ServerMethod, IncompleteHandled | CoreForwardedMethod>;
        expectTypeOf<Leftover>().toEqualTypeOf<'host.status'>();
    });
});
