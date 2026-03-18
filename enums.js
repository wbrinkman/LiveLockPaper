export const Keys = {
    // Lock screen settings
    LOCKSCREEN_ENABLED: "lockscreen-enabled",
    VIDEO_PATH: "background-video-path",
    VIDEO_PATHS: "background-video-paths",
    VIDEO_RANDOM_ORDER: "background-video-random-order",
    VIDEO_AUTO_FPS: "background-video-auto-fps",
    VIDEO_METADATA: "background-video-metadata",
    VIDEO_TRANSITION_TYPE: "background-video-transition-type",
    VIDEO_TRANSITION_DURATION: "background-video-transition-duration",
    VIDEO_PLAYBACK_SPEED: "background-video-playback-speed",
    VIDEO_START_POSITION: "background-video-start-position",
    VIDEO_LAST_POSITIONS: "background-video-last-positions",
    SCALING_MODE: "background-video-scaling-mode",
    FRAMERATE: "background-video-framerate",
    LOOPED: "background-video-looped",
    FADE_IN_DURATION: "background-fade-in-duration",
    
    BLUR_RADIUS: "background-video-blur-radius",
    BLUR_BRIGHTNESS: "background-video-blur-brightness",

    AUDIO_VOLUME: "background-audio-volume",

    PROMPT_PAUSE: "prompt-pause-video",
    PROMPT_CHANGE_BLUR: "prompt-change-blur",
    PROMPT_BLUR_RADIUS: "prompt-blur-radius",
    PROMPT_BLUR_BRIGHTNESS: "prompt-blur-brightness",
    PROMPT_BLUR_ANIM_DURATION: "prompt-blur-anim-duration",
    PROMPT_GRAYSCALE: "prompt-grayscale",

    // General
    WALLPAPER_DISABLE_ON_BATTERY: "wallpaper-disable-on-battery",
    LOCKSCREEN_DISABLE_ON_BATTERY: "lockscreen-disable-on-battery",

    // Lock screen per-monitor
    LOCKSCREEN_PER_MONITOR: "background-video-per-monitor",
    LOCKSCREEN_PER_MONITOR_CONFIG: "background-video-per-monitor-config",

    DEBUG_SKIP_FIRST_FRAME: "debug-skip-frame",
    DEBUG_USE_UNSAFE_PIPELINE: "debug-use-unsafe-pipeline",
    DEBUG_PREFER_HW_DECODER: "debug-prefer-hardware-decoder",
    DEBUG_GPU_COLOR_CONVERSION: "debug-gpu-color-conversion",
    PAUSE_WHEN_HIDDEN_MODE: "pause-when-hidden-mode",
    DEBUG_PUSH_FRAME_DELIVERY: "debug-push-frame-delivery",
    DEBUG_USE_GTK4_SINK: "debug-use-gtk4-sink",
    DEBUG_GTK_HELPER_LOGS: "debug-gtk-helper-logs",
    DEBUG_SHOW_PANEL_BUTTON: "debug-show-panel-button",
    PANEL_ICON_MODE: "panel-icon-mode",
    PANEL_ICON_CUSTOM_STATIC: "panel-icon-custom-static",
    PANEL_ICON_CUSTOM_DYNAMIC_WALLPAPER: "panel-icon-custom-dynamic-wallpaper",
    PANEL_ICON_CUSTOM_DYNAMIC_LOCKSCREEN: "panel-icon-custom-dynamic-lockscreen",
    PANEL_ICON_CUSTOM_DYNAMIC_BOTH: "panel-icon-custom-dynamic-both",
    PANEL_ICON_CUSTOM_DYNAMIC_NONE: "panel-icon-custom-dynamic-none",

    // Wallpaper settings
    WALLPAPER_ENABLED: "wallpaper-enabled",
    WALLPAPER_VIDEO_PATHS: "wallpaper-video-paths",
    WALLPAPER_RANDOM_ORDER: "wallpaper-random-order",
    WALLPAPER_AUTO_FPS: "wallpaper-auto-fps",
    WALLPAPER_FRAMERATE: "wallpaper-framerate",
    WALLPAPER_SCALING_MODE: "wallpaper-scaling-mode",
    WALLPAPER_BLUR_RADIUS: "wallpaper-blur-radius",
    WALLPAPER_BLUR_BRIGHTNESS: "wallpaper-blur-brightness",
    WALLPAPER_LOOPED: "wallpaper-looped",
    WALLPAPER_VOLUME: "wallpaper-volume",
    WALLPAPER_FADE_IN_DURATION: "wallpaper-fade-in-duration",
    WALLPAPER_PER_MONITOR: "wallpaper-per-monitor",
    WALLPAPER_PER_MONITOR_CONFIG: "wallpaper-per-monitor-config",
    WALLPAPER_VIDEO_METADATA: "wallpaper-video-metadata",
    WALLPAPER_QUALITY: "wallpaper-quality",
};

export const ScalingMode = {
    STRETCH: 0,
    FIT: 1,
    COVER: 2,
}

export const TransitionType = {
    NONE: 0,
    FADE: 1,
    CROSSFADE: 2,
}

export const PauseWhenHiddenMode = {
    OFF: 0,
    ALL_MONITORS: 1,
    ANY_MONITOR: 2,
}