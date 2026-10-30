import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';

import type { EnvironmentMonitorIpProfile } from '@caxri/protocol';
import { environmentMonitorIpProfileSchema } from '@caxri/protocol';
import { readCappedBody } from '@caxri/system';

const PUBLIC_IP_ENDPOINT = 'https://api.ipify.org?format=json';
const PUBLIC_IP_PROFILE_HOST = 'checkip.me';

const PUBLIC_IP_RESPONSE_BYTES = 4 * 1024;
const PUBLIC_IP_PROFILE_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type PublicIpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function readJsonResponse(
    response: Response,
    maximumBytes: number,
): Promise<Record<string, unknown>> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
        throw new Error('environment response is larger than expected');
    if (!response.ok || !response.body) throw new Error('environment request failed');

    const chunks: Uint8Array[] = [];
    const end = await readCappedBody(response, maximumBytes, (chunk) => {
        chunks.push(chunk);
    });
    if (end !== 'end') throw new Error('environment response is larger than expected');
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('environment response is invalid');
    return value as Record<string, unknown>;
}

function optionalString(value: unknown, maximumLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= maximumLength ? trimmed : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function optionalRiskScore(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : undefined;
}

function operatorName(value: unknown): string | undefined {
    if (typeof value === 'string') return optionalString(value, 200);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const operator = value as Record<string, unknown>;
    return (
        optionalString(operator.name, 200) ??
        optionalString(operator.service, 200) ??
        optionalString(operator.operator, 200)
    );
}

export async function readPublicIp(fetcher: PublicIpFetcher = fetch): Promise<string> {
    const payload = await readJsonResponse(
        await fetcher(PUBLIC_IP_ENDPOINT, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
        PUBLIC_IP_RESPONSE_BYTES,
    );
    if (typeof payload.ip !== 'string' || isIP(payload.ip) === 0)
        throw new Error('public IP response is invalid');
    return payload.ip;
}

/**
 * Enriches the explicit address observed through ipify. The request never substitutes its own caller address for that
 * observation, so a different route to the profile provider cannot silently become the monitored exit.
 *
 * @see https://checkip.me/api
 */
export async function readPublicIpProfile(
    ip: string,
    checkedAt: number,
    fetcher: PublicIpFetcher = fetch,
): Promise<EnvironmentMonitorIpProfile> {
    if (isIP(ip) === 0) throw new Error('public IP profile target is invalid');
    const payload = await readJsonResponse(
        await fetcher(`https://${PUBLIC_IP_PROFILE_HOST}/${encodeURIComponent(ip)}`, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
        PUBLIC_IP_PROFILE_RESPONSE_BYTES,
    );
    if (payload.ip !== ip) throw new Error('public IP profile response is invalid');

    const country = optionalString(payload.country, 100);
    const countryCode = optionalString(payload.country_code, 3);
    const region = optionalString(payload.region, 160);
    const city = optionalString(payload.city, 160);
    const asn = optionalString(payload.asn, 32);
    const isp = optionalString(payload.isp, 200);
    const organization = optionalString(payload.organisation, 200);
    const networkType = optionalString(payload.type, 100);
    const networkOperator = operatorName(payload.operator);
    const riskScore = optionalRiskScore(payload.risk);
    const anonymous = optionalBoolean(payload.anonymous);
    const compromised = optionalBoolean(payload.compromised);
    const hosting = optionalBoolean(payload.hosting);
    const proxy = optionalBoolean(payload.proxy);
    const scraper = optionalBoolean(payload.scraper);
    const tor = optionalBoolean(payload.tor);
    const vpn = optionalBoolean(payload.vpn);

    return environmentMonitorIpProfileSchema.parse({
        status: 'available',
        source: PUBLIC_IP_PROFILE_HOST,
        checkedAt,
        ...(country && { country }),
        ...(countryCode && { countryCode }),
        ...(region && { region }),
        ...(city && { city }),
        ...(asn && { asn }),
        ...(isp && { isp }),
        ...(organization && { organization }),
        ...(networkType && { networkType }),
        ...(networkOperator && { operator: networkOperator }),
        ...(riskScore !== undefined && { riskScore }),
        signals: {
            ...(anonymous !== undefined && { anonymous }),
            ...(compromised !== undefined && { compromised }),
            ...(hosting !== undefined && { hosting }),
            ...(proxy !== undefined && { proxy }),
            ...(scraper !== undefined && { scraper }),
            ...(tor !== undefined && { tor }),
            ...(vpn !== undefined && { vpn }),
        },
    });
}
