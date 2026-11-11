export type SettingsWriteDecision = { ok: false; reason: string } | { ok: true; value: unknown };

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isString = (value: unknown): value is string => typeof value === 'string';

const stringEnum =
    (values: readonly string[]) =>
    (value: unknown): value is string =>
        isString(value) && values.includes(value);

const PLATFORM_VALUES = ['linux', 'macos', 'web', 'windows'] as const;
const PLAYER_TYPE_VALUES = ['dlna', 'jukebox', 'local', 'web'] as const;
const PASSWORD_STORE_VALUES = ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'] as const;

const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((item) => isString(item) && item.length > 0 && item.length <= 256);

type ValueValidator = (value: unknown) => boolean;

const SETTINGS_WRITE_VALIDATORS: Record<string, ValueValidator> = {
    enableNeteaseTranslation: isBoolean,
    global_media_hotkeys: isBoolean,
    ignore_cors: isBoolean,
    ignore_ssl: isBoolean,
    lyrics: isStringArray,
    mediaSession: isBoolean,
    password_store: stringEnum(PASSWORD_STORE_VALUES),
    playbackType: stringEnum(PLAYER_TYPE_VALUES),
    resume: isBoolean,
    visualizer_system_audio_consent_granted: isBoolean,
    window_enable_tray: isBoolean,
    window_exit_to_tray: isBoolean,
    window_minimize_to_tray: isBoolean,
    window_prevent_sleep_on_playback: isBoolean,
    window_prevent_suspend_on_playback: isBoolean,
    window_start_minimized: isBoolean,
    window_window_bar_style: stringEnum(PLATFORM_VALUES),
};

/**
 * Generic settings-set is a renderer convenience path, not a privileged one. It may
 * only write the keys the renderer legitimately owns. Paths, credentials and anything
 * the main process manages itself are rejected so a compromised renderer cannot use
 * this channel as a side door.
 */
export const isAllowedSettingsKey = (property: unknown): property is string => {
    if (!isString(property) || property.length === 0 || property.length > 128) return false;
    return Object.hasOwn(SETTINGS_WRITE_VALIDATORS, property);
};

export const validateSettingsWrite = (property: unknown, value: unknown): SettingsWriteDecision => {
    if (!isAllowedSettingsKey(property)) {
        return { ok: false, reason: 'protected-property' };
    }

    const validator = SETTINGS_WRITE_VALIDATORS[property];
    if (!validator(value)) {
        return { ok: false, reason: 'invalid-value' };
    }

    return { ok: true, value };
};

const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const isValidServerId = (value: unknown): value is string =>
    isString(value) && SERVER_ID_PATTERN.test(value);

export const isValidStoredPassword = (value: unknown): value is string =>
    isString(value) && value.length > 0 && value.length <= 4096;

export const isHttpUrl = (value: unknown): value is string => {
    if (!isString(value) || value.length === 0 || value.length > 4096) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

export const isValidRendererPathInput = (value: unknown): value is string =>
    isString(value) && value.length > 0 && value.length <= 4096 && !value.includes('\0');

export const isValidServerIdList = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((item) => isValidServerId(item) || typeof item === 'number');
