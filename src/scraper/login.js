import { chromium } from 'playwright';
import config from '../shared/config.js';
import path from 'path';

async function loginToPatreon() {
  console.log('Opening browser for Patreon login...');
  
  const browser = await chromium.launchPersistentContext(
    config.patreon.sessionDir,
    {
      headless: false,
      viewport: { width: 1280, height: 720 }
    }
  );
  
  const page = await browser.newPage();
  
  try {
    console.log(`Session will be saved to: ${config.patreon.sessionDir}`);
    
    await page.goto('https://www.patreon.com/login');
    
    console.log('Please log in to Patreon in the browser window.');
    console.log('After logging in, navigate to any creator page to confirm you\'re logged in.');
    console.log('Then close the browser window.');
    console.log('Press Ctrl+C to cancel if needed.');
    
    // Wait for user to navigate away from login page (manual polling, no timeout)
    console.log('Waiting for you to complete login...');
    while (true) {
      try {
        const currentPath = await page.evaluate(() => window.location.pathname);
        if (!currentPath.includes('/login') && !currentPath.includes('/signup')) {
          break;
        }
        await page.waitForTimeout(2000); // Check every 2 seconds
      } catch (error) {
        // If page is closed or navigation fails, break out
        break;
      }
    }
    
    console.log('✅ Login successful! Session saved.');
    
  } catch (error) {
    console.error('Login error:', error.message);
  } finally {
    await browser.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loginToPatreon().catch(console.error);
}

export { loginToPatreon };