import { Feed } from 'feed';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from './config.js';
import { Database } from './database.js';

const execAsync = promisify(exec);

class RSSGenerator {
  constructor() {
    this.db = new Database();
    this.feed = new Feed({
      title: config.podcast.title,
      description: config.podcast.description,
      id: config.server.siteUrl,
      link: config.server.siteUrl,
      language: config.podcast.language,
      image: 'https://www.porivo.com/podcasts/cover.jpg',
      favicon: `${config.server.siteUrl}/favicon.ico`,
      copyright: `© ${new Date().getFullYear()} ${config.podcast.author}`,
      updated: new Date(),
      generator: 'Patreon-to-Podcast',
      feedLinks: {
        rss: `${config.server.siteUrl}/feed.xml`
      },
      author: {
        name: config.podcast.author,
        email: 'noreply@example.com',
        link: config.server.siteUrl
      },
      itunes: {
        author: config.podcast.author,
        summary: config.podcast.description,
        type: 'episodic',
        owner: {
          name: config.podcast.author,
          email: 'noreply@example.com'
        },
        image: 'https://www.porivo.com/podcasts/cover.jpg',
        categories: [
          {
            text: config.podcast.category,
            subcategories: []
          }
        ],
        explicit: config.podcast.explicit === 'yes',
        complete: false,
        block: false
      }
    });
  }

  async getAudioDuration(audioPath) {
    try {
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`);
      return parseFloat(stdout.trim());
    } catch (error) {
      console.warn(`Could not get duration for ${audioPath}:`, error.message);
      return 0;
    }
  }

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '00:00:00';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  async getFileSize(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.size;
    } catch (error) {
      console.warn(`Could not get file size for ${filePath}:`, error.message);
      return 0;
    }
  }

  async loadChapterMetadata(chapterId) {
    const dataFile = path.join(config.paths.data, `${chapterId}.json`);
    try {
      const data = await fs.readFile(dataFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.warn(`Could not load metadata for chapter ${chapterId}:`, error.message);
      return null;
    }
  }

  async generateFeed() {
    console.log('Generating RSS feed...');
    
    try {
      await this.db.init();
      
      // Get all chapters with audio from database
      const chapters = await this.db.all(`
        SELECT * FROM chapters 
        WHERE processed_at IS NOT NULL 
        AND audio_file_size > 0
        ORDER BY scraped_at DESC
      `);
      
      console.log(`Found ${chapters.length} chapters with audio`);
      
      // Process each chapter
      const episodes = [];
      
      for (const chapter of chapters) {
        const audioPath = path.join(config.paths.output, `${chapter.id}.mp3`);
        
        // Verify audio file exists
        try {
          await fs.access(audioPath);
        } catch {
          console.warn(`Audio file missing for chapter ${chapter.id}: ${chapter.title}`);
          continue;
        }
        
        episodes.push({
          id: chapter.id.toString(),
          title: chapter.title,
          description: `Audio version of ${chapter.title} from Patreon`,
          url: chapter.url,
          audioUrl: `${config.server.siteUrl}/audio/${chapter.id}.mp3`,
          fileSize: chapter.audio_file_size,
          duration: chapter.audio_duration,
          pubDate: new Date(chapter.published_at || chapter.processed_at || chapter.scraped_at),
          chapterNumber: parseInt(chapter.title.match(/Chapter\s+(\d+)/i)?.[1] || '0')
        });
      }
      
      // Sort episodes by chapter number (ascending for chronological order)
      episodes.sort((a, b) => a.chapterNumber - b.chapterNumber);
      
      // Add episodes to feed
      for (const episode of episodes) {
        this.feed.addItem({
          title: episode.title,
          id: episode.id,
          link: episode.url,
          description: episode.description,
          content: episode.description,
          date: episode.pubDate,
          enclosure: {
            url: episode.audioUrl,
            length: episode.fileSize,
            type: 'audio/mpeg'
          },
          itunes: {
            author: config.podcast.author,
            explicit: config.podcast.explicit === 'yes',
            duration: this.formatDuration(episode.duration),
            episode: episode.chapterNumber || (episodes.indexOf(episode) + 1),
            episodeType: 'full',
            title: episode.title,
            subtitle: `Chapter ${episode.chapterNumber}`,
            summary: episode.description
          }
        });
      }
      
      // Generate RSS XML
      const rssXml = this.feed.rss2();
      
      // Ensure public directory exists
      await fs.mkdir(config.paths.public, { recursive: true });
      
      // Write feed to file
      const feedPath = path.join(config.paths.public, 'feed.xml');
      await fs.writeFile(feedPath, rssXml);
      
      // Update chapters as published
      const chapterIds = episodes.map(ep => ep.id);
      if (chapterIds.length > 0) {
        await this.db.run(`
          UPDATE chapters 
          SET published_at = CURRENT_TIMESTAMP 
          WHERE id IN (${chapterIds.join(',')}) 
          AND published_at IS NULL
        `);
      }
      
      console.log(`RSS feed generated: ${feedPath}`);
      console.log(`Added ${episodes.length} episodes`);
      
      return {
        feedPath,
        episodeCount: episodes.length,
        episodes: episodes
      };
      
    } catch (error) {
      console.error('Failed to generate RSS feed:', error);
      throw error;
    }
  }

  async generateEpisodeList() {
    // Generate a JSON file with episode metadata for the web UI
    try {
      const chapters = await this.db.all(`
        SELECT * FROM chapters 
        WHERE processed_at IS NOT NULL 
        ORDER BY scraped_at DESC
      `);
      
      const episodes = chapters.map(ch => ({
        id: ch.id,
        title: ch.title,
        duration: ch.audio_duration,
        fileSize: ch.audio_file_size,
        scrapedAt: ch.scraped_at,
        processedAt: ch.processed_at,
        publishedAt: ch.published_at,
        wordCount: ch.word_count,
        chapterNumber: parseInt(ch.title.match(/Chapter\s+(\d+)/i)?.[1] || '0')
      }));
      
      const episodeListPath = path.join(config.paths.public, 'episodes.json');
      await fs.writeFile(episodeListPath, JSON.stringify(episodes, null, 2));
      
      return episodes;
      
    } catch (error) {
      console.error('Failed to generate episode list:', error);
      throw error;
    }
  }
}

export { RSSGenerator };

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const generator = new RSSGenerator();
  async function run() {
    try {
      await generator.db.init();
      await Promise.all([
        generator.generateFeed(),
        generator.generateEpisodeList()
      ]);
    } catch (error) {
      console.error(error);
    } finally {
      await generator.db.close();
    }
  }
  run();
}