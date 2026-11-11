import type { FSWatcher } from 'fs';

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron';
import Store from 'electron-store';
import { promises as fs, watch as fsWatch } from 'fs';
import path from 'path';

import { isTrustedIpcSender } from '../../../index';
import { validateReadableFile } from '../../../security/file-policy';
import {
    isAllowedSettingsKey,
    isValidServerId,
    isValidStoredPassword,
    validateSettingsWrite,
} from '../../../security/ipc-policy';

import log from '/@/main/logger';
import { Platform, type TitleTheme } from '/@/shared/types/types';

const getFrame = () => {
    const isWindows = process.platform === 'win32';
    const isMacOS = process.platform === 'darwin';

    if (isWindows) {
        return Platform.WINDOWS;
    }

    if (isMacOS) {
        return Platform.MACOS;
    }

    return Platform.LINUX;
};

const isDevelopment = process.env.NODE_ENV === 'development';

const defaultUserDataPath = app.getPath('userData');
const storePath = isDevelopment
    ? path.normalize(`${defaultUserDataPath}-dev`)
    : path.normalize(defaultUserDataPath);

const CUSTOM_CSS_FILENAME = 'custom.css';
const customCssPath = path.join(storePath, CUSTOM_CSS_FILENAME);
let customCssWatcher: FSWatcher | null = null;
let customCssDebounce: NodeJS.Timeout | null = null;

const readCustomCss = async (): Promise<{ content: string; exists: boolean }> => {
    try {
        const content = await fs.readFile(customCssPath, 'utf8');
        return { content, exists: true };
    } catch (error) {
        const fsError = error as NodeJS.ErrnoException;
        if (fsError.code === 'ENOENT') {
            return { content: '', exists: false };
        }

        log.error('Failed to read custom css file', error);
        return { content: '', exists: false };
    }
};

const notifyCustomCssUpdate = async () => {
    const { content, exists } = await readCustomCss();
    BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send('custom-css-updated', {
            content,
            exists,
            path: customCssPath,
        });
    });
};

const scheduleCustomCssUpdate = () => {
    if (customCssDebounce) {
        clearTimeout(customCssDebounce);
    }

    customCssDebounce = setTimeout(() => {
        notifyCustomCssUpdate().catch((error) => {
            log.error('Failed to broadcast custom css update', error);
        });
    }, 100);
};

const startCustomCssWatcher = async () => {
    if (customCssWatcher) return;

    try {
        await fs.mkdir(storePath, { recursive: true });
        customCssWatcher = fsWatch(storePath, (eventType, filename) => {
            if (!filename) return;
            if (filename.toString() !== CUSTOM_CSS_FILENAME) return;

            if (eventType === 'change' || eventType === 'rename') {
                scheduleCustomCssUpdate();
            }
        });
    } catch (error) {
        log.error('Failed to watch custom css file', error);
    }
};

export const store = new Store<any>({
    beforeEachMigration: (_store, context) => {
        log.info(`settings migrate from ${context.fromVersion} → ${context.toVersion}`);
    },
    cwd: storePath,
    defaults: {
        enableNeteaseTranslation: false,
        global_media_hotkeys: true,
        lyrics: ['NetEase', 'lrclib.net'],
        mediaSession: false,
        playbackType: 'web',
        should_prompt_accessibility: true,
        shown_accessibility_warning: false,
        visualizer_system_audio_consent_granted: false,
        window_enable_tray: true,
        window_exit_to_tray: false,
        window_minimize_to_tray: false,
        window_start_minimized: false,
        window_window_bar_style: getFrame(),
    },
    migrations: {
        '>=0.21.2': (store) => {
            store.set('window_bar_style', 'linux');
        },
        '>=1.0.0': (store) => {
            store.clear();
        },
    },
});

ipcMain.handle('settings-get', (event, data: { property: string }) => {
    if (!isTrustedIpcSender(event)) return undefined;
    if (!data || typeof data.property !== 'string' || data.property === 'server') return undefined;
    return store.get(data.property);
});

ipcMain.on('settings-set', (event, data: { property: string; value: any }) => {
    if (!isTrustedIpcSender(event)) return;

    // Preserve the original "undefined deletes" semantics, but only for keys the
    // renderer is allowed to own.
    if (data?.value === undefined) {
        if (!isAllowedSettingsKey(data?.property)) {
            log.warn('Rejected settings delete', { reason: 'protected-property' });
            return;
        }
        store.delete(data!.property);
        return;
    }

    const decision = validateSettingsWrite(data?.property, data?.value);
    if (!decision.ok) {
        log.warn('Rejected settings write', { reason: decision.reason });
        return;
    }

    store.set(data.property, decision.value);
});

