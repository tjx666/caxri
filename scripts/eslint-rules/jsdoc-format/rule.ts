import type { Rule } from 'eslint';

import { formatJsdocCommentValue } from './format-comment';

const TYPESCRIPT_EXTENSION = /\.[mc]?tsx?$/;

/**
 * Repository tab width for JavaScript and TypeScript, as `bunfig.toml` `[fmt]` declares it.
 */
const TAB_WIDTH = 4;

/**
 * Prints a comment value the way Prettier prints a block comment (`isIndentableBlockComment` and
 * `printIndentableBlockComment` in Prettier's `src/language-js/print/comment.js`): a multi-line comment whose lines all
 * start with `*` is re-indented to the comment's line, any other comment is printed verbatim.
 */
function printBlockComment(value: string, indentation: string): string {
    const lines = value.split('\n');
    const indentable =
        lines.length > 1 &&
        `*${value}*`.split('\n').every((line) => line.trimStart().startsWith('*'));
    if (!indentable) return `/*${value}*/`;
    const printed = lines.map((line, index) => {
        if (index === 0) return line.trimEnd();
        return ` ${index < lines.length - 1 ? line.trim() : line.trimStart()}`;
    });
    return `/*${printed.join(`\n${indentation}`)}*/`;
}

/**
 * Returns the indentation the formatter gives a block comment's continuation lines. A comment that starts its line is
 * indented like that line. One that follows code (`cond ? a : /** ... *\/ b`) is indented by the enclosing AST node,
 * which only the formatter knows, so keep the indentation the source already has before the closing `*\/`; the rule
 * runs after the formatter, so that is the formatter's choice.
 */
function continuationIndentation(before: string, value: string): string {
    const lineIndentation = /^[ \t]*/.exec(before)![0];
    if (lineIndentation === before || !value.includes('\n')) return lineIndentation;
    const closingLine = value.slice(value.lastIndexOf('\n') + 1);
    return /^[ \t]*$/.test(closingLine) ? closingLine.replace(/ $/, '') : lineIndentation;
}

/**
 * Formats JSDoc comments: tag order and spelling, capitalized and whitespace-normalized descriptions, Markdown lists,
 * and wrapping at 120 columns. It replaces `prettier-plugin-jsdoc`, which the repository formatter (`bun fmt`) does not
 * load; the formatter leaves comment text alone, so this rule owns it without either tool undoing the other.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'layout',
        fixable: 'whitespace',
        schema: [],
        messages: {
            format: 'Format this JSDoc comment (run ESLint with --fix).',
            empty: 'Remove this empty JSDoc comment.',
        },
    },
    create(context) {
        const { sourceCode } = context;
        const text = sourceCode.getText();
        const parser = TYPESCRIPT_EXTENSION.test(context.filename) ? 'typescript' : 'babel';
        return {
            Program() {
                for (const comment of sourceCode.getAllComments()) {
                    if (
                        comment.type !== 'Block' ||
                        !comment.value.startsWith('*') ||
                        !comment.range
                    )
                        continue;
                    const [start, end] = comment.range;
                    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
                    const before = text.slice(lineStart, start);
                    const preceding = /[ \t]*$/.exec(before)![0];
                    const value = formatJsdocCommentValue(comment.value, {
                        cwd: context.cwd,
                        parser,
                        precedingSpaces: preceding.replaceAll('\t', '').length,
                        precedingTabs: preceding.length - preceding.replaceAll('\t', '').length,
                        tabWidth: TAB_WIDTH,
                        textAfter: text.slice(end),
                    });
                    if (value === undefined) continue;
                    if (value === '') {
                        context.report({
                            loc: comment.loc!,
                            messageId: 'empty',
                            fix(fixer) {
                                const lineEnd = text.indexOf('\n', end);
                                const after = text.slice(
                                    end,
                                    lineEnd === -1 ? text.length : lineEnd,
                                );
                                if (!before.trim() && !after.trim()) {
                                    return fixer.removeRange([
                                        lineStart,
                                        lineEnd === -1 ? text.length : lineEnd + 1,
                                    ]);
                                }
                                return fixer.removeRange([start, end]);
                            },
                        });
                        continue;
                    }
                    const indentation = continuationIndentation(before, comment.value);
                    const printed = printBlockComment(value, indentation);
                    if (printed === text.slice(start, end)) continue;
                    context.report({
                        loc: comment.loc!,
                        messageId: 'format',
                        fix: (fixer) => fixer.replaceTextRange([start, end], printed),
                    });
                }
            },
        };
    },
};

export default rule;
