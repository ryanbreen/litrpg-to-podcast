import config from '../shared/config.js';
import { PatreonScraper } from './scraper.js';
import { RoyalRoadScraper } from './royal-road-scraper.js';

/**
 * Factory class to create the appropriate scraper based on configuration
 */
class ScraperFactory {
  /**
   * Create scraper instance based on source provider configuration
   */
  static createScraper() {
    const provider = config.source.provider;

    switch (provider) {
      case 'patreon':
        return new PatreonScraper();
      case 'royalroad':
        return new RoyalRoadScraper();
      default:
        throw new Error(`Unsupported content source provider: ${provider}`);
    }
  }

  /**
   * Get the current content source provider
   */
  static getProvider() {
    return config.source.provider;
  }

  /**
   * Check if provider is supported
   */
  static isSupported(provider) {
    return ['patreon', 'royalroad'].includes(provider);
  }
}

export { ScraperFactory };
