import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  tts: {
    provider: process.env.TTS_PROVIDER || 'openai',
    chunkSize: parseInt(process.env.TTS_CHUNK_SIZE) || 3500,
    pauseMs: parseInt(process.env.PAUSE_MS) || 750
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    voice: process.env.OPENAI_TTS_VOICE || 'alloy',
    model: process.env.OPENAI_TTS_MODEL || 'tts-1'
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB' // Adam voice
  },
  
  patreon: {
    creatorUrl: process.env.PATREON_CREATOR_URL,
    chapterRegex: process.env.CHAPTER_SELECTOR_REGEX || 'chapter',
    sessionDir: process.env.SESSION_DIR || './.patreon-session',
    startFromChapter: process.env.START_FROM_CHAPTER ? parseInt(process.env.START_FROM_CHAPTER) : null
  },
  
  scraping: {
    delayBaseMs: parseInt(process.env.SCRAPE_DELAY_BASE_MS) || 600,
    delayJitterMs: parseInt(process.env.SCRAPE_DELAY_JITTER_MS) || 800,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3
  },
  
  
  server: {
    port: parseInt(process.env.PORT) || 8383,
    siteUrl: process.env.SITE_URL || 'http://localhost:8383'
  },
  
  podcast: {
    title: process.env.PODCAST_TITLE || 'My Patreon Audiobook',
    author: process.env.PODCAST_AUTHOR || 'Unknown Author',
    description: process.env.PODCAST_DESCRIPTION || 'Private listening feed',
    language: process.env.PODCAST_LANGUAGE || 'en-us',
    category: process.env.PODCAST_CATEGORY || 'Arts',
    explicit: process.env.PODCAST_EXPLICIT || 'no'
  },
  
  database: {
    path: process.env.DATABASE_PATH || './db/jobs.db'
  },
  
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  
  paths: {
    output: process.env.OUTPUT_DIR || './public/audio',
    data: process.env.DATA_DIR || './public/data',
    public: './public'
  },
  
  s3: {
    bucket: process.env.S3_BUCKET || 'porivo.com',
    prefix: process.env.S3_PREFIX || 'podcasts/',
    profile: process.env.AWS_PROFILE || 'porivo'
  }
};

export default config;