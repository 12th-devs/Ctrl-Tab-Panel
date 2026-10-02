# Ctrl Tab Panel

Ctrl Tab Panel adds a Zen-native tab preview panel while cycling with Ctrl+Tab.

Hold Ctrl and press Tab to open the panel, continue pressing Tab to move through tabs, then release Ctrl to switch. Press Esc while the panel is open to cancel without switching.

## Settings

- Show tab preview panel for Ctrl+Tab
- Order tabs by recent use
- Group split view tabs into a single card

Tabs in the same Zen split view appear as one card with a mini preview per
split tab, a stacked favicon row, and a `Split · N` badge. Releasing Ctrl on a
split card re-selects that split view instead of a single tab. Turn grouping
off to cycle split tabs individually; split tabs still show a `Split` badge.

## Sine Install

Install from:

```text
12th-devs/Ctrl-Tab-Panel
```

The Sine manifest is `theme.json`. It loads `zen-ctrl-tab-panel.uc.js`, `chrome.css`, and `preferences.json`.
