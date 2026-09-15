import { MAX_TRUSTED_FOLDERS, normalizeTrustedFolderRule } from '@caxri/protocol';

import { RuleListForm } from './rule-list-form';

interface TrustedFoldersFormProperties {
    rules: string[];
    onChange: (rules: string[]) => void;
}

/**
 * Structured Settings editor for absolute folder paths trusted for read-only Terminal file link opens.
 */
export function TrustedFoldersForm({ rules, onChange }: TrustedFoldersFormProperties) {
    return (
        <RuleListForm
            ariaLabel="Trusted Folders editor"
            // The row above already says what trusting a folder does; repeating it here left the same sentence printed
            // twice on one screen. This line carries only what the row cannot: the shape of an entry.
            description="Paths must be absolute. A trusted folder covers everything under it."
            placeholder="/Users/me/.config"
            inputLabel="Trusted folder rule"
            listLabel="Trusted folder rules"
            emptyText="No user-defined trusted folders."
            normalize={normalizeTrustedFolderRule}
            invalidMessage="Enter an absolute folder path."
            duplicateMessage="This folder is already trusted."
            maximum={MAX_TRUSTED_FOLDERS}
            maximumMessage={`Trusted Folders supports at most ${MAX_TRUSTED_FOLDERS} rules.`}
            removeLabel={(rule) => `Remove trusted folder ${rule}`}
            rules={rules}
            onChange={onChange}
        />
    );
}
