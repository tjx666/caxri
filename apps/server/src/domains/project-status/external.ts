import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProjectStatusDeployment, ProjectStatusError } from '@caxri/protocol';

import type { CliFailureKind, ExternalStatusSource } from '../external-status';
import { retryTimeLabel } from '../retry-time';

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
 * A Linear magic word owns only the identifiers attached to it (`Fixes TASK-1, TASK-2`), so the scan stops at the first
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

/**
 * A deployment search cannot prove whether `vc link` succeeded: a newly linked project may have no deployments yet.
 * Vercel writes the link IDs to this local file. Read a bounded regular file without following a symlink.
 *
 * @see https://vercel.com/docs/cli/project-linking
 */
export async function hasLocalVercelLink(rootPath: string): Promise<boolean> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(
            join(rootPath, '.vercel', 'project.json'),
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
    try {
        const stats = await file.stat();
        if (!stats.isFile() || stats.size > 16_384) return false;
        const buffer = Buffer.alloc(16_385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead === buffer.length) return false;
        const link: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead));
        return (
            link !== null &&
            typeof link === 'object' &&
            typeof (link as { orgId?: unknown }).orgId === 'string' &&
            typeof (link as { projectId?: unknown }).projectId === 'string' &&
            Boolean((link as { orgId: string }).orgId && (link as { projectId: string }).projectId)
        );
    } catch (error) {
        if (error instanceof SyntaxError) return false;
        throw error;
    } finally {
        await file.close();
    }
}

export function projectStatusNoDeploymentsError(): ProjectStatusError {
    return {
        source: 'vercel',
        kind: 'prerequisite',
        message: 'No Vercel deployments found',
        hint: 'This repository is linked to Vercel, but no matching deployments were found. Create one, then recheck.',
    };
}

/**
 * What each provider CLI is called in front of the user, and what it is being asked for. Held as one record rather than
 * a chain of ternaries so adding a provider is a single entry and no branch can be missed: an `lh` failure that fell
 * through to Linear's copy would tell the user to run `linear config` to fix an acceptance report.
 *
 * `providerName` is separate from `displayName` because a rate limit belongs to the service's account budget, not to
 * the executable that happened to discover it — that copy names the service, while the prerequisites name the binary
 * the user has to install.
 */
const CLI_PROVIDERS = {
    gh: {
        displayName: 'GitHub CLI',
        installHint:
            'Pull requests for this repository need the GitHub CLI. Install it, then recheck.',
        accessHint:
            'Run gh auth refresh, authorize SSO for the organization if it requires it, then recheck.',
        loginCommand: 'gh auth login',
        credentialEnvironmentVariable: 'GH_TOKEN',
        providerName: 'GitHub',
        resource: 'pull requests',
        source: 'github',
    },
    lh: {
        displayName: 'LobeHub CLI',
        installHint:
            'Acceptance reports need the LobeHub CLI. Install it with npm i -g @lobehub/cli, then recheck.',
        accessHint: 'Check that your LobeHub account can read this report, then recheck.',
        loginCommand: 'lh login',
        credentialEnvironmentVariable: 'LOBEHUB_CLI_API_KEY',
        providerName: 'LobeHub',
        resource: 'acceptance reports',
        source: 'acceptance',
    },
    linear: {
        displayName: 'Linear CLI',
        installHint: 'Linked issues need the Linear CLI. Install it, then recheck.',
        linkHint: 'Run linear config in this repository, then recheck.',
        accessHint: 'Check that your Linear account can see this team, then recheck.',
        loginCommand: 'linear auth login',
        credentialEnvironmentVariable: 'LINEAR_API_KEY',
        providerName: 'Linear',
        resource: 'linked issues',
        source: 'linear',
    },
    vc: {
        displayName: 'Vercel CLI',
        installHint:
            'Deployments for this repository need the Vercel CLI. Install it with npm i -g vercel, then recheck.',
        linkHint: 'Run vc link in this repository, then recheck.',
        linkMessage: 'Repository not linked to Vercel',
        accessHint: 'Check that your Vercel account can access this project, then recheck.',
        loginCommand: 'vc login',
        credentialEnvironmentVariable: 'VERCEL_TOKEN',
        providerName: 'Vercel',
        resource: 'deployments',
        source: 'vercel',
    },
} as const satisfies Record<
    Exclude<ExternalStatusSource, 'git'>,
    {
        /**
         * Recovery for a signed-in account the service still refuses (SSO, scopes, team membership).
         */
        accessHint: string;
        /**
         * The environment variable this CLI accepts as an alternative to its own persisted login (issue caxri#1345).
         * Caxri's external commands run on an allowlisted environment that deliberately excludes every application
         * credential (`packages/system/src/process/environment.ts`), so a user authenticated only this way sees
         * `not-logged-in` even though their own shell is signed in. Naming the variable in the hint explains that gap
         * instead of implying the user was never signed in at all.
         */
        credentialEnvironmentVariable: string;
        displayName: string;
        installHint: string;
        linkHint?: string;
        linkMessage?: string;
        loginCommand: string;
        providerName: string;
        resource: string;
        source: ProjectStatusError['source'];
    }
