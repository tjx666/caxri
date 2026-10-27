import type {
    DelegationClientRow,
    DelegationClientStore,
    MobileDeviceRow,
    MobileDeviceStore,
    MobileGatewayPreferenceRow,
    ServerCredentialStores,
} from '../../domains/db';

/**
 * In-memory stand-ins for the Server database's credential tables. Every `write` stores a deep copy, like a real write,
 * so a test that mutates a returned record cannot reach the "persisted" state. `failNextWrite` rejects the next write
 * to exercise a registry's failed-persistence path.
 */
export interface MemoryMobileDeviceStore extends MobileDeviceStore {
    devices: MobileDeviceRow[];
    preferences: MobileGatewayPreferenceRow;
    failNextWrite(error?: Error): void;
}

export interface MemoryDelegationClientStore extends DelegationClientStore {
    clients: DelegationClientRow[];
    failNextWrite(error?: Error): void;
}

export function createMemoryMobileDeviceStore(
    initial: { devices?: MobileDeviceRow[]; preferences?: MobileGatewayPreferenceRow } = {},
): MemoryMobileDeviceStore {
    let failure: Error | undefined;
    const store: MemoryMobileDeviceStore = {
        devices: structuredClone(initial.devices ?? []),
        preferences: structuredClone(initial.preferences ?? {}),
        failNextWrite: (error = new Error('injected write failure')) => {
            failure = error;
        },
        load: () => structuredClone({ devices: store.devices, preferences: store.preferences }),
        write: (devices, preferences) => {
            if (failure) {
                const error = failure;
                failure = undefined;
                throw error;
            }
            store.devices = structuredClone([...devices]);
            store.preferences = structuredClone(preferences);
        },
    };
    return store;
}

export function createMemoryDelegationClientStore(
    initial: DelegationClientRow[] = [],
): MemoryDelegationClientStore {
    let failure: Error | undefined;
    const store: MemoryDelegationClientStore = {
        clients: structuredClone(initial),
        failNextWrite: (error = new Error('injected write failure')) => {
            failure = error;
        },
        load: () => structuredClone(store.clients),
        write: (clients) => {
            if (failure) {
                const error = failure;
                failure = undefined;
                throw error;
            }
            store.clients = structuredClone([...clients]);
        },
    };
    return store;
}

export function createMemoryCredentialStores(): ServerCredentialStores {
    return {
        delegationClients: createMemoryDelegationClientStore(),
        mobileDevices: createMemoryMobileDeviceStore(),
    };
}
