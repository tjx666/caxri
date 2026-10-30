import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Keeps the outbound-network inventory in `security.md` from drifting silently. Electron Main, Server Core, and the
 * shared system package may only open a network request from a file listed below, and each listed file names the
 * `security.md` entries (bold list-item titles under "Main outbound requests" or "Server outbound requests") that
 * document it. Adding a request therefore fails here until the author adds the document entry and this mapping; the
 * second test fails when an entry is renamed or deleted without updating the mapping.
 *
 * Known limit: the scan matches literal call sites only. A request made through an injected `fetch` parameter that
 * defaults to the global (for example the Model price list in `usage/pricing.ts`) is reviewed by hand, not detected.
 */
const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');
const SECURITY_DOC = '.agents/skills/project-architecture/references/security.md';
const SCANNED_ROOTS = ['apps/desktop/src/main', 'apps/server/src', 'packages/system/src'];

const REQUEST_CALL =
    /(?<![\w.$])fetch\(|\bnet\.(?:fetch|request)\(|\bhttps?\.request\(|\bnew WebSocket\(/;

/**
 * Source file to the `security.md` entry names that account for its network requests.
 */
const ALLOWED_REQUEST_SITES: Record<string, string[]> = {
    'apps/desktop/src/main/environment-monitor/mihomo-controller.ts': ['Mihomo Controller'],
    'apps/desktop/src/main/link-favicons.ts': ['Link favicons'],
    'apps/desktop/src/main/link-previews.ts': ['Link previews'],
    'apps/desktop/src/main/main-methods.ts': [
        'Agent provider status',
        'Codex global reset forecast',
    ],
    'apps/desktop/src/main/net-request-fetch.ts': ['Link favicons', 'Link previews'],
    'apps/desktop/src/main/notifications/desktop-notifications.ts': ['Environment public exit'],
    'apps/desktop/src/main/public-https-fetch.ts': ['Link favicons', 'Link previews'],
    'apps/desktop/src/main/updates/updates.ts': ['Update check and download'],
    'apps/server/src/core/mobile/agent-usage-requests.ts': ['Agent provider status for mobile'],
    'apps/server/src/core/mobile/relay/host-connector.ts': ['Mobile Relay host connection'],
    'packages/system/src/network/agent-provider-status.ts': ['Agent provider status'],
    'packages/system/src/network/codex-global-reset.ts': ['Codex global reset forecast'],
};

function isTestFile(path: string): boolean {
    return /(?:^|\/)__tests__\/|\.test\.tsx?$/.test(path);
}

function isCommentLine(line: string): boolean {
    return /^\s*(?:\/\/|\/?\*)/.test(line);
}

function filesWithRequestCalls(): string[] {
    const tracked = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCANNED_ROOTS],
        { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
        .split('\n')
        .filter((path) => /\.tsx?$/.test(path) && !isTestFile(path));
    return tracked
        .filter((path) =>
            readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
                .split('\n')
                .some((line) => !isCommentLine(line) && REQUEST_CALL.test(line)),
        )
        .toSorted((a, b) => a.localeCompare(b));
}

describe('network egress inventory', () => {
    it('lists every source file that opens a network request', () => {
        const unlisted = filesWithRequestCalls().filter((path) => !(path in ALLOWED_REQUEST_SITES));
        expect(
            unlisted,
            `Add a "Main outbound requests" or "Server outbound requests" entry to ${SECURITY_DOC}, then list the file in ALLOWED_REQUEST_SITES.`,
        ).toEqual([]);
    });

    it('does not keep an allowlist row for a file that no longer makes requests', () => {
        const present = new Set(filesWithRequestCalls());
        expect(Object.keys(ALLOWED_REQUEST_SITES).filter((path) => !present.has(path))).toEqual([]);
    });

    it('documents every allowlisted entry in security.md', () => {
        const document_ = readFileSync(join(REPOSITORY_ROOT, SECURITY_DOC), 'utf8');
        const entries = new Set(Object.values(ALLOWED_REQUEST_SITES).flat());
        const missing = [...entries].filter((name) => !document_.includes(`- **${name}**`));
        expect(missing).toEqual([]);
    });
});