>;

export function projectStatusCliError(
    command: ExternalStatusSource,
    kind: CliFailureKind,
    options: {
        /**
         * The limiter's pause deadline, when this failure is a rate limit that carries one.
         */
        retryAt?: number;
        subject?: string;
    } = {},
): ProjectStatusError {
    const { retryAt, subject } = options;
    // `git` is local and never reaches this reporter; fall back to the GitHub copy rather than widening every entry.
    const provider = CLI_PROVIDERS[command === 'git' ? 'gh' : command];
    const { displayName, providerName, source } = provider;
    if (kind === 'not-found') {
        return {
            source,
            kind: 'prerequisite',
            message: `${displayName} not installed`,
            hint: provider.installHint,
        };
    }
    if (kind === 'not-logged-in') {
        return {
            source,
            kind: 'prerequisite',
            message: `${displayName} not signed in`,
            hint: `Run ${provider.loginCommand} in a Terminal, then recheck. A ${provider.credentialEnvironmentVariable} environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.`,
        };
    }
    if (kind === 'not-linked') {
        const linkMessage = 'linkMessage' in provider ? provider.linkMessage : undefined;
        const linkHint = 'linkHint' in provider ? provider.linkHint : undefined;
        return {
            source,
            kind: 'prerequisite',
            message: linkMessage ?? `${displayName} not linked`,
            hint: linkHint ?? `Configure ${providerName} for this repository, then recheck.`,
        };
    }
    if (kind === 'permission-denied') {
        return {
            source,
            kind: 'prerequisite',
            message: `${displayName} access denied`,
            hint: provider.accessHint,
        };
    }
    if (kind === 'network')
        return {
            source,
            kind: 'failure',
            reason: 'network',
            message: `${displayName} connection failed`,
            hint: `Caxri could not reach ${displayName}. Check the connection, then recheck.`,
        };
    if (kind === 'tls')
        return {
            source,
            kind: 'failure',
            reason: 'tls',
            message: `${displayName} secure connection failed`,
            hint: 'Check your proxy or certificates, then retry.',
        };
    if (kind === 'rate-limited') {
        const retryTime = retryTimeLabel(retryAt);
        return {
            source,
            kind: 'failure',
            reason: 'rate-limited',
            message: `${providerName} API limit reached`,
            hint: `Caxri paused ${providerName} checks to protect the shared API budget. ${
                retryTime ? `Retries after ${retryTime}.` : 'Refresh after the limit resets.'
            }`,
            ...(retryAt !== undefined && { retryAt }),
        };
    }
    if (kind === 'timeout')
        return {
            source,
            kind: 'failure',
            message: `${displayName} timed out`,
            hint: 'Check the network or proxy, then refresh.',
        };
    return {
        source,
        kind: 'failure',
        message: subject ? `${displayName}: ${subject} failed` : `${displayName} failed`,
        hint: `Something went wrong while loading ${provider.resource}. Open Logs for details.`,
        /*
         * The record this branch is about is the `project_status.cli` failure `ExternalStatusCommandTelemetry` writes at
         * `warn`. `error` rides along because the same lookup can also fail further up, outside that observer, and an
         * error the user went looking for should not be the one level the panel hid.
         */
        logs: { filter: 'project_status.cli', levels: ['warn', 'error'] },
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
