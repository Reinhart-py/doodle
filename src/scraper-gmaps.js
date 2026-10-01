const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { getExportsDir, updateProgress, saveHistoryItem, clearActiveCheckpoint } = require('./storage');

function loadTargetList(targetInput) {
  const clean = targetInput.replace(/["']/g, '').trim();
  if (fs.existsSync(clean) && fs.statSync(clean).isFile()) {
    const ext = path.extname(clean).toLowerCase();
    if (ext === '.csv') {
      const content = fs.readFileSync(clean, 'utf8');
      return content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.readFile(clean);
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const json = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });
      const items = [];
      for (const row of json) {
        if (Array.isArray(row)) {
          const combined = row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' ');
          if (combined) items.push(combined);
        }
      }
      return items.length ? items : [clean];
    }
    const content = fs.readFileSync(clean, 'utf8');
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  return [clean];
}

async function getBrowser() {
  const launchOptions = {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--lang=en-US',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled'
    ]
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    return await chromium.launch({ ...launchOptions, channel: 'msedge' });
  }
}

function rankPhones(phones) {
  function getDigits(p) {
    return p.replace(/[^\d+]/g, '');
  }

  function score(p) {
    const clean = getDigits(p);
    if (clean.startsWith('+9715') || clean.startsWith('009715') || clean.startsWith('05')) return 0;
    if (/^(\+91|91|0)?[6-9]\d{9}$/.test(clean)) return 1;
    if (clean.startsWith('+447') || clean.startsWith('07')) return 2;
    if (/800|\+971800|1800/.test(clean)) return 10;
    return 5;
  }

  const uniqueMap = new Map();
  for (const p of phones) {
    if (!p) continue;
    const digits = getDigits(p);
    if (digits.replace(/[^\d]/g, '').length < 7) continue; // Ignore garbage or very short strings

    if (!uniqueMap.has(digits)) {
      uniqueMap.set(digits, p.trim());
    } else {
      const existing = uniqueMap.get(digits);
      // Prefer nicely spaced format from Gmaps over raw tel: strings
      if (p.includes(' ') && !existing.includes(' ')) {
        uniqueMap.set(digits, p.trim());
      }
    }
  }

  const unique = Array.from(uniqueMap.values()).map(p => {
    // Add space formatting to prevent Excel Scientific Notation (e.g. 9.72E+11)
    if (!p.includes(' ') && !p.includes('-')) {
      if (p.startsWith('+')) return p.substring(0, 4) + ' ' + p.substring(4);
      return p.substring(0, 3) + ' ' + p.substring(3);
    }
    return p;
  });

  return unique.sort((a, b) => score(a) - score(b));
}

async function extractActivePane(page) {
  const data = {
    title: 'Unknown',
    phone_1: 'None',
    phone_2: 'None',
    website: 'None',
    address: 'None',
    rating: 'None',
    reviews: 'None'
  };

  try {
    const titleEl = await page.$('h1.DUwDvf');
    if (titleEl) {
      data.title = (await titleEl.innerText()).replace(/\r?\n/g, ' ').trim();
    }
  } catch {}

  try {
    const phoneHandles = await page.$$('button[data-item-id^="phone:"], button[aria-label*="Phone"], a[href^="tel:"]');
    const rawPhones = [];
    for (const el of phoneHandles) {
      try {
        const text = await el.innerText();
        const href = await el.getAttribute('href');
        if (text) {
          const cleanedText = text.replace(/Phone:/i, '').replace(/[^\d+ \-()]/g, '').trim();
          if (cleanedText.replace(/[^\d]/g, '').length >= 7) {
            rawPhones.push(cleanedText);
          }
        }
        if (href && href.startsWith('tel:')) {
          const tel = href.replace('tel:', '').trim();
          if (tel.replace(/[^\d]/g, '').length >= 7) {
            rawPhones.push(tel);
          }
        }
      } catch {}
    }
    const ranked = rankPhones(rawPhones);
    if (ranked.length > 0) data.phone_1 = ranked[0];
    if (ranked.length > 1) data.phone_2 = ranked[1];
  } catch {}

  try {
    const addrEl = await page.$('button[data-item-id="address"], button[aria-label*="Address"]');
    if (addrEl) {
      data.address = (await addrEl.innerText()).replace('Address:', '').replace(/\r?\n/g, ' ').trim();
    }
  } catch {}

  try {
    const webEl = await page.$('a[data-item-id="authority"], a[aria-label*="Website"]');
    if (webEl) {
      data.website = (await webEl.getAttribute('href')) || 'None';
    }
  } catch {}

  try {
    const ratingEl = await page.$('div.F7nice span[aria-hidden="true"]');
    if (ratingEl) {
      data.rating = (await ratingEl.innerText()).replace(/\r?\n/g, ' ').trim();
    }
    const revsEl = await page.$('div.F7nice span[aria-label*="reviews"]');
    if (revsEl) {
      const text = await revsEl.innerText();
      data.reviews = text.replace(/[^\d]/g, '');
    }
  } catch {}

  return data;
}

