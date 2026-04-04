// Auto-split from prefs.js — shared constants for preferences UI.
export const APP_ID = 'Live LockPaper';
/** Use for clipboard / summary joins — avoids editors splitting `join('\\n')` across lines and breaking parse. */
export const _LLP_LINE_JOIN = String.fromCharCode(10);
export const VIDEO_EXTS = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.flv', '.wmv', '.ogv', '.3gp', '.hevc', '.m2ts', '.mts'];
export const CARD_W = 180;
export const CARD_H = 102;
export const HERO_W = 960;
export const HERO_H = 540;

/** Lock screen / wallpaper fade-in duration: prefs + schema (ms). */
export const FADE_IN_DURATION_MS_MAX = 5000;
export const FADE_IN_DURATION_MS_STEP = 50;

/** Manual FPS fallback (lock + wallpaper); matches gschema `background-video-framerate` / `wallpaper-framerate`. */
export const MANUAL_FPS_MIN = 1;
export const MANUAL_FPS_MAX = 120;

/** Stored values are CSS `font-weight` / empty for default. Labels match common prefs spellings. */
export const LOCK_TEXT_FONT_WEIGHT_CHOICES = [
    {value: '', label: 'Default'},
    {value: 'normal', label: 'Normal'},
    {value: 'bold', label: 'Bold'},
    {value: 'lighter', label: 'Lighter'},
    {value: 'bolder', label: 'Bolder'},
    {value: '100', label: '100'},
    {value: '200', label: '200'},
    {value: '300', label: '300'},
    {value: '400', label: '400'},
    {value: '500', label: '500'},
    {value: '600', label: '600'},
    {value: '700', label: '700'},
    {value: '800', label: '800'},
    {value: '900', label: '900'},
];

export const LOCK_TEXT_FONT_STYLE_CHOICES = [
    {value: '', label: 'Default'},
    {value: 'normal', label: 'Normal'},
    {value: 'italic', label: 'Italic'},
    {value: 'oblique', label: 'Oblique'},
];
