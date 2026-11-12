export type {
    MpvCompressorSettings as CompressorSettings,
    MpvEqBand as EqBand,
    MpvEqSettings as EqSettings,
} from '/@/shared/types/mpv-settings';
// Renderer compatibility entry point for the shared, pure MPV filter builder.
// The main process validates the numeric values before it builds the actual af
// property, so this module is not allowed to accept arbitrary filter text.
export { buildMpvAudioFilters } from '/@/shared/utils/mpv-audio-filters';