async function returnToFeed(page) {
  try {
    const backBtn = page.locator('div[role="main"] button[aria-label="Back to results"], button[jsaction*="pane.back"], div[role="main"] button[aria-label="Back"]').first();
    if (await backBtn.isVisible({ timeout: 600 }).catch(() => false)) {
      await backBtn.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
  }

  await page.waitForSelector('div[role="feed"]', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(250);
}

async function executeSearch(page, query) {
  const searchUrl = query.startsWith('http')
    ? query
    : `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

  try {
    const acceptBtn = await page.$('button[aria-label*="Accept all"], form button');
    if (acceptBtn) await acceptBtn.click();
  } catch {}

  await page.waitForTimeout(1800);

  const isBlankMap = await page.evaluate(() => {
    const input = document.querySelector('#searchboxinput');
    const hasNoQuery = !input || !input.value.trim();
    const isRoot = window.location.href.includes('/@') && !window.location.href.includes('/search/') && !window.location.href.includes('/place/');
    return hasNoQuery && isRoot;
  });

  if (isBlankMap) {
    const inputLocator = page.locator('#searchboxinput');
    if (await inputLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
      await inputLocator.fill(query);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2500);
    }
  }
}

async function runGmaps(config, control, log) {
  const { target, cap = 0, initialSaved = 0 } = config;
  const queries = loadTargetList(target);

  let startIdx = Number(config.startIdx) || 0;
  if (startIdx >= queries.length) {
    log(`All ${queries.length} queries completed. Resetting to query 1.`);
    startIdx = 0;
    clearActiveCheckpoint();
  }

  const baseFileName = path.basename(target).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 24);
  const csvPath = path.join(getExportsDir(), `gmaps_${baseFileName}.csv`);
  const fileExists = fs.existsSync(csvPath);

  const seenPhones = new Set();
  const seenTitles = new Set();

  if (fileExists) {
    try {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        
        // CSV columns: Query, Business Name (1), Primary Phone (2), Secondary Phone (3)
        const matchTitle = line.match(/^[^,]*,([^,]+)/);
        if (matchTitle) {
          const t = matchTitle[1].replace(/"/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (t) seenTitles.add(t);
        }
        
        const phones = line.match(/\+?\d[\d \-]{6,}\d/g);
        if (phones) {
          for (const p of phones) {
            seenPhones.add(p.replace(/[^\d]/g, ''));
          }
        }
      }
    } catch {}
  }

  // Write UTF-8 BOM if file doesn't exist to prevent Excel Mojibake / column shifts
  if (!fileExists) {
    fs.writeFileSync(csvPath, '\uFEFFQuery,Business Name,Primary Phone,Secondary Phone,Website,Address,Rating,Reviews\n', 'utf8');
  }

  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'query', title: 'Query' },
      { id: 'title', title: 'Business Name' },
      { id: 'phone_1', title: 'Primary Phone' },
      { id: 'phone_2', title: 'Secondary Phone' },
      { id: 'website', title: 'Website' },
      { id: 'address', title: 'Address' },
      { id: 'rating', title: 'Rating' },
      { id: 'reviews', title: 'Reviews' }
    ],
    append: true
  });

  saveHistoryItem({
    engine: 'gmaps',
    target,
    lastStep: startIdx,
    totalSaved: initialSaved,
    date: new Date().toISOString()
  });

  log(`Target queue: ${queries.length} queries`);
  log(`Starting at query ${startIdx + 1}`);

  const browser = await getBrowser();
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  let totalSaved = initialSaved;

  try {
    for (let i = startIdx; i < queries.length; i++) {
      if (control.cancelled) {
        log('Stopped by user.');
        break;
      }

      if (cap > 0 && totalSaved >= cap) {
        log(`Target limit of ${cap} leads reached.`);
        break;
      }

      const q = queries[i];
      log(`[${i + 1}/${queries.length}] ${q}`);

      try {
        await executeSearch(page, q);
      } catch {
        log(`Failed loading: ${q}. Advancing.`);
        updateProgress('gmaps', target, i + 1, totalSaved);
        continue;
      }

      if (page.url().includes('/maps/place/')) {
        const details = await extractActivePane(page);
        if (details.title && details.title !== 'Unknown') {
          const titleKey = details.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const p1Digits = details.phone_1 ? details.phone_1.replace(/[^\d]/g, '') : '';
          const p2Digits = details.phone_2 ? details.phone_2.replace(/[^\d]/g, '') : '';
          
          if ((titleKey && seenTitles.has(titleKey)) || 
              (p1Digits && seenPhones.has(p1Digits)) || 
              (p2Digits && seenPhones.has(p2Digits))) {
            log(`Skipped duplicate: ${details.title.substring(0, 24)}`);
          } else {
            await csvWriter.writeRecords([{ query: q, ...details }]);
            totalSaved++;
            if (titleKey) seenTitles.add(titleKey);
            if (p1Digits) seenPhones.add(p1Digits);
            if (p2Digits) seenPhones.add(p2Digits);
            log(`Saved #${totalSaved}: ${details.title} | ${details.phone_1}`);
          }
        }
        updateProgress('gmaps', target, i + 1, totalSaved);
        continue;
      }

      const seenUrls = new Set();
      let scrollRounds = 0;
      let idleScrolls = 0;

      while (scrollRounds < 35) {
        if (control.cancelled) break;
        if (cap > 0 && totalSaved >= cap) break;

        let visibleHrefs = [];
        try {
          visibleHrefs = await page.$$eval(
            'div[role="feed"] a.hfpxzc, div[role="feed"] a[href*="/maps/place/"]',
            (elements) => elements.map((el) => el.href).filter(Boolean)
          );
        } catch {
          visibleHrefs = [];
        }

        if (visibleHrefs.length === 0) {
          const isDead = await page.$('span:has-text("No more results"), div:has-text("Partial match"), div:has-text("No results found")');
          if (isDead) break;
        }

        const unvisited = visibleHrefs.filter((h) => !seenUrls.has(h));

        if (unvisited.length > 0) {
          idleScrolls = 0;

          for (const href of unvisited) {
            if (control.cancelled) break;
            if (cap > 0 && totalSaved >= cap) break;

            seenUrls.add(href);

            try {
              const card = page.locator(`div[role="feed"] a[href="${href}"]`).first();
              await card.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
              await card.click({ timeout: 3000 }).catch(() => {});

              await page.waitForSelector('h1.DUwDvf, button[data-item-id="address"]', { timeout: 5000 }).catch(() => {});

              const details = await extractActivePane(page);
              if (details.title && details.title !== 'Unknown') {
                const titleKey = details.title.toLowerCase().replace(/[^a-z0-9]/g, '');
                const p1Digits = details.phone_1 ? details.phone_1.replace(/[^\d]/g, '') : '';
                const p2Digits = details.phone_2 ? details.phone_2.replace(/[^\d]/g, '') : '';
                
                if ((titleKey && seenTitles.has(titleKey)) || 
                    (p1Digits && seenPhones.has(p1Digits)) || 
                    (p2Digits && seenPhones.has(p2Digits))) {
                  log(`Skipped duplicate: ${details.title.substring(0, 24)}`);
                } else {
                  await csvWriter.writeRecords([{ query: q, ...details }]);
                  totalSaved++;
                  if (titleKey) seenTitles.add(titleKey);
                  if (p1Digits) seenPhones.add(p1Digits);
                  if (p2Digits) seenPhones.add(p2Digits);
                  log(`Saved #${totalSaved}: ${details.title.substring(0, 24)} | ${details.phone_1}`);
                }
              }

              await returnToFeed(page);
            } catch {
              await returnToFeed(page);
            }
          }
        } else {
          idleScrolls++;
        }

        let isEndOfFeed = false;
        try {
          const marker = await page.$('span:has-text("reached the end of the list"), div.HlvSq, div:has-text("Partial match"), div:has-text("No more results")');
          if (marker) isEndOfFeed = true;
        } catch {}

        if (isEndOfFeed || idleScrolls >= 2) {
          break;
        }

        try {
          const feed = page.locator('div[role="feed"]').first();
          if (await feed.isVisible().catch(() => false)) {
            await feed.evaluate((el) => el.scrollBy(0, 1100));
          } else {
            await page.evaluate(() => window.scrollBy(0, 1100));
          }
          await page.waitForTimeout(1100);
        } catch {
          break;
        }

        scrollRounds++;
      }

      updateProgress('gmaps', target, i + 1, totalSaved);
    }
  } finally {
    try {
      await browser.close();
    } catch {}
    log('Finished.');
  }
}

module.exports = { runGmaps };
