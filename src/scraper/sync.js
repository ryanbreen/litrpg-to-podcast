import { PatreonScraper } from './scraper.js';

async function syncPatreon() {
  console.log('Starting Patreon sync...');
  const scraper = new PatreonScraper();
  
  try {
    const newChapters = await scraper.scrapeAll();
    
    if (newChapters.length > 0) {
      console.log(`Found ${newChapters.length} new chapters. Starting TTS processing...`);
      
      // Here we would typically queue TTS jobs
      // For now, just log the chapters found
      newChapters.forEach(chapter => {
        console.log(`- ${chapter.title} (${chapter.wordCount} words)`);
      });
    } else {
      console.log('No new chapters found.');
    }
    
  } catch (error) {
    console.error('Sync failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPatreon();
}

export { syncPatreon };