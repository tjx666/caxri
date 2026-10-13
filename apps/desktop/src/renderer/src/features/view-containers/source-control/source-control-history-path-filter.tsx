import type { Dispatch, FocusEvent, SetStateAction } from 'react';
import { useRef } from 'react';

import { X } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Input, InputGroup } from '../../../components/ui/input';
import { Tooltip } from '../../../components/ui/tooltip';
import { treeRowTabIndex, useSourceControlTreeFocus } from './source-control-tree-focus';

/**
 * The per-repository `Commits` path filter, as a row of the Source Control tree.
 *
 * A text field is the one control in this panel that cannot be a `treeitem` itself: overriding an `<input>`'s implicit
 * `textbox` role would take away the semantics that make it typeable. `treeitem` is not a children-presentational role,
 * though, so a row _containing_ a field is legal and is the only legal place for one inside `role="tree"`: VS Code
 * reaches the same conclusion, carrying its SCM commit box as a tree element (`InputRenderer` in `scmViewPane.ts`)
 * rather than as a stray focusable beside the list.
 *
 * The row wrapper therefore owns the tree semantics and the field owns the Tab stop: arrow navigation focuses the
 * wrapper, which hands focus straight to the field so the user can type on arrival, and the clear button stays
 * `tabIndex={-1}` like every other inline action in the tree so Tab still leaves after a single stop.
 */
export function SourceControlHistoryPathFilter({
    clearPathLabel,
    inputLabel,
    level,
    path,
    placeholder,
    rowId,
    setPath,
}: {
    clearPathLabel: string;
    inputLabel: string;
    level: number;
    path: string;
    placeholder: string;
    rowId: string;
    setPath: Dispatch<SetStateAction<string>>;
}) {
    const focus = useSourceControlTreeFocus();
    const inputReference = useRef<HTMLInputElement>(null);
    const handleFocus = (event: FocusEvent<HTMLDivElement>): void => {
        focus.focusRow(rowId);
        if (event.target === event.currentTarget) inputReference.current?.focus();
    };
    return (
        <div
            className="commit-path-filter border-y border-border p-1.5 outline-none"
            aria-label={inputLabel}
            aria-level={level}
            data-row-id={rowId}
            role="treeitem"
            tabIndex={-1}
            onFocus={handleFocus}
        >
            <InputGroup appearance="workbench" size="dense">
                <Input
                    ref={inputReference}
                    appearance="embedded"
                    className="flex-1 text-foreground"
                    aria-label={inputLabel}
                    placeholder={placeholder}
                    size="dense"
                    tabIndex={treeRowTabIndex(focus.activeRowId, rowId)}
                    value={path}
                    onChange={(event) => setPath(event.currentTarget.value)}
                />
                {path.length > 0 && (
                    <Tooltip content={clearPathLabel}>
                        <Button
                            className="size-5 shrink-0 rounded-md text-muted enabled:hover:text-foreground"
                            size="icon"
                            variant="ghost"
                            aria-label={clearPathLabel}
                            tabIndex={-1}
                            onClick={() => setPath('')}
                        >
                            <X aria-hidden="true" size={12} />
                        </Button>
                    </Tooltip>
                )}
            </InputGroup>
        </div>
    );
}
