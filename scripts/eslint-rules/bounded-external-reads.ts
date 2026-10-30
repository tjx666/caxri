import type { Rule } from 'eslint';

const fileSystemModules = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
const unboundedReaders = new Set(['readFile', 'readFileSync']);

/**
 * Rejects a bare `readFile` / `readFileSync` from `node:fs` in the modules that read provider- and user-owned files.
 * Those paths can be a FIFO (the read blocks forever), a device, or an arbitrarily large file, and a `stat` before
 * `readFile` is a time-of-check/time-of-use gap. `readBoundedRegularFile` / `readBoundedRegularFileText` from
 * `@caxri/system` open with `O_NONBLOCK`, `fstat` the handle, and cap the size. A read of a file Caxri itself wrote
 * opts out with `// eslint-disable-next-line caxri/bounded-external-reads -- <why Caxri owns this path>`.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            unbounded:
                'Read provider- or user-owned files with readBoundedRegularFile(Text) from @caxri/system. If Caxri wrote this file, disable this rule with a reason naming the owner.',
        },
    },
    create(context) {
        /**
         * Local names bound to `readFile` / `readFileSync` themselves.
         */
        const readerNames = new Set<string>();
        /**
         * Local names bound to a module object whose `readFile` / `readFileSync` member is unbounded (`fs`,
         * `promises`).
         */
        const moduleNames = new Set<string>();
        return {
            ImportDeclaration(node) {
                if (
                    typeof node.source.value !== 'string' ||
                    !fileSystemModules.has(node.source.value)
                )
                    return;
                for (const specifier of node.specifiers) {
                    if (specifier.type !== 'ImportSpecifier') {
                        moduleNames.add(specifier.local.name);
                        continue;
                    }
                    if (specifier.imported.type !== 'Identifier') continue;
                    if (unboundedReaders.has(specifier.imported.name))
                        readerNames.add(specifier.local.name);
                    else if (specifier.imported.name === 'promises')
                        moduleNames.add(specifier.local.name);
                }
            },
            CallExpression(node) {
                const { callee } = node;
                if (callee.type === 'Identifier' && readerNames.has(callee.name))
                    context.report({ node, messageId: 'unbounded' });
                if (
                    callee.type !== 'MemberExpression' ||
                    callee.computed ||
                    callee.property.type !== 'Identifier' ||
                    !unboundedReaders.has(callee.property.name)
                )
                    return;
                // `fs.readFile(...)` or `fs.promises.readFile(...)` through a namespace, default, or `promises` import.
                const owner =
                    callee.object.type === 'MemberExpression' &&
                    !callee.object.computed &&
                    callee.object.property.type === 'Identifier' &&
                    callee.object.property.name === 'promises'
                        ? callee.object.object
                        : callee.object;
                if (owner.type === 'Identifier' && moduleNames.has(owner.name))
                    context.report({ node, messageId: 'unbounded' });
            },
        };
    },
};

export default rule;
