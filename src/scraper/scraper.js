import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import config from '../shared/config.js';

class PatreonScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.server = null; // Will be set by APIServer for logging
  }

  log(message, level = 'info') {
    if (this.server && this.server.log) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  async init() {
    try {
      this.log('🚀 Initializing browser...');

      // Clean up any existing browser first
      if (this.browser) {
        this.log('🧹 Closing existing browser...');
        await this.close();
      }

      this.log('📂 Session directory: ' + config.patreon.sessionDir);
      this.log('🔧 Launching browser context...');

      this.browser = await chromium.launchPersistentContext(
        config.patreon.sessionDir,
        {
          headless: false, // Non-headless mode for session debugging
          viewport: { width: 1280, height: 720 },
        }
      );

      this.log('✅ Browser context created');

      if (!this.browser) {
        throw new Error('Browser context failed to launch');
      }

      this.log('📄 Creating new page...');
      this.page = await this.browser.newPage();

      if (!this.page) {
        throw new Error('Failed to create new page');
      }

      this.log('✅ Browser initialized successfully');
    } catch (error) {
      this.log(`❌ Failed to initialize browser: ${error.message}`, 'error');
      this.log(`❌ Error stack: ${error.stack}`, 'error');
      // Clean up on failure
      this.browser = null;
      this.page = null;
      throw error;
    }
  }

  async close() {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        this.log(`⚠️ Error closing browser: ${error.message}`);
      }
      this.browser = null;
      this.page = null;
    }
  }

  async waitWithJitter() {
    const delay =
      config.scraping.delayBaseMs +
      Math.random() * config.scraping.delayJitterMs;

    if (this.page) {
      await this.page.waitForTimeout(delay);
    } else {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  async retryWithBackoff(fn, retries = config.scraping.maxRetries) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (error) {
        if (i === retries - 1) throw error;

        const backoffDelay = 1000 * Math.pow(2, i);
        this.log(
          `Retry ${i + 1}/${retries} in ${backoffDelay}ms: ${error.message}`
        );

        // Use setTimeout instead of page.waitForTimeout if page is not available
        if (this.page) {
          await this.page.waitForTimeout(backoffDelay);
        } else {
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }
  }

  async scrollToLoadAll() {
    let previousHeight = 0;
    let stableCount = 0;

    while (stableCount < 2) {
      await this.page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      await this.page.waitForTimeout(2000);

      const currentHeight = await this.page.evaluate(
        () => document.body.scrollHeight
      );

      if (currentHeight === previousHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        previousHeight = currentHeight;
      }
    }

    console.log('Finished loading all content');
  }

  async getChapterLinks() {
    const chapterRegex = new RegExp(config.patreon.chapterRegex, 'i');

    console.log(
      `🔍 Looking for posts matching pattern: /${config.patreon.chapterRegex}/i`
    );

    // Debug what's actually on the page
    const pageInfo = await this.page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      const postLinks = Array.from(
        document.querySelectorAll('a[href*="/posts/"]')
      );
      const patreonLinks = allLinks.filter(
        (link) => link.href && link.href.includes('patreon.com')
      );

      return {
        totalLinks: allLinks.length,
        postLinks: postLinks.length,
        patreonLinks: patreonLinks.length,
        sampleLinks: allLinks.slice(0, 10).map((link) => ({
          href: link.href,
          text: link.textContent.trim().substring(0, 100),
        })),
        pageTitle: document.title,
        url: window.location.href,
      };
    });

    console.log(`🔍 Page debugging info:`);
    console.log(`   Title: "${pageInfo.pageTitle}"`);
    console.log(`   URL: ${pageInfo.url}`);
    console.log(`   Total links: ${pageInfo.totalLinks}`);
    console.log(`   Post links: ${pageInfo.postLinks}`);
    console.log(`   Patreon links: ${pageInfo.patreonLinks}`);

    if (pageInfo.sampleLinks.length > 0) {
      console.log(`📝 Sample links found:`);
      pageInfo.sampleLinks.forEach((link, i) => {
        console.log(`   ${i + 1}. "${link.text}" -> ${link.href}`);
      });
    }

    // First get all post links for debugging
    const allLinks = await this.page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/posts/"]'));
      return links.map((link) => ({
        url: link.href,
        title: link.textContent.trim(),
        id: link.href.match(/\/posts\/[^\/]+-(\d+)/)?.[1] || null,
      })); // Extract ID from end of URL like /posts/chapter-1177-133855876
    });

    console.log(`📋 Found ${allLinks.length} total post links`);
    if (allLinks.length > 0) {
      console.log('📝 Sample post titles and URLs:');
      allLinks.slice(0, 5).forEach((link, i) => {
        console.log(
          `   ${i + 1}. "${link.title}" -> ${link.url} (ID: ${link.id})`
        );
      });
      if (allLinks.length > 5) {
        console.log(`   ... and ${allLinks.length - 5} more`);
      }
    }

    // Now filter for chapters using the actual allLinks data
    const chapters = allLinks
      .filter((link) => {
        const regex = new RegExp(config.patreon.chapterRegex, 'i');
        const matches = regex.test(link.title);
        if (matches) {
          console.log(`✅ MATCHED: "${link.title}"`);
        }
        return matches;
      })
      .filter((item) => item.id); // Only keep items with valid IDs

    this.log(`📖 Found ${chapters.length} chapters matching pattern`);
    chapters.forEach((chapter, i) => {
      this.log(`   ${i + 1}. "${chapter.title}" (ID: ${chapter.id})`);
    });

    // Filter by starting chapter if specified
    if (config.patreon.startFromChapter) {
      console.log(
        `🔽 Filtering chapters starting from chapter ${config.patreon.startFromChapter}`
      );

      const filteredChapters = chapters.filter((chapter) => {
        // Extract chapter number from title (e.g., "Chapter 0912" -> 912)
        const chapterMatch = chapter.title.match(/Chapter\s+(\d+)/i);
        if (chapterMatch) {
          const chapterNum = parseInt(chapterMatch[1]);
          return chapterNum >= config.patreon.startFromChapter;
        }
        return false; // Skip if we can't parse chapter number
      });

      console.log(
        `📖 After filtering: ${filteredChapters.length} chapters (${chapters.length - filteredChapters.length} skipped)`
      );
      if (filteredChapters.length > 0) {
        console.log(`📝 Chapters to process:`);
        filteredChapters.forEach((chapter, i) => {
          console.log(`   ${i + 1}. "${chapter.title}" (ID: ${chapter.id})`);
        });
      }

      return filteredChapters;
    }

    return chapters;
  }

  async scrapeChapterContent(chapterUrl) {
    // Initialize browser if not already done
    if (!this.page || !this.browser) {
      this.log('🔧 Initializing browser for chapter content scraping...');
      await this.init();

      if (!this.page) {
        throw new Error(
          'Failed to initialize browser page for content scraping'
        );
      }
    }

    await this.retryWithBackoff(async () => {
      await this.page.goto(chapterUrl);
      await this.waitWithJitter();
    });

    // Wait for page to load and try multiple selectors
    await this.page.waitForTimeout(3000); // Give page time to load

    const result = await this.page.evaluate(() => {
      // Try different selectors for Patreon post content
      const selectors = [
        '[data-tag="post-content"]',
        '.post-content',
        'article',
        '.user-generated-content',
        '[class*="content"]',
        'main [data-testid]',
        'div[data-tag="post-content"]',
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (
          element &&
          element.innerText &&
          element.innerText.trim().length > 100
        ) {
          return {
            content: element.innerText.trim(),
            selector: selector,
          };
        }
      }

      // Fallback: get all text from main content area
      const mainContent = document.querySelector('main') || document.body;
      const text = mainContent.innerText;
      if (text && text.length > 500) {
        return {
          content: text.trim(),
          selector: 'fallback',
        };
      }

      return null;
    });

    if (result && result.selector) {
      if (result.selector === 'fallback') {
        this.log('Using fallback main content extraction');
      } else {
        this.log(`Found content using selector: ${result.selector}`);
      }
    }

    const content = result ? result.content : null;

    if (!content) {
      throw new Error('Could not extract post content');
    }

    // Clean up the content
    const cleanedContent = this.cleanContent(content);

    // Extract chapter number and add end marker
    return this.addChapterEndMarker(cleanedContent);
  }

  cleanContent(content) {
    // Remove common Patreon UI elements and badges
    let cleaned = content;

    // Remove "New" badges and similar UI elements
    cleaned = cleaned.replace(/^New\s*$/gm, '');

    // Remove relative time indicators like "2 days ago", "3 hours ago", etc.
    cleaned = cleaned.replace(
      /^\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\s*$/gm,
      ''
    );

    // Remove "just now" type indicators
    cleaned = cleaned.replace(/^just now\s*$/gim, '');

    // Remove standalone dates that are on their own line
    cleaned = cleaned.replace(
      /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\s*$/gm,
      ''
    );

    // Remove multiple consecutive newlines (clean up gaps left by removals)
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Trim whitespace from start and end
    cleaned = cleaned.trim();

    return cleaned;
  }

  addChapterEndMarker(content) {
    // Try to extract chapter number from the content
    const chapterMatch = content.match(/Chapter\s+(\d+)/i);

    if (chapterMatch) {
      const chapterNumber = chapterMatch[1];
      const endMarker = `\n\nEnd of Chapter ${chapterNumber}`;

      this.log(`Adding end marker: "End of Chapter ${chapterNumber}"`);
      return content + endMarker;
    } else {
      // Fallback: try to extract from any numeric pattern at the start
      const numericMatch = content.match(/^\s*(\d+)/);
      if (numericMatch) {
        const chapterNumber = numericMatch[1];
        const endMarker = `\n\nEnd of Chapter ${chapterNumber}`;

        this.log(
          `Adding end marker (fallback): "End of Chapter ${chapterNumber}"`
        );
        return content + endMarker;
      }
    }

    // If no chapter number found, add generic end marker
    this.log('No chapter number found, adding generic end marker');
    return content + '\n\nEnd of Chapter';
  }

  async scrapeChapterByUrl(url) {
    try {
      this.log('🔧 Starting browser initialization...');
      this.log('🔍 Config patreon sessionDir: ' + config.patreon.sessionDir);
      this.log('🔍 Chromium import: ' + typeof chromium);

      try {
        await this.init();
      } catch (initError) {
        this.log(`🚨 Init failed: ${initError.message}`, 'error');
        this.log(`🚨 Init stack: ${initError.stack}`, 'error');
        throw initError;
      }

      // Verify page is initialized
      if (!this.page) {
        throw new Error(
          'Failed to initialize browser page - page is null after init'
        );
      }

      if (!this.browser) {
        throw new Error(
          'Failed to initialize browser context - browser is null after init'
        );
      }

      this.log(`🌐 Navigating to chapter: ${url}`);
      await this.page.goto(url, { timeout: 0 });
      await this.waitWithJitter();

      // Extract post ID from URL - handle different formats
      let postId = url.match(/\/posts\/(\d+)/)?.[1]; // Format: /posts/123456
      if (!postId) {
        postId = url.match(/\/posts\/.*-(\d+)$/)?.[1]; // Format: /posts/chapter-913-of-104223888
      }
      if (!postId) {
        throw new Error(`Could not extract post ID from URL: ${url}`);
      }

      // Get the page title to use as chapter title
      const title = await this.page.evaluate(() => {
        // Try different selectors for the post title
        const titleSelectors = [
          'h1[data-tag="post-title"]',
          'h1',
          '[data-tag="post-title"]',
          '.post-title',
        ];

        for (const selector of titleSelectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent.trim()) {
            return element.textContent.trim();
          }
        }

        return document.title || 'Untitled Chapter';
      });

      this.log(`📝 Found title: ${title}`);

      // Extract content directly since we're already on the page
      this.log(`📖 Extracting content from page...`);

      // Wait for page to load
      await this.page.waitForTimeout(3000);

      const result = await this.page.evaluate(() => {
        // Try specific selectors for just the post body content, excluding comments/tags
        const selectors = [
          // Most specific - post content wrapper
          '[data-tag="post-content"]',
          '.user-generated-content',
          '[data-tag="post-content"] > div',

          // Backup selectors
          'article [class*="userContent"]',
          'article .post-content',
          '.post-content',
          'article',

          // Last resort - but try to exclude comments
          'main',
        ];

        for (const selector of selectors) {
          const element = document.querySelector(selector);

          if (
            element &&
            element.innerText &&
            element.innerText.trim().length > 100
          ) {
            // Additional filtering to exclude common comment/footer elements
            let content = element.innerText.trim();

            // Remove common footer elements that appear after content
            const footerPatterns = [
              /\n\s*Tags\s*\n[\s\S]*$/i,
              /\n\s*\d+\s*\d+\s*Share\s*[\s\S]*$/i,
              /\n\s*Share\s*[\s\S]*$/i,
              /\n\s*Comments?\s*\n[\s\S]*$/i,
              /\n\s*Like\s*Comment\s*[\s\S]*$/i,
              /\n\s*\w+\s*·\s*\d+\w+\s*[\s\S]*$/i, // Remove "Joshua Little · 7mo" type comments
            ];

            for (const pattern of footerPatterns) {
              content = content.replace(pattern, '');
            }

            // If we still have substantial content after cleaning
            if (content.trim().length > 100) {
              return {
                content: content.trim(),
                selector: selector,
              };
            }
          }
        }

        return null;
      });

      if (result && result.selector) {
        if (result.selector === 'fallback') {
          this.log('Using fallback main content extraction');
        } else {
          this.log(`Found content using selector: ${result.selector}`);
        }
      }

      const rawContent = result ? result.content : null;

      if (!rawContent) {
        throw new Error('Could not extract post content');
      }

      // Clean up the content
      const content = this.cleanContent(rawContent);

      const chapterData = {
        id: postId,
        title: title,
        url: url,
        content: content,
        wordCount: content.split(/\s+/).length,
        scrapedAt: new Date().toISOString(),
      };

      this.log(`✅ Successfully scraped chapter: ${title}`);
      this.log(`📝 Content length: ${content.length} characters`);

      return chapterData;
    } catch (error) {
      this.log(`❌ Failed to scrape chapter: ${error.message}`, 'error');
      throw error;
    } finally {
      await this.close();
    }
  }

  async scrapeCreatorPage() {
    this.log(`🌐 Navigating to: ${config.patreon.creatorUrl}`);

    await this.retryWithBackoff(async () => {
      await this.page.goto(config.patreon.creatorUrl);
      await this.waitWithJitter();
    });

    // Check if we're actually logged in
    const loginCheck = await this.page.evaluate(() => {
      const hasLoginButton =
        document.querySelector('a[href*="/login"]') !== null;
      const hasLogoutButton =
        document.querySelector('a[href*="/settings"]') !== null ||
        document.querySelector('[data-tag="profile-button"]') !== null;
      const cookies = document.cookie;
      const hasSessionCookie =
        cookies.includes('session_id') || cookies.includes('patreon_device_id');

      return {
        hasLoginButton,
        hasLogoutButton,
        currentUrl: window.location.href,
        hasSessionCookie,
        cookieCount: cookies.split(';').length,
        isLoggedIn: !hasLoginButton || hasLogoutButton || hasSessionCookie,
      };
    });

    this.log(
      `🔐 Login status: ${loginCheck.isLoggedIn ? 'Logged in' : 'NOT logged in'}`
    );
    this.log(`📍 Current URL: ${loginCheck.currentUrl}`);
    this.log(`🍪 Has session cookies: ${loginCheck.hasSessionCookie}`);
    this.log(`🍪 Total cookies: ${loginCheck.cookieCount}`);

    // Let's continue anyway and see what posts we can find
    this.log(`⚠️ Continuing with scraping attempt...`);

    // Wait for page to load
    this.log('⏳ Waiting for page to load...');
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch (error) {
      this.log('⚠️ Page load timeout, continuing anyway...');
    }

    this.log('📜 Scrolling to load all posts...');
    await this.scrollToLoadAll();

    this.log('🔍 Extracting chapter links...');
    const chapters = await this.getChapterLinks();

    this.log(`✅ Found ${chapters.length} chapters total`);
    return chapters;
  }

  async scrapeChapter(chapter, outputPath) {
    // Check if already exists
    const audioFile = path.join(config.paths.output, `${chapter.id}.mp3`);
    try {
      await fs.access(audioFile);
      this.log(`Skipping ${chapter.title} - already exists`);
      return null;
    } catch {
      // File doesn't exist, continue scraping
    }

    this.log(`Scraping: ${chapter.title}`);

    const content = await this.scrapeChapterContent(chapter.url);

    const chapterData = {
      id: chapter.id,
      title: chapter.title,
      url: chapter.url,
      content: content,
      scrapedAt: new Date().toISOString(),
      wordCount: content.split(/\s+/).length,
    };

    // Save raw content
    const textFile = path.join(config.paths.data, `${chapter.id}.json`);
    await fs.writeFile(textFile, JSON.stringify(chapterData, null, 2));

    this.log(`Saved: ${textFile}`);
    return chapterData;
  }

  async scrapeAll() {
    try {
      await this.init();

      // Ensure output directories exist
      await fs.mkdir(config.paths.output, { recursive: true });
      await fs.mkdir(config.paths.data, { recursive: true });

      const chapters = await this.scrapeCreatorPage();
      const results = [];

      // For testing, just scrape the first chapter
      this.log(`🧪 Testing with first chapter only...`);
      const testChapters = chapters.slice(0, 1);

      for (const chapter of testChapters) {
        try {
          const result = await this.scrapeChapter(chapter);
          if (result) {
            results.push(result);
            this.log(`✅ Successfully scraped: ${chapter.title}`);
            this.log(`📝 Content length: ${result.content.length} characters`);
          }

          // Rate limiting between chapters
          await this.waitWithJitter();
        } catch (error) {
          console.error(`❌ Failed to scrape ${chapter.title}:`, error.message);
        }
      }

      this.log(`Scraped ${results.length} new chapters`);
      return results;
    } finally {
      await this.close();
    }
  }

  async findNextChapter(currentChapterNumber) {
    await this.init();

    try {
      const nextChapterNumber = currentChapterNumber + 1;
      const searchQuery = `Chapter ${nextChapterNumber}`;

      this.log(`🔍 Searching for: "${searchQuery}"`);

      // Go to creator's posts page
      const creatorUrl = config.patreon.creatorUrl;
      let postsUrl;

      if (creatorUrl.endsWith('/posts')) {
        // Already a posts URL
        postsUrl = creatorUrl;
      } else if (creatorUrl.includes('/c/')) {
        // Handle /c/creatorname URLs (without /posts)
        postsUrl = creatorUrl.replace('/c/', '/') + '/posts';
      } else {
        // Regular creator URL
        postsUrl = creatorUrl + '/posts';
      }

      this.log(`Navigating to posts page: ${postsUrl}`);
      await this.page.goto(postsUrl, { waitUntil: 'networkidle' });

      // Wait for page to load
      await this.page.waitForTimeout(2000);

      // Use the search functionality directly
      this.log(`Using search to find "${searchQuery}"...`);

      // Use the correct sidebar search input
      const searchSelector = '#search-posts-sidebar';

      try {
        // Wait for the search input to be present
        await this.page.waitForSelector(searchSelector, { timeout: 5000 });

        // Clear and search
        await this.page.fill(searchSelector, ''); // Clear
        await this.page.fill(searchSelector, searchQuery); // Type
        await this.page.press(searchSelector, 'Enter'); // Submit

        this.log(`Successfully searched for: ${searchQuery}`);
      } catch (searchError) {
        this.log(`❌ Failed to use search input: ${searchError.message}`);
        return null;
      }

      this.log(`Waiting for search results to load...`);
      await this.page.waitForTimeout(3000);

      // Look for results in post-card elements with post-title spans
      const postLinks = await this.page.$$eval(
        '[data-tag="post-card"]',
        (cards, searchText) => {
          const results = [];

          cards.forEach((card) => {
            const titleSpan = card.querySelector('[data-tag="post-title"]');
            if (titleSpan) {
              const link = titleSpan.querySelector('a');
              if (link) {
                const title = link.textContent || '';
                if (title.toLowerCase().includes(searchText.toLowerCase())) {
                  results.push({
                    url: link.href,
                    title: title.trim(),
                  });
                }
              }
            }
          });

          return results;
        },
        searchQuery
      );

      if (postLinks.length > 0) {
        this.log(
          `✅ Found ${postLinks.length} matching posts in search results`
        );
        // Return the first match
        return postLinks[0];
      }

      this.log(`❌ No posts found matching "${searchQuery}" in search results`);
      return null;
    } catch (error) {
      this.log(`Failed to find next chapter: ${error.message}`, 'error');
      return null;
    } finally {
      await this.close();
    }
  }
}

export { PatreonScraper };

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const scraper = new PatreonScraper();
  scraper.scrapeAll().catch(console.error);
}