ipcMain.handle('settings-set-sync', (event, data: { property: string; value: any }) => {
    if (!isTrustedIpcSender(event)) return false;

    if (data?.value === null) {
        if (!isAllowedSettingsKey(data?.property)) {
            log.warn('Rejected settings delete', { reason: 'protected-property' });
            return false;
        }
        store.delete(data!.property);
        return true;
    }

    const decision = validateSettingsWrite(data?.property, data?.value);
    if (!decision.ok) {
        log.warn('Rejected settings write', { reason: decision.reason });
        return false;
    }

    store.set(data.property, decision.value);
    return true;
});

ipcMain.handle('password-get', (event, server: string): null | string => {
    if (!isTrustedIpcSender(event)) return null;
    if (!isValidServerId(server)) return null;

    if (safeStorage.isEncryptionAvailable()) {
        const servers = store.get('server') as Record<string, string> | undefined;

        if (!servers) {
            return null;
        }

        const encrypted = servers[server];
        if (!encrypted) return null;

        const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'hex'));
        return decrypted;
    }

    log.warn('Password encryption unavailable', { serverId: server });
    return null;
});

ipcMain.on('password-remove', (event, server: string) => {
    if (!isTrustedIpcSender(event) || !isValidServerId(server)) return;

    const passwords = store.get('server', {}) as Record<string, string>;
    if (server in passwords) {
        delete passwords[server];
    }
    store.set({ server: passwords });
    log.info('Password removed', { serverId: server });
});

ipcMain.handle('password-set', (event, password: string, server: string) => {
    if (!isTrustedIpcSender(event)) return false;
    if (!isValidServerId(server) || !isValidStoredPassword(password)) return false;

    if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(password);
        const passwords = store.get('server', {}) as Record<string, string>;
        passwords[server] = encrypted.toString('hex');
        store.set({ server: passwords });

        log.info('Password saved', { serverId: server });
        return true;
    }

    log.warn('Password encryption unavailable', { serverId: server });
    return false;
});

const TITLE_THEME_VALUES: TitleTheme[] = ['dark', 'light', 'system'];

ipcMain.on('theme-set', (event, theme: TitleTheme) => {
    if (!isTrustedIpcSender(event)) return;
    if (!TITLE_THEME_VALUES.includes(theme)) return;

    store.set('theme', theme);
    nativeTheme.themeSource = theme;
});

ipcMain.handle('font-select-file', async (event) => {
    if (!isTrustedIpcSender(event)) return null;

    const result = await dialog.showOpenDialog({
        filters: [{ extensions: ['otf', 'ttc', 'ttf', 'woff', 'woff2'], name: 'Fonts' }],
        properties: ['openFile'],
    });

    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;

    const validated = await validateReadableFile(selectedPath, 'font');
    if (!validated.ok || !validated.paths?.[0]) {
        log.warn('Rejected custom font selection', { reason: validated.reason });
        return null;
    }

    store.set('local_font_path', validated.paths[0]);
    return validated.paths[0];
});

ipcMain.handle('font-clear-file', (event) => {
    if (!isTrustedIpcSender(event)) return false;
    store.delete('local_font_path');
    return true;
});

ipcMain.handle('custom-css-get', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    const { content, exists } = await readCustomCss();
    return {
        content,
        exists,
        path: customCssPath,
    };
});

ipcMain.handle('custom-css-save', async (event, data: { content: string }) => {
    if (!isTrustedIpcSender(event)) return false;
    const content = typeof data?.content === 'string' ? data.content : '';
    if (content.length > 1024 * 1024) {
        log.warn('Rejected custom CSS larger than 1 MiB');
        return false;
    }

    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(customCssPath, content, 'utf8');
    await notifyCustomCssUpdate();
    return true;
});

ipcMain.handle('custom-css-open-folder', async (event) => {
    if (!isTrustedIpcSender(event)) return false;
    await fs.mkdir(storePath, { recursive: true });
    await shell.openPath(storePath);
    return true;
});

app.whenReady()
    .then(() => startCustomCssWatcher())
    .catch((error) => log.error('Failed to start custom css watcher', error));

app.on('before-quit', () => {
    if (customCssWatcher) {
        customCssWatcher.close();
        customCssWatcher = null;
    }

    if (customCssDebounce) {
        clearTimeout(customCssDebounce);
        customCssDebounce = null;
    }
});
