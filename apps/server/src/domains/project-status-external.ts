import type { ProjectStatusDeployment, ProjectStatusError } from '@caxri/protocol';

import type { CliFailureKind, ExternalStatusSource } from './external-status';

export interface VercelLink {
    project: string;
    team: string;
}

interface LinearReference {
    identifier: string;
    workspace?: string;
}

const REFERENCE_MARKERS = [
    'Fix',
    'Fixes',
    'Fixed',
    'Close',
    'Closes',
    'Closed',
    'Resolve',
    'Resolves',
    'Resolved',
    'Related to',
] as const;

/**
 * A Linear magic word owns only the identifiers attached to it (`Fixes LOBE-1, LOBE-2`), so the scan stops at the first
 * token that is neither an identifier nor a connector. Sweeping every `word-digits` token out of the rest of the line
 * instead — the previous behavior — pulled ordinary prose into the reference list: "This fixes local installs … The
 * packageManager SHA-512 value matches the published npm artifact" yielded a `SHA-512` lookup that failed and marked
 * the whole Project Status panel with a Linear error.
 *
 * Only whitespace and a soft `issue` may precede the first identifier. `#123` and `and` stay out of that prefix so a
 * GitHub-style reference cannot bridge the keyword to an unrelated hyphenated word further down the sentence.
 *
 * @see https://github.com/tjx666/caxri/issues/796
 */
const REFERENCE_IDENTIFIER_PATTERN = /^([a-z][a-z0-9]*-[1-9]\d*)(?![\w-])/iu;
const REFERENCE_PREFIX_PATTERN = /^(?:[^\S\n]+|[:：]|issues?\b)/iu;
const REFERENCE_SEPARATOR_PATTERN = /^(?:[^\S\n]+|[,;、&+]|and\b|issues?\b|#\d+\b)/iu;

export function projectStatusCliError(
    command: ExternalStatusSource,
    kind: CliFailureKind,
    subject?: string,
): ProjectStatusError {
    const source = command === 'gh' ? 'github' : command === 'vc' ? 'vercel' : 'linear';
    if (kind === 'not-found') {
        return {
            source,
            message: `${command} not installed`,
            hint:
                command === 'gh'
                    ? 'Install GitHub CLI to load pull requests.'
                    : command === 'vc'
                      ? 'Install Vercel CLI to load deployments.'
                      : 'Install linear-cli to load linked issues.',
        };
    }
    if (kind === 'not-logged-in') {
        return {
            source,
            message: `${command}: not logged in`,
            hint: `Run \`${command} ${command === 'vc' ? 'login' : 'auth login'}\` in a Terminal.`,
        };
    }
    if (kind === 'not-linked') {
        return {
            source,
            message: `${command}: not linked`,
            hint:
                command === 'vc'
                    ? 'Run `vc link` in the repository.'
                    : 'Run `linear config` in the repository.',
        };
    }
    if (kind === 'rate-limited')
        return {
            source,
            message: `${command}: rate limited`,
            hint: 'Refresh after the API limit resets.',
        };
    if (kind === 'timeout')
        return {
            source,
            message: `${command} timed out`,
            hint: 'Check the network or proxy, then refresh.',
        };
    /**
     * `diagnostics.ts` deliberately drops CLI stderr, so promising "details" in the logs was a lie: the only recorded
     * fields are the failure classification, the exit code, and the subject below. Name what the logs actually hold,
     * and name the failing subject here so a panel-level error points at the request that produced it.
     */
    return {
        source,
        message: subject ? `${command}: ${subject} failed` : `${command}: error`,
        hint: subject
            ? `Runtime logs record the failure kind and exit code for ${subject}. CLI output is never logged.`
            : 'Runtime logs record the failure kind and exit code. CLI output is never logged.',
        detailsView: 'logs',
    };
}

/**
 * Walks the text directly after one magic word and returns the identifiers attached to it, stopping at the first token
 * that is neither an identifier nor a connector.
 */
function markerReferences(rest: string): string[] {
    const identifiers: string[] = [];
    let remaining = rest;
    while (remaining.length > 0) {
        const identifier = REFERENCE_IDENTIFIER_PATTERN.exec(remaining);
        if (identifier) {
            identifiers.push(identifier[1]);
            remaining = remaining.slice(identifier[0].length);
            continue;
        }
        const connector = (
            identifiers.length > 0 ? REFERENCE_SEPARATOR_PATTERN : REFERENCE_PREFIX_PATTERN
        ).exec(remaining);
        if (!connector) break;
        remaining = remaining.slice(connector[0].length);
    }
    return identifiers;
}

export function extractLinearReferences(body: string): LinearReference[] {
    const references: LinearReference[] = [];
    const add = (identifier: string, workspace?: string): void => {
        const normalized = identifier.toUpperCase();
        if (references.some((candidate) => candidate.identifier === normalized)) return;
        references.push({ identifier: normalized, workspace: workspace?.toLowerCase() });
    };
    for (const match of body.matchAll(
        /https?:\/\/linear\.app\/([a-z0-9-]+)\/issue\/([a-z][a-z0-9]*-[1-9]\d*)/giu,
    )) {
        add(match[2], match[1]);
    }
    const markerPattern = REFERENCE_MARKERS.map((marker) =>
        marker.replaceAll(' ', String.raw`\s+`),
    ).join('|');
    const referenceLine = new RegExp(String.raw`(?:^|\b)(?:${markerPattern})\b([^\n]*)`, 'giu');
    for (const marker of body.matchAll(referenceLine)) {
        const identifiers = markerReferences(marker[1]);
        for (const identifier of identifiers) add(identifier);
    }
    return references;
}

export function vcListArguments(
    team: string,
    meta: Record<string, string>,
    environment?: ProjectStatusDeployment['environment'],
): string[] {
    const query = new URLSearchParams({ limit: '20' });
    for (const [key, value] of Object.entries(meta)) query.set(`meta-${key}`, value);
    if (environment) query.set('target', environment);
    return ['api', `/v6/deployments?${query}`, '--scope', team, '--raw'];
}

/**
 * Deployment details remain useful when a build is canceled or fails. Prefer Vercel's validated provider URL, then use
 * the API's stable deployment ID rather than guessing an inspector identifier from the deployed hostname. `vc ls` drops
 * both fields, so lists use `vc api` instead.
 *
 * @see https://github.com/vercel/vercel/blob/c628be7835e03a965b93e9cf9e2bd5ac2acbf5eb/packages/cli/src/util/deploy/get-deployments-by-project-id.ts
 */
export function vercelInspectorUrl(
    team: string,
    project: string,
    deploymentId: string | undefined,
    providerUrl?: string | null,
): string | undefined {
    if (providerUrl) {
        try {
            const url = new URL(providerUrl);
            if (
                url.protocol === 'https:' &&
                url.hostname === 'vercel.com' &&
                !url.port &&
                !url.username &&
                !url.password
            )
                return url.href;
        } catch {
            // Fall through to the stable deployment ID when the provider URL is malformed.
        }
    }
    if (!deploymentId || !/^dpl_[a-zA-Z0-9]+$/.test(deploymentId)) return undefined;
    return `https://vercel.com/${encodeURIComponent(team)}/${encodeURIComponent(project)}/${deploymentId.slice(4)}`;
}
