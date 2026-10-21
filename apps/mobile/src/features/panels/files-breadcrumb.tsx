import { Fragment, useRef } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { Pressable, ScrollView, Text } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { FileTypeIcon } from './file-type-icon';
import { panelsStyles as styles } from './panels-styles';

/**
 * The open folder path, each segment wearing the same icon as its Files row. Earlier segments jump back to that folder;
 * the current one is plain text. A long path scrolls sideways and starts at its end, where the current location is.
 */
export const FilesBreadcrumb = ({
    onSelect,
    segments,
    theme,
}: {
    /**
     * Receives how many segments to keep, so selecting the first folder keeps one.
     */
    onSelect: (depth: number) => void;
    segments: FileEntry[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const scroll = useRef<ScrollViewInstance>(null);
    return (
        <ScrollView
            contentContainerStyle={styles.crumbTrail}
            horizontal
            onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
            ref={scroll}
            showsHorizontalScrollIndicator={false}
            style={styles.crumbScroll}
            testID="files-breadcrumb"
        >
            {segments.map((entry, index) => {
                const isCurrent = index === segments.length - 1;
                return (
                    <Fragment key={entry.path}>
                        {index > 0 ? <ChevronRight color={theme.muted} size={14} /> : null}
                        <Pressable
                            accessibilityLabel={
                                isCurrent ? undefined : t('panels.openFolder', { name: entry.name })
                            }
                            accessibilityRole={isCurrent ? 'text' : 'button'}
                            disabled={isCurrent}
                            hitSlop={{ bottom: 10, top: 10 }}
                            onPress={() => onSelect(index + 1)}
                            style={styles.crumb}
                            testID={`files-crumb-${index}`}
                        >
                            <FileTypeIcon entry={entry} size={16} theme={theme} />
                            <Text
                                numberOfLines={1}
                                style={[
                                    styles.crumbText,
                                    { color: isCurrent ? theme.text : theme.muted },
                                ]}
                            >
                                {entry.name}
                            </Text>
                        </Pressable>
                    </Fragment>
                );
            })}
        </ScrollView>
    );
};
