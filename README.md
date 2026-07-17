# Google Maps List Organizer

Bulk-move saved places between Google Maps lists by city.

**Use case:** You have thousands of places in "Want to go" and want to split them into city-specific lists like "Seoul WTG", "Taipei WTG", etc. — without clicking through each one manually.

## How it works

1. Connects to your real Chrome via remote debugging (no credentials stored)
2. Intercepts Google Maps' internal API request to fetch all your saved places
3. Filters by city using a configurable lat/lng bounding box
4. Automates moving matching places to a destination list via the Maps UI

## Prerequisites

- Node.js 18+
- pnpm
- Google Chrome or Microsoft Edge (Chromium-based)

## Setup

```bash
pnpm install
```

## Usage

**Step 1 — Launch your browser with remote debugging:**

Fully quit your browser first, then run the command matching your operating system and browser:

| OS | Browser | Command |
| :--- | :--- | :--- |
| **macOS** | Google Chrome | `pnpm run launch-chrome` |
| **macOS** | Microsoft Edge | `pnpm run launch-edge-mac` |
| **Windows** | Microsoft Edge | `pnpm run launch-edge` |
| **Windows** | Google Chrome | `pnpm run launch-chrome-win` |

Sign into Google Maps in the window that opens. Your session will be saved in the profile directory (e.g. `.chrome-session/` or `.edge-session/`) for future runs.

**Step 2 — Create your destination list** manually in Google Maps (e.g. "Tokyo WTG").

**Step 3 — Extract:**

You have three options for extraction:

1. **Extract configured lists** (fetches from lists configured in `src/config.ts`):
   ```bash
   pnpm extract
   ```
2. **Extract all lists** (dynamically scans and fetches from **all** of your saved lists on Google Maps):
   ```bash
   pnpm extract:all
   ```
3. **Local filter only** (runs instantly; applies the bounds filter to the cached `tmp/places.json` without launching the browser or reloading Maps):
   ```bash
   pnpm filter
   ```

These scripts output:
- `tmp/places.json` — all saved places with coordinates and notes
- `tmp/{dest-list}-places.json` — places within the configured bounding box

**Step 4 — Move:**
```bash
pnpm move
```
Moves each matching place from the source list to the destination list via the Maps UI. Progress is saved to `tmp/progress.json` after each move — safe to interrupt and resume. Failed places are written to `tmp/failed.json`.

**Options:**
```bash
pnpm move --limit=5      # process only 5 places (for testing)
pnpm move --dry-run      # navigate without making changes
pnpm move --retry        # retry previously failed places (skipped by default)
```

**Switching to a new city?** Update `src/config.ts`, then clear progress before re-running:
```bash
pnpm reset
```

## Configuration

Edit `src/config.ts`:

```ts
export const config = {
  // Can be a single list name, an array of list names, or 'ALL' to scan all lists
  sourceList: [
    '2025台北米其林必比登',
    '2024 518-520',
    '20241120',
  ] as string | string[],
  destList: 'Tokyo WTG',          // destination list (must exist in Maps)
  bounds: BOUNDS.tokyo,           // or set custom: { latMin, latMax, lngMin, lngMax }
  pageSize: 500,
};
```

Built-in presets are in `BOUNDS` — pick one or define your own. Visualize any bounding box at [bboxfinder.com](http://bboxfinder.com).

## Performance

**~91% success rate** tested across Seoul, Hong Kong, and Taiwan (~400 places). 

## Why this exists

Google Maps has no built-in way to bulk move saved places between lists, organize pins by city, or split a large "Want to Go" list into smaller city-specific lists. If you've ever saved hundreds of places across multiple cities and wanted to reorganize them without clicking through each one manually — this tool does that.

**Related searches that land here:** bulk move Google Maps pins · organize Google Maps saved places · split Want to Go list by city · Google Maps list management · export Google Maps saved places · move pins between Google Maps lists · Google Maps bulk edit saved places

## Project status

See [PROJECT.md](PROJECT.md) for full architecture details.
