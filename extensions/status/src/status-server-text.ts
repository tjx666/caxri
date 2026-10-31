import { l10n } from 'caxri';

/**
 * The sentences Server Core writes into a Project Status error's `message` and `hint`
 * (`apps/server/src/domains/project-status/external.ts`). The Server composes them in English and sends no structured
 * reason the panel could word itself (#1865), so the Status extension recognizes each one here and renders it through
 * `l10n.t`, which keeps their translations in this extension's bundle beside the rest of the panel's copy. A sentence
 * that matches none of them is shown as sent.
 *
 * `{provider}` and `{service}` match only the four provider names, so a template such as `{provider} failed` cannot
 * swallow an unrelated sentence that happens to end in "failed". Every other placeholder matches any text.
 */
export const SERVER_STATUS_TEXT_TEMPLATES = [
    '{provider} not installed',
    '{provider} not signed in',
    '{provider} not linked',
    'Repository not linked to Vercel',
    '{provider} access denied',
    '{provider} connection failed',
    '{provider} secure connection failed',
    '{service} API limit reached',
    '{provider} timed out',
    '{provider}: {subject} failed',
    '{provider} failed',
    'Pull requests for this repository need the GitHub CLI. Install it, then recheck.',
    'Acceptance reports need the LobeHub CLI. Install it with npm i -g @lobehub/cli, then recheck.',
    'Linked issues need the Linear CLI. Install it, then recheck.',
    'Deployments for this repository need the Vercel CLI. Install it with npm i -g vercel, then recheck.',
    'Run {command} in a Terminal, then recheck. A {variable} environment variable alone is not enough — Caxri does not forward personal shell credentials to CLI checks.',
    'Run linear config in this repository, then recheck.',
    'Run vc link in this repository, then recheck.',
    'Configure {service} for this repository, then recheck.',
    'Run gh auth refresh, authorize SSO for the organization if it requires it, then recheck.',
    'Check that your LobeHub account can read this report, then recheck.',
    'Check that your Linear account can see this team, then recheck.',
    'Check that your Vercel account can access this project, then recheck.',
    'Caxri could not reach {provider}. Check the connection, then recheck.',
    'Check your proxy or certificates, then retry.',
    'Caxri paused {service} checks to protect the shared API budget. Retries after {time}.',
    'Caxri paused {service} checks to protect the shared API budget. Refresh after the limit resets.',
    'Check the network or proxy, then refresh.',
    'Something went wrong while loading pull requests. Open Logs for details.',
    'Something went wrong while loading acceptance reports. Open Logs for details.',
    'Something went wrong while loading linked issues. Open Logs for details.',
    'Something went wrong while loading deployments. Open Logs for details.',
    'No Vercel deployments found',
    'This repository is linked to Vercel, but no matching deployments were found. Create one, then recheck.',
] as const;

const NAMED_PLACEHOLDERS: Readonly<Record<string, string>> = {
    provider: 'GitHub CLI|LobeHub CLI|Linear CLI|Vercel CLI',
    service: 'GitHub|LobeHub|Linear|Vercel',
};

const PLACEHOLDER = /\{(\w+)\}/g;

interface CompiledTemplate {
    names: readonly string[];
    pattern: RegExp;
    template: string;
}

function escapeRegExp(value: string): string {
    return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

function compile(template: string): CompiledTemplate {
    const names: string[] = [];
    let source = '';
    let cursor = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
        source += escapeRegExp(template.slice(cursor, match.index));
        source += `(${NAMED_PLACEHOLDERS[match[1]] ?? String.raw`[\s\S]+?`})`;
        names.push(match[1]);
        cursor = match.index + match[0].length;
    }
    source += escapeRegExp(template.slice(cursor));
    return { names, pattern: new RegExp(`^${source}$`), template };
}

const COMPILED_TEMPLATES: readonly CompiledTemplate[] = SERVER_STATUS_TEXT_TEMPLATES.map(compile);

/**
 * A Server-composed Project Status sentence in the interface language.
 */
export function localizeServerStatusText(text: string): string {
    for (const { names, pattern, template } of COMPILED_TEMPLATES) {
        const match = pattern.exec(text);
        if (!match) continue;
        return l10n.t(
            template,
            Object.fromEntries(names.map((name, index) => [name, match[index + 1]])),
        );
    }
    return text;
}
