import { Prism } from 'prism-react-renderer';

/**
 * `prism-react-renderer` bundles no shell or diff grammar, yet Agent Chat paints commands and their output as shell and
 * `git diff` output as a diff, as Desktop does. These compact grammars name only token types the Dracula theme colors,
 * so every match shows: strings, variables, keywords, flags, and comments for shell; added, removed, and header lines
 * for a diff.
 */
const shellGrammar = {
    'comment': { pattern: /(^|\s)#.*/u, lookbehind: true },
    'string': {
        pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^'\n]*'/u,
        greedy: true,
    },
    'variable': /\$(?:\w+|[!#$*?@-]|\{[^\n}]+\})/u,
    'keyword': {
        pattern:
            /(^|[\s;&|(])(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|return|then|until|while)(?=$|[\s;&|)])/mu,
        lookbehind: true,
    },
    'attr-name': { pattern: /(^|\s)--?[A-Za-z][\w-]*/u, lookbehind: true },
};

const diffGrammar = {
    comment: /^(?:diff |index |--- |\+\+\+ |new file mode|deleted file mode).*$/mu,
    constant: /^@@.*$/mu,
    inserted: /^\+.*$/mu,
    deleted: /^-.*$/mu,
};

Prism.languages.bash = shellGrammar;
Prism.languages.diff = diffGrammar;
