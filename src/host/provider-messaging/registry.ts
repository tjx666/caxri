import { randomUUID } from 'node:crypto';

import type { AgentInboundMessage } from '../../shared/ipc/agent-inbox-contract';
import type { AgentEndpointRef } from '../../shared/ipc/agent-endpoint-contract';
import { CaxriError } from '../../shared/ipc/errors';
import {
    providerMessageAckSchema,
    providerMessageDeliverySchema,
    providerMessagingRegistrationSchema,
    type ProviderMessagingAdapter,
    type ProviderMessagingRegistration,
} from '../../shared/ipc/provider-messaging-contract';
import type { AgentEndpointRegistry } from '../agent-endpoints';

interface RegisteredAdapter {
    adapter: ProviderMessagingAdapter;
    registration: ProviderMessagingRegistration;
}

function endpointKey(ref: AgentEndpointRef): string {
    return `${ref.hostId}:${ref.endpointId}:${ref.generation}`;
}

/** Host-memory registry for documented push adapters; no Provider private state crosses it. */
export class ProviderMessagingAdapterRegistry {
    private readonly adapters = new Map<string, RegisteredAdapter>();

    constructor(private readonly endpoints: AgentEndpointRegistry) {
        endpoints.onRetired((endpoint) => void this.revoke(endpoint.ref));
        endpoints.onMessagingChanged((endpoint) => {
            if (endpoint.messaging.deliveryMode !== 'push') void this.revoke(endpoint.ref);
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
        void this.revoke(current.ref);
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

    async revoke(ref: AgentEndpointRef): Promise<void> {
        const registered = this.adapters.get(endpointKey(ref));
        if (!registered) return;
        this.adapters.delete(endpointKey(ref));
        await registered.adapter.revoke();
    }

    async close(): Promise<void> {
        const adapters = [...this.adapters.values()];
        this.adapters.clear();
        await Promise.allSettled(adapters.map(({ adapter }) => Promise.resolve(adapter.revoke())));
    }
}
