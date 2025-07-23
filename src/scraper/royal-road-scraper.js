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
    this.log(`📖 Navigating to story: ${storyUrl}`);

    await this.page.goto(storyUrl, {
      waitUntil: 'networkidle',
      timeout: 60000, // 60 second timeout
    });
    this.log('✅ Story page loaded');
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
    const content = await contentElement.textContent();

    if (!content || content.trim().length === 0) {
      throw new Error(`No content found for chapter ${chapterInfo.number}`);
    }

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
   */
  getNextChapterNumber() {
    const startFrom = config.source.startFromChapter;

    // For now, just return the start chapter
    // TODO: Implement logic to track which chapters have been scraped
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
   * Compatibility method for Patreon workflow - scrape one chapter
   */
  async scrapeAll() {
    // For Royal Road, we only scrape one chapter at a time
    return await this.sync();
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
