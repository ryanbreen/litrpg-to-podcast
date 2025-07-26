import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import config from '../shared/config.js';

class RoyalRoadScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.server = null; // Set by API server for logging
  }

  log(message, level = 'info') {
    if (this.server) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  async init() {
    this.log('🚀 Initializing Royal Road scraper...');

    // Launch browser with persistent session
    this.browser = await chromium.launchPersistentContext(
      config.royalroad.sessionDir,
      {
        headless: false, // Use headed mode to access logged-in session
        viewport: { width: 1280, height: 720 },
      }
    );

    this.page = await this.browser.newPage();
    this.log('✅ Royal Road scraper initialized');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.log('🔒 Royal Road scraper closed');
    }
  }

  /**
   * Navigate to the Primal Hunter story page and search for a specific chapter
   */
  async navigateToStory() {
    const storyUrl = config.royalroad.storyUrl;
    const currentUrl = this.page.url();
    this.log(`📖 Navigating to story: ${storyUrl} (from ${currentUrl})`);

    await this.page.goto(storyUrl, {
      waitUntil: 'networkidle',
      timeout: 60000, // 60 second timeout
    });
    this.log('✅ Story page loaded - ready for chapter search');
  }

  /**
   * Search for a specific chapter number using the search field
   */
  async searchForChapter(chapterNumber) {
    this.log(`🔍 Searching for chapter ${chapterNumber}...`);

    // Find the search input field
    const searchInput = await this.page.locator(
      'input.form-control[placeholder="Search..."]'
    );

    // Clear and type the chapter number
    await searchInput.clear();
    await searchInput.fill(chapterNumber.toString());

    // Wait for the search results to update
    await this.page.waitForTimeout(1000); // Give time for live search to update

    // Look for the first chapter row result
    const chapterRow = this.page.locator('tr.chapter-row').first();

    // Check if we found a result
    const chapterExists = (await chapterRow.count()) > 0;
    if (!chapterExists) {
      throw new Error(`Chapter ${chapterNumber} not found in search results`);
    }

    // Get the chapter link
    const chapterLink = await chapterRow.locator('a').first();
    const chapterUrl = await chapterLink.getAttribute('href');
    const chapterTitle = await chapterLink.textContent();

    this.log(`📄 Found chapter: ${chapterTitle}`);
    return {
      url: `https://www.royalroad.com${chapterUrl}`,
      title: chapterTitle.trim(),
      number: chapterNumber,
    };
  }

  /**
   * Scrape a specific chapter's content
   */
  async scrapeChapter(chapterInfo) {
    this.log(`📖 Scraping chapter: ${chapterInfo.title}`);

    // Navigate to the chapter page
    await this.page.goto(chapterInfo.url, {
      waitUntil: 'networkidle',
      timeout: 60000, // 60 second timeout
    });

    // Extract the title from the page
    const titleElement = this.page.locator('div.fic-header h1');
    const pageTitle = await titleElement.textContent();

    // Extract the chapter content
    const contentElement = this.page.locator(
      'div.chapter-inner.chapter-content'
    );
    let content = await contentElement.textContent();

    if (!content || content.trim().length === 0) {
      throw new Error(`No content found for chapter ${chapterInfo.number}`);
    }

    // Filter out Royal Road piracy warning text
    content = content.replace(
      /This tale has been unlawfully lifted from Royal Road\. If you spot it on Amazon, please report it\./g,
      ''
    );

    // Also filter out other common Royal Road warnings
    content = content.replace(
      /This story originates from Royal Road\. Ensure the author gets the support they deserve by reading it there\./g,
      ''
    );

    // Clean up any extra whitespace left by removals
    content = content.replace(/\n\s*\n\s*\n/g, '\n\n').trim();

    // Generate a unique ID based on chapter number (similar to Patreon post IDs)
    const chapterId = `rr_${chapterInfo.number}`;

    const chapterData = {
      id: chapterId,
      title: pageTitle ? pageTitle.trim() : chapterInfo.title,
      url: chapterInfo.url,
      content: content.trim(),
      wordCount: content.trim().split(/\s+/).length,
      scrapedAt: new Date().toISOString(),
      source: 'royalroad',
      chapterNumber: chapterInfo.number,
    };

    this.log(
      `✅ Scraped chapter ${chapterInfo.number}: ${chapterData.wordCount} words`
    );
    return chapterData;
  }

  /**
   * Save chapter data to JSON file (similar to Patreon scraper)
   */
  async saveChapterData(chapterData) {
    const dataDir = config.paths?.data || './public/data';
    await fs.mkdir(dataDir, { recursive: true });

    const filename = `${chapterData.id}.json`;
    const filepath = path.join(dataDir, filename);

    await fs.writeFile(filepath, JSON.stringify(chapterData, null, 2));
    this.log(`💾 Saved chapter data: ${filename}`);

    return filepath;
  }

  /**
   * Main method to scrape a specific chapter by number
   */
  async scrapeChapterByNumber(chapterNumber) {
    try {
      // Navigate to story page
      await this.navigateToStory();

      // Search for the specific chapter
      const chapterInfo = await this.searchForChapter(chapterNumber);

      // Scrape the chapter content
      const chapterData = await this.scrapeChapter(chapterInfo);

      // Save the data
      const filepath = await this.saveChapterData(chapterData);

      return {
        success: true,
        chapterData,
        filepath,
      };
    } catch (error) {
      this.log(
        `❌ Failed to scrape chapter ${chapterNumber}: ${error.message}`,
        'error'
      );
      throw error;
    }
  }

  /**
   * Get the next chapter number to scrape (based on START_FROM_CHAPTER config)
   * NOTE: This method doesn't have database access, so it only handles single chapter extraction.
   * For bulk extraction, use the API server's load-next-chapter endpoint which tracks progress.
   */
  getNextChapterNumber() {
    const startFrom = config.source.startFromChapter;

    // This method is designed for single chapter extraction only
    // For bulk operations, the API server should handle chapter tracking
    this.log(
      `⚠️  getNextChapterNumber() always returns startFromChapter: ${startFrom}`
    );
    this.log(
      `⚠️  For bulk extraction, use repeated /api/chapters/load-next calls instead`
    );

    return startFrom;
  }

  /**
   * Main sync method (compatible with existing Patreon workflow)
   */
  async sync() {
    this.log('🔄 Starting Royal Road sync...');

    try {
      const nextChapter = this.getNextChapterNumber();
      this.log(`📖 Loading chapter ${nextChapter}...`);

      const result = await this.scrapeChapterByNumber(nextChapter);

      this.log(`✅ Successfully scraped chapter ${nextChapter}`);
      return [result.chapterData]; // Return array for compatibility
    } catch (error) {
      this.log(`❌ Sync failed: ${error.message}`, 'error');
      throw error;
    }
  }

  /**
   * Compatibility method for Patreon workflow - scrape multiple chapters for bulk extraction
   */
  async scrapeAll() {
    this.log('🔄 Starting Royal Road bulk extraction...');

    // If we don't have server access, fall back to single chapter mode
    if (!this.server) {
      this.log(
        '⚠️  No server instance available, falling back to single chapter mode'
      );
      return await this.sync();
    }

    const newChapters = [];
    const maxChapters = 10; // Limit bulk extraction to prevent infinite loops

    try {
      // Keep trying to load next chapters until we can't find any more
      for (let i = 0; i < maxChapters; i++) {
        try {
          // Use the server's logic to find the next chapter number
          const chapters = await this.server.db.getChapters();
          let highestChapterNumber = 0;

          if (chapters.length === 0) {
            highestChapterNumber = config.source.startFromChapter - 1;
          } else {
            chapters.forEach((chapter) => {
              const match = chapter.title.match(/Chapter (\d+)/i);
              if (match) {
                const num = parseInt(match[1]);
                if (num > highestChapterNumber) {
                  highestChapterNumber = num;
                }
              }
            });

            // If the configured start is higher than our highest chapter, jump to the configured start
            if (config.source.startFromChapter > highestChapterNumber + 1) {
              highestChapterNumber = config.source.startFromChapter - 1;
            }
          }

          const nextChapterNumber = highestChapterNumber + 1;
          this.log(
            `🔍 Bulk extraction: Looking for chapter ${nextChapterNumber}...`
          );

          // Try to scrape this chapter (will navigate to story page first)
          this.log(
            `🔄 About to scrape chapter ${nextChapterNumber} - will navigate to story page first`
          );
          const result = await this.scrapeChapterByNumber(nextChapterNumber);

          if (result && result.chapterData) {
            newChapters.push(result.chapterData);
            this.log(
              `✅ Bulk extracted chapter ${nextChapterNumber}: ${result.chapterData.title}`
            );

            // Add to database immediately so next iteration sees it
            await this.server.db.upsertChapter(result.chapterData);
          } else {
            this.log(
              `❌ Chapter ${nextChapterNumber} not found, stopping bulk extraction`
            );
            break;
          }
        } catch (error) {
          this.log(
            `❌ Failed to extract chapter, stopping bulk extraction: ${error.message}`,
            'error'
          );
          break;
        }
      }

      if (newChapters.length === maxChapters) {
        this.log(
          `⚠️  Reached maximum bulk extraction limit of ${maxChapters} chapters`
        );
      }

      this.log(
        `🎯 Bulk extraction complete: Found ${newChapters.length} new chapters`
      );
      return newChapters;
    } catch (error) {
      this.log(`❌ Bulk extraction failed: ${error.message}`, 'error');
      // Fall back to single chapter mode if bulk fails
      return await this.sync();
    }
  }

  /**
   * Scrape chapters from Wayback Machine URLs
   */
  async scrapeWaybackChapters(waybackUrls) {
    this.log(
      `🕰️ Starting Wayback Machine extraction for ${waybackUrls.length} chapters...`
    );

    const chapters = [];

    for (let i = 0; i < waybackUrls.length; i++) {
      const url = waybackUrls[i];
      try {
        this.log(
          `📚 Extracting chapter ${i + 1}/${waybackUrls.length} from Wayback Machine...`
        );

        // Navigate to the Wayback Machine URL
        await this.page.goto(url, {
          waitUntil: 'domcontentloaded', // Less strict wait condition for Wayback Machine
          timeout: 60000,
        });

        // Extract the chapter number from the URL
        const chapterMatch = url.match(/chapter-(\d+)-/);
        const chapterNumber = chapterMatch
          ? parseInt(chapterMatch[1])
          : 971 + i;

        // Extract the title from the page (same logic as regular Royal Road)
        const titleElement = this.page.locator('div.fic-header h1');
        const pageTitle = await titleElement.textContent().catch(() => null);

        // Extract chapter title from URL as fallback
        const urlTitleMatch = url.match(/chapter-\d+-(.*?)$/);
        const urlTitle = urlTitleMatch
          ? urlTitleMatch[1]
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (l) => l.toUpperCase())
          : `Chapter ${chapterNumber}`;

        const title = pageTitle || `Chapter ${chapterNumber} - ${urlTitle}`;

        // Extract the chapter content (same logic as regular Royal Road)
        const contentElement = this.page.locator(
          'div.chapter-inner.chapter-content'
        );
        const content = await contentElement.textContent();

        if (!content || content.trim().length === 0) {
          throw new Error(
            `No content found for chapter ${chapterNumber} in Wayback Machine`
          );
        }

        // Generate chapter data (use chapter_ prefix for consistency)
        const chapterId = `chapter_${chapterNumber}`;

        const chapterData = {
          id: chapterId,
          title: title.trim(),
          url: url,
          content: content.trim(),
          wordCount: content.trim().split(/\s+/).length,
          scrapedAt: new Date().toISOString(),
          source: 'royalroad-wayback',
          chapterNumber: chapterNumber,
        };

        // Save the data
        await this.saveChapterData(chapterData);

        chapters.push(chapterData);
        this.log(
          `✅ Extracted chapter ${chapterNumber}: ${chapterData.title} (${chapterData.wordCount} words)`
        );

        // Brief pause between requests to be respectful to Wayback Machine
        if (i < waybackUrls.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        this.log(
          `❌ Failed to extract chapter from ${url}: ${error.message}`,
          'error'
        );
        // Continue with next chapter instead of failing entirely
      }
    }

    this.log(
      `🕰️ Wayback Machine extraction complete: ${chapters.length} chapters extracted`
    );
    return chapters;
  }

  /**
   * Scrape chapter by URL (for compatibility)
   */
  async scrapeChapterByUrl(url) {
    this.log(`📖 Scraping chapter from URL: ${url}`);

    // Navigate directly to the chapter page
    await this.page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 60000, // 60 second timeout
    });

    // Extract the title from the page
    const titleElement = this.page.locator('div.fic-header h1');
    const pageTitle = await titleElement.textContent();

    // Extract the chapter content
    const contentElement = this.page.locator(
      'div.chapter-inner.chapter-content'
    );
    const content = await contentElement.textContent();

    if (!content || content.trim().length === 0) {
      throw new Error(`No content found at URL: ${url}`);
    }

    // Extract chapter number from URL if possible
    const chapterMatch = url.match(/chapter-(\d+)/);
    const chapterNumber = chapterMatch ? parseInt(chapterMatch[1]) : Date.now();

    // Generate a unique ID
    const chapterId = `rr_${chapterNumber}`;

    const chapterData = {
      id: chapterId,
      title: pageTitle ? pageTitle.trim() : 'Royal Road Chapter',
      url: url,
      content: content.trim(),
      wordCount: content.trim().split(/\s+/).length,
      scrapedAt: new Date().toISOString(),
      source: 'royalroad',
      chapterNumber: chapterNumber,
    };

    // Save the data
    await this.saveChapterData(chapterData);

    this.log(`✅ Scraped chapter from URL: ${chapterData.wordCount} words`);
    return chapterData;
  }

  /**
   * Find next chapter (for compatibility with Patreon workflow)
   */
  async findNextChapter(previousChapterNumber) {
    const nextChapterNumber = previousChapterNumber + 1;

    this.log(`🔍 Looking for chapter ${nextChapterNumber}...`);

    try {
      // Make sure scraper is initialized
      if (!this.page) {
        await this.init();
      }

      // Navigate to story page first
      await this.navigateToStory();

      // Search for the chapter
      const chapterInfo = await this.searchForChapter(nextChapterNumber);

      return {
        url: chapterInfo.url,
        title: chapterInfo.title,
        chapterNumber: nextChapterNumber,
      };
    } catch (error) {
      this.log(
        `❌ Chapter ${nextChapterNumber} not found: ${error.message}`,
        'error'
      );
      throw new Error(`Chapter ${nextChapterNumber} not found on Royal Road`);
    }
  }
}

export { RoyalRoadScraper };
