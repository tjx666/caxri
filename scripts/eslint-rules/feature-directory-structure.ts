import { readdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { Rule } from 'eslint';

/**
 * Matches a colocated test file directly inside a feature directory (`foo.test.ts`, `foo.integration.test.tsx`).
 */
const testFilePattern = /\.test\.tsx?$/;
/**
 * Matches a feature-local hook module (`use-project-order.ts`); hooks are `.ts` per the naming contract.
 */
const hookFilePattern = /^use-[a-z0-9-]+\.ts$/;

interface DirectoryShape {
    colocatedTestCount: number;
    flatHookCount: number;
    hasHooksDir: boolean;
    hasTestsDir: boolean;
    hasUtilsDir: boolean;
}

const emptyShape: DirectoryShape = {
    colocatedTestCount: 0,
    flatHookCount: 0,
    hasHooksDir: false,
    hasTestsDir: false,
    hasUtilsDir: false,
};

/**
 * Directory listings are cached because every file in a directory triggers the same directory-level checks. The cache
 * is keyed on the directory's mtime, which changes whenever a direct child is added, removed, or renamed (exactly the
 * events this rule observes), so a long-lived lint process (the VS Code ESLint server) sees edits instead of serving
 * stale shapes forever.
 */
const directoryShapes = new Map<string, { mtimeMs: number; shape: DirectoryShape }>();

function readDirectoryShape(directory: string): DirectoryShape {
    let mtimeMs: number;
    try {
        // ESLint rules execute synchronously, so the async-fs preference cannot apply here.
        // oxlint-disable-next-line node/no-sync -- ESLint's rule API is synchronous
        mtimeMs = statSync(directory).mtimeMs;
    } catch {
        // An unreadable directory (e.g. an in-memory lint of unsaved text) simply reports no findings.
        return emptyShape;
    }

    const cached = directoryShapes.get(directory);
    if (cached?.mtimeMs === mtimeMs) return cached.shape;

    const shape: DirectoryShape = { ...emptyShape };
    try {
        // oxlint-disable-next-line node/no-sync -- ESLint's rule API is synchronous
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                shape.hasTestsDir ||= entry.name === '__tests__';
                shape.hasHooksDir ||= entry.name === 'hooks';
                shape.hasUtilsDir ||= entry.name === 'utils';
                continue;
            }
            if (testFilePattern.test(entry.name)) shape.colocatedTestCount += 1;
            else if (hookFilePattern.test(entry.name)) shape.flatHookCount += 1;
        }
    } catch {
        return emptyShape;
    }
    directoryShapes.set(directory, { mtimeMs, shape });
    return shape;
}

/**
 * Enforces the Renderer feature-directory scale contract from `.agents/skills/source-layout/SKILL.md` section 3: a kind
 * of file (tests, feature-local hooks, utils) stays flat below the threshold and earns a kind folder (`__tests__/`,
 * `hooks/`, `utils/`) at the threshold, and the flat form never coexists with the folder.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'enforce the feature-directory scale thresholds for __tests__/, hooks/, and utils/',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    threshold: { type: 'integer', minimum: 2 },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            consolidateTests:
                'This directory holds {{count}} colocated test files (threshold {{threshold}}); move them into __tests__/.',
            coexistTests:
                '__tests__/ already exists in this directory; move this colocated test file into it.',
            consolidateHooks:
                'This directory holds {{count}} flat use-* hooks (threshold {{threshold}}); move them into hooks/.',
            coexistHooks:
                'hooks/ already exists in this directory; move this feature-local hook into it.',
            coexistUtils:
                'utils.ts and utils/ must not coexist; fold this file into utils/ as a named module.',
        },
    },
    create(context) {
        const options = (context.options[0] ?? {}) as { threshold?: number };
        const threshold = options.threshold ?? 3;
        const filename = context.filename;
        const directory = dirname(filename);
        const parentName = basename(directory);
        const base = basename(filename);

        return {
            Program(node) {
                const shape = readDirectoryShape(directory);

                if (parentName !== '__tests__' && testFilePattern.test(base)) {
                    if (shape.hasTestsDir) {
                        context.report({ node, messageId: 'coexistTests' });
                    } else if (shape.colocatedTestCount >= threshold) {
                        context.report({
                            node,
                            messageId: 'consolidateTests',
                            data: {
                                count: String(shape.colocatedTestCount),
                                threshold: String(threshold),
                            },
                        });
                    }
                    return;
                }

                if (parentName !== 'hooks' && hookFilePattern.test(base)) {
                    if (shape.hasHooksDir) {
                        context.report({ node, messageId: 'coexistHooks' });
                    } else if (shape.flatHookCount >= threshold) {
                        context.report({
                            node,
                            messageId: 'consolidateHooks',
                            data: {
                                count: String(shape.flatHookCount),
                                threshold: String(threshold),
                            },
                        });
                    }
                    return;
                }

                if (base === 'utils.ts' && shape.hasUtilsDir) {
                    context.report({ node, messageId: 'coexistUtils' });
                }
            },
        };
    },
};

export default rule;
