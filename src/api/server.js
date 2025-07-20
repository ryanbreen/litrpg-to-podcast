import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import config from '../shared/config.js';
import { Database } from '../shared/database.js';
import { TTSWorker } from '../worker/tts-worker.js';
import { MultiVoiceTTSWorker } from '../worker/multi-voice-tts.js';
import { PatreonScraper } from '../scraper/scraper.js';
import { RSSGenerator } from '../shared/rss-generator.js';
import { S3Sync } from '../shared/s3-sync.js';
import { SpeakerIdentifier } from '../shared/speaker-identifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class APIServer {
  constructor() {
    this.fastify = Fastify({ logger: true });
    this.db = new Database();
    this.ttsWorker = new TTSWorker();
    this.speakerIdentifier = new SpeakerIdentifier();
    this.logClients = new Set();
    this.rebuildProgress = {}; // Track rebuild progress by chapter ID
    this.setupWebSocket();
    this.setupRoutes();
    this.setupStaticFiles();
  }

  log(message, level = 'info') {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message
    };
    
    // Broadcast to all connected WebSocket clients
    for (const client of this.logClients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(JSON.stringify(logEntry));
      }
    }
    
    console.log(`[${level.toUpperCase()}] ${message}`);
  }

  setupWebSocket() {
    this.fastify.register(fastifyWebsocket);
    
    this.fastify.register(async function (fastify) {
      fastify.get('/api/logs', { websocket: true }, (connection) => {
        const { socket } = connection;
        
        // Add client to the set
        this.logClients.add(socket);
        
        // Send initial connection message
        socket.send(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: 'Connected to log stream'
        }));
        
        // Remove client on disconnect
        socket.on('close', () => {
          this.logClients.delete(socket);
        });
        
        socket.on('error', (err) => {
          console.error('WebSocket error:', err);
          this.logClients.delete(socket);
        });
      });
    }.bind(this));
  }

  setupStaticFiles() {
    // Serve public files
    this.fastify.register(fastifyStatic, {
      root: path.join(__dirname, '../../public'),
      prefix: '/',
    });

    // CORS for API endpoints
    this.fastify.register(fastifyCors, {
      origin: true
    });
  }

  setupRoutes() {
    // Health check
    this.fastify.get('/api/health', async (request, reply) => {
      const stats = await this.db.getStats();
      return { 
        status: 'ok', 
        ...stats,
        elevenlabs_configured: !!config.elevenlabs?.apiKey
      };
    });

    // Get all chapters
    this.fastify.get('/api/chapters', async (request, reply) => {
      try {
        const chapters = await this.db.getChapters();
        return chapters.map(chapter => ({
          id: chapter.id,
          title: chapter.title,
          url: chapter.url,
          duration: chapter.audio_duration,
          fileSize: chapter.audio_file_size,
          scrapedAt: chapter.scraped_at,
          processedAt: chapter.processed_at,
          speakersIdentifiedAt: chapter.speakers_identified_at,
          publishedAt: chapter.published_at,
          listenedSeconds: chapter.listened_seconds || 0,
          status: chapter.processed_at ? 'ready' : 'pending'
        }));
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get specific chapter
    this.fastify.get('/api/chapters/:id', async (request, reply) => {
      try {
        const chapter = await this.db.getChapter(request.params.id);
        if (!chapter) {
          reply.code(404);
          return { error: 'Chapter not found' };
        }

        return {
          id: chapter.id,
          title: chapter.title,
          url: chapter.url,
          duration: chapter.audio_duration,
          fileSize: chapter.audio_file_size,
          scrapedAt: chapter.scraped_at,
          processedAt: chapter.processed_at,
          speakersIdentifiedAt: chapter.speakers_identified_at,
          publishedAt: chapter.published_at,
          listenedSeconds: chapter.listened_seconds || 0,
          status: chapter.processed_at ? 'ready' : 'pending',
          metadata: chapter.metadata
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Update listening position
    this.fastify.post('/api/chapters/:id/seek', async (request, reply) => {
      try {
        const { seconds } = request.body;
        await this.db.updateListeningPosition(request.params.id, seconds);
        return { success: true };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get chapter text for editing
    this.fastify.get('/api/chapters/:id/text', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        const dataFile = path.join(config.paths.data, `${chapterId}.json`);
        
        // Check if file exists first
        try {
          await fs.access(dataFile);
        } catch (fileError) {
          // File doesn't exist - this is a stub chapter
          reply.code(404);
          return { 
            error: 'Chapter content not found',
            message: 'This chapter is a stub. Content needs to be scraped first.',
            isStub: true
          };
        }
        
        const data = await fs.readFile(dataFile, 'utf-8');
        const chapterData = JSON.parse(data);
        
        return {
          id: chapterId,
          title: chapterData.title,
          url: chapterData.url,
          content: chapterData.content || '',
          wordCount: chapterData.wordCount || 0,
          scrapedAt: chapterData.scrapedAt
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Update chapter text
    this.fastify.put('/api/chapters/:id/text', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        const { content } = request.body;
        const dataFile = path.join(config.paths.data, `${chapterId}.json`);
        
        // Load existing data
        const data = await fs.readFile(dataFile, 'utf-8');
        const chapterData = JSON.parse(data);
        
        // Update content and word count
        chapterData.content = content;
        chapterData.wordCount = content.split(/\s+/).length;
        chapterData.editedAt = new Date().toISOString();
        
        // Save updated data
        await fs.writeFile(dataFile, JSON.stringify(chapterData, null, 2));
        
        // Update database
        await this.db.upsertChapter(chapterData);
        
        return { 
          success: true, 
          wordCount: chapterData.wordCount,
          editedAt: chapterData.editedAt
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Scrape individual chapter content
    this.fastify.post('/api/chapters/:id/scrape', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        this.log(`🔄 Scraping content for chapter ${chapterId}`);
        
        // Get chapter info from database
        const chapter = await this.db.getChapter(chapterId);
        if (!chapter) {
          reply.code(404);
          return { error: 'Chapter not found' };
        }
        
        if (!chapter.url || chapter.url.includes('placeholder')) {
          reply.code(400);
          return { error: 'Chapter has no valid URL to scrape from' };
        }
        
        // Process in background
        this.processScrapeChapterContent(chapterId, chapter.url);
        
        return { 
          success: true, 
          message: `Scraping content for ${chapter.title}...`
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Delete chapter
    this.fastify.delete('/api/chapters/:id', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        this.log(`Deleting chapter ${chapterId}`);
        
        // Delete from database
        await this.db.run('DELETE FROM chapters WHERE id = ?', [chapterId]);
        
        // Delete data file if it exists
        const dataFile = path.join(config.paths.data, `${chapterId}.json`);
        try {
          await fs.unlink(dataFile);
          this.log(`Deleted data file: ${dataFile}`);
        } catch (err) {
          // File might not exist, that's ok
          this.log(`Data file not found: ${dataFile}`);
        }
        
        // Delete audio file if it exists
        const audioFile = path.join(config.paths.output, `${chapterId}.mp3`);
        try {
          await fs.unlink(audioFile);
          this.log(`Deleted audio file: ${audioFile}`);
        } catch (err) {
          // File might not exist, that's ok
          this.log(`Audio file not found: ${audioFile}`);
        }
        
        this.log(`✅ Chapter ${chapterId} deleted successfully`);
        return { success: true, message: 'Chapter deleted successfully' };
      } catch (error) {
        this.log(`Failed to delete chapter ${request.params.id}: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });


    // Get all jobs
    this.fastify.get('/api/jobs', async (request, reply) => {
      try {
        const jobs = await this.db.getJobs();
        return jobs;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get jobs by status
    this.fastify.get('/api/jobs/:status', async (request, reply) => {
      try {
        const jobs = await this.db.getJobs(request.params.status);
        return jobs;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Rebuild all chapters
    this.fastify.post('/api/jobs/rebuild-all', async (request, reply) => {
      try {
        // Start full rebuild process
        this.processFullRebuild();
        return { success: true, message: 'Full rebuild started' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Stage 1: Extract chapters from Patreon
    this.fastify.post('/api/jobs/sync', async (request, reply) => {
      try {
        this.processSyncJob();
        return { success: true, message: 'Stage 1: Chapter extraction started' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Load next chapter
    this.fastify.post('/api/chapters/load-next', {
      preHandler: async (request, reply) => {
        // Allow empty body
        if (!request.body) {
          request.body = {};
        }
      }
    }, async (request, reply) => {
      try {
        this.log(`🔍 Finding next chapter to load...`);
        
        // Find the highest chapter number we have
        const chapters = await this.db.getChapters();
        if (chapters.length === 0) {
          reply.code(400);
          return { error: 'No chapters found. This should start with Chapter 912.' };
        }
        
        let highestChapterNumber = 0;
        chapters.forEach(chapter => {
          const match = chapter.title.match(/Chapter (\d+)/i);
          if (match) {
            const num = parseInt(match[1]);
            if (num > highestChapterNumber) {
              highestChapterNumber = num;
            }
          }
        });
        
        const nextChapterNumber = highestChapterNumber + 1;
        this.log(`Current highest chapter: ${highestChapterNumber}, searching for: ${nextChapterNumber}`);
        
        // Process in background: search for and load the next chapter
        this.processSearchAndLoadNextChapter(nextChapterNumber);
        
        return { 
          success: true, 
          message: `Searching for Chapter ${nextChapterNumber}...`,
          currentChapter: highestChapterNumber,
          searchingFor: nextChapterNumber
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Stage 2: Identify speakers in chapters
    this.fastify.post('/api/jobs/identify-speakers', async (request, reply) => {
      try {
        this.log('🎭 Stage 2: Starting speaker identification for all chapters...');
        
        // Get all chapters that have content but haven't had speakers identified
        const chapters = await this.db.all(`
          SELECT * FROM chapters 
          WHERE scraped_at IS NOT NULL 
          AND speakers_identified_at IS NULL
          ORDER BY scraped_at DESC
        `);

        if (chapters.length === 0) {
          this.log('No chapters need speaker identification');
          return { 
            success: true, 
            message: 'No chapters need speaker identification',
            processed: 0
          };
        }

        this.log(`Found ${chapters.length} chapters for speaker identification`);
        
        // Process each chapter
        let processed = 0;
        for (const chapter of chapters) {
          try {
            await this.processChapterSpeakerIdentification(chapter.id);
            processed++;
            this.log(`✅ Processed speakers for: ${chapter.title}`);
          } catch (error) {
            this.log(`❌ Failed speaker identification for ${chapter.title}: ${error.message}`, 'error');
          }
        }

        this.log(`🎭 Stage 2 complete: ${processed}/${chapters.length} chapters processed`);
        return { 
          success: true, 
          message: `Speaker identification complete: ${processed}/${chapters.length} chapters processed`,
          processed
        };
      } catch (error) {
        this.log(`Stage 2 failed: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Identify speakers for a specific chapter
    this.fastify.post('/api/chapters/:id/identify-speakers', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        this.log(`🎭 Identifying speakers for chapter ${chapterId}`);
        
        // Initialize progress tracking
        this.speakerIdProgress = this.speakerIdProgress || {};
        this.speakerIdProgress[chapterId] = {
          status: 'starting',
          phase: 'loading',
          message: 'Loading chapter content...',
          startedAt: new Date().toISOString(),
          completed: false,
          error: null,
          segments: null,
          speakerCounts: null
        };
        
        // Process in background
        this.processChapterSpeakerIdentification(chapterId);
        
        return { 
          success: true, 
          message: 'Speaker identification started',
          chapterId 
        };
      } catch (error) {
        this.log(`Speaker identification failed for ${request.params.id}: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Get speaker identification progress
    this.fastify.get('/api/chapters/:id/speaker-id-progress', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        
        if (!this.speakerIdProgress || !this.speakerIdProgress[chapterId]) {
          return {
            status: 'not_started',
            phase: null,
            message: null,
            completed: false,
            error: null
          };
        }
        
        const progress = this.speakerIdProgress[chapterId];
        
        // Create a copy to return
        const result = { ...progress };
        
        // Clear the newSegment after sending it once
        if (progress.newSegment) {
          delete this.speakerIdProgress[chapterId].newSegment;
        }
        
        return result;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Mark speaker identification as complete for a chapter
    this.fastify.post('/api/chapters/:id/mark-speakers-complete', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        this.log(`✅ Marking speaker identification as complete for chapter ${chapterId}`);
        
        // Update the chapter to mark speakers as identified
        await this.db.run(
          `UPDATE chapters SET speakers_identified_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [chapterId]
        );
        
        return { 
          success: true, 
          message: `Speaker identification marked as complete for chapter ${chapterId}`
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Stage 3: Generate multi-voice TTS
    this.fastify.post('/api/jobs/generate-audio', async (request, reply) => {
      try {
        this.log('🎙️ Stage 3: Starting multi-voice TTS generation...');
        
        // Process TTS generation in background
        this.processMultiVoiceTTS();
        
        return { 
          success: true, 
          message: 'Stage 3: Multi-voice TTS generation started',
          note: 'Processing in background. Check logs for progress.'
        };
      } catch (error) {
        this.log(`Stage 3 failed: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Generate audio for specific chapter
    this.fastify.post('/api/chapters/:id/generate-audio', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        this.log(`🎙️ Generating multi-voice audio for chapter ${chapterId}`);
        
        // Initialize progress tracking
        this.generationProgress = this.generationProgress || {};
        this.generationProgress[chapterId] = {
          status: 'starting',
          currentSegment: 0,
          totalSegments: 0,
          segments: [],
          startedAt: new Date().toISOString(),
          completed: false,
          error: null
        };
        
        // Process in background
        this.processChapterAudio(chapterId);
        
        return { 
          success: true, 
          message: 'Audio generation started',
          chapterId 
        };
      } catch (error) {
        this.log(`Audio generation failed for ${request.params.id}: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get generation progress for a specific chapter
    this.fastify.get('/api/chapters/:id/generation-progress', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        
        if (!this.generationProgress || !this.generationProgress[chapterId]) {
          return {
            status: 'not_started',
            currentSegment: 0,
            totalSegments: 0,
            segments: [],
            completed: false,
            error: null
          };
        }
        
        return this.generationProgress[chapterId];
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get cached segments for a chapter
    this.fastify.get('/api/chapters/:id/segments', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        
        const worker = new MultiVoiceTTSWorker();
        await worker.init();
        
        const segmentFiles = await worker.getChapterSegments(chapterId);
        await worker.close();
        
        return { segments: segmentFiles };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Update segment speaker assignment
    this.fastify.put('/api/chapters/:id/segments/:index/speaker', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        const segmentIndex = parseInt(request.params.index);
        const { speakerId } = request.body;
        
        if (!speakerId) {
          reply.code(400);
          return { error: 'speakerId is required' };
        }
        
        this.log(`👤 Updating speaker for segment ${segmentIndex} in chapter ${chapterId} to speaker ${speakerId}`);
        
        // Update the speaker assignment in the database
        await this.db.updateSegmentSpeaker(chapterId, segmentIndex, speakerId);
        
        // Delete the full chapter MP3 since a segment was updated
        const chapterMp3Path = path.join(config.paths.output, `${chapterId}.mp3`);
        try {
          await fs.unlink(chapterMp3Path);
          this.log(`🗑️ Deleted chapter MP3 for ${chapterId} after speaker update`);
          
          // Mark chapter as needing rebuild in database
          await this.db.run(
            `UPDATE chapters SET processed_at = NULL, audio_duration = NULL, audio_file_size = NULL WHERE id = ?`,
            [chapterId]
          );
        } catch (err) {
          // File might not exist, that's okay
          this.log(`ℹ️ Chapter MP3 not found for deletion: ${err.message}`);
        }
        
        return { 
          success: true, 
          message: `Segment ${segmentIndex} speaker updated to ${speakerId}`,
          chapterId,
          segmentIndex,
          speakerId,
          chapterMp3Deleted: true
        };
      } catch (error) {
        this.log(`❌ Failed to update segment speaker: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Regenerate a specific segment
    this.fastify.post('/api/chapters/:id/segments/:index/regenerate', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        const segmentIndex = parseInt(request.params.index);
        
        this.log(`🔄 Regenerating segment ${segmentIndex} for chapter ${chapterId}`);
        
        const worker = new MultiVoiceTTSWorker();
        worker.server = this;
        await worker.init();
        
        const segmentFile = await worker.regenerateSegment(chapterId, segmentIndex);
        await worker.close();
        
        // Delete the full chapter MP3 since a segment was regenerated
        const chapterMp3Path = path.join(config.paths.output, `${chapterId}.mp3`);
        try {
          await fs.unlink(chapterMp3Path);
          this.log(`🗑️ Deleted chapter MP3 for ${chapterId} after segment regeneration`);
          
          // Mark chapter as needing rebuild in database
          await this.db.run(
            `UPDATE chapters SET processed_at = NULL, audio_duration = NULL, audio_file_size = NULL WHERE id = ?`,
            [chapterId]
          );
        } catch (err) {
          // File might not exist, that's okay
          this.log(`ℹ️ Chapter MP3 not found for deletion: ${err.message}`);
        }
        
        return { 
          success: true, 
          message: `Segment ${segmentIndex} regenerated, chapter MP3 deleted`,
          file: segmentFile,
          chapterMp3Deleted: true
        };
      } catch (error) {
        this.log(`Failed to regenerate segment: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Rebuild chapter from cached segments
    this.fastify.post('/api/chapters/:id/rebuild', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        
        this.log(`🔄 Rebuilding chapter ${chapterId} from cached segments`);
        
        // Store rebuild progress for streaming
        this.rebuildProgress[chapterId] = {
          status: 'starting',
          phase: 'initializing',
          message: 'Starting rebuild process...',
          segments: [],
          currentSegment: 0,
          totalSegments: 0,
          ffmpegOutput: [],
          startTime: Date.now()
        };
        
        const worker = new MultiVoiceTTSWorker();
        worker.server = this;
        worker.rebuildProgressCallback = (progress) => {
          this.rebuildProgress[chapterId] = {
            ...this.rebuildProgress[chapterId],
            ...progress
          };
        };
        await worker.init();
        
        const outputFile = await worker.rebuildChapterWithProgress(chapterId);
        await worker.close();
        
        // Publish only the rebuilt MP3 to S3
        this.log(`📤 Publishing rebuilt chapter ${chapterId} to S3...`);
        const s3Sync = new S3Sync();
        s3Sync.server = this; // Set server for logging
        await s3Sync.init();
        
        // Upload only the rebuilt MP3 file
        const mp3Filename = `${chapterId}.mp3`;
        const localPath = path.join(config.paths.output, mp3Filename);
        const s3Path = `${config.s3.prefix}audio/${mp3Filename}`;
        
        await s3Sync.copyFileToS3(localPath, s3Path);
        
        // Update published timestamp
        await this.db.run(
          'UPDATE chapters SET published_at = CURRENT_TIMESTAMP WHERE id = ?',
          [chapterId]
        );
        this.log(`✓ Updated published timestamp for chapter ${chapterId}`);
        
        // Mark rebuild as completed
        if (this.rebuildProgress[chapterId]) {
          this.rebuildProgress[chapterId] = {
            ...this.rebuildProgress[chapterId],
            status: 'completed',
            phase: 'done',
            message: 'Rebuild completed successfully',
            endTime: Date.now()
          };
        }
        
        return { 
          success: true, 
          message: `Chapter ${chapterId} rebuilt and published to S3`,
          file: outputFile
        };
      } catch (error) {
        this.log(`Failed to rebuild chapter: ${error.message}`, 'error');
        
        // Mark rebuild as failed
        if (this.rebuildProgress[chapterId]) {
          this.rebuildProgress[chapterId] = {
            ...this.rebuildProgress[chapterId],
            status: 'failed',
            phase: 'error',
            message: error.message,
            error: error.message,
            endTime: Date.now()
          };
        }
        
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get rebuild progress
    this.fastify.get('/api/chapters/:id/rebuild-progress', async (request, reply) => {
      const chapterId = request.params.id;
      const progress = this.rebuildProgress[chapterId];
      
      if (!progress) {
        return {
          status: 'idle',
          message: 'No rebuild in progress'
        };
      }
      
      // Clean up completed rebuilds after 5 minutes
      if (progress.status === 'completed' && Date.now() - progress.startTime > 5 * 60 * 1000) {
        delete this.rebuildProgress[chapterId];
        return {
          status: 'idle',
          message: 'No rebuild in progress'
        };
      }
      
      return progress;
    });

    // Debug merge chapter - shows detailed ffmpeg output for troubleshooting
    this.fastify.post('/api/chapters/:id/debug-merge', async (request, reply) => {
      try {
        const chapterId = request.params.id;
        
        this.log(`🔍 Debug merging chapter ${chapterId}...`);
        
        const worker = new MultiVoiceTTSWorker();
        worker.server = this;
        await worker.init();
        
        const debugOutput = await worker.debugMergeChapter(chapterId);
        await worker.close();
        
        return { 
          success: true, 
          debugOutput: debugOutput
        };
      } catch (error) {
        this.log(`Failed to debug merge chapter: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Serve audio segments and full chapter files
    this.fastify.get('/api/audio/:chapterId/:filename', async (request, reply) => {
      try {
        const { chapterId, filename } = request.params;
        
        // Determine if this is a segment or full chapter
        if (filename.startsWith('segment_')) {
          // Serve segment file
          const segmentPath = path.join(config.paths.output, 'segments', chapterId, filename);
          return reply.sendFile(filename, path.join(config.paths.output, 'segments', chapterId));
        } else {
          // Serve full chapter file
          const chapterPath = path.join(config.paths.output, `${chapterId}.mp3`);
          return reply.sendFile(`${chapterId}.mp3`, config.paths.output);
        }
      } catch (error) {
        reply.code(404);
        return { error: 'Audio file not found' };
      }
    });

    // Stage 4: Publish to S3
    this.fastify.post('/api/jobs/publish', async (request, reply) => {
      try {
        this.log('Stage 4: Publishing podcast feed and audio files');
        
        // Generate RSS
        const generator = new RSSGenerator();
        await generator.generateFeed();
        await generator.generateEpisodeList();
        
        // Sync to S3
        const s3Sync = new S3Sync();
        await s3Sync.syncPodcastFiles();
        
        this.log('✅ Published podcast feed to S3');
        
        return { 
          success: true,
          message: 'Podcast published to S3',
          feedUrl: `${config.server.siteUrl}/feed.xml`
        };
      } catch (error) {
        this.log(`Publishing failed: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get feed info
    this.fastify.get('/api/feed/info', async (request, reply) => {
      try {
        const stats = await this.db.getStats();
        const publishedChapters = await this.db.all(`
          SELECT COUNT(*) as count FROM chapters 
          WHERE published_at IS NOT NULL
        `);
        
        return {
          episodeCount: publishedChapters[0]?.count || 0,
          totalChapters: stats.totalChapters,
          processedChapters: stats.processedChapters,
          feedUrl: `${config.server.siteUrl}/feed.xml`,
          lastUpdated: new Date().toISOString()
        };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Generate RSS feed
    this.fastify.post('/api/feed/generate', async (request, reply) => {
      try {
        this.log('📡 Generating RSS feed...');
        const generator = new RSSGenerator();
        generator.server = this;
        
        await generator.db.init();
        const result = await generator.generateFeed();
        await generator.generateEpisodeList();
        await generator.db.close();
        
        this.log(`✅ RSS feed generated with ${result.episodeCount} episodes`);
        
        return { 
          success: true, 
          episodeCount: result.episodeCount,
          feedPath: result.feedPath
        };
      } catch (error) {
        this.log(`RSS generation failed: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Sync to S3
    this.fastify.post('/api/sync/s3', async (request, reply) => {
      try {
        this.log('☁️ Starting S3 sync...');
        
        const s3Sync = new S3Sync();
        s3Sync.server = this;
        
        await s3Sync.syncPodcastFiles();
        
        this.log('✅ Podcast files synced to S3');
        this.log(`📡 Feed available at: https://www.porivo.com/podcasts/feed.xml`);
        
        return { 
          success: true,
          message: 'Files synced to S3',
          feedUrl: 'https://www.porivo.com/podcasts/feed.xml'
        };
      } catch (error) {
        this.log(`S3 sync failed: ${error.message}`, 'error');
        reply.code(500);
        return { error: error.message };
      }
    });

    // Speaker management endpoints
    this.fastify.get('/api/speakers', async (request, reply) => {
      try {
        const speakers = await this.db.getAllSpeakers();
        return speakers;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    this.fastify.put('/api/speakers/:id/voice', async (request, reply) => {
      try {
        const speakerId = request.params.id;
        const { voiceId, voiceName } = request.body;
        
        await this.db.updateSpeakerVoice(speakerId, voiceId, voiceName);
        
        this.log(`Updated voice for speaker ${speakerId}: ${voiceName} (${voiceId})`);
        return { success: true, message: 'Voice assignment updated' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });


    // Character dashboard
    this.fastify.get('/api/characters/dashboard', async (request, reply) => {
      try {
        const dashboard = await this.db.getCharacterDashboard();
        return dashboard;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Merge speakers (for cases like Villy = Malefic Viper)
    this.fastify.post('/api/speakers/merge', async (request, reply) => {
      try {
        const { fromSpeakerId, toSpeakerId } = request.body;
        
        if (!fromSpeakerId || !toSpeakerId) {
          reply.code(400);
          return { error: 'Both fromSpeakerId and toSpeakerId are required' };
        }
        
        await this.db.mergeSpeakers(fromSpeakerId, toSpeakerId);
        
        this.log(`Merged speaker ${fromSpeakerId} into ${toSpeakerId}`);
        return { success: true, message: 'Speakers merged successfully' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Get chapters affected by voice change
    this.fastify.get('/api/speakers/:id/affected-chapters', async (request, reply) => {
      try {
        const speakerId = request.params.id;
        const chapters = await this.db.getChaptersAffectedByVoiceChange(speakerId);
        return chapters;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Delete a speaker/character
    this.fastify.delete('/api/speakers/:id', async (request, reply) => {
      try {
        const speakerId = request.params.id;
        const { force } = request.query; // ?force=true to delete with segments
        
        // Check if this speaker has any segments
        const segmentCount = await this.db.getSpeakerSegmentCount(speakerId);
        
        if (segmentCount > 0 && !force) {
          reply.code(400);
          return { 
            error: 'Cannot delete character with existing segments. Use force=true to delete anyway, or use merge to combine with another character.',
            segmentCount
          };
        }
        
        // Delete the speaker
        await this.db.deleteSpeaker(speakerId, force === 'true');
        
        this.log(`Deleted character with ID ${speakerId}${force ? ' (forced)' : ''}`);
        return { success: true, message: 'Character deleted successfully' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });

    // Voice preview endpoint
    this.fastify.post('/api/voices/preview', async (request, reply) => {
      try {
        const { voiceId, text } = request.body;
        
        if (!voiceId || !text) {
          reply.code(400);
          return { error: 'voiceId and text are required' };
        }
        
        // Check if it's a custom voice or OpenAI preset
        const voice = await this.db.getVoice(voiceId);
        
        if (!voice || voice.provider === 'openai') {
          // Generate a short audio preview using OpenAI TTS
          const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.openai.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'tts-1',
              voice: voiceId,
              input: text.substring(0, 200) // Limit preview length
            })
          });
          
          if (!response.ok) {
            throw new Error('Failed to generate voice preview');
          }
          
          // Return audio file as blob
          reply.type('audio/mpeg');
          return response.body;
        } else if (voice.provider === 'elevenlabs') {
          // Generate preview using ElevenLabs
          if (!config.elevenlabs?.apiKey) {
            throw new Error('ElevenLabs API key not configured');
          }
          
          const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.settings.voice_id}`, {
            method: 'POST',
            headers: {
              'xi-api-key': config.elevenlabs.apiKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              text: text.substring(0, 200), // Limit preview length
              model_id: voice.settings.model_id || 'eleven_monolingual_v1',
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
              }
            })
          });
          
          if (!response.ok) {
            throw new Error('Failed to generate ElevenLabs preview');
          }
          
          // Return audio file as blob
          reply.type('audio/mpeg');
          return response.body;
        } else {
          // Handle other custom voice providers
          throw new Error(`Voice provider ${voice.provider} not yet implemented`);
        }
        
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Voice library endpoints
    this.fastify.get('/api/voices', async (request, reply) => {
      try {
        const allVoices = await this.db.getAllVoices();
        // Filter out OpenAI voices - only return ElevenLabs and custom voices
        const voices = allVoices.filter(voice => voice.provider !== 'openai');
        return voices;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    this.fastify.get('/api/voices/:id', async (request, reply) => {
      try {
        const voice = await this.db.getVoice(request.params.id);
        if (!voice) {
          reply.code(404);
          return { error: 'Voice not found' };
        }
        return voice;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    this.fastify.post('/api/voices', async (request, reply) => {
      try {
        const voiceData = request.body;
        
        // Validate required fields
        if (!voiceData.id || !voiceData.name) {
          reply.code(400);
          return { error: 'id and name are required' };
        }
        
        // Create the voice
        await this.db.createVoice(voiceData);
        
        this.log(`Created custom voice: ${voiceData.name} (${voiceData.id})`);
        return { success: true, message: 'Voice created successfully' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    this.fastify.put('/api/voices/:id', async (request, reply) => {
      try {
        const voiceId = request.params.id;
        const updates = request.body;
        
        await this.db.updateVoice(voiceId, updates);
        
        this.log(`Updated voice: ${voiceId}`);
        return { success: true, message: 'Voice updated successfully' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    this.fastify.delete('/api/voices/:id', async (request, reply) => {
      try {
        const voiceId = request.params.id;
        
        await this.db.deleteVoice(voiceId);
        
        this.log(`Deactivated voice: ${voiceId}`);
        return { success: true, message: 'Voice deactivated successfully' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Voice samples endpoints
    this.fastify.get('/api/voices/:id/samples', async (request, reply) => {
      try {
        const samples = await this.db.getVoiceSamples(request.params.id);
        return samples;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    this.fastify.post('/api/voices/:id/samples', async (request, reply) => {
      try {
        const voiceId = request.params.id;
        const { text } = request.body;
        
        if (!text) {
          reply.code(400);
          return { error: 'text is required' };
        }
        
        // Generate and save sample
        // TODO: Generate audio and upload to storage
        const audioUrl = null; // Placeholder
        
        await this.db.saveVoiceSample(voiceId, text, audioUrl);
        
        return { success: true, message: 'Sample saved' };
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
    
    // Fetch ElevenLabs voice details
    this.fastify.get('/api/elevenlabs/voices/:voiceId', async (request, reply) => {
      try {
        const { voiceId } = request.params;
        
        if (!config.elevenlabs?.apiKey) {
          this.log('ElevenLabs API key not found in config', 'error');
          reply.code(400);
          return { error: 'ElevenLabs API key not configured. Please set ELEVENLABS_API_KEY in your .env file' };
        }
        
        this.log(`Fetching ElevenLabs voice details for: ${voiceId}`);
        
        // First try to fetch from user's voices
        let response = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'xi-api-key': config.elevenlabs.apiKey
          }
        });
        
        if (!response.ok) {
          // Handle 404 and 400 "voice_not_found" as Voice Library voices
          if (response.status === 404 || response.status === 400) {
            const errorData = await response.json().catch(() => ({}));
            
            if (response.status === 404 || errorData.detail?.status === 'voice_not_found') {
              this.log(`Voice not found in user library, trying Voice Library API: ${voiceId}`);
              
              // Use the correct Voice Library search endpoint
              try {
                this.log(`Searching Voice Library with search parameter: ${voiceId}`);
                
                const params = new URLSearchParams({ 
                  search: voiceId, 
                  page_size: '1' 
                });
                
                const libraryResponse = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${params}`, {
                  method: 'GET',
                  headers: {
                    'Accept': 'application/json',
                    'xi-api-key': config.elevenlabs.apiKey
                  }
                });
                
                if (libraryResponse.ok) {
                  const libraryData = await libraryResponse.json();
                  
                  if (libraryData.voices && libraryData.voices.length > 0) {
                    const voice = libraryData.voices[0];
                    this.log(`Found Voice Library voice: ${voice.name} (${voice.voice_id})`);
                    
                    return {
                      id: `elevenlabs_${voice.voice_id}`,
                      name: voice.name,
                      provider: 'elevenlabs',
                      type: 'custom',
                      settings: {
                        voice_id: voice.voice_id,
                        model_id: 'eleven_monolingual_v1',
                        is_voice_library: true,
                        public_owner_id: voice.public_owner_id
                      },
                      tags: [
                        voice.gender,
                        voice.age,
                        voice.accent,
                        voice.category,
                        ...(voice.descriptive ? voice.descriptive.split(',').map(s => s.trim()) : [])
                      ].filter(Boolean).join(', '),
                      description: voice.description,
                      preview_url: voice.preview_url
                    };
                  } else {
                    this.log(`No voices found in Voice Library search for: ${voiceId}`);
                  }
                } else {
                  const errorText = await libraryResponse.text();
                  this.log(`Voice Library search failed: ${libraryResponse.status} ${errorText}`, 'error');
                }
                
              } catch (libraryError) {
                this.log(`Failed to search Voice Library: ${libraryError.message}`, 'error');
              }
              
              // Fallback if Voice Library search fails
              this.log(`Voice not found in Voice Library either, using placeholder: ${voiceId}`);
              return {
                id: `elevenlabs_${voiceId}`,
                name: `Voice Library: ${voiceId}`,
                provider: 'elevenlabs',
                type: 'custom',
                settings: {
                  voice_id: voiceId,
                  model_id: 'eleven_monolingual_v1',
                  is_voice_library: true
                },
                tags: 'voice-library'
              };
            }
          }
          if (response.status === 401) {
            const errorData = await response.json();
            this.log(`ElevenLabs API authentication failed: ${JSON.stringify(errorData)}`, 'error');
            
            if (errorData.detail?.message?.includes('missing_permissions')) {
              reply.code(401);
              return { 
                error: 'Your ElevenLabs API key is missing the "voices_read" permission. Please update your API key permissions at elevenlabs.io',
                details: errorData.detail.message
              };
            }
            
            reply.code(401);
            return { error: 'ElevenLabs API authentication failed. Please check your ELEVENLABS_API_KEY in .env file' };
          }
          const errorText = await response.text();
          this.log(`ElevenLabs API error ${response.status}: ${errorText}`, 'error');
          throw new Error(`ElevenLabs API error: ${response.status}`);
        }
        
        const voiceData = await response.json();
        
        // Extract relevant details
        const voice = {
          id: `elevenlabs_${voiceData.voice_id}`,
          name: voiceData.name,
          provider: 'elevenlabs',
          type: 'custom',
          settings: {
            voice_id: voiceData.voice_id,
            model_id: 'eleven_monolingual_v1'
          },
          tags: [
            voiceData.labels?.gender,
            voiceData.labels?.age,
            voiceData.labels?.accent,
            voiceData.labels?.description
          ].filter(Boolean).join(', ')
        };
        
        return voice;
      } catch (error) {
        reply.code(500);
        return { error: error.message };
      }
    });
  }

  // Background job processors
  async processChapterRebuild(chapterId) {
    try {
      console.log(`Starting rebuild for chapter ${chapterId}`);
      
      // Update job status
      await this.db.updateJobStatus(chapterId, 'scrape', 'running');
      
      // Re-scrape would need the chapter URL - for now skip scraping step
      // In a real implementation, you'd load the chapter URL and re-scrape
      
      // Process TTS
      await this.db.updateJobStatus(chapterId, 'tts', 'running');
      await this.ttsWorker.processChapter(chapterId);
      await this.db.updateJobStatus(chapterId, 'tts', 'completed');
      
      // Regenerate RSS
      const generator = new RSSGenerator();
      await generator.generateFeed();
      await generator.generateEpisodeList();
      
      console.log(`Completed rebuild for chapter ${chapterId}`);
      
    } catch (error) {
      console.error(`Failed to rebuild chapter ${chapterId}:`, error);
      await this.db.updateJobStatus(chapterId, 'tts', 'failed', error.message);
    }
  }

  async processFullRebuild() {
    try {
      console.log('Starting full rebuild...');
      
      // Scrape all chapters
      const scraper = new PatreonScraper();
      const chapters = await scraper.scrapeAll();
      
      // Update database with chapter data
      for (const chapter of chapters) {
        await this.db.upsertChapter(chapter);
      }
      
      // Process TTS for all chapters
      await this.ttsWorker.processAllChapters();
      
      // Generate RSS feed
      const generator = new RSSGenerator();
      await generator.generateFeed();
      await generator.generateEpisodeList();
      
      console.log('Full rebuild completed');
      
    } catch (error) {
      console.error('Full rebuild failed:', error);
    }
  }

  async processSyncJob() {
    try {
      this.log('Starting sync (Stage 1: Extract chapters)...');
      
      // Create scraper instance with server logging
      const scraper = new PatreonScraper();
      scraper.server = this; // Pass server instance for logging
      
      const newChapters = await scraper.scrapeAll(); // This already skips existing
      
      if (newChapters.length > 0) {
        this.log(`Found ${newChapters.length} new chapters to extract`);
        
        // Update database - just extraction, no TTS
        for (const chapter of newChapters) {
          await this.db.upsertChapter(chapter);
          this.log(`✅ Extracted chapter ${chapter.id}: ${chapter.title}`);
        }
        
        this.log(`Stage 1 complete: ${newChapters.length} chapters extracted`);
        
        // Automatically start speaker identification for extracted chapters
        this.log(`🎭 Automatically starting Stage 2: Speaker identification for ${newChapters.length} chapters...`);
        let speakerIdSuccess = 0;
        
        for (const chapter of newChapters) {
          try {
            await this.processChapterSpeakerIdentification(chapter.id);
            speakerIdSuccess++;
            this.log(`✅ Speaker identification completed for: ${chapter.title}`);
          } catch (error) {
            this.log(`⚠️ Speaker identification failed for ${chapter.title}: ${error.message}`, 'warning');
          }
        }
        
        this.log(`🎭 Stage 2 complete: ${speakerIdSuccess}/${newChapters.length} chapters processed`);
        this.log(`Next steps:`);
        this.log(`  - Stage 3: Generate multi-voice TTS`); 
        this.log(`  - Stage 4: Publish to S3`);
      } else {
        this.log(`No new chapters found`);
      }
      
    } catch (error) {
      this.log(`Sync failed: ${error.message}`, 'error');
      console.error('Sync failed:', error);
    }
  }

  async processLoadNextChapter(postId) {
    try {
      this.log(`🔄 Loading next chapter: ${postId}`);
      
      // Create scraper instance with server logging
      const scraper = new PatreonScraper();
      scraper.server = this;
      
      // Scrape the specific post
      const postUrl = `https://www.patreon.com/posts/${postId}`;
      this.log(`📖 Scraping: ${postUrl}`);
      
      const chapterData = await scraper.scrapeChapterByUrl(postUrl);
      
      if (chapterData) {
        // Save to database
        await this.db.upsertChapter(chapterData);
        this.log(`✅ Successfully loaded chapter: ${chapterData.title}`);
        this.log(`📝 Content length: ${chapterData.content?.length || 0} characters`);
        
        // Save raw data file BEFORE speaker identification
        const dataFile = path.join(config.paths.data, `${chapterData.id}.json`);
        await fs.writeFile(dataFile, JSON.stringify(chapterData, null, 2));
        this.log(`💾 Saved data file: ${dataFile}`);
        
        // Automatically start speaker identification AFTER file is saved
        this.log(`🎭 Automatically starting speaker identification for loaded chapter...`);
        try {
          await this.processChapterSpeakerIdentification(chapterData.id);
          this.log(`✅ Speaker identification completed for: ${chapterData.title}`);
        } catch (error) {
          this.log(`⚠️ Speaker identification failed: ${error.message}`, 'warning');
        }
        
        return chapterData;
      } else {
        throw new Error('Failed to extract chapter content');
      }
      
    } catch (error) {
      this.log(`❌ Failed to load chapter ${postId}: ${error.message}`, 'error');
      throw error;
    }
  }

  async processScrapeChapterContent(chapterId, chapterUrl) {
    try {
      this.log(`📖 Scraping content for chapter ${chapterId} from: ${chapterUrl}`);
      
      // Create scraper instance with server logging
      const scraper = new PatreonScraper();
      scraper.server = this;
      
      // Scrape the chapter content
      const chapterData = await scraper.scrapeChapterByUrl(chapterUrl);
      
      if (chapterData) {
        // Keep the original chapter ID and metadata
        chapterData.id = chapterId;
        
        // Update the chapter in database with content
        await this.db.upsertChapter(chapterData);
        this.log(`✅ Successfully scraped content for chapter ${chapterId}`);
        this.log(`📝 Content length: ${chapterData.content?.length || 0} characters`);
        
        // Save raw data file
        const dataFile = path.join(config.paths.data, `${chapterId}.json`);
        await fs.writeFile(dataFile, JSON.stringify(chapterData, null, 2));
        this.log(`💾 Saved data file: ${dataFile}`);
        
        // Automatically start speaker identification after successful extraction
        this.log(`🎭 Automatically starting speaker identification for chapter ${chapterId}...`);
        try {
          await this.processChapterSpeakerIdentification(chapterId);
          this.log(`✅ Speaker identification completed for chapter ${chapterId}`);
        } catch (speakerError) {
          this.log(`⚠️ Speaker identification failed for chapter ${chapterId}: ${speakerError.message}`, 'warning');
          // Don't throw - we still successfully scraped the content
        }
        
        return chapterData;
      } else {
        throw new Error('Failed to extract chapter content');
      }
      
    } catch (error) {
      this.log(`❌ Failed to scrape content for chapter ${chapterId}: ${error.message}`, 'error');
      throw error;
    }
  }

  async processSearchAndLoadNextChapter(chapterNumber) {
    try {
      this.log(`🔍 Searching for Chapter ${chapterNumber}...`);
      
      // Create scraper instance with server logging
      const scraper = new PatreonScraper();
      scraper.server = this;
      
      // Search for the chapter using the updated findNextChapter method
      const chapterInfo = await scraper.findNextChapter(chapterNumber - 1); // Pass previous chapter number
      
      if (chapterInfo) {
        this.log(`✅ Found chapter: ${chapterInfo.title}`);
        this.log(`📖 URL: ${chapterInfo.url}`);
        this.log(`🆔 Post ID: ${chapterInfo.url.match(/\/posts\/.*-(\d+)$/)?.[1] || 'unknown'}`);
        
        // Extract post ID from URL
        const postIdMatch = chapterInfo.url.match(/\/posts\/.*-(\d+)$/);
        const postId = postIdMatch ? postIdMatch[1] : `chapter_${chapterNumber}`;
        
        // Create stub record first (with real title and ID)
        const stubData = {
          id: postId,
          title: chapterInfo.title,
          url: chapterInfo.url,
          content: null, // No content yet
          scrapedAt: null, // Not scraped yet
          wordCount: 0,
          createdAt: new Date().toISOString()
        };
        
        await this.db.upsertChapter(stubData);
        this.log(`✅ Created stub record for ${chapterInfo.title}`);
        
        // Now scrape the content
        this.log(`📖 Scraping content...`);
        const chapterData = await scraper.scrapeChapterByUrl(chapterInfo.url);
        
        if (chapterData) {
          // Update the stub with content
          chapterData.id = postId; // Keep the post ID
          chapterData.title = chapterInfo.title; // Keep the found title
          chapterData.url = chapterInfo.url; // Keep the found URL
          
          // Save to database with content
          await this.db.upsertChapter(chapterData);
          this.log(`✅ Successfully scraped content for: ${chapterData.title}`);
          this.log(`📝 Content length: ${chapterData.content?.length || 0} characters`);
          
          // Save raw data file BEFORE speaker identification
          const dataFile = path.join(config.paths.data, `${chapterData.id}.json`);
          await fs.writeFile(dataFile, JSON.stringify(chapterData, null, 2));
          this.log(`💾 Saved data file: ${dataFile}`);
          
          // Automatically start speaker identification AFTER file is saved
          this.log(`🎭 Automatically starting speaker identification for found chapter...`);
          try {
            await this.processChapterSpeakerIdentification(chapterData.id);
            this.log(`✅ Speaker identification completed for: ${chapterData.title}`);
          } catch (error) {
            this.log(`⚠️ Speaker identification failed: ${error.message}`, 'warning');
          }
          
          return chapterData;
        } else {
          this.log(`⚠️ Found chapter but failed to scrape content. Stub record created.`);
          return stubData;
        }
      } else {
        this.log(`❌ Chapter ${chapterNumber} not found on Patreon`);
        this.log(`💡 It might not be published yet, might be from a different series, or use different naming`);
      }
      
    } catch (error) {
      this.log(`❌ Failed to search and load Chapter ${chapterNumber}: ${error.message}`, 'error');
    }
  }

  async processChapterSpeakerIdentification(chapterId) {
    const updateProgress = (updates) => {
      if (this.speakerIdProgress && this.speakerIdProgress[chapterId]) {
        this.speakerIdProgress[chapterId] = {
          ...this.speakerIdProgress[chapterId],
          ...updates
        };
      }
    };
    
    try {
      this.log(`🎭 Processing speaker identification for chapter ${chapterId}`);
      
      // Update progress - loading chapter
      updateProgress({
        status: 'processing',
        phase: 'loading',
        message: 'Loading chapter content...'
      });
      
      // Load chapter content
      const dataFile = path.join(config.paths.data, `${chapterId}.json`);
      const data = await fs.readFile(dataFile, 'utf-8');
      const chapterData = JSON.parse(data);
      
      if (!chapterData.content) {
        throw new Error('No content found for chapter');
      }
      
      // Update progress - loading speakers
      updateProgress({
        phase: 'loading_speakers',
        message: 'Loading existing speakers...',
        contentLength: chapterData.content.length
      });

      // Get existing speakers to pass as context
      const knownSpeakers = await this.db.getAllSpeakers();
      this.log(`Found ${knownSpeakers.length} existing speakers`);
      
      // Update progress - analyzing
      updateProgress({
        phase: 'analyzing',
        message: `Analyzing ${chapterData.content.length.toLocaleString()} characters with GPT-4...`,
        knownSpeakers: knownSpeakers.length
      });
      
      // Set up speaker identifier with server logging
      this.speakerIdentifier.server = this;
      
      // Identify speakers in the chapter with progress callback
      this.log(`📝 Analyzing chapter content (${chapterData.content.length} characters)...`);
      const segments = await this.speakerIdentifier.identifySpeakersTwoStage(
        chapterData.content, 
        knownSpeakers,
        (progress) => {
          // Update progress with additional streaming info
          updateProgress({
            ...progress,
            contentLength: chapterData.content.length,
            knownSpeakers: knownSpeakers.length
          });
        }
      );
      
      this.log(`🎯 Identified ${segments.length} segments`);
      
      // Log speaker breakdown
      const speakerCounts = {};
      segments.forEach(segment => {
        speakerCounts[segment.speaker] = (speakerCounts[segment.speaker] || 0) + 1;
      });
      
      this.log(`👥 Speaker breakdown:`);
      Object.entries(speakerCounts).forEach(([speaker, count]) => {
        this.log(`   - ${speaker}: ${count} segments`);
      });
      
      // Update progress - saving
      updateProgress({
        phase: 'saving',
        message: `Saving ${segments.length} segments to database...`,
        segments: segments.length,
        speakerCounts: speakerCounts
      });
      
      // Save segments to database
      await this.db.saveChapterSegments(chapterId, segments);
      
      // Update progress - complete
      updateProgress({
        status: 'completed',
        phase: 'complete',
        message: `Successfully identified ${segments.length} segments`,
        completed: true,
        segments: segments.length,
        speakerCounts: speakerCounts
      });
      
      this.log(`✅ Speaker identification complete for chapter ${chapterId}`);
      
      return segments;
      
    } catch (error) {
      this.log(`❌ Speaker identification failed for chapter ${chapterId}: ${error.message}`, 'error');
      
      // Update progress - error
      updateProgress({
        status: 'failed',
        phase: 'error',
        message: `Failed: ${error.message}`,
        completed: false,
        error: error.message
      });
      
      throw error;
    }
  }

  async processMultiVoiceTTS() {
    try {
      this.log('🎙️ Starting multi-voice TTS processing...');
      
      const worker = new MultiVoiceTTSWorker();
      worker.server = this; // Pass server instance for logging
      await worker.init();
      
      await worker.processAllChapters();
      
      this.log('✅ Multi-voice TTS processing complete');
      
      // Publish to S3 after processing all chapters
      this.log('📤 Publishing all generated audio to S3...');
      const s3Sync = new S3Sync();
      await s3Sync.syncPodcastFiles();
      this.log('✅ Published all audio to S3');
      
    } catch (error) {
      this.log(`❌ Multi-voice TTS processing failed: ${error.message}`, 'error');
    }
  }

  async processChapterAudio(chapterId) {
    try {
      this.log(`🎙️ Processing audio for chapter ${chapterId}`);
      
      const worker = new MultiVoiceTTSWorker();
      worker.server = this; // Pass server instance for logging
      await worker.init();
      
      const outputFile = await worker.processChapter(chapterId);
      
      this.log(`✅ Audio generated: ${outputFile}`);
      
      // Publish to S3 after processing chapter
      this.log(`📤 Publishing chapter ${chapterId} to S3...`);
      const s3Sync = new S3Sync();
      await s3Sync.syncPodcastFiles();
      this.log(`✅ Published chapter ${chapterId} to S3`);
      
    } catch (error) {
      this.log(`❌ Audio generation failed for chapter ${chapterId}: ${error.message}`, 'error');
    }
  }

  async start() {
    try {
      await this.db.init();
      await this.fastify.listen({ 
        port: config.server.port,
        host: '0.0.0.0'
      });
      
      console.log(`Server running on port ${config.server.port}`);
      
    } catch (err) {
      this.fastify.log.error(err);
      process.exit(1);
    }
  }

  async stop() {
    await this.db.close();
    await this.fastify.close();
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new APIServer();
  
  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await server.stop();
    process.exit(0);
  });
  
  server.start();
}

export { APIServer };