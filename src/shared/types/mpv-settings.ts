export interface MpvCompressorSettings {
    attack: number;
    enabled: boolean;
    knee: number;
    makeup: number;
    ratio: number;
    release: number;
    threshold: number;
}

export interface MpvEqBand {
    freq: number;
    gain: number;
}

export interface MpvEqSettings {
    bands: MpvEqBand[];
    enabled: boolean;
    preamp: number;
}

export interface MpvInitializeResult {
    error?: string;
    rejectedParameters?: string[];
    rejectedProperties?: string[];
    success: boolean;
}

export interface MpvOperationResult {
    error?: string;
    rejectedProperties?: string[];
    success: boolean;
}

export type MpvPropertySet = Record<string, MpvPropertyValue>;

export type MpvPropertyValue = number | string;
