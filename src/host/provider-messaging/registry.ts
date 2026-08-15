import { randomUUID } from 'node:crypto';

import type { AgentEndpointRef as AgentEndpointReference } from '../../shared/ipc/agent-endpoint-contract';
import type { AgentInboundMessage } from '../../shared/ipc/agent-inbox-contract';
import { CaxriError } from '../../shared/ipc/errors';
import type {
    ProviderMessagingAdapter,
    ProviderMessagingRegistration,
} from '../../shared/ipc/provider-messaging-contract';
import {
    providerMessageAckSchema,
    providerMessageDeliverySchema,
    providerMessagingRegistrationSchema,
} from '../../shared/ipc/provider-messaging-contract';
import type { AgentEndpointRegistry } from '../agent-endpoints';

interface RegisteredAdapter {
    adapter: ProviderMessagingAdapter;
    registration: ProviderMessagingRegistration;
}

function endpointKey(reference: AgentEndpointReference): string {
    return `${reference.hostId}:${reference.endpointId}:${reference.generation}`;
}

/**
 * Host-memory registry for documented push adapters; no Provider private state crosses it.
 */
export class ProviderMessagingAdapterRegistry {
    private readonly adapters = new Map<string, RegisteredAdapter>();

    constructor(private readonly endpoints: AgentEndpointRegistry) {
        endpoints.onRetired(async (endpoint) => {
            await this.revoke(endpoint.ref);
        });
        endpoints.onMessagingChanged(async (endpoint) => {
            if (endpoint.messaging.deliveryMode !== 'push') await this.revoke(endpoint.ref);
        });
    }

    register(
        raw: ProviderMessagingRegistration,
        adapter: ProviderMessagingAdapter,
    ): ProviderMessagingRegistration {
        const registration = providerMessagingRegistrationSchema.parse(raw);
        const current = this.endpoints.resolve(registration.endpoint.ref);
        if (
            current.messaging.deliveryMode !== 'push' ||
            current.messaging.health !== 'ready' ||
            current.provider !== registration.endpoint.provider
        )
            throw new CaxriError('UNAVAILABLE', 'Provider push messaging is unavailable');
        const key = endpointKey(current.ref);
        // `register` is synchronous by contract; superseding a prior adapter's revoke is
        // deliberately fire-and-forget here rather than blocking this registration on it.
        // eslint-disable-next-line unicorn/prefer-await -- register() is sync, see comment above
        this.revoke(current.ref).catch(() => {});
        this.adapters.set(key, { adapter, registration: { ...registration, endpoint: current } });
        return registration;
    }

    async deliver(message: AgentInboundMessage): Promise<void> {
        const current = this.endpoints.resolve(message.to);
        if (current.messaging.deliveryMode !== 'push' || current.messaging.health !== 'ready')
            throw new CaxriError('UNAVAILABLE', 'Provider push messaging is unavailable');
        const registered = this.adapters.get(endpointKey(message.to));
        if (!registered)
            throw new CaxriError('UNAVAILABLE', 'Provider push adapter is unavailable');
        const delivery = providerMessageDeliverySchema.parse({
            deliveryId: randomUUID(),
            message,
        });
        let rawAck: unknown;
        try {
            rawAck = await registered.adapter.deliver(delivery);
        } catch {
            throw new CaxriError(
                'UNAVAILABLE',
                'Provider push adapter did not acknowledge delivery',
            );
        }
        const ack = providerMessageAckSchema.safeParse(rawAck);
        if (
            !ack.success ||
            ack.data.deliveryId !== delivery.deliveryId ||
            ack.data.outcome !== 'accepted'
        )
            throw new CaxriError('UNAVAILABLE', 'Provider push adapter did not accept delivery');
    }

    async revoke(reference: AgentEndpointReference): Promise<void> {
        const registered = this.adapters.get(endpointKey(reference));
        if (!registered) return;
        this.adapters.delete(endpointKey(reference));
        await registered.adapter.revoke();
    }

    async close(): Promise<void> {
        const adapters = this.adapters.values().toArray();
        this.adapters.clear();
        await Promise.allSettled(adapters.map(({ adapter }) => Promise.resolve(adapter.revoke())));
    }
}
