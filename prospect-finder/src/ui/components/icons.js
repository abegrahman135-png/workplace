/**
 * icons.js — inline SVG icon set.
 * Emoji were replaced with SVG: emoji render inconsistently across
 * Windows/macOS/Linux and disappear entirely on systems without an emoji
 * font, which broke every badge and metric label in the card.
 * Each icon inherits `currentColor` and scales with font-size via `em` units.
 */
const svg = (body, vb = '0 0 16 16') =>
  `<svg class="ico" viewBox="${vb}" width="1em" height="1em" fill="none" ` +
  `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  fire:     svg('<path d="M8 1.5s.6 2.2-.9 3.7C5.3 6.9 4 8.2 4 10a4 4 0 0 0 8 0c0-1.5-.7-2.6-1.5-3.4-.3 .8-.9 1.2-1.4 1.2.6-1.9.2-4.4-1.1-6.3Z"/>'),
  check:    svg('<circle cx="8" cy="8" r="6.3"/><path d="m5.4 8.2 1.8 1.8 3.4-3.7"/>'),
  eye:      svg('<path d="M1.6 8S3.9 3.9 8 3.9 14.4 8 14.4 8 12.1 12.1 8 12.1 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="1.9"/>'),
  ban:      svg('<circle cx="8" cy="8" r="6.3"/><path d="m3.9 3.9 8.2 8.2"/>'),
  clock:    svg('<circle cx="8" cy="8" r="6.3"/><path d="M8 4.4V8l2.4 1.5"/>'),
  female:   svg('<circle cx="8" cy="6" r="3.6"/><path d="M8 9.6v4.9M6.1 12.6h3.8"/>'),
  male:     svg('<circle cx="6.6" cy="9.4" r="3.6"/><path d="M9.6 6.4 14 2m-3.5 0H14v3.5"/>'),
  question: svg('<circle cx="8" cy="8" r="6.3"/><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3"/><circle cx="8" cy="11.4" r=".8" fill="currentColor" stroke="none"/>'),
  scale:    svg('<path d="M8 2.6v10.8M4.6 13.4h6.8M2 6.2h12M2 6.2 3.9 10h-.1a1.9 1.9 0 0 1-3.7 0Zm12 0L15.9 10h-.1a1.9 1.9 0 0 1-3.7 0Z"/>'),
  grid:     svg('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  users:    svg('<circle cx="6" cy="6" r="2.6"/><path d="M1.8 13.4a4.4 4.4 0 0 1 8.4 0M11 3.6a2.6 2.6 0 0 1 0 4.9m3.2 4.9a4.3 4.3 0 0 0-2.3-3.3"/>'),
  arrowOut: svg('<path d="M6.4 3.2H3.4a1 1 0 0 0-1 1v8.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-3M9.4 2.4H14v4.6M14 2.4 7.6 8.8"/>'),
  star:     svg('<path d="m8 1.9 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.7l-3.8 2 .7-4.3-3.1-3 4.3-.6Z"/>'),
  close:    svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  lock:     svg('<rect x="3.2" y="7" width="9.6" height="6.6" rx="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/>'),
  globe:    svg('<circle cx="8" cy="8" r="6.3"/><path d="M2 8h12M8 1.8a12 12 0 0 1 0 12.4A12 12 0 0 1 8 1.8Z"/>'),
  warn:     svg('<path d="M7.1 2.6 1.5 12a1 1 0 0 0 .9 1.5h11.2a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0Z"/><path d="M8 6.4v2.8"/><circle cx="8" cy="11.3" r=".8" fill="currentColor" stroke="none"/>'),
  chevron:  svg('<path d="M6 3.6 10.4 8 6 12.4"/>'),
  camera:   svg('<path d="M2 5.6h2.4l1-1.6h5.2l1 1.6H14a.9.9 0 0 1 .9.9v6a.9.9 0 0 1-.9.9H2a.9.9 0 0 1-.9-.9v-6A.9.9 0 0 1 2 5.6Z"/><circle cx="8" cy="9.4" r="2.4"/>'),
  arrowR:   svg('<path d="M2.6 8h10.8M9.6 4.2 13.4 8l-3.8 3.8"/>'),
  link:     svg('<path d="M6.6 9.4a2.6 2.6 0 0 0 3.8 0l2-2a2.7 2.7 0 0 0-3.8-3.8l-1 1"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.8 0l-2 2a2.7 2.7 0 0 0 3.8 3.8l1-1"/>'),
  gem:      svg('<path d="M4.4 2.2h7.2l2.6 3.9L8 14 1.8 6.1Z"/><path d="M1.8 6.1h12.4M5.6 6.1 8 14l2.4-7.9M4.4 2.2 5.6 6.1M11.6 2.2 10.4 6.1"/>'),
  sparkNew: svg('<path d="M5.8 1.9 7 4.9l3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2Z"/><path d="M11.6 8.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z"/>'),
  user:     svg('<circle cx="8" cy="5.4" r="2.9"/><path d="M2.6 13.8a5.4 5.4 0 0 1 10.8 0"/>'),
  play:     svg('<path d="M4.6 2.9 12.8 8l-8.2 5.1Z"/>'),
  recycle:  svg('<path d="M4.3 6.1 2.5 9.2a1 1 0 0 0 .9 1.5h2.2M11.7 6.1l1.8 3.1a1 1 0 0 1-.9 1.5h-3.4M6.5 3.3 8 1.7l1.5 1.6"/><path d="M6.2 12.9 8 14.3M5.6 10.7l-1.2 2"/>'),
  down:     svg('<path d="M8 2.6v8.2M4.6 7.6 8 11l3.4-3.4M2.8 13.4h10.4"/>'),
  search:   svg('<circle cx="7.2" cy="7.2" r="4.6"/><path d="m10.6 10.6 3 3"/>'),
  ring:     svg('<circle cx="8" cy="10" r="4"/><path d="m6 4.4 2-2.2 2 2.2-2 1.8Z"/>'),
};

/** Icon + label, spaced so the glyph optically aligns with the text baseline. */
export const iconLabel = (name, text) =>
  `<span class="ic-lbl">${ICON[name] || ''}<span>${text}</span></span>`;
