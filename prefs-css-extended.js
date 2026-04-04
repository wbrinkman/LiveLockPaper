export const PREFS_CSS_EXTENDED = `.llp-page-wrap { padding: 6px; }
.llp-page-stack { padding-bottom: 4px; }
.llp-library-root { min-height: 680px; }
.llp-surface,
.llp-sidebar-card,
.llp-main-card,
.llp-stat-card,
.llp-settings-card,
.llp-strip-card {
  border-radius: 18px;
  border: 1px solid alpha(@window_fg_color, 0.08);
  background: alpha(@window_fg_color, 0.035);
}
.llp-sidebar-card { padding: 14px; }
.llp-main-card { padding: 12px; }
.llp-stat-card, .llp-settings-card, .llp-strip-card { padding: 16px; }
.llp-stat-card.compact { padding: 14px 16px; }
.llp-section-title { font-weight: 800; font-size: 15px; }
.llp-sidebar-brand { margin-bottom: 2px; }
.llp-sidebar-brand image { border-radius: 8px; }
.llp-hero-title { font-weight: 800; font-size: 14px; color: white; }
.llp-subtitle { color: alpha(@window_fg_color, 0.72); }
.llp-big-copy { font-weight: 900; font-size: 24px; letter-spacing: -0.02em; }
.llp-card-title { font-size: 13px; font-weight: 800; }
.llp-card-subtitle { color: alpha(@window_fg_color, 0.68); font-size: 12px; }
.llp-dim { color: alpha(@window_fg_color, 0.68); }
.llp-hero-shell {
  min-height: 400px;
  border-radius: 22px;
  background: alpha(@window_fg_color, 0.055);
  overflow: hidden;
}
.llp-hero-compact {
  min-height: 220px;
}
.llp-preview-thumb-off picture {
  opacity: 0.62;
  filter: brightness(0.88);
}
label.llp-pill.llp-pill-clickable:hover {
  background: alpha(@window_fg_color, 0.11);
}
box.llp-overlay-source-pill {
  border-radius: 999px;
  padding: 4px 10px;
  background: alpha(@window_fg_color, 0.085);
  align-self: start;
}
box.llp-overlay-source-pill label {
  font-size: 11px;
  font-weight: 700;
  color: @window_fg_color;
  opacity: 1;
}
.llp-hero-media {
  border-radius: 22px;
  overflow: hidden;
}
.llp-hero-meta {
  background: linear-gradient(to top, alpha(#0b0d12, 0.84), alpha(#0b0d12, 0.18));
  padding: 18px 18px 16px 18px;
}
.llp-pill {
  border-radius: 999px;
  padding: 4px 10px;
  background: alpha(@window_fg_color, 0.085);
  font-size: 11px;
  font-weight: 700;
}
.llp-pill-accent {
  background: alpha(@accent_bg_color, 0.18);
  color: mix(@accent_bg_color, white, 0.28);
}
.llp-entry-row {
  border-radius: 14px;
  padding: 12px;
}
.llp-entry-row.active {
  outline: 2px solid alpha(@accent_bg_color, 0.88);
  outline-offset: -2px;
  background: alpha(@accent_bg_color, 0.12);
}
.llp-thumb-card {
  border-radius: 15px;
  overflow: hidden;
  border: 1px solid alpha(@window_fg_color, 0.08);
  background: alpha(@window_fg_color, 0.03);
}
.llp-thumb-card.selected {
  outline: 2px solid alpha(@accent_bg_color, 0.92);
  outline-offset: -2px;
  background: alpha(@accent_bg_color, 0.06);
}
.llp-chipbar > label { margin: 0 6px 6px 0; }
.llp-badge {
  border-radius: 999px;
  background: alpha(#11161d, 0.86);
  color: white;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 700;
  margin: 8px;
}
.llp-stat-value { font-size: 28px; font-weight: 900; }
.llp-stat-value.compact { font-size: 34px; }
.llp-stat-label { color: alpha(@window_fg_color, 0.72); font-size: 12px; }
.llp-stat-main { min-height: 52px; }
.llp-stat-copy { margin-right: 10px; }
.llp-toolbar-btn { min-height: 36px; }
progressbar.llp-flow-load-bar {
  min-height: 8px;
}
progressbar.llp-flow-load-bar trough {
  min-height: 8px;
  border-radius: 999px;
  background: alpha(@window_fg_color, 0.1);
}
progressbar.llp-flow-load-bar progress {
  border-radius: 999px;
  background: alpha(@accent_bg_color, 0.92);
}
/* Bundled GitHub SVG + CSS invert (same approach as prefs WORKING.js). */
.llp-home-github-btn image.llp-github-brand {
  filter: brightness(0) invert(1);
  opacity: 0.92;
}
.llp-home-github-wrap {
  min-width: 0;
}
centerbox.llp-home-toolbar {
  margin-bottom: 8px;
}
.llp-home-brand-title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.02em;
  opacity: 0.95;
}
.llp-home-toolbar .llp-home-chip-row > label {
  margin-bottom: 0;
}
.llp-home-github-btn {
  min-height: 0;
  padding: 4px 10px;
}
button.llp-home-toolbar-link {
  min-height: 0;
  min-width: 0;
  padding: 4px 10px;
}
button.llp-home-toolbar-link label {
  font-size: 11px;
  font-weight: 700;
}
.llp-sidebar-head { margin-bottom: 6px; }
.llp-search { min-height: 38px; }
.llp-mini-thumb {
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid alpha(@window_fg_color, 0.08);
  background: alpha(@window_fg_color, 0.03);
}
.llp-mini-thumb.selected {
  outline: 2px solid alpha(@accent_bg_color, 0.9);
  outline-offset: -2px;
}
.llp-footer-bar {
  border-radius: 18px;
  padding: 10px 14px;
  background: alpha(@window_fg_color, 0.04);
  border-top: 1px solid alpha(@window_fg_color, 0.08);
  border-left: 0; border-right: 0; border-bottom: 0;
  margin-top: 8px;
}
box.llp-footer-primary-actions {
  min-width: 0;
}
label.llp-footer-grid-count {
  min-width: 10.5rem;
}
/* Footer actions: Gtk.Button + Libadwaita suggested / destructive. */
button.llp-lib-footer-btn {
  padding: 4px 12px;
  min-height: 34px;
  min-width: 8.5rem;
}
button.llp-lib-footer-btn label {
  font-size: 12px;
  font-weight: 600;
}
/* Box + gesture (not Gtk.Button): Libadwaita flattens button backgrounds; boxes keep a solid fill. */
box.llp-library-scroll-top-fab {
  min-width: 52px;
  min-height: 52px;
  border-radius: 10px;
  background-color: #1a1a26;
  background-image: none;
  border: none;
  box-shadow: 0 2px 10px alpha(#000, 0.4);
}
box.llp-library-scroll-top-fab:hover {
  background-color: #252534;
  box-shadow: 0 3px 12px alpha(#000, 0.48);
}
box.llp-library-scroll-top-fab:focus {
  outline: none;
  box-shadow: 0 2px 10px alpha(#000, 0.4);
}
box.llp-library-scroll-top-fab:focus:hover {
  box-shadow: 0 3px 12px alpha(#000, 0.48);
}
box.llp-library-scroll-top-fab image {
  color: white;
  opacity: 0.95;
}
.llp-control-row {
  padding: 10px 0;
  border-bottom: 1px solid alpha(@window_fg_color, 0.06);
}
.llp-control-row:last-child {
  border-bottom: none;
}
.llp-empty {
  border-radius: 18px;
  padding: 26px;
  background: alpha(@window_fg_color, 0.03);
  border: 1px dashed alpha(@window_fg_color, 0.16);
}
clamp { max-width: 1800px; }
preferencesgroup, preferencespage, preferencesgroup > box { max-width: none; }
.llp-apply-dlg-instr {
  max-width: 420px;
}
.llp-mon-canvas {
  min-width: 520px;
  min-height: 300px;
  background: alpha(@window_fg_color, 0.06);
  border-radius: 16px;
  border: 1px solid alpha(@window_fg_color, 0.1);
}
.llp-mon-tile {
  padding: 4px 6px;
  border-radius: 10px;
  background: alpha(@window_fg_color, 0.12);
  border: 1px solid alpha(@window_fg_color, 0.14);
}
.llp-mon-tile.primary {
  border-top-width: 5px;
  border-top-color: alpha(@window_fg_color, 0.5);
}
.llp-apply-mon-screen.llp-mon-tile {
  padding: 0;
  border: 1px solid alpha(@window_fg_color, 0.2);
}
.llp-apply-mon-screen {
  border-radius: 10px;
  overflow: hidden;
}
.llp-apply-mon-screen picture {
  border-radius: 0;
}
.llp-apply-mon-column.llp-apply-mon-selected .llp-apply-mon-screen {
  border: 3px solid @accent_bg_color;
  box-shadow: 0 0 0 2px alpha(@accent_bg_color, 0.35);
}
.llp-apply-mon-caption {
  margin-top: 2px;
  padding: 0 2px;
}
.llp-mon-tile-num { font-weight: 900; font-size: 16px; }
.llp-mon-tile-sub { font-size: 10px; font-weight: 700; opacity: 0.85; }
.llp-mon-tile-title { font-weight: 800; font-size: 11px; }
.llp-mon-tile-conn { font-size: 10px; font-weight: 700; opacity: 0.9; }
.llp-mon-tile-dim { font-size: 9px; opacity: 0.65; }
`;
