import { useId, useRef, useState } from 'react';

import { LockKeyhole } from 'lucide-react';

import { useFocusOnRevision } from '@/hooks/use-focus-on-revision';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';

/**
 * What a password-protected PDF shows in place of its pages: the field takes focus when the form appears and again,
 * with its text selected, after each rejected password, so a reader retypes without reaching for the pointer. The
 * password is held only by the field and the reading hook; it never reaches a log or persisted state.
 */
export function PdfPasswordForm({
    attempt,
    isChecking,
    isIncorrect,
    onSubmit,
}: {
    /**
     * The read that asked for the password; a new value after a wrong password refocuses the field.
     */
    attempt: number;
    isChecking: boolean;
    isIncorrect: boolean;
    onSubmit: (password: string) => void;
}) {
    const { t } = useTranslation();
    const errorId = useId();
    const inputReference = useRef<HTMLInputElement>(null);
    const [password, setPassword] = useState('');
    // `attempt` can be 0 for the tab's first read, and the hook only focuses a truthy revision.
    useFocusOnRevision(attempt + 1, inputReference, { select: true });
    return (
        <Empty className="empty-work h-full flex-1">
            <EmptyMedia>
                <LockKeyhole aria-hidden="true" size={28} />
            </EmptyMedia>
            <EmptyTitle className="max-w-80 text-pretty">
                {t('preview.pdf.passwordPrompt')}
            </EmptyTitle>
            <form
                className="flex w-64 flex-col gap-2"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (password !== '' && !isChecking) onSubmit(password);
                }}
            >
                <div className="flex gap-2">
                    <Input
                        ref={inputReference}
                        aria-describedby={isIncorrect ? errorId : undefined}
                        aria-invalid={isIncorrect}
                        aria-label={t('preview.pdf.password')}
                        autoComplete="off"
                        className="flex-1"
                        placeholder={t('preview.pdf.password')}
                        size="dense"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.currentTarget.value)}
                    />
                    <Button disabled={password === '' || isChecking} size="sm" type="submit">
                        {t('common.open')}
                    </Button>
                </div>
                {isIncorrect && (
                    // Keyed by the attempt so each rejected password is announced again.
                    <p
                        key={attempt}
                        className="m-0 text-left text-[12px] text-danger"
                        id={errorId}
                        role="alert"
                    >
                        {t('preview.pdf.passwordIncorrect')}
                    </p>
                )}
            </form>
        </Empty>
    );
}
