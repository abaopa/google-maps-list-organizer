import * as fs from 'fs';
import { chromium, Page } from 'playwright';
import { config, destSlug } from './config';
import { SavedPlace } from './types';

function isInBounds(lat: number, lng: number): boolean {
  const { latMin, latMax, lngMin, lngMax } = config.bounds;
  return lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax;
}

function parsePlaces(responseText: string): SavedPlace[] {
  const data = JSON.parse(responseText.replace(/^\)\]\}'/, '').trim());
  const entries: unknown[] = data?.[0]?.[8] ?? [];
  const places: SavedPlace[] = [];

  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const inner = entry[1];
    if (!Array.isArray(inner)) continue;

    const name: string = entry[2] ?? inner[1] ?? '';
    const note: string = entry[3] ?? '';
    const address: string = inner[2] ?? '';
    const coords = inner[5];

    if (!Array.isArray(coords) || coords.length < 4) continue;
    const lat: number = coords[2];
    const lng: number = coords[3];
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;

    places.push({
      name, note, address,
      url: `https://www.google.com/maps/search/${encodeURIComponent(name)}/@${lat},${lng},18z`,
      coordinates: { lat, lng },
    });
  }

  return places;
}

function extractNextCursor(responseText: string): string | null {
  const data = JSON.parse(responseText.replace(/^\)\]\}'/, '').trim());
  const cursor = data?.[1];
  return typeof cursor === 'string' && cursor.length > 10 ? cursor : null;
}

async function fetchWithNextToken(page: Page, baseUrl: string, nextToken: string, limit: number): Promise<string> {
  // data[1] is standard base64 (+, /) but the URL uses URL-safe base64 (-, _)
  const urlSafeToken = nextToken.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const next = baseUrl.replace(/!4i\d+/, `!4i${limit}!5B${urlSafeToken}`);
  return page.evaluate(async (u) => {
    const res = await fetch(u);
    return res.text();
  }, next);
}

async function ensureSidebarOpen(page: Page): Promise<void> {
  try {
    // Check if the list container is already visible
    if (await page.locator('.AeaXub').first().isVisible().catch(() => false)) {
      return;
    }

    // If not visible, click the Saved button
    const savedBtn = page.getByRole('button', { name: 'Saved', exact: true });
    await savedBtn.waitFor({ state: 'visible', timeout: 10000 });
    await savedBtn.click();

    // Wait for the list container to become visible
    await page.locator('.AeaXub').first().waitFor({ state: 'visible', timeout: 10000 }).catch(async () => {
      console.warn('⚠️ Saved sidebar (.AeaXub) did not open after clicking "Saved". Retrying click...');
      // If still not visible, try clicking again (in case it toggled closed or click was missed)
      await savedBtn.click();
      await page.locator('.AeaXub').first().waitFor({ state: 'visible', timeout: 10000 });
    });
  } catch (err) {
    const screenshotPath = `tmp/screenshots/sidebar-open-failure.png`;
    fs.mkdirSync('tmp/screenshots', { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.error(`  ✗ Failed to open sidebar. Screenshot saved to ${screenshotPath}`);
    throw err;
  }
}

async function extractAllSourceLists(page: Page): Promise<string[]> {
  console.log('Navigating to Google Maps to fetch all saved lists...');
  await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await ensureSidebarOpen(page);

  console.log('Scrolling to load all saved lists...');
  let lastHeight = 0;
  for (let i = 0; i < 30; i++) {
    const height = await page.evaluate(() => {
      const listContainer = document.querySelector('.AeaXub');
      let scrollable: HTMLElement | null = null;
      if (listContainer) {
        let parent = listContainer.parentElement;
        while (parent) {
          const style = window.getComputedStyle(parent);
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
            scrollable = parent as HTMLElement;
            break;
          }
          parent = parent.parentElement;
        }
      }
      if (!scrollable) {
        scrollable = Array.from(document.querySelectorAll('*')).find(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        }) as HTMLElement || null;
      }
      if (scrollable) {
        scrollable.scrollTop = scrollable.scrollHeight;
        return scrollable.scrollHeight;
      }
      return 0;
    });

    if (height === lastHeight && height > 0) {
      break;
    }
    lastHeight = height;
    await page.waitForTimeout(800);
  }

  // Scroll back to top to restore layout state
  await page.evaluate(() => {
    const listContainer = document.querySelector('.AeaXub');
    let scrollable: HTMLElement | null = null;
    if (listContainer) {
      let parent = listContainer.parentElement;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
          scrollable = parent as HTMLElement;
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (!scrollable) {
      scrollable = Array.from(document.querySelectorAll('*')).find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      }) as HTMLElement || null;
    }
    if (scrollable) {
      scrollable.scrollTop = 0;
    }
  });
  await page.waitForTimeout(1000);

  const lists = await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll('.AeaXub .fontBodyLarge'));
    return divs.map(d => d.textContent?.trim()).filter(Boolean) as string[];
  });

  // Exclude destination list case-insensitively to avoid circular logic
  return lists.filter(name => name.toLowerCase().trim() !== config.destList.toLowerCase().trim());
}

