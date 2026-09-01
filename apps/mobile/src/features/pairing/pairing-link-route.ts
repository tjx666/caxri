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
        throw new Error('Pairing route parameters do not match the protocol');

    const search = new URLSearchParams();
    for (const name of pairingRouteParameterNames) {
        const value = parameters[name];
        if (typeof value !== 'string')
            throw new Error('Pairing route parameters do not match the protocol');
        search.set(name, value);
    }
    return `caxri://pair?${search.toString()}`;
};
