/**
 * Renderer functions React Compiler currently skips, as `file -> reasons`. The coverage test in
 * `scripts/__tests__/react-compiler-coverage.test.ts` fails on any bailout missing here and on any entry that now
 * compiles, so this ledger only shrinks. Do not add an entry for new code: rewrite it so it compiles.
 */
export const knownReactCompilerBailouts: Record<string, readonly string[]> = {
    // the focus effect runs on a question change only on purpose, so its exhaustive-deps suppression stays.
    'apps/desktop/src/renderer/src/features/agent-chat/transcript/questions/agent-chat-question-form.tsx':
        [
            'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
        ],
    // incompatible library: TanStack Virtual.
    'apps/desktop/src/renderer/src/features/panel/views/logs/log-viewer-panel.tsx': [
        'Use of incompatible library',
    ],
    // incompatible library: TanStack Virtual.
    'apps/desktop/src/renderer/src/features/preview/csv-preview.tsx': [
        'Use of incompatible library',
    ],
    // lazy ref initialisation with `??=`; the lint rule `prefer-nullish-coalescing` rejects the expanded `if`, and a `useState` initializer
    // surfaces `set-state-in-effect` errors in this hook's effects.
    'apps/desktop/src/renderer/src/features/primary-sidebar/hooks/use-project-order.ts': [
        '(BuildHIR::lowerExpression) Handle ??= operators in AssignmentExpression',
    ],
    // the request effect keys on `renameRequest?.id` only on purpose, so its exhaustive-deps suppression stays.
    'apps/desktop/src/renderer/src/features/primary-sidebar/hooks/use-session-rename.ts': [
        'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
    ],
    // incompatible library: TanStack Virtual.
    'apps/desktop/src/renderer/src/features/settings/settings-page.tsx': [
        'Use of incompatible library',
    ],
    // lazy ref initialisation with `??=`; an expanded `if` and a `useState` initializer both fail with "Cannot access refs during render".
    'apps/desktop/src/renderer/src/features/settings/hooks/use-settings-page-controller.ts': [
        '(BuildHIR::lowerExpression) Handle ??= operators in AssignmentExpression',
        '(BuildHIR::lowerExpression) Handle ??= operators in AssignmentExpression',
    ],
    // the PTY attach effect omits unstable search/size callbacks from its deps on purpose, so its exhaustive-deps suppression stays.
    'apps/desktop/src/renderer/src/features/terminal/hooks/use-terminal-pane-runtime.ts': [
        'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
    ],
    // incompatible library: TanStack Virtual.
    'apps/desktop/src/renderer/src/features/view-containers/extension-tree-view.tsx': [
        'Use of incompatible library',
    ],
    // incompatible library: TanStack Virtual, plus effects that read the live virtualizer.
    'apps/desktop/src/renderer/src/features/view-containers/resource-explorer/file-tree.tsx': [
        'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
        'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
    ],
    // incompatible library: TanStack Virtual.
    'apps/desktop/src/renderer/src/features/view-containers/source-control/source-control-tree-items.tsx':
        ['Use of incompatible library'],
    // the value-keyed memo on `signature` is the point of the hook, so its exhaustive-deps suppression stays.
    'apps/desktop/src/renderer/src/hooks/use-editor-options.ts': [
        'React Compiler has skipped optimizing this component because one or more React ESLint rules were disabled',
    ],
};
