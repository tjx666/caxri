import type { ServerMethod } from '@caxri/protocol';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { CoreForwardedMethod, CoreHandledMethod } from '../core-methods';

describe('Host dispatch exhaustiveness', () => {
    it('splits every server-owned method into exactly one of handled or forwarded', () => {
        type Unclassified = Exclude<ServerMethod, CoreHandledMethod | CoreForwardedMethod>;
        type Both = Extract<CoreHandledMethod, CoreForwardedMethod>;
        expectTypeOf<Unclassified>().toEqualTypeOf<never>();
        expectTypeOf<Both>().toEqualTypeOf<never>();
        expectTypeOf<'app.bootstrap'>().toExtend<CoreForwardedMethod>();
        expectTypeOf<'session.markRead'>().toExtend<CoreForwardedMethod>();
        expectTypeOf<'host.status'>().toExtend<CoreHandledMethod>();
        expectTypeOf<'mobile.access.status'>().toExtend<CoreHandledMethod>();
        expect(true).toBe(true);
    });

    it('treats an omitted Host-handled method as a leftover that cannot be forwarded', () => {
        type IncompleteHandled = Exclude<CoreHandledMethod, 'host.status'>;
        type Leftover = Exclude<ServerMethod, IncompleteHandled | CoreForwardedMethod>;
        expectTypeOf<Leftover>().toEqualTypeOf<'host.status'>();
    });
});
