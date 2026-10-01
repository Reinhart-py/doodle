const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { getExportsDir, updateProgress, saveHistoryItem } = require('./storage');

async function getBrowser() {
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  try {
    return await chromium.launch({ ...launchOptions, channel: 'chrome' });
  } catch {
    return await chromium.launch({ ...launchOptions, channel: 'msedge' });
  }
}

function buildSearchUrl(city, query) {
  const cleanCity = city.trim().toLowerCase();
  const encodedQuery = encodeURIComponent(query.trim());

  const viewports = {
    'abu dhabi': '54.756359%2C24.560894%2F9.96',
    'al ain': '55.760559%2C24.207500%2F11.0',
    'sharjah': '55.405556%2C25.357500%2F11.5',
    'ajman': '55.479444%2C25.411111%2F12.0'
  };

  if (viewports[cleanCity]) {
    return `https://2gis.ae/dubai/search/${encodedQuery}?m=${viewports[cleanCity]}`;
  }

  return `https://2gis.ae/${cleanCity}/search/${encodedQuery}`;
}

async function runTwoGis(config, control, log) {
  const { city, query, cap = 0, initialSaved = 0 } = config;
  const { loadTargetList, getExportsDir, updateProgress, saveHistoryItem } = require('./storage');
  
  const queries = loadTargetList(query);
  let startIdx = Number(config.startIdx) || 0;
  if (startIdx >= queries.length) {
    log(`All ${queries.length} queries completed. Resetting to query 1.`);
    startIdx = 0;
  }

  const targetLabel = `${city}:${path.basename(query)}`;
  const safeName = targetLabel.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
  const csvPath = path.join(getExportsDir(), `2gis_${safeName}.csv`);
  const seenPhones = new Set();
  const seenTitles = new Set();

  if (fileExists) {
    try {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
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

  const csvWriter = createCsvWriter({
    path: csvPath,
    header: [
      { id: 'query', title: 'Query' },
      { id: 'title', title: 'Business Name' },
      { id: 'category', title: 'Category' },
      { id: 'phone_1', title: 'Primary Phone' },
      { id: 'phone_2', title: 'Secondary Phone' },
      { id: 'website', title: 'Website' },
      { id: 'address', title: 'Address' }
    ],
    append: fileExists
  });

  if (!fileExists) {
    fs.writeFileSync(csvPath, '\uFEFFQuery,Business Name,Category,Primary Phone,Secondary Phone,Website,Address\n', 'utf8');
  }

  saveHistoryItem({
    engine: '2gis',
    target: targetLabel,
    lastStep: startIdx,
    totalSaved: initialSaved,
    date: new Date().toISOString()
  });

  log(`Searching 2GIS in ${city} for ${queries.length} queries`);
  log(`Saving leads to: ${csvPath}`);

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();

  let totalSaved = initialSaved;

  try {
    for (let i = startIdx; i < queries.length; i++) {
      if (control.cancelled) {
        log('Task paused by user.');
        break;
      }
      if (cap > 0 && totalSaved >= cap) {
        log(`Target limit of ${cap} reached.`);
        break;
      }

      const q = queries[i];
      log(`[${i + 1}/${queries.length}] Processing: ${q}`);
      
      const url = buildSearchUrl(city, q);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(()=>{});
      await page.waitForTimeout(3000);

      let currentPage = 1;
      let hasNextPage = true;

    while (currentPage <= 150 && hasNextPage) {
      if (control.cancelled) {
        break;
      }

      if (cap > 0 && totalSaved >= cap) {
        log(`Target limit of ${cap} reached.`);
        break;
      }

      log(`Scraping Page ${currentPage}...`);

      for (let s = 0; s < 4; s++) {
        try {
          await page.evaluate(() => {
            const containers = document.querySelectorAll('div._15gu4wr, div[class*="sidebar"]');
            if (containers.length) {
              containers[containers.length - 1].scrollTop += 700;
            } else {
              window.scrollBy(0, 700);
            }
          });
          await page.waitForTimeout(250);
        } catch {}
      }

      const cardHandles = await page.$$('div._1kf6gff, div[class*="_1469e3a"], a[href*="/firm/"]');

      if (cardHandles.length === 0) {
        log('No more business listings found.');
        break;
      }

      for (const card of cardHandles) {
        if (control.cancelled) break;
        if (cap > 0 && totalSaved >= cap) break;

        try {
          const rawText = await card.innerText();
          const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length === 0) continue;

          const title = lines[0];
          let address = 'None';
          for (let l = 1; l < lines.length; l++) {
            const lower = lines[l].toLowerCase();
            if (lower.includes('street') || lower.includes('road') || lower.includes('tower') || lower.includes('building') || lower.includes('bay')) {
              address = lines[l];
              break;
            }
          }

          await card.click();
          await page.waitForTimeout(600);

          try {
            const showBtn = await page.$('span:has-text("Show phone"), button:has-text("phone"), button:has-text("Phone")');
            if (showBtn) {
              await showBtn.click();
              await page.waitForTimeout(300);
            }
          } catch {}

          const phoneLinks = await page.$$('a[href^="tel:"]');
          const foundPhones = [];
          for (const pl of phoneLinks) {
            const href = await pl.getAttribute('href');
            if (href) {
              const num = href.replace('tel:', '').trim();
              if (num && !foundPhones.includes(num)) foundPhones.push(num);
            }
          }

          let website = 'None';
          const webLinks = await page.$$('a[href^="http"]');
          for (const wl of webLinks) {
            const href = await wl.getAttribute('href');
            if (href && !href.includes('2gis') && !href.includes('google')) {
              website = href;
              break;
            }
          }

          let category = lines.length > 1 ? lines[1] : 'General Business';
          
          const titleKey = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          const p1Digits = foundPhones[0] ? foundPhones[0].replace(/[^\d]/g, '') : '';
          const p2Digits = foundPhones[1] ? foundPhones[1].replace(/[^\d]/g, '') : '';

          if ((titleKey && seenTitles.has(titleKey)) || 
              (p1Digits && seenPhones.has(p1Digits)) || 
              (p2Digits && seenPhones.has(p2Digits))) {
            log(`Skipped duplicate: ${title.substring(0, 22)}`);
          } else {
            await csvWriter.writeRecords([{
              query: q,
              title,
              category,
              phone_1: foundPhones[0] || 'None',
              phone_2: foundPhones[1] || 'None',
              website,
              address
            }]);

            totalSaved++;
            if (titleKey) seenTitles.add(titleKey);
            if (p1Digits) seenPhones.add(p1Digits);
            if (p2Digits) seenPhones.add(p2Digits);
            log(`Saved #${totalSaved}: ${title.substring(0, 22)} | ${foundPhones[0] || 'None'}`);
          }

          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        } catch {}
      }

      const nextBtn = await page.$('div._5ocwns div:last-child, div[class*="pagination"] div:last-child');
      if (nextBtn) {
        await nextBtn.scrollIntoViewIfNeeded();
        await nextBtn.click();
        currentPage++;
        await page.waitForTimeout(2500);
      } else {
        log(`Finished scraping query: ${q}`);
        hasNextPage = false;
      }
    }
    
    updateProgress('2gis', targetLabel, i + 1, totalSaved);
  }
  } finally {
    try {
      await browser.close();
    } catch {}
    log('Done.');
  }
}

module.exports = { runTwoGis };
