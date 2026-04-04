import {HERO_H} from './prefs-constants.js';

export const PREFS_CSS_BASE = `.llp-page-wrap { padding: 6px; }
.llp-page-stack { max-width: 1760px; }
.llp-library-root { min-height: 620px; }
.llp-sidebar-card, .llp-main-card, .llp-settings-card, .llp-preview-card, .llp-stat-card {
  border-radius: 16px;
  border: 1px solid alpha(@window_fg_color, 0.08);
  background: alpha(@window_fg_color, 0.035);
}
.llp-sidebar-card { padding: 12px; }
.llp-main-card { padding: 14px; }
.llp-section-title { font-weight: 800; font-size: 15px; }
.llp-dim { color: alpha(@window_fg_color, 0.65); }
.llp-hero-shell {
  min-height: ${HERO_H}px;
  border-radius: 16px;
  background: alpha(@window_fg_color, 0.06);
  overflow: hidden;
}
.llp-hero-meta {
  background: linear-gradient(to top, alpha(#0b0d12, 0.82), alpha(#0b0d12, 0.18));
  padding: 12px 14px;
}
.llp-hero-overlay-hidden { opacity: 0; }
.llp-pill {
  border-radius: 999px;
  padding: 3px 10px;
  background: alpha(@window_fg_color, 0.08);
  font-size: 11px;
  font-weight: 700;
}
.llp-entry-row {
  border-radius: 12px;
  padding: 10px;
}
.llp-entry-row.active {
  outline: 2px solid alpha(@accent_bg_color, 0.95);
  outline-offset: -2px;
  background: alpha(@accent_bg_color, 0.2);
}
.llp-entry-row.active .llp-card-title,
.llp-entry-row.active .llp-card-subtitle,
.llp-entry-row.active .llp-sidebar-type-icon {
  color: @accent_color;
}
.llp-thumb-card {
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid alpha(@window_fg_color, 0.08);
  background: alpha(@window_fg_color, 0.03);
}
.llp-thumb-card.selected {
  outline: 2px solid alpha(@accent_bg_color, 0.95);
  outline-offset: -2px;
}
.llp-chipbar > label { margin: 0 6px 6px 0; }
.llp-title-hero, .llp-hero-title { font-size: 15px; font-weight: 800; color: white; }
.llp-big-copy { font-size: 24px; font-weight: 800; }
.llp-card-title { font-size: 12px; font-weight: 700; }
.llp-card-subtitle, .llp-subtitle { color: alpha(@window_fg_color, 0.72); font-size: 12px; }
.llp-badge {
  border-radius: 999px;
  background: alpha(#11161d, 0.82);
  color: white;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
}
.llp-drop { box-shadow: 0 8px 24px alpha(#000, 0.16); }
.llp-search { min-width: 220px; }
.llp-toolbar-btn { min-width: 96px; }
.llp-footer-bar {
  border-radius: 14px;
  background: alpha(@window_fg_color, 0.03);
  padding: 10px;
}
.llp-mini-thumb, .llp-sidebar-thumb {
  border-radius: 10px;
  overflow: hidden;
  background: alpha(@window_fg_color, 0.04);
}
.llp-sidebar-type-icon { color: alpha(@window_fg_color, 0.72); }
.llp-settings-card { padding: 14px; }
.llp-control-row {
  border-top: 1px solid alpha(@window_fg_color, 0.06);
  padding-top: 12px;
  padding-bottom: 12px;
}
.llp-control-row:first-of-type {
  border-top: none;
  padding-top: 0;
}
.llp-settings-flow > flowboxchild {
  padding: 0;
}
.llp-settings-panel {
  min-width: 320px;
}
.llp-home-toolbar { margin-bottom: 8px; }
.llp-home-chip-row > label { margin-right: 6px; margin-bottom: 6px; }
.llp-library-chip-row > label,
.llp-library-chip-row > box { margin-right: 6px; margin-bottom: 0; }
box.llp-library-chip-row { align-items: center; }
.llp-overlay-chip {
  background: alpha(#0b0d12, 0.56);
}
.llp-center-play {
  border-radius: 999px;
  min-width: 64px;
  min-height: 64px;
  background: alpha(#0b0d12, 0.45);
}
.llp-icon-btn {
  min-width: 36px;
  min-height: 36px;
  border-radius: 999px;
}
clamp {
  max-width: 1800px;
}
preferencesgroup,
preferencespage,
preferencesgroup > box {
  max-width: none;
}
`;
