import type { Rule } from 'eslint';
import type { Node } from 'estree';

import { approvedNativeTitles } from './native-title-inventory';

/**
 * Generated HTML that carries a native tooltip: `<span title="...">` or `title='...'` inside a string or template.
 */
const htmlTitleAttribute = /<[a-z][^>]*\stitle\s*=\s*["'\\]/iu;

/**
 * Repo-relative, forward-slash path of the linted file, so the inventory keys are stable across platforms.
 */
function relativePath(context: Rule.RuleContext): string {
    const cwd = context.cwd.replaceAll('\\', '/');
    const filename = context.filename.replaceAll('\\', '/');
    return filename.startsWith(`${cwd}/`) ? filename.slice(cwd.length + 1) : filename;
}

type AttributeNode = Node & {
    name: { type: string; name?: string };
    parent: { name: { type: string; name?: string } };
};

const rule: Rule.RuleModule = {
    create(context) {
        const path = relativePath(context);
        const approved = approvedNativeTitles[path]?.count ?? 0;
        const sites: Node[] = [];

        function record(node: Node): void {
            sites.push(node);
        }

        return {
            'AssignmentExpression': (node) => {
                const { left } = node;
                if (
                    left.type === 'MemberExpression' &&
                    !left.computed &&
                    left.property.type === 'Identifier' &&
                    left.property.name === 'title' &&
                    // `document.title` names the window, not a tooltip.
                    !(left.object.type === 'Identifier' && left.object.name === 'document')
                ) {
                    record(node);
                }
            },
            'CallExpression': (node) => {
                const { arguments: arguments_, callee } = node;
                if (
                    callee.type === 'MemberExpression' &&
                    callee.property.type === 'Identifier' &&
                    callee.property.name === 'setAttribute' &&
                    arguments_[0]?.type === 'Literal' &&
                    arguments_[0].value === 'title'
                ) {
                    record(node);
                }
            },
            'JSXAttribute': (rawNode: Rule.Node) => {
                const node = rawNode as unknown as AttributeNode;
                const opening = node.parent.name;
                // Only host elements reach the DOM `title` attribute; `<Dialog title>` and friends are component props.
                if (
                    node.name.type === 'JSXIdentifier' &&
                    node.name.name === 'title' &&
                    opening.type === 'JSXIdentifier' &&
                    /^[a-z]/u.test(opening.name ?? '')
                ) {
                    record(rawNode);
                }
            },
            'Literal': (node) => {
                if (typeof node.value === 'string' && htmlTitleAttribute.test(node.value))
                    record(node);
            },
            'Program:exit': function () {
                for (const node of sites.slice(approved)) {
                    context.report({ messageId: 'nativeTitle', node });
                }
            },
            'TemplateElement': (node) => {
                if (htmlTitleAttribute.test(node.value.cooked ?? node.value.raw)) record(node);
            },
        };
    },
    meta: {
        docs: {
            description:
                'Rejects native `title` tooltips outside the approved inventory, because they never show on keyboard focus.',
        },
        messages: {
            nativeTitle:
                'A native `title` shows only on mouse hover, so keyboard users never see it. Use the shared `Tooltip` for unique or truncated content; if this title only repeats visible text, add the file to `approvedNativeTitles` in `scripts/eslint-rules/native-title-inventory.ts`.',
        },
        schema: [],
        type: 'problem',
    },
};

export default rule;
