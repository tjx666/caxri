import type { MethodResult } from '@caxri/protocol';
import {
    externalUrlOrigin,
    isExternalUrlTrusted,
    parseExternalHttpUrl,
    trustableParentHostname,
} from '@caxri/protocol';

export type ExternalOpenDecision = 'open_once' | 'trust' | 'trust_parent' | 'cancel';

export interface ExternalUrlDependencies {
    getTrustedDomains(): Promise<readonly string[]>;
    open(url: string): Promise<void>;
    prompt(url: URL, parentHostname?: string): Promise<ExternalOpenDecision>;
    trust(domain: string): Promise<void>;
}

export interface ExternalOpenOptions {
    allowTrust: boolean;
}

/**
 * Validates and opens a Renderer-submitted URL without giving the Renderer native authority.
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
        const parentHostname = options.allowTrust ? trustableParentHostname(url) : undefined;
        const decision = await dependencies.prompt(url, parentHostname);
        if (decision === 'cancel') return { status: 'canceled' };
        if (decision === 'trust' || decision === 'trust_parent') {
            if (!options.allowTrust) return { status: 'canceled' };
            /**
             * The wildcard rule is written only when this call is the one that offered it. A `trust_parent` arriving
             * without a candidate means the dialog and the decision disagree, and the wider rule is exactly the thing
             * that must not be persisted on a disagreement.
             */
            if (decision === 'trust_parent' && !parentHostname) return { status: 'canceled' };
            await dependencies.trust(
                parentHostname && decision === 'trust_parent'
                    ? `${url.protocol}//*.${parentHostname}`
                    : externalUrlOrigin(url),
            );
        }
    }
    await dependencies.open(url.toString());
    return { status: 'opened' };
}
