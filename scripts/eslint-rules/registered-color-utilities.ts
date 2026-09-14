import type { Rule } from 'eslint';

import {
    rawOnlyColorNames,
    registeredColorRoles,
    tailwindPaletteNames,
} from '../renderer-color-tokens';

/**
 * Tailwind utilities whose value is a color. `text-`, `border-`, `divide-`, and `outline-` are overloaded with size and
 * style utilities, which is why this rule matches the token against known color names instead of rejecting whatever it
 * fails to recognize: an unknown token is far more likely to be `text-[12px]` than a color.
 */
const COLOR_UTILITY_PREFIXES = [
    'accent',
    'bg',
    'border',
    'caret',
    'decoration',
    'divide',
    'fill',
    'from',
    'outline',
    'placeholder',
    'ring',
    'shadow',
    'stroke',
    'text',
    'to',
    'via',
];

const paletteNames = new Set(tailwindPaletteNames);
const rawOnly = new Set(rawOnlyColorNames);
const registered = new Set(registeredColorRoles);

/**
 * The color token a class name carries, with the variant chain and the opacity modifier dropped: `white` for
 * `bg-white/60`, `selection` for `hover:bg-selection`. Undefined for anything not shaped like a color utility.
 */
function colorToken(className: string): string | undefined {
    const base = className.split(':').pop() ?? className;
    const withoutOpacity = base.split('/', 1)[0] ?? base;
    const prefix = COLOR_UTILITY_PREFIXES.find((candidate) =>
        withoutOpacity.startsWith(`${candidate}-`),
    );
    if (prefix === undefined) return undefined;
    const token = withoutOpacity.slice(prefix.length + 1);
    // `bg-[var(--selection)]` is the sanctioned escape hatch for a raw color; it resolves at runtime, not through a
    // registered token, so it is deliberately out of scope.
    return token.startsWith('[') ? undefined : token;
}

/**
 * The color name a token names, if any: `white` for `white`, `blue` for `blue-500`, `git-added` for `git-added`.
 */
function paletteName(token: string): string {
    const shaded = /^([a-z]+)-\d{2,3}$/.exec(token);
    return shaded?.[1] ?? token;
}

const rule: Rule.RuleModule = {
    create(context) {
        function checkClassName(className: string, node: Rule.Node): void {
            const token = colorToken(className);
            if (token === undefined || registered.has(token)) return;
            const name = paletteName(token);
            if (rawOnly.has(name)) {
                context.report({
                    data: { className, name },
                    messageId: 'rawThemeColor',
                    node,
                });
                return;
            }
            if (paletteNames.has(name)) {
                context.report({ data: { className }, messageId: 'unregisteredPalette', node });
            }
        }

        function checkLiteral(value: string, node: Rule.Node): void {
            for (const className of value.split(/\s+/)) {
                if (className.length > 0) checkClassName(className, node);
            }
        }

        return {
            Literal(node) {
                if (typeof node.value === 'string') checkLiteral(node.value, node);
            },
            TemplateElement(node) {
                checkLiteral(node.value.cooked ?? node.value.raw, node);
            },
        };
    },
    meta: {
        docs: {
            description:
                'Rejects Tailwind color utilities that resolve to no registered token, which render silently unstyled.',
        },
        messages: {
            rawThemeColor:
                '`{{className}}` names `--{{name}}`, a raw theme color with no semantic role, so it produces no CSS. Reference it directly as `[var(--{{name}})]`.',
            unregisteredPalette:
                "`{{className}}` uses Tailwind's default palette, which `theme.css` unregisters, so it produces no CSS. Use a semantic role from the `@theme inline` bridge.",
        },
        schema: [],
        type: 'problem',
    },
};

export default rule;
