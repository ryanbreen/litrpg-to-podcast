#!/usr/bin/env node

import { RoyalRoadScraper } from '../src/scraper/royal-road-scraper.js';
import { Database } from '../src/shared/database.js';

const chapter985Url =
  'https://web.archive.org/web/20250114004737/https://www.royalroad.com/fiction/36049/the-primal-hunter/chapter/1941510/chapter-985-intelligence-work';

async function extractChapter985() {
  const scraper = new RoyalRoadScraper();
  const db = new Database();

  try {
    console.log('🚀 Attempting to extract chapter 985...');

    // Initialize scraper and database
    await scraper.init();
    await db.init();

    // Extract just chapter 985
    const chapters = await scraper.scrapeWaybackChapters([chapter985Url]);

    if (chapters.length > 0) {
      console.log(`📚 Successfully extracted chapter 985!`);

      // Add to database
      const chapter = chapters[0];
      await db.upsertChapter(chapter);
      console.log(
        `✅ Added chapter ${chapter.chapterNumber} to database: ${chapter.title}`
      );

      console.log('\n🎉 All Wayback chapters (971-985) are now complete!');
    } else {
      console.log('❌ Failed to extract chapter 985');
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
extractChapter985();
