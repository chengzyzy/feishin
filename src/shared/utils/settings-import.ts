export const SETTINGS_IMPORT_MAX_BYTES = 1024 * 1024;

export type SettingsImportErrorCode =
    | 'empty'
    | 'invalid-json'
    | 'invalid-root'
    | 'invalid-version'
    | 'migration-failed'
    | 'read-failed'
    | 'schema-invalid'
    | 'too-large';

export interface SettingsImportHooks {
    currentSettings: Record<string, unknown>;
    currentVersion: number;
    maxBytes?: number;
    migrate: (settings: unknown, version: number) => unknown;
    validate: (
        settings: unknown,
    ) => (SettingsImportValidationFailure & { success: false }) | { data: unknown; success: true };
}

export type SettingsImportResult =
    | {
          code: SettingsImportErrorCode;
          detail?: string;
          ok: false;
      }
    | {
          ok: true;
          settings: Record<string, unknown>;
      };

export interface SettingsImportValidationFailure {
    error: {
        issues: Array<{
            message: string;
            path: Array<number | string>;
        }>;
    };
}

const cloneJson = <T>(value: T): T => {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const getByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const readVersion = (value: unknown): { error?: true; version: number } => {
    if (value === undefined) {
        // Legacy exports did not always carry a version; treat them as the oldest
        // migration input instead of rejecting otherwise valid settings.
        return { version: 0 };
    }

    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return { error: true, version: 0 };
    }

    return { version: value };
};

const mergeLocalOnlySettings = (
    imported: Record<string, unknown>,
    current: Record<string, unknown>,
): Record<string, unknown> => {
    const merged = cloneJson(imported);

    // Remote-control credentials and ports are local security settings. A settings
    // file must not be able to change them.
    if (current.remote !== undefined) {
        merged.remote = cloneJson(current.remote);
    }

    const importedPlayback = isRecord(merged.playback) ? merged.playback : undefined;
    const currentPlayback = isRecord(current.playback) ? current.playback : undefined;
    if (importedPlayback && currentPlayback?.mpvExtraParameters !== undefined) {
        // MPV command-line arguments are a local execution surface. Keep the copy
        // this machine already accepted instead of trusting the imported file.
        importedPlayback.mpvExtraParameters = cloneJson(currentPlayback.mpvExtraParameters);
    }

    return merged;
};

/**
 * Shared import path for dropped and picked settings files. The caller must read the
 * raw text first; this function enforces size, parse, migration and schema order and
 * returns the exact object that should be previewed and then written.
 */
export const prepareSettingsImport = (
    rawText: string,
    hooks: SettingsImportHooks,
): SettingsImportResult => {
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
        return { code: 'empty', ok: false };
    }

    const maxBytes = hooks.maxBytes ?? SETTINGS_IMPORT_MAX_BYTES;
    if (getByteLength(rawText) > maxBytes) {
        return { code: 'too-large', ok: false };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        return { code: 'invalid-json', ok: false };
    }

    if (!isRecord(parsed)) {
        return { code: 'invalid-root', ok: false };
    }

    const { error: versionError, version } = readVersion(parsed.version);
    if (versionError) {
        return { code: 'invalid-version', ok: false };
    }

    // Import files newer than this build are not safe to interpret with old migrations.
    if (version > hooks.currentVersion) {
        return { code: 'invalid-version', detail: 'newer-than-current', ok: false };
    }

    const candidateSettings = { ...parsed };
    delete candidateSettings.version;
    let migrated: unknown;
    try {
        migrated = hooks.migrate(candidateSettings, version);
    } catch (error) {
        return {
            code: 'migration-failed',
            detail: error instanceof Error ? error.message : String(error),
            ok: false,
        };
    }

    if (!isRecord(migrated)) {
        return { code: 'schema-invalid', ok: false };
    }

    const merged = mergeLocalOnlySettings(migrated, hooks.currentSettings);

    let validation: ReturnType<SettingsImportHooks['validate']>;
    try {
        validation = hooks.validate(merged);
    } catch (error) {
        return {
            code: 'schema-invalid',
            detail: error instanceof Error ? error.message : String(error),
            ok: false,
        };
    }

    if (!validation.success) {
        const issue = validation.error.issues[0];
        return {
            code: 'schema-invalid',
            detail: issue ? `${issue.path.join('.') || 'settings'}: ${issue.message}` : undefined,
            ok: false,
        };
    }

    if (!isRecord(validation.data)) {
        return { code: 'schema-invalid', ok: false };
    }

    return { ok: true, settings: cloneJson(validation.data) };
};

/**
 * Reads a File-like object with the same size guard. Kept separate from the parser so
 * drag/drop and the file picker can share one read path and one error contract.
 */
export const readSettingsImportFile = async (
    file: { size: number; text: () => Promise<string> },
    hooks: SettingsImportHooks,
): Promise<SettingsImportResult> => {
    const maxBytes = hooks.maxBytes ?? SETTINGS_IMPORT_MAX_BYTES;
    if (file.size > maxBytes) {
        return { code: 'too-large', ok: false };
    }

    let text: string;
    try {
        text = await file.text();
    } catch (error) {
        return {
            code: 'read-failed',
            detail: error instanceof Error ? error.message : String(error),
            ok: false,
        };
    }

    return prepareSettingsImport(text, hooks);
};
