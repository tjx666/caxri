import { MobilePairingError } from '../connection/mobile-gateway-client';
import { pairingErrorMessage } from './pairing-error';

const pairingRouteParameterNames = [
    'addresses',
    'expires',
    'pairing',
    'port',
    'secret',
    'server',
    'v',
] as const;

export type PairingRouteParameters = Record<string, string | string[] | undefined>;

/**
 * Rebuilds the short-lived desktop link after Expo Router maps `caxri://pair?...` to `/pair`. Keeping this contract
 * closed prevents navigation metadata from becoming protocol input.
 */
export const pairingLinkFromRouteParameters = (parameters: PairingRouteParameters): string => {
    const keys = Object.keys(parameters);
    if (
        keys.length !== pairingRouteParameterNames.length ||
        keys.some(
            (key) =>
                !pairingRouteParameterNames.includes(
                    key as (typeof pairingRouteParameterNames)[number],
                ),
        )
    )
        throw new MobilePairingError(
            'invalid-link',
            'Pairing route parameters do not match the protocol',
        );

    const search = new URLSearchParams();
    for (const name of pairingRouteParameterNames) {
        const value = parameters[name];
        if (typeof value !== 'string')
            throw new MobilePairingError(
                'invalid-link',
                'Pairing route parameters do not match the protocol',
            );
        search.set(name, value);
    }
    return `caxri://pair?${search.toString()}`;
};

/**
 * Keeps malformed links in the pairing error UI instead of throwing during render.
 */
export const readPairingRoute = (parameters: PairingRouteParameters) => {
    try {
        return { link: pairingLinkFromRouteParameters(parameters), error: undefined };
    } catch (error) {
        return { link: undefined, error: pairingErrorMessage(error) };
    }
};

/**
 * Owns one focused route attempt. Blur or replacement fences both late navigation and errors. Expo Stack screens can
 * remain mounted after losing focus: https://docs.expo.dev/router/reference/url-parameters/
 */
export const startPairingRoute = ({
    link,
    pair,
    cancel,
    onSuccess,
    onError,
}: {
    link: string;
    pair: (link: string) => Promise<void>;
    cancel: () => void;
    onSuccess: () => void;
    onError: (message: string) => void;
}): (() => void) => {
    let isCurrent = true;
    let isPending = true;
    const complete = async (): Promise<void> => {
        try {
            await pair(link);
            isPending = false;
            if (isCurrent) onSuccess();
        } catch (error) {
            isPending = false;
            if (isCurrent) onError(pairingErrorMessage(error));
        }
    };
    // eslint-disable-next-line no-void -- The route owns this bounded operation and its cleanup.
    void complete();
    return () => {
        if (!isCurrent) return;
        isCurrent = false;
        if (isPending) cancel();
    };
};
