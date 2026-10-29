/**
 * Runtime limits for one Relay process. Every value has a conservative default sized for a single small container;
 * operators override them through `CAXRI_RELAY_*` environment variables.
 */
export interface RelayConfig {
    /**
     * Path prefix the Relay serves under, without a trailing slash. Empty when it owns the whole origin.
     */
    basePath: string;
    host: string;
    port: number;
    /**
     * Take the client address from the first `X-Forwarded-For` hop. Enable only behind a proxy that overwrites it;
     * otherwise any client can pick its own rate-limit bucket.
     */
    trustProxy: boolean;
    firstFrameTimeoutMs: number;
    hostDialTimeoutMs: number;
    heartbeatIntervalMs: number;
    /**
     * Consecutive unanswered pings before a socket is terminated.
     */
    heartbeatMissLimit: number;
    maxHosts: number;
    maxConnectionsPerHost: number;
    maxPayloadBytes: number;
    /**
     * Upgrade attempts per source address in one minute, counted before authentication.
     */
    sourceAttemptsPerMinute: number;
    /**
     * Unauthenticated sockets one source address may hold open at once.
     */
    sourcePendingSockets: number;
    pauseAboveBytes: number;
    resumeBelowBytes: number;
    maxDirectionBufferedBytes: number;
    maxPausedMs: number;
    maxProcessBufferedBytes: number;
    summaryIntervalMs: number;
}

export const defaultRelayConfig: RelayConfig = {
    basePath: '',
    host: '0.0.0.0',
    port: 8080,
    trustProxy: false,
    firstFrameTimeoutMs: 10_000,
    hostDialTimeoutMs: 10_000,
    heartbeatIntervalMs: 20_000,
    heartbeatMissLimit: 2,
    maxHosts: 10_000,
    maxConnectionsPerHost: 32,
    maxPayloadBytes: 256 * 1024,
    sourceAttemptsPerMinute: 30,
    sourcePendingSockets: 8,
    pauseAboveBytes: 256 * 1024,
    resumeBelowBytes: 64 * 1024,
    maxDirectionBufferedBytes: 8 * 1024 * 1024,
    maxPausedMs: 10_000,
    maxProcessBufferedBytes: 64 * 1024 * 1024,
    summaryIntervalMs: 60_000,
};

const integer = (
    value: string | undefined,
    name: string,
    fallback: number,
    min: number,
): number => {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min)
        throw new Error(`${name} must be an integer of at least ${min}`);
    return parsed;
};

/**
 * Reads `CAXRI_RELAY_*` variables over the defaults and fails fast on malformed values.
 */
export const relayConfigFromEnvironment = (
    environment: Record<string, string | undefined>,
): RelayConfig => {
    const basePath = (environment.CAXRI_RELAY_BASE_PATH ?? '').replace(/\/+$/u, '');
    if (basePath !== '' && !basePath.startsWith('/'))
        throw new Error('CAXRI_RELAY_BASE_PATH must start with /');
    const value = (key: string, fallback: number, min = 1) =>
        integer(environment[`CAXRI_RELAY_${key}`], `CAXRI_RELAY_${key}`, fallback, min);
    const config: RelayConfig = {
        ...defaultRelayConfig,
        basePath,
        host:
            (environment.CAXRI_RELAY_HOST === '' ? undefined : environment.CAXRI_RELAY_HOST) ??
            defaultRelayConfig.host,
        port: value('PORT', defaultRelayConfig.port, 0),
        trustProxy: environment.CAXRI_RELAY_TRUST_PROXY === '1',
        maxHosts: value('MAX_HOSTS', defaultRelayConfig.maxHosts),
        maxConnectionsPerHost: value(
            'MAX_CONNECTIONS_PER_HOST',
            defaultRelayConfig.maxConnectionsPerHost,
        ),
        sourceAttemptsPerMinute: value(
            'SOURCE_ATTEMPTS_PER_MINUTE',
            defaultRelayConfig.sourceAttemptsPerMinute,
        ),
        sourcePendingSockets: value(
            'SOURCE_PENDING_SOCKETS',
            defaultRelayConfig.sourcePendingSockets,
        ),
        heartbeatIntervalMs: value('HEARTBEAT_INTERVAL_MS', defaultRelayConfig.heartbeatIntervalMs),
        maxProcessBufferedBytes: value(
            'MAX_PROCESS_BUFFERED_BYTES',
            defaultRelayConfig.maxProcessBufferedBytes,
        ),
    };
    if (config.port > 65_535) throw new Error('CAXRI_RELAY_PORT must be at most 65535');
    return config;
};
