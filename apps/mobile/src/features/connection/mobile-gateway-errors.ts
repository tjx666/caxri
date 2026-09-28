import { MOBILE_TRANSPORT_VERSION } from '@caxri/mobile-transport';

export class MobileGatewayRequestError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'MobileGatewayRequestError';
        this.code = code;
    }
}

export class MobileGatewayTimeoutError extends Error {
    constructor() {
        super('Caxri did not respond in time.');
        this.name = 'MobileGatewayTimeoutError';
    }
}

export type MobilePairingErrorCode = 'expired' | 'invalid-link' | 'rejected' | 'unreachable';

export class MobilePairingError extends Error {
    readonly code: MobilePairingErrorCode;

    constructor(code: MobilePairingErrorCode, message: string) {
        super(message);
        this.name = 'MobilePairingError';
        this.code = code;
    }
}

export class MobileReconnectError extends Error {
    readonly code = 'unverified' as const;

    constructor() {
        super('Caxri could not verify this stored pairing.');
        this.name = 'MobileReconnectError';
    }
}

export class MobileVersionMismatchError extends Error {
    readonly code = 'version-mismatch' as const;
    /**
     * The transport version Desktop speaks, when Desktop said so; a pairing link rejected locally carries none.
     */
    readonly supportedVersion: number | undefined;

    constructor(supportedVersion?: number) {
        super(
            'This app and Caxri on your computer use different versions. Update both to the latest build.',
        );
        this.name = 'MobileVersionMismatchError';
        this.supportedVersion = supportedVersion;
    }

    /**
     * Only a newer Desktop can hold the build that fixes the mismatch, so only then is update recovery worth trying.
     */
    get isDesktopNewer(): boolean {
        return (
            this.supportedVersion !== undefined && this.supportedVersion > MOBILE_TRANSPORT_VERSION
        );
    }
}

export class MobileServerVerificationError extends Error {
    constructor() {
        super('Caxri could not verify this pairing.');
        this.name = 'MobileServerVerificationError';
    }
}
