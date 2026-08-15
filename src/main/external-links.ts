import type { MethodResult } from '../shared/ipc/methods';
import {
    externalUrlOrigin,
    isExternalUrlTrusted,
    parseExternalHttpUrl,
} from '../shared/trusted-domains';

export type ExternalOpenDecision = 'open_once' | 'trust' | 'cancel';

export interface ExternalUrlDependencies {
    getTrustedDomains(): Promise<readonly string[]>;
    open(url: string): Promise<void>;
    prompt(url: URL): Promise<ExternalOpenDecision>;
    trust(domain: string): Promise<void>;
}

export interface ExternalOpenOptions {
    allowTrust: boolean;
}

/**
Validates and opens a Renderer-submitted URL without giving the Renderer native authority.
 */
export async function openExternalUrl(
    input: string,
    dependencies: ExternalUrlDependencies,
    options: ExternalOpenOptions,
): Promise<MethodResult<'external.open'>> {
    const parsed = parseExternalHttpUrl(input);
    if (!parsed.ok) return { status: 'rejected', reason: parsed.reason };
    const { url } = parsed;
    const rules = await dependencies.getTrustedDomains();
    if (!isExternalUrlTrusted(url, rules)) {
        const decision = await dependencies.prompt(url);
        if (decision === 'cancel') return { status: 'canceled' };
        if (decision === 'trust') {
            if (!options.allowTrust) return { status: 'canceled' };
            await dependencies.trust(externalUrlOrigin(url));
        }
    }
    await dependencies.open(url.toString());
    return { status: 'opened' };
}
