#!/usr/bin/env node

import { RoyalRoadScraper } from '../src/scraper/royal-road-scraper.js';
import { Database } from '../src/shared/database.js';

const remainingUrls = [
  'https://web.archive.org/web/20250114165650/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1937730/chapter-983-king',
  'https://web.archive.org/web/20241204230343/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1939617/chapter-984-after-the-fall',
  'https://web.archive.org/web/20250114004737/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1941510/chapter-985-intelligence-work',
];

async function extractRemainingChapters() {
  const scraper = new RoyalRoadScraper();
  const db = new Database();

  try {
    console.log('🚀 Starting extraction of remaining chapters (983-985)...');

    // Initialize scraper and database
    await scraper.init();
    await db.init();

    // Extract the remaining 3 chapters
    const chapters = await scraper.scrapeWaybackChapters(remainingUrls);

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

    console.log('🎉 Extraction complete!');
    console.log('📊 Summary of all Wayback chapters (971-985):');

    // Show summary of all wayback chapters
    const allChapters = await db.all(`
      SELECT id, title FROM chapters 
      WHERE id BETWEEN 'chapter_971' AND 'chapter_985' 
      ORDER BY id
    `);

    console.log(`Total chapters: ${allChapters.length}/15`);
    allChapters.forEach((ch) => console.log(`  ✅ ${ch.id}: ${ch.title}`));

    // Check missing
    for (let i = 971; i <= 985; i++) {
      const exists = allChapters.find((ch) => ch.id === `chapter_${i}`);
      if (!exists) {
        console.log(`  ❌ chapter_${i}: MISSING`);
      }
    }
  } catch (error) {
    console.error('❌ Extraction failed:', error);
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
extractRemainingChapters();
