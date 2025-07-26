#!/usr/bin/env node
import { RoyalRoadScraper } from '../src/scraper/royal-road-scraper.js';
import { Database } from '../src/shared/database.js';

async function rescrapeChapter1005() {
  const scraper = new RoyalRoadScraper();
  const db = new Database();

  try {
    await db.init();
    await scraper.init();

    console.log('🔄 Re-scraping chapter 1005 with cleaned content...');

    // Scrape chapter 1005
    const result = await scraper.scrapeChapterByNumber(1005);

    if (result.success) {
      console.log('✅ Successfully scraped chapter 1005');
      console.log(`📁 Saved to: ${result.filepath}`);

      // Add to database
      await db.upsertChapter(result.chapterData);
      console.log('💾 Added to database');

      // Verify the content doesn't have the warning
      const hasWarning = result.chapterData.content.includes(
        'This tale has been unlawfully lifted from Royal Road'
      );
      if (hasWarning) {
        console.error(
          '❌ WARNING: The piracy warning is still present in the content!'
        );
      } else {
        console.log(
          '✅ Confirmed: Piracy warning has been removed from content'
        );
      }
    } else {
      console.error('❌ Failed to scrape chapter 1005');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await scraper.close();
    await db.close();
  }
}

rescrapeChapter1005();
