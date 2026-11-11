import { t } from 'i18next';
import { useCallback, useRef, useState } from 'react';

import { DiffVisualiser } from '/@/renderer/components/settings-diff-visualiser/settings-diff-visualiser';
import {
    migrateSettings,
    type SettingsState,
    useSettingsForExport,
    useSettingsStoreActions,
    ValidationSettingsStateSchema,
} from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { DragDropZone } from '/@/shared/components/drag-drop-zone/drag-drop-zone';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import {
    prepareSettingsImport,
    SETTINGS_IMPORT_MAX_BYTES,
    type SettingsImportResult,
} from '/@/shared/utils/settings-import';

enum SCREENS {
    FILE_PICKER,
    DIFF_VISUALS,
    IMPORT_COMPLETE,
}

const importErrorMessage = (result: Extract<SettingsImportResult, { ok: false }>): string => {
    switch (result.code) {
        case 'empty':
        case 'invalid-json':
        case 'invalid-root':
            return t('setting.exportImportSettings_notValidJSON').toString();
        case 'invalid-version':
            return t('setting.exportImportSettings_invalidVersion').toString();
        case 'migration-failed':
            return t('setting.exportImportSettings_migrationFailed').toString();
        case 'read-failed':
            return t('setting.exportImportSettings_readError').toString();
        case 'schema-invalid': {
            const separator = result.detail?.indexOf(': ') ?? -1;
            const offendingKey = separator >= 0 ? result.detail!.slice(0, separator) : 'settings';
            const reason = separator >= 0 ? result.detail!.slice(separator + 2) : result.detail;
            return t('setting.exportImportSettings_offendingKeyError', {
                offendingKey,
                reason: reason ?? 'invalid settings',
            }).toString();
        }
        case 'too-large':
            return t('setting.exportImportSettings_fileTooLarge').toString();
        default:
            return t('setting.exportImportSettings_notValidJSON').toString();
    }
};

export const ExportImportSettingsModal = () => {
    const { version: currentVersion, ...currentSettings } = useSettingsForExport();
    const { setSettings } = useSettingsStoreActions();

    const [currentScreen, setCurrentScreen] = useState<SCREENS>(SCREENS.FILE_PICKER);
    const [selectedSettingsFile, setSettingsFile] = useState<SettingsState>();
    const preparedSettingsRef = useRef<null | SettingsState>(null);

    const validateItemSelected = useCallback(
        (itemContents: string): { error?: string; isValid: boolean } => {
            preparedSettingsRef.current = null;

            const result = prepareSettingsImport(itemContents, {
                currentSettings: currentSettings as unknown as Record<string, unknown>,
                currentVersion,
                migrate: (settings, version) => migrateSettings(settings as SettingsState, version),
                validate: (settings) => ValidationSettingsStateSchema.safeParse(settings),
            });

            if (!result.ok) {
                return { error: importErrorMessage(result), isValid: false };
            }

            // Preview and the eventual write must use this exact validated object.
            preparedSettingsRef.current = result.settings as SettingsState;
            return { isValid: true };
        },
        [currentSettings, currentVersion],
    );

    const onItemSelected = useCallback(() => {
        if (!preparedSettingsRef.current) return;
        setSettingsFile(preparedSettingsRef.current);
        setCurrentScreen(SCREENS.DIFF_VISUALS);
    }, []);

    const onImportClick = useCallback(() => {
        if (selectedSettingsFile) {
            setSettings(selectedSettingsFile);
            setCurrentScreen(SCREENS.IMPORT_COMPLETE);
        }
    }, [selectedSettingsFile, setSettings]);

    return (
        <>
            {currentScreen === SCREENS.FILE_PICKER ? (
                <Stack>
                    <DragDropZone
                        icon="fileJson"
                        maxBytes={SETTINGS_IMPORT_MAX_BYTES}
                        onItemSelected={onItemSelected}
                        validateItem={validateItemSelected}
                    />
                </Stack>
            ) : null}
            {currentScreen === SCREENS.DIFF_VISUALS ? (
                <Stack>
                    <DiffVisualiser
                        newSettings={selectedSettingsFile!}
                        originalSettings={currentSettings}
                    />
                    <Text size="sm" ta="center">
                        {t('setting.exportImportSettings_destructiveWarning').toString()}
                    </Text>
                    <Button onClick={onImportClick} variant="state-info">
                        {t('setting.exportImportSettings_importBtn').toString()}
                    </Button>
                </Stack>
            ) : null}
            {currentScreen === SCREENS.IMPORT_COMPLETE ? (
                <Text py="md" ta="center">
                    {t('setting.exportImportSettings_importSuccess').toString()}
                </Text>
            ) : null}
        </>
    );
};
