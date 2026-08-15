import { describe, expect, expectTypeOf, it } from 'vitest';

import type { RuntimeHostControlRequest } from '../../../packages/protocol/src/agent/agent-endpoint-control';
import type { HostMethod } from '../../shared/ipc/methods';
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

describe('Agent Endpoint control exhaustiveness', () => {
    it('requires a new Endpoint operation to be added to the Host switch', () => {
        type Operation = RuntimeHostControlRequest['operation'];
        type Handled =
            | 'agent-endpoint.begin'
            | 'agent-endpoint.activate'
            | 'agent-endpoint.messaging'
            | 'agent-endpoint.retire';
        expectTypeOf<Handled>().toEqualTypeOf<Operation>();
        type Missing = Exclude<Operation, Exclude<Handled, 'agent-endpoint.retire'>>;
        expectTypeOf<Missing>().toEqualTypeOf<'agent-endpoint.retire'>();
    });
});
