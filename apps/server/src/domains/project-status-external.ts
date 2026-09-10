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

export function projectStatusCliError(
    command: ExternalStatusSource,
    kind: CliFailureKind,
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
    return {
        source,
        message: `${command}: error`,
        hint: 'See Runtime logs for details.',
        detailsView: 'logs',
    };
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
        const identifiers = marker[1].matchAll(/\b([a-z][a-z0-9]*-[1-9]\d*)\b/giu);
        for (const identifier of identifiers) add(identifier[1]);
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