async function scrollAndClickList(page: Page, listName: string): Promise<void> {
  // Scope selector explicitly to list sidebar container to avoid matching map pins, text boxes, etc.
  const selector = page.locator('.AeaXub').getByText(listName, { exact: false }).first();
  try {
    for (let i = 0; i < 30; i++) {
      // Check if element is present in DOM (count > 0) rather than isVisible()
      // because scrolled-out elements may be present in DOM but marked not visible.
      if (await selector.count().catch(() => 0) > 0) {
        await selector.scrollIntoViewIfNeeded().catch(() => {});
        await selector.click();
        return;
      }

      await page.evaluate(() => {
        const listContainer = document.querySelector('.AeaXub');
        let scrollable: HTMLElement | null = null;
        if (listContainer) {
          let parent = listContainer.parentElement;
          while (parent) {
            const style = window.getComputedStyle(parent);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
              scrollable = parent as HTMLElement;
              break;
            }
            parent = parent.parentElement;
          }
        }
        if (!scrollable) {
          scrollable = Array.from(document.querySelectorAll('*')).find(el => {
            const style = window.getComputedStyle(el);
            return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
          }) as HTMLElement || null;
        }
        if (scrollable) {
          scrollable.scrollTop += 500;
        }
      });

      await page.waitForTimeout(800);
    }

    // Fallback to normal click which will raise error with full trace if it fails
    await selector.click();
  } catch (err) {
    const screenshotSlug = listName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40);
    const screenshotPath = `tmp/screenshots/extract-failure-${screenshotSlug}.png`;
    fs.mkdirSync('tmp/screenshots', { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.error(`  ✗ Failed to find or click list "${listName}". Screenshot saved to ${screenshotPath}`);
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const filterOnly = args.includes('--filter-only');

  if (filterOnly) {
    console.log('Filtering existing places from tmp/places.json...');
    if (!fs.existsSync('tmp/places.json')) {
      console.error('Error: tmp/places.json does not exist. Run a full extraction first.');
      process.exit(1);
    }
    const uniquePlaces: SavedPlace[] = JSON.parse(fs.readFileSync('tmp/places.json', 'utf-8'));
    const destPlaces = uniquePlaces.filter(p => isInBounds(p.coordinates.lat, p.coordinates.lng));
    
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync(`tmp/${destSlug}-places.json`, JSON.stringify(destPlaces, null, 2));
    
    console.log(`\nTotal cached: ${uniquePlaces.length} places`);
    console.log(`${config.destList}: ${destPlaces.length} places (within bounds)`);
    console.log(`→ tmp/${destSlug}-places.json`);
    process.exit(0);
  }

  if (fs.existsSync('tmp/progress.json') || fs.existsSync('tmp/failed.json')) {
    console.warn('⚠  Stale progress detected (tmp/progress.json or tmp/failed.json exists).');
    console.warn('   If you are starting a new city run, clear it first: pnpm reset');
    console.warn('   Continuing in 5 seconds — press Ctrl+C to abort...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.warn('');
  }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222').catch(() => {
    console.error('Could not connect to the browser. Make sure Chrome or Edge is running with remote debugging on port 9222.');
    console.error('To launch, use the appropriate command from package.json (e.g. `pnpm run launch-chrome-win` or `pnpm run launch-edge-win`).');
    process.exit(1);
  });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.newPage();

  const extractAllFlag = args.includes('--all');

  let sourceLists: string[] = [];
  if (extractAllFlag || config.sourceList === 'ALL' || (Array.isArray(config.sourceList) && config.sourceList.includes('ALL'))) {
    sourceLists = await extractAllSourceLists(page);
    console.log(`\nFound ${sourceLists.length} saved lists (excluding destination "${config.destList}"):`);
    console.log(sourceLists.map(s => `  - ${s}`).join('\n'));
    console.log('');
  } else {
    sourceLists = Array.isArray(config.sourceList)
      ? config.sourceList
      : [config.sourceList];
  }

  const allPlaces: SavedPlace[] = [];

  for (const source of sourceLists) {
    console.log(`\n--- Processing source list: "${source}" ---`);
    const capturedUrls: string[] = [];
    const requestHandler = (req: any) => {
      if (req.url().includes('entitylist/getlist')) {
        capturedUrls.push(req.url());
      }
    };
    page.on('request', requestHandler);

    console.log(`Navigating to "${source}" to capture initial API request...`);
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await ensureSidebarOpen(page);
    await scrollAndClickList(page, source);
    await page.waitForTimeout(3000);

    page.off('request', requestHandler);

    const pageUrls = [...capturedUrls];
    if (pageUrls.length === 0) {
      console.warn(`⚠️ No getlist request captured for "${source}" — make sure you are logged into Google Maps and the list exists.`);
      continue;
    }

    const baseUrl = pageUrls[0];
    let pageNum = 1;
    let nextToken: string | null = null;
    let listPlacesCount = 0;

    while (true) {
      console.log(`Fetching page ${pageNum} for "${source}"...`);
      const text = pageNum === 1
        ? await page.evaluate(async (u) => { const r = await fetch(u); return r.text(); }, baseUrl)
        : await fetchWithNextToken(page, baseUrl, nextToken!, config.pageSize);

      const places = parsePlaces(text);
      if (places.length === 0) break;
      allPlaces.push(...places);
      listPlacesCount += places.length;

      nextToken = extractNextCursor(text);
      console.log(`  Got ${places.length} (total so far for this list: ${listPlacesCount})`);

      if (!nextToken) break;
      pageNum++;
    }
    console.log(`Finished "${source}": fetched ${listPlacesCount} places.`);
  }

  // Deduplicate by URL (same name + coords = true duplicate)
  const seen = new Set<string>();
  const uniquePlaces = allPlaces.filter(p => {
    if (!p.name) return false; // drop entries with no name
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  const dupeCount = allPlaces.length - uniquePlaces.length;
  if (dupeCount > 0) console.log(`Removed ${dupeCount} duplicates/unnamed entries`);

  const destPlaces = uniquePlaces.filter(p => isInBounds(p.coordinates.lat, p.coordinates.lng));

  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/places.json', JSON.stringify(uniquePlaces, null, 2));
  fs.writeFileSync(`tmp/${destSlug}-places.json`, JSON.stringify(destPlaces, null, 2));

  console.log(`\nTotal: ${uniquePlaces.length} places`);
  console.log(`${config.destList}: ${destPlaces.length} places`);
  console.log('→ tmp/places.json');
  console.log(`→ tmp/${destSlug}-places.json`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
