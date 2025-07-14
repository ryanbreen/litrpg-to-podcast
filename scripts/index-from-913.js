import { PatreonScraper } from '../src/scraper/scraper.js';
import { Database } from '../src/shared/database.js';

async function indexFromChapter913() {
  const scraper = new PatreonScraper();
  const db = new Database();
  
  try {
    await db.init();
    await scraper.init();
    
    console.log('🔍 Indexing all chapters from 913 onwards...');
    
    // Go to posts page
    const postsUrl = 'https://www.patreon.com/c/zogarth/posts';
    console.log(`📖 Navigating to: ${postsUrl}`);
    await scraper.page.goto(postsUrl, { waitUntil: 'networkidle' });
    
    // Give page time to load
    await scraper.page.waitForTimeout(3000);
    
    console.log('📜 Scrolling to load ALL posts...');
    
    // Scroll to load all posts - we need to get everything
    let scrollCount = 0;
    let previousHeight = 0;
    let stableCount = 0;
    const maxScrolls = 100; // Increase limit since we need to go far back
    
    while (scrollCount < maxScrolls && stableCount < 3) {
      // Scroll to bottom
      await scraper.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await scraper.page.waitForTimeout(2000);
      
      const currentHeight = await scraper.page.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === previousHeight) {
        stableCount++;
        console.log(`📜 Height stable (${stableCount}/3) at ${currentHeight}px`);
      } else {
        stableCount = 0;
        previousHeight = currentHeight;
        scrollCount++;
        console.log(`📜 Scrolled ${scrollCount}/${maxScrolls} times, height: ${currentHeight}px`);
      }
    }
    
    console.log('✅ Finished scrolling, collecting all chapter links...');
    
    // Collect all chapter links from 913 onwards
    const chapters = await scraper.page.$$eval('a[href*="/posts/"]', links => {
      const chapterLinks = [];
      
      links.forEach(link => {
        const title = link.querySelector('h3')?.textContent || link.textContent || '';
        const chapterMatch = title.match(/Chapter\s+(\d+)/i);
        
        if (chapterMatch) {
          const chapterNum = parseInt(chapterMatch[1]);
          if (chapterNum >= 913) { // Only chapters 913 and above
            // Extract post ID from URL
            const urlMatch = link.href.match(/\/posts\/.*-(\d+)$/);
            const postId = urlMatch ? urlMatch[1] : null;
            
            if (postId) {
              chapterLinks.push({
                title: title.trim(),
                url: link.href,
                chapterNumber: chapterNum,
                id: postId
              });
            }
          }
        }
      });
      
      // Remove duplicates by chapter number (keep first occurrence)
      const uniqueChapters = [];
      const seenChapters = new Set();
      
      chapterLinks.forEach(chapter => {
        if (!seenChapters.has(chapter.chapterNumber)) {
          seenChapters.add(chapter.chapterNumber);
          uniqueChapters.push(chapter);
        }
      });
      
      // Sort by chapter number (oldest first)
      return uniqueChapters.sort((a, b) => a.chapterNumber - b.chapterNumber);
    });
    
    console.log(`\n📚 Found ${chapters.length} chapters from 913 onwards:`);
    
    if (chapters.length === 0) {
      console.log('❌ No chapters found from 913 onwards');
      return;
    }
    
    // Show first few and last few chapters
    console.log('\n📋 First 10 chapters:');
    chapters.slice(0, 10).forEach((ch, i) => {
      console.log(`  ${i + 1}. Chapter ${ch.chapterNumber}: ${ch.title}`);
    });
    
    if (chapters.length > 10) {
      console.log(`\n📋 ... and ${chapters.length - 10} more chapters up to:`);
      chapters.slice(-3).forEach(ch => {
        console.log(`  Chapter ${ch.chapterNumber}: ${ch.title}`);
      });
    }
    
    // Create stub records in database (NO CONTENT - just metadata)
    console.log('\n💾 Creating stub records...');
    
    let created = 0;
    let skipped = 0;
    
    for (const chapter of chapters) {
      // Check if chapter already exists
      const existing = await db.getChapter(chapter.id);
      if (existing) {
        console.log(`✓ Chapter ${chapter.chapterNumber} already exists`);
        skipped++;
        continue;
      }
      
      // Create stub record with NO CONTENT
      const stubData = {
        id: chapter.id,
        title: chapter.title,
        url: chapter.url,
        content: null,           // No content - will be scraped later
        scrapedAt: null,         // Not scraped yet
        wordCount: 0,
        createdAt: new Date().toISOString()
      };
      
      await db.upsertChapter(stubData);
      console.log(`✅ Created stub for Chapter ${chapter.chapterNumber}: ${chapter.title}`);
      created++;
    }
    
    console.log(`\n✨ Indexing complete!`);
    console.log(`📊 Results:`);
    console.log(`  - Created: ${created} new stubs`);
    console.log(`  - Skipped: ${skipped} existing`);
    console.log(`  - Total: ${chapters.length} chapters indexed`);
    
    // Show database summary
    const allChapters = await db.getChapters();
    const stubChapters = allChapters.filter(ch => !ch.scrapedAt);
    const scrapedChapters = allChapters.filter(ch => ch.scrapedAt);
    
    console.log('\n📊 Database summary:');
    console.log(`  Total chapters: ${allChapters.length}`);
    console.log(`  Scraped chapters: ${scrapedChapters.length}`);
    console.log(`  Stub chapters (ready for scraping): ${stubChapters.length}`);
    
    // Show chapter range
    if (allChapters.length > 0) {
      const chapterNumbers = allChapters.map(ch => {
        const match = ch.title.match(/Chapter\s+(\d+)/i);
        return match ? parseInt(match[1]) : 0;
      }).filter(n => n > 0).sort((a, b) => a - b);
      
      console.log(`\n📖 Chapter range: ${chapterNumbers[0]} to ${chapterNumbers[chapterNumbers.length - 1]}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await scraper.close();
    await db.close();
  }
}

// Run the indexing
indexFromChapter913();