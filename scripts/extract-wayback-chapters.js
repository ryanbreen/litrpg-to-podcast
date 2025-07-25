#!/usr/bin/env node

import { RoyalRoadScraper } from '../src/scraper/royal-road-scraper.js';
import { Database } from '../src/shared/database.js';

const waybackUrls = [
  'https://web.archive.org/web/20241122220926/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1905442/chapter-971-the-cost-of-saving-a-friend',
  'https://web.archive.org/web/20241122221002/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1910955/chapter-972-doctors-orders',
  'https://web.archive.org/web/20241122220932/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1912890/chapter-973-a-tough-job-to-do',
  'https://web.archive.org/web/20241122221012/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1914710/chapter-974-not-a-good-start',
  'https://web.archive.org/web/20241123013958/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1916428/chapter-975-an-old-mans-measured-approach',
  'https://web.archive.org/web/20241123020254/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1918278/chapter-976-setting-people-straight',
  'https://web.archive.org/web/20241126202447/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1923561/chapter-977-a-good-faction-developing-situation',
  'https://web.archive.org/web/20241126193541/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1925441/chapter-978-unsettling-whispers',
  'https://web.archive.org/web/20250114141824/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1927233/chapter-979-a-perplexing-creature',
  'https://web.archive.org/web/20250114140218/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1928878/chapter-980-durability-test',
  'https://web.archive.org/web/20250114225826/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1930614/chapter-981-a-perilous-escape-from-desolation',
  'https://web.archive.org/web/20250114022121/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1935903/chapter-982-rightful-burden',
  'https://web.archive.org/web/20250114165650/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1937730/chapter-983-king',
  'https://web.archive.org/web/20241204230343/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1939617/chapter-984-after-the-fall',
  'https://web.archive.org/web/20250114004737/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1941510/chapter-985-intelligence-work',
];

async function extractWaybackChapters() {
  const scraper = new RoyalRoadScraper();
  const db = new Database();

  try {
    console.log('🚀 Starting Wayback Machine extraction...');

    // Initialize scraper and database
    await scraper.init();
    await db.init();

    // Check which chapters already exist
    const existingChapters = [];
    for (let i = 971; i <= 985; i++) {
      const existing = await db.getChapter(`chapter_${i}`);
      if (existing) {
        existingChapters.push(i);
        console.log(`⏭️  Skipping chapter ${i} - already exists`);
      }
    }

    // Filter URLs to only extract missing chapters
    const urlsToExtract = waybackUrls.filter((url, index) => {
      const chapterNum = 971 + index;
      return !existingChapters.includes(chapterNum);
    });

    console.log(
      `📋 Need to extract ${urlsToExtract.length} chapters (${existingChapters.length} already exist)`
    );

    // Extract missing chapters from Wayback Machine
    const chapters =
      urlsToExtract.length > 0
        ? await scraper.scrapeWaybackChapters(urlsToExtract)
        : [];

    console.log(
      `📚 Extracted ${chapters.length} chapters from Wayback Machine`
    );

    // Add chapters to database
    for (const chapter of chapters) {
      await db.upsertChapter(chapter);
      console.log(
        `✅ Added chapter ${chapter.chapterNumber} to database: ${chapter.title}`
      );
    }

    console.log('🎉 Wayback Machine extraction complete!');
    console.log('Next steps:');
    console.log('  1. Run speaker identification on the extracted chapters');
    console.log('  2. Generate TTS audio');
    console.log('  3. Publish to RSS feed');
  } catch (error) {
    console.error('❌ Wayback extraction failed:', error);
  } finally {
    // Clean up
    if (scraper.browser) {
      await scraper.close();
    }
    if (db) {
      await db.close();
    }
  }
}

// Run the extraction
extractWaybackChapters();
