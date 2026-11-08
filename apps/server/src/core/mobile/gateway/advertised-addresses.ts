import { selectMobileGatewayAddresses } from './address-selection';

/**
 * The private addresses the gateway tells phones to dial. The listener is bound to every interface, so it already
 * answers on an address this computer gained after the gateway started (a new Wi-Fi network). Only the advertised list
 * could go stale: read once at enable, it kept handing out the old network's address, and a phone holding it never
 * reached the computer directly again. Every pairing link and `mobile.computer.routes` read therefore re-reads the
 * interfaces.
 */
export class MobileAdvertisedAddresses {
    readonly #select: () => string[];
    #current?: string[];

    constructor(select: () => string[] = selectMobileGatewayAddresses) {
        this.#select = select;
    }

    /**
     * The list last advertised; `undefined` while the gateway is off.
     */
    get current(): readonly string[] | undefined {
        return this.#current;
    }

    /**
     * Reads the interfaces; throws `UNAVAILABLE` when no private IPv4 network is up.
     */
    read(): string[] {
        return this.#select();
    }

    adopt(addresses: string[]): void {
        this.#current = addresses;
    }

    /**
     * Re-reads the interfaces, keeping the last known list while no private network is up so a pairing link can still
     * carry the Relay.
     */
    refresh(): string[] {
        try {
            this.#current = this.#select();
        } catch (error) {
            if (!this.#current) throw error;
        }
        return this.#current;
    }

    clear(): void {
        this.#current = undefined;
    }
}
