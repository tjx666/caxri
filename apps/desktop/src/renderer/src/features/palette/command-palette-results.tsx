import type { ReactNode } from 'react';
import { Fragment } from 'react';

import { useCommandState } from 'cmdk';

import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandList,
} from '../../components/ui/command';
import { useTranslation } from '../../i18n';
import { rankPaletteEntries } from './command-palette-search';

export interface CommandPaletteEntry {
    id: string;
    value: string;
    content: ReactNode;
}

interface CommandPaletteGroup {
    id: string;
    heading: string;
    entries: readonly CommandPaletteEntry[];
}

function PaletteResultList({ groups }: { groups: readonly CommandPaletteGroup[] }) {
    const { t } = useTranslation();
    const search = useCommandState((state) => state.search);
    const matches = rankPaletteEntries(
        groups.flatMap(({ entries }) => entries),
        search,
    );
    return (
        <CommandList>
            <CommandEmpty>{t('palette.empty')}</CommandEmpty>
            {search.trim()
                ? matches.map(({ id, content }) => <Fragment key={id}>{content}</Fragment>)
                : groups.map(({ id, heading, entries }) => (
                      <CommandGroup key={id} heading={heading}>
                          {entries.map((entry) => (
                              <Fragment key={entry.id}>{entry.content}</Fragment>
                          ))}
                      </CommandGroup>
                  ))}
        </CommandList>
    );
}

/**
 * Query state stays below the palette's Session and Terminal reads. Explicit filtering lets React order every match
 * together and restore the original groups when the query is cleared.
 */
export function CommandPaletteResults({ groups }: { groups: readonly CommandPaletteGroup[] }) {
    const { t } = useTranslation();
    return (
        <Command label={t('palette.title')} className="w-full" shouldFilter={false}>
            <CommandInput autoFocus placeholder={t('palette.searchPlaceholder')} />
            <PaletteResultList groups={groups} />
        </Command>
    );
}
