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
    const arguments_ = ['ls', '--format', 'json', '--scope', team];
    for (const [key, value] of Object.entries(meta)) arguments_.push('--meta', `${key}=${value}`);
    if (environment) arguments_.push('--environment', environment);
    arguments_.push('--yes');
    return arguments_;
}

/**
 * `vc ls --format json` omits the inspector URL. Generated deployment aliases encode the short hash that Vercel accepts
 * in its inspector route; non-matching custom aliases deliberately return no logs link. See
 * https://github.com/tjx666/caxri/issues/413.
 */
export function vercelInspectorUrl(
    team: string,
    project: string,
    deploymentUrl: string,
): string | undefined {
    const hostname = deploymentUrl.replace(/^https?:\/\//, '').replace(/\.vercel\.app$/, '');
    const prefix = `${project}-`;
    const suffix = `-${team}`;
    if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) return undefined;
    const hash = hostname.slice(prefix.length, hostname.length - suffix.length);
    if (!hash || hash.includes('.')) return undefined;
    return `https://vercel.com/${team}/${project}/${hash}`;
}
