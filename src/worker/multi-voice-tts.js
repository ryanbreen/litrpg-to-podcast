import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../shared/config.js';
import { Database } from '../shared/database.js';
import { RSSGenerator } from '../shared/rss-generator.js';
import { S3Sync } from '../shared/s3-sync.js';

// Custom exec with larger buffer for all operations
const execAsync = (command, options = {}) => {
  return new Promise((resolve, reject) => {
    const defaultOptions = { maxBuffer: 50 * 1024 * 1024 };
    const finalOptions = { ...defaultOptions, ...options };

    exec(command, finalOptions, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
};

// Alias for backward compatibility
const execAsyncLarge = execAsync;

class MultiVoiceTTSWorker {
  constructor() {
    this.db = new Database();
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
    });
    this.server = null; // Set by API server for logging
  }

  log(message, level = 'info') {
    if (this.server) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  updateProgress(chapterId, updates) {
    if (this.server && this.server.generationProgress) {
      this.server.generationProgress[chapterId] = {
        ...this.server.generationProgress[chapterId],
        ...updates,
      };
    }
  }

  async init() {
    await this.db.init();
  }

  async generateSpeechSegment(
    text,
    voice,
    outputPath,
    segmentType = null,
    sound = null
  ) {
    // Check if this is a pause marker
    if (text.trim() === '<pause3s>') {
      this.log(`Creating 3-second pause...`);
      await this.createSilence(3000, outputPath);
      return;
    }

    // Check if this is a DING! sound effect
    if (
      (segmentType === 'sound_effect' && sound === 'ding') ||
      text.trim() === 'DING!' ||
      text.trim() === 'Ding!' ||
      text.trim() === 'ding!' ||
      text.trim() === "'DING!'" ||
      text.trim() === "'Ding!'" ||
      text.trim() === "'ding!'" ||
      text.trim().startsWith("'DING!'") ||
      text.trim().startsWith('DING!')
    ) {
      this.log(`🔔 Using ding sound effect for: ${text.trim()}`);
      const dingFile = path.join('public', 'audio', 'ding.mp3');
      await fs.copyFile(dingFile, outputPath);
      return;
    }

    this.log(
      `Generating speech segment (${text.length} chars) with voice ${voice.name}...`
    );

    // Parse settings if it's a string
    if (typeof voice.settings === 'string') {
      try {
        voice.settings = JSON.parse(voice.settings);
      } catch (e) {
        this.log(
          `Warning: Failed to parse voice settings for ${voice.name}`,
          'warning'
        );
        voice.settings = {};
      }
    }

    if (!voice.provider || voice.provider === 'openai') {
      // OpenAI TTS
      const mp3 = await this.openai.audio.speech.create({
        model: 'tts-1',
        voice: voice.id || voice.voice_id,
        input: text,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      await fs.writeFile(outputPath, buffer);
    } else if (voice.provider === 'elevenlabs') {
      // ElevenLabs TTS
      if (!config.elevenlabs?.apiKey) {
        throw new Error('ElevenLabs API key not configured');
      }

      const voiceId = voice.settings?.voice_id || voice.voice_id;
      if (!voiceId) {
        throw new Error(`No voice ID found for ElevenLabs voice ${voice.name}`);
      }

      this.log(`Using ElevenLabs voice ID: ${voiceId}`);

      // Check if text is too long for ElevenLabs (10,000 character limit)
      if (text.length > 10000) {
        this.log(
          `Text too long for ElevenLabs (${text.length} chars), splitting into chunks...`
        );
        await this.generateLongElevenLabsSegment(
          text,
          voice,
          voiceId,
          outputPath
        );
        return;
      }

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': config.elevenlabs.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text,
            model_id: voice.settings?.model_id || 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.5,
            },
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`ElevenLabs TTS failed (${response.status}): ${error}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(outputPath, buffer);
    } else {
      throw new Error(`Unsupported voice provider: ${voice.provider}`);
    }

    return outputPath;
  }

  async generateLongElevenLabsSegment(text, voice, voiceId, outputPath) {
    // Split text into chunks of max 9000 characters (leave buffer for safety)
    const chunks = this.splitTextIntoChunks(text, 9000);
    this.log(`Split into ${chunks.length} chunks for ElevenLabs`);

    const tempFiles = [];

    try {
      // Generate audio for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const tempFile = outputPath.replace('.mp3', `_chunk_${i}.mp3`);

        this.log(
          `Generating chunk ${i + 1}/${chunks.length} (${chunk.length} chars)...`
        );

        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': config.elevenlabs.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: chunk,
              model_id: voice.settings?.model_id || 'eleven_monolingual_v1',
              voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5,
              },
            }),
          }
        );

        if (!response.ok) {
          const error = await response.text();
          throw new Error(
            `ElevenLabs TTS failed on chunk ${i + 1} (${response.status}): ${error}`
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(tempFile, buffer);
        tempFiles.push(tempFile);
      }

      // Concatenate all chunks into final output
      if (tempFiles.length > 1) {
        await this.concatenateAudio(tempFiles, outputPath);
      } else {
        // Only one chunk, just rename it
        await fs.rename(tempFiles[0], outputPath);
      }
    } finally {
      // Clean up temp files
      for (const tempFile of tempFiles) {
        try {
          await fs.unlink(tempFile);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  }

  splitTextIntoChunks(text, maxChars) {
    const chunks = [];
    let currentChunk = '';

    // Split by sentences first
    const sentences = text.split(/([.!?]\s+)/);

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];

      // If adding this sentence would exceed the limit, finalize current chunk
      if (
        currentChunk.length + sentence.length > maxChars &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }

    // Add the last chunk if it has content
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    // Handle edge case where a single sentence is still too long
    const finalChunks = [];
    for (const chunk of chunks) {
      if (chunk.length <= maxChars) {
        finalChunks.push(chunk);
      } else {
        // Force split by words if sentence is too long
        const words = chunk.split(' ');
        let wordChunk = '';

        for (const word of words) {
          if (
            wordChunk.length + word.length + 1 > maxChars &&
            wordChunk.length > 0
          ) {
            finalChunks.push(wordChunk.trim());
            wordChunk = word;
          } else {
            wordChunk += (wordChunk ? ' ' : '') + word;
          }
        }

        if (wordChunk.trim().length > 0) {
          finalChunks.push(wordChunk.trim());
        }
      }
    }

    return finalChunks;
  }

  async createSilence(durationMs, outputPath) {
    const durationSec = durationMs / 1000;
    // Use mono channel layout to match TTS-generated segments
    // Ensure bitrate matches other segments (128k) for consistency
    const command = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${durationSec} -c:a libmp3lame -b:a 128k "${outputPath}" -y`;

    await execAsync(command);

    // Verify the silence file was created with correct duration
    try {
      const { stdout } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`
      );
      const actualDuration = parseFloat(stdout.trim());
      if (Math.abs(actualDuration - durationSec) > 0.1) {
        this.log(
          `Warning: Silence file duration mismatch. Expected: ${durationSec}s, Got: ${actualDuration}s`,
          'warning'
        );
      }
    } catch (e) {
      this.log(
        `Warning: Could not verify silence file duration: ${e.message}`,
        'warning'
      );
    }

    return outputPath;
  }

  async concatenateAudioWithProgress(inputFiles, outputPath) {
    // Create concat file list
    const concatFile = outputPath + '.concat.txt';
    const fileList = inputFiles
      .map((file) => `file '${path.resolve(file)}'`)
      .join('\n');
    await fs.writeFile(concatFile, fileList);

    // Log the last few files to help debug
    this.log(
      `Concatenating ${inputFiles.length} files with progress tracking...`
    );

    try {
      // Use spawn for better progress tracking
      const { spawn } = await import('child_process');

      // First pass: concatenate with forced resampling
      const tempFile = outputPath + '.temp.mp3';

      if (this.rebuildProgressCallback) {
        this.rebuildProgressCallback({
          ffmpegOutput: ['Starting first pass: concatenation...'],
        });
      }

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          concatFile,
          '-ar',
          '44100',
          '-ac',
          '1',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          '-progress',
          'pipe:2',
          tempFile,
          '-y',
        ]);

        ffmpeg.stderr.on('data', (data) => {
          const output = data.toString();
          const lines = output.split('\n').filter((line) => line.trim());

          lines.forEach((line) => {
            // Parse progress info
            if (line.includes('time=')) {
              const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
              if (timeMatch && this.rebuildProgressCallback) {
                this.rebuildProgressCallback({
                  ffmpegOutput: [`Pass 1: ${timeMatch[1]}`],
                  currentTime: timeMatch[1],
                });
              }
            }
          });
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });
      });

      // Second pass: apply loudnorm
      if (this.rebuildProgressCallback) {
        this.rebuildProgressCallback({
          ffmpegOutput: ['Starting second pass: volume normalization...'],
        });
      }

      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i',
          tempFile,
          '-af',
          'loudnorm=I=-16:TP=-1.5:LRA=11',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          '-progress',
          'pipe:2',
          outputPath,
          '-y',
        ]);

        ffmpeg.stderr.on('data', (data) => {
          const output = data.toString();
          const lines = output.split('\n').filter((line) => line.trim());

          lines.forEach((line) => {
            // Parse progress info
            if (line.includes('time=')) {
              const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
              if (timeMatch && this.rebuildProgressCallback) {
                this.rebuildProgressCallback({
                  ffmpegOutput: [`Pass 2: ${timeMatch[1]}`],
                  currentTime: timeMatch[1],
                });
              }
            }
          });
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg failed with code ${code}`));
          }
        });
      });

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      this.log(`✅ Audio concatenation complete`);
    } finally {
      // Clean up concat file
      await fs.unlink(concatFile).catch(() => {});
    }
  }

  async concatenateAudio(inputFiles, outputPath) {
    // Create concat file list
    const concatFile = outputPath + '.concat.txt';
    const fileList = inputFiles
      .map((file) => `file '${path.resolve(file)}'`)
      .join('\n');
    await fs.writeFile(concatFile, fileList);

    // Log the last few files to help debug
    this.log(`Concatenating ${inputFiles.length} files...`);
    if (inputFiles.length > 5) {
      this.log(`Last 5 files:`);
      inputFiles.slice(-5).forEach((f) => {
        this.log(`  - ${path.basename(f)}`);
      });
    }

    try {
      // Use a two-pass approach for safety with large files
      // First pass: concatenate with forced resampling to handle any format inconsistencies
      const tempFile = outputPath + '.temp.mp3';
      const concatCommand = `ffmpeg -f concat -safe 0 -i "${concatFile}" -ar 44100 -ac 1 -c:a libmp3lame -b:a 128k "${tempFile}" -y`;
      await execAsyncLarge(concatCommand);

      // Second pass: apply loudnorm for consistent volume
      const normalizeCommand = `ffmpeg -i "${tempFile}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a libmp3lame -b:a 128k "${outputPath}" -y`;
      await execAsyncLarge(normalizeCommand);

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      this.log(`✅ Audio concatenation complete`);

      // Verify the output file duration
      try {
        const { stdout } = await execAsync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`
        );
        const duration = parseFloat(stdout.trim());
        this.log(`Final audio duration: ${duration.toFixed(2)} seconds`);
      } catch (e) {
        this.log(`Could not verify output duration: ${e.message}`, 'warning');
      }
    } finally {
      // Clean up concat file
      await fs.unlink(concatFile).catch(() => {});
    }

    return outputPath;
  }

  async processChapter(chapterId) {
    try {
      const outputFile = path.join(config.paths.output, `${chapterId}.mp3`);

      // Update progress
      this.updateProgress(chapterId, {
        status: 'starting',
        currentSegment: 0,
        totalSegments: 0,
      });

      // Check if already processed
      try {
        await fs.access(outputFile);
        this.log(`Audio already exists for chapter ${chapterId}`);

        // Check if we need to regenerate due to voice changes
        const chapter = await this.db.getChapter(chapterId);
        if (
          chapter.speakers_identified_at &&
          chapter.processed_at &&
          new Date(chapter.speakers_identified_at) >
            new Date(chapter.processed_at)
        ) {
          this.log(`Speaker assignments have changed, regenerating audio...`);
        } else {
          this.updateProgress(chapterId, {
            status: 'completed',
            completed: true,
          });
          return outputFile;
        }
      } catch {
        // File doesn't exist, continue processing
      }

      // Load segments with speaker information
      const segments = await this.db.getChapterSegments(chapterId);

      if (segments.length === 0) {
        throw new Error(
          `No segments found for chapter ${chapterId}. Run speaker identification first.`
        );
      }

      // Load chapter details to get the title
      const chapter = await this.db.getChapter(chapterId);
      if (!chapter) {
        throw new Error(`Chapter ${chapterId} not found in database`);
      }

      // Find the narrator from existing segments
      const narratorSegment = segments.find(
        (s) => s.speaker_name === 'Narrator' || s.is_narrator === 1
      );

      // Only add title segment if we have a narrator in the chapter
      let segmentsWithTitle = segments;
      if (narratorSegment) {
        // Add chapter title as the first segment using the actual narrator speaker
        const titleSegment = {
          id: 0,
          chapter_id: chapterId,
          segment_index: -1, // Special index for title
          speaker_id: narratorSegment.speaker_id, // Use the actual numeric speaker_id
          speaker_name: narratorSegment.speaker_name,
          text: chapter.title,
          type: 'narration',
          voice_id: narratorSegment.voice_id,
          voice_name: narratorSegment.voice_name,
          is_narrator: narratorSegment.is_narrator,
        };

        // Prepend title segment to the segments array
        segmentsWithTitle = [titleSegment, ...segments];
      } else {
        // No narrator found, skip title narration
        this.log('⚠️ No narrator found in chapter, skipping title narration');
      }

      // Initialize progress with segment data
      this.updateProgress(chapterId, {
        status: 'generating',
        totalSegments: segmentsWithTitle.length,
        segments: segmentsWithTitle.map((seg, index) => ({
          text: seg.text,
          status: 'pending',
        })),
      });

      // Load voices for all speakers
      const speakerVoices = new Map();
      for (const segment of segmentsWithTitle) {
        if (!speakerVoices.has(segment.speaker_id)) {
          // Special handling for AI Announcer and Narrator
          if (segment.speaker_id === 'ai_announcer') {
            // Check if we have a custom AI Announcer voice configured
            let voice = await this.db.getVoiceForSpeaker('ai_announcer');
            if (!voice) {
              // Default to a robotic-sounding voice
              this.log(`🤖 Using default AI Announcer voice (alloy)`);
              voice = {
                id: 'alloy',
                name: 'AI Announcer (Default)',
                provider: 'openai',
                settings: {},
              };
            }
            speakerVoices.set(segment.speaker_id, {
              ...voice,
              speaker_name: 'AI Announcer',
            });
          } else {
            // Check if speaker has a voice assigned
            if (!segment.voice_id) {
              throw new Error(
                `Speaker "${segment.speaker_name}" has no voice assigned. Please assign voices to all speakers.`
              );
            }

            // Load voice details
            const voice = await this.db.getVoice(segment.voice_id);
            if (!voice) {
              throw new Error(
                `Voice ${segment.voice_id} not found for speaker ${segment.speaker_name}`
              );
            }

            speakerVoices.set(segment.speaker_id, {
              ...voice,
              speaker_name: segment.speaker_name,
            });
          }
        }
      }

      this.log(
        `Processing chapter with ${segmentsWithTitle.length} segments and ${speakerVoices.size} unique speakers`
      );

      // Create permanent directory for segments (not temporary)
      const segmentsDir = path.join(
        config.paths.output,
        'segments',
        chapterId.toString()
      );
      await fs.mkdir(segmentsDir, { recursive: true });

      try {
        const audioFiles = [];
        let lastSpeakerId = null;

        // Generate speech for each segment
        for (let i = 0; i < segmentsWithTitle.length; i++) {
          const segment = segmentsWithTitle[i];
          const voice = speakerVoices.get(segment.speaker_id);

          // Update progress - mark current segment as processing
          this.updateProgress(chapterId, {
            currentSegment: i,
            segments: segmentsWithTitle.map((seg, index) => ({
              text: seg.text,
              status:
                index < i
                  ? 'completed'
                  : index === i
                    ? 'processing'
                    : 'pending',
            })),
          });

          this.log(
            `Segment ${i + 1}/${segmentsWithTitle.length}: ${segment.speaker_name} (${segment.type})`
          );

          const segmentFile = path.join(
            segmentsDir,
            `segment_${i.toString().padStart(3, '0')}.mp3`
          );
          const segmentMetaFile = path.join(
            segmentsDir,
            `segment_${i.toString().padStart(3, '0')}.json`
          );

          // Check if segment needs regeneration
          let needsRegeneration = false;

          try {
            await fs.access(segmentFile);

            // Check if metadata exists and matches current speaker
            try {
              const metaData = JSON.parse(
                await fs.readFile(segmentMetaFile, 'utf-8')
              );

              // Check if speaker has changed
              if (
                metaData.speaker_id !== segment.speaker_id ||
                metaData.voice_id !== voice.id ||
                metaData.text_hash !==
                  Buffer.from(segment.text).toString('base64')
              ) {
                needsRegeneration = true;
                this.log(
                  `Speaker/voice/text changed for segment ${i + 1}, regenerating...`
                );
              } else {
                this.log(
                  `Using cached segment: ${path.basename(segmentFile)} (speaker unchanged)`
                );
              }
            } catch {
              // No metadata file, should regenerate
              needsRegeneration = true;
              this.log(`No metadata for segment ${i + 1}, regenerating...`);
            }
          } catch {
            // Segment file doesn't exist
            needsRegeneration = true;
          }

          if (needsRegeneration) {
            // Generate new segment
            await this.generateSpeechSegment(
              segment.text,
              voice,
              segmentFile,
              segment.type,
              segment.sound
            );

            // Save metadata for future comparison
            const metadata = {
              speaker_id: segment.speaker_id,
              speaker_name: segment.speaker_name,
              voice_id: voice.id,
              voice_name: voice.name,
              text_hash: Buffer.from(segment.text).toString('base64'),
              generated_at: new Date().toISOString(),
            };
            await fs.writeFile(
              segmentMetaFile,
              JSON.stringify(metadata, null, 2)
            );

            this.log(`Generated new segment: ${path.basename(segmentFile)}`);
          }

          audioFiles.push(segmentFile);

          // Add pause between segments if speaker changes or it's dialogue
          if (i < segmentsWithTitle.length - 1) {
            const nextSegment = segmentsWithTitle[i + 1];
            let pauseDuration = 300; // Default short pause

            // Longer pause for speaker changes
            if (segment.speaker_id !== nextSegment.speaker_id) {
              pauseDuration = 500;
            }

            // Even longer pause for dialogue transitions
            if (
              segment.type === 'dialogue' &&
              nextSegment.type === 'narration'
            ) {
              pauseDuration = 750;
            }

            // Special pause for AI Announcer segments
            if (
              segment.speaker_id === 'ai_announcer' ||
              nextSegment.speaker_id === 'ai_announcer'
            ) {
              pauseDuration = 1000; // 1 second pause around announcements
            }

            const pauseFile = path.join(
              segmentsDir,
              `pause_${i.toString().padStart(3, '0')}.mp3`
            );

            // Check if pause file already exists
            try {
              await fs.access(pauseFile);
            } catch {
              await this.createSilence(pauseDuration, pauseFile);
            }

            audioFiles.push(pauseFile);
          }

          // Update progress - mark current segment as completed
          this.updateProgress(chapterId, {
            currentSegment: i + 1,
            segments: segmentsWithTitle.map((seg, index) => ({
              text: seg.text,
              status: index <= i ? 'completed' : 'pending',
            })),
          });

          this.log(`Completed segment ${i + 1}/${segmentsWithTitle.length}`);
        }

        // Add "End of Chapter" announcement with 2-second pause before it
        this.log('Adding end of chapter announcement...');

        // Create 2-second pause before "End of Chapter"
        const endPauseFile = path.join(segmentsDir, `end_pause.mp3`);
        await this.createSilence(2000, endPauseFile);
        audioFiles.push(endPauseFile);

        // Generate "End of Chapter" audio
        const endChapterFile = path.join(segmentsDir, `end_chapter.mp3`);
        const narratorVoice = speakerVoices.get(
          segmentsWithTitle.find((s) => s.speaker_id === 'narrator')?.speaker_id
        ) || {
          id: 'nova',
          name: 'Nova (Narrator)',
          provider: 'openai',
          settings: {},
        };
        await this.generateSpeechSegment(
          'End of Chapter',
          narratorVoice,
          endChapterFile
        );
        audioFiles.push(endChapterFile);

        // Add 2-second pause after "End of Chapter"
        const afterEndPauseFile = path.join(segmentsDir, `after_end_pause.mp3`);
        await this.createSilence(2000, afterEndPauseFile);
        audioFiles.push(afterEndPauseFile);

        // Concatenate all audio files
        this.log(`Concatenating ${audioFiles.length} audio segments...`);
        this.log(
          `Last 5 files: ${audioFiles
            .slice(-5)
            .map((f) => path.basename(f))
            .join(', ')}`
        );
        await this.concatenateAudio(audioFiles, outputFile);

        // Get audio duration and file size
        const { stdout } = await execAsync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputFile}"`
        );
        const durationSeconds = parseFloat(stdout.trim());

        // Verify the final audio file includes all expected content
        this.log(`Final audio duration: ${durationSeconds.toFixed(2)}s`);

        const stats = await fs.stat(outputFile);
        const fileSize = stats.size;

        // Update database with audio info
        await this.db.run(
          `UPDATE chapters SET audio_duration = ?, audio_file_size = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [durationSeconds, fileSize, chapterId]
        );

        // Log speaker breakdown
        const speakerBreakdown = Array.from(speakerVoices.values())
          .map((v) => `${v.speaker_name} (${v.name})`)
          .join(', ');

        // Mark generation as complete
        this.updateProgress(chapterId, {
          status: 'completed',
          currentSegment: segmentsWithTitle.length,
          completed: true,
          duration: durationSeconds,
          fileSize: fileSize,
        });

        this.log(`✅ Completed multi-voice TTS for chapter ${chapterId}`);
        this.log(`   Duration: ${Math.round(durationSeconds)}s`);
        this.log(`   File size: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
        this.log(`   Voices used: ${speakerBreakdown}`);

        // Publish this chapter immediately
        await this.publishChapter(chapterId);

        return outputFile;
      } finally {
        // Don't clean up segments directory - we want to keep the cached segments
        this.log(`Segments cached in: ${segmentsDir}`);
      }
    } catch (error) {
      // Mark generation as failed
      this.updateProgress(chapterId, {
        status: 'failed',
        error: error.message,
        completed: false,
      });

      this.log(
        `❌ Failed to process chapter ${chapterId}: ${error.message}`,
        'error'
      );
      throw error;
    }
  }

  async processAllChapters() {
    try {
      // Get all chapters that have speakers identified but no audio
      const chapters = await this.db.all(`
        SELECT * FROM chapters 
        WHERE speakers_identified_at IS NOT NULL 
        AND (processed_at IS NULL OR speakers_identified_at > processed_at)
        ORDER BY scraped_at DESC
      `);

      this.log(
        `Found ${chapters.length} chapters to process with multi-voice TTS`
      );

      for (const chapter of chapters) {
        try {
          await this.processChapter(chapter.id);
        } catch (error) {
          this.log(
            `Failed to process chapter ${chapter.id}: ${error.message}`,
            'error'
          );
        }
      }

      this.log('Multi-voice TTS processing complete');
    } catch (error) {
      this.log(`Failed to process chapters: ${error.message}`, 'error');
      throw error;
    }
  }

  async regenerateSegment(chapterId, segmentIndex) {
    this.log(
      `🔄 Regenerating segment ${segmentIndex} for chapter ${chapterId}`
    );

    // Get the specific segment
    const segments = await this.db.getChapterSegments(chapterId);

    if (segmentIndex < 0 || segmentIndex >= segments.length) {
      throw new Error(`Invalid segment index: ${segmentIndex}`);
    }

    const segment = segments[segmentIndex];

    // Get voice for this segment
    const voice = await this.db.getVoice(segment.voice_id);
    if (!voice) {
      throw new Error(
        `Voice ${segment.voice_id} not found for segment ${segmentIndex}`
      );
    }

    // Create segments directory
    const segmentsDir = path.join(
      config.paths.output,
      'segments',
      chapterId.toString()
    );
    await fs.mkdir(segmentsDir, { recursive: true });

    // Generate the specific segment file
    const segmentFile = path.join(
      segmentsDir,
      `segment_${segmentIndex.toString().padStart(3, '0')}.mp3`
    );

    // Delete existing file if it exists
    try {
      await fs.unlink(segmentFile);
    } catch {
      // File doesn't exist, that's fine
    }

    // Generate new segment
    await this.generateSpeechSegment(
      segment.text,
      voice,
      segmentFile,
      segment.type,
      segment.sound
    );

    this.log(
      `✅ Regenerated segment ${segmentIndex}: ${path.basename(segmentFile)}`
    );
    return segmentFile;
  }

  async rebuildChapter(chapterId) {
    this.log(`🔄 Rebuilding chapter ${chapterId} from cached segments`);

    const segments = await this.db.getChapterSegments(chapterId);
    if (segments.length === 0) {
      throw new Error(`No segments found for chapter ${chapterId}`);
    }

    const segmentsDir = path.join(
      config.paths.output,
      'segments',
      chapterId.toString()
    );
    const outputFile = path.join(config.paths.output, `${chapterId}.mp3`);

    // Build array of all audio files in order
    const audioFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const segmentFile = path.join(
        segmentsDir,
        `segment_${i.toString().padStart(3, '0')}.mp3`
      );

      // Check if segment exists
      try {
        await fs.access(segmentFile);
        audioFiles.push(segmentFile);
      } catch {
        throw new Error(
          `Missing segment file: ${path.basename(segmentFile)}. Generate segments first.`
        );
      }

      // Add pause file if not last segment
      if (i < segments.length - 1) {
        const pauseFile = path.join(
          segmentsDir,
          `pause_${i.toString().padStart(3, '0')}.mp3`
        );
        try {
          await fs.access(pauseFile);
          audioFiles.push(pauseFile);
        } catch {
          // Pause file missing, create it
          const segment = segments[i];
          const nextSegment = segments[i + 1];
          let pauseDuration = 300;

          if (segment.speaker_id !== nextSegment.speaker_id) {
            pauseDuration = 500;
          }

          if (segment.type === 'dialogue' && nextSegment.type === 'narration') {
            pauseDuration = 750;
          }

          // Special pause for AI Announcer segments
          if (
            segment.speaker_id === 'ai_announcer' ||
            nextSegment.speaker_id === 'ai_announcer'
          ) {
            pauseDuration = 1000;
          }

          await this.createSilence(pauseDuration, pauseFile);
          audioFiles.push(pauseFile);
        }
      }
    }

    // Add "End of Chapter" announcement with 2-second pause before it
    this.log('Adding end of chapter announcement...');

    // Create 2-second pause before "End of Chapter"
    const endPauseFile = path.join(segmentsDir, `end_pause.mp3`);
    try {
      await fs.access(endPauseFile);
    } catch {
      await this.createSilence(2000, endPauseFile);
    }
    audioFiles.push(endPauseFile);

    // Use existing or generate "End of Chapter" audio
    const endChapterFile = path.join(segmentsDir, `end_chapter.mp3`);
    try {
      await fs.access(endChapterFile);
    } catch {
      // Find narrator voice from segments
      const narratorSegment = segments.find(
        (s) => s.speaker_id === 'narrator' || s.speaker_name === 'narrator'
      );
      const narratorVoiceId = narratorSegment?.voice_id || 'nova';
      const narratorVoice = (await this.db.getVoice(narratorVoiceId)) || {
        id: 'nova',
        name: 'Nova (Narrator)',
        provider: 'openai',
        settings: {},
      };
      await this.generateSpeechSegment(
        'End of Chapter',
        narratorVoice,
        endChapterFile
      );
    }
    audioFiles.push(endChapterFile);

    // Add 2-second pause after "End of Chapter"
    const afterEndPauseFile = path.join(segmentsDir, `after_end_pause.mp3`);
    try {
      await fs.access(afterEndPauseFile);
    } catch {
      await this.createSilence(2000, afterEndPauseFile);
    }
    audioFiles.push(afterEndPauseFile);

    // Concatenate all audio files
    this.log(`Concatenating ${audioFiles.length} audio files...`);
    await this.concatenateAudio(audioFiles, outputFile);

    // Get audio duration and file size
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputFile}"`
    );
    const durationSeconds = parseFloat(stdout.trim());

    const stats = await fs.stat(outputFile);
    const fileSize = stats.size;

    // Update database
    await this.db.run(
      `UPDATE chapters SET audio_duration = ?, audio_file_size = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [durationSeconds, fileSize, chapterId]
    );

    this.log(`✅ Rebuilt chapter ${chapterId}`);
    this.log(`   Duration: ${Math.round(durationSeconds)}s`);
    this.log(`   File size: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    return outputFile;
  }

  async rebuildChapterWithProgress(chapterId) {
    this.log(`🔄 Rebuilding chapter ${chapterId} with progress tracking...`);

    const segments = await this.db.getChapterSegments(chapterId);
    if (segments.length === 0) {
      throw new Error(`No segments found for chapter ${chapterId}`);
    }

    const segmentsDir = path.join(
      config.paths.output,
      'segments',
      chapterId.toString()
    );
    const outputFile = path.join(config.paths.output, `${chapterId}.mp3`);

    // Update progress
    if (this.rebuildProgressCallback) {
      this.rebuildProgressCallback({
        status: 'analyzing',
        phase: 'segments',
        message: `Analyzing ${segments.length} segments...`,
        totalSegments: segments.length,
        segments: [],
      });
    }

    // Build array of all audio files in order
    const audioFiles = [];
    const segmentDetails = [];

    for (let i = 0; i < segments.length; i++) {
      const segmentFile = path.join(
        segmentsDir,
        `segment_${i.toString().padStart(3, '0')}.mp3`
      );

      // Update progress for current segment
      if (this.rebuildProgressCallback) {
        this.rebuildProgressCallback({
          status: 'processing',
          phase: 'analyzing_segments',
          message: `Analyzing segment ${i + 1}/${segments.length}...`,
          currentSegment: i + 1,
        });
      }

      // Check if segment exists
      try {
        const stats = await fs.stat(segmentFile);

        // Get audio duration
        const { stdout: durationOutput } = await execAsync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${segmentFile}"`
        );
        const duration = parseFloat(durationOutput.trim());

        const segmentInfo = {
          index: i,
          file: path.basename(segmentFile),
          size: stats.size,
          duration: duration,
          speaker: segments[i].speaker_name || 'Unknown',
          text: segments[i].text.substring(0, 50) + '...',
        };

        segmentDetails.push(segmentInfo);
        audioFiles.push(segmentFile);

        // Update progress with segment details
        if (this.rebuildProgressCallback) {
          this.rebuildProgressCallback({
            segments: [...segmentDetails],
            newSegment: segmentInfo,
          });
        }
      } catch {
        throw new Error(
          `Missing segment file: ${path.basename(segmentFile)}. Generate segments first.`
        );
      }

      // Add pause file if not last segment
      if (i < segments.length - 1) {
        const pauseFile = path.join(
          segmentsDir,
          `pause_${i.toString().padStart(3, '0')}.mp3`
        );
        try {
          await fs.access(pauseFile);
          audioFiles.push(pauseFile);
        } catch {
          // Pause file missing, create it
          const segment = segments[i];
          const nextSegment = segments[i + 1];
          let pauseDuration = 300;

          if (segment.speaker_id !== nextSegment.speaker_id) {
            pauseDuration = 500;
          }

          if (segment.type === 'dialogue' && nextSegment.type === 'narration') {
            pauseDuration = 750;
          }

          // Special pause for AI Announcer segments
          if (
            segment.speaker_id === 'ai_announcer' ||
            nextSegment.speaker_id === 'ai_announcer'
          ) {
            pauseDuration = 1000;
          }

          await this.createSilence(pauseDuration, pauseFile);
          audioFiles.push(pauseFile);
        }
      }
    }

    // Add "End of Chapter" announcement with 2-second pause before it
    this.log('Adding end of chapter announcement...');

    if (this.rebuildProgressCallback) {
      this.rebuildProgressCallback({
        status: 'processing',
        phase: 'end_chapter',
        message: 'Adding end of chapter announcement...',
      });
    }

    // Create 2-second pause before "End of Chapter"
    const endPauseFile = path.join(segmentsDir, `end_pause.mp3`);
    try {
      await fs.access(endPauseFile);
    } catch {
      await this.createSilence(2000, endPauseFile);
    }
    audioFiles.push(endPauseFile);

    // Use existing or generate "End of Chapter" audio
    const endChapterFile = path.join(segmentsDir, `end_chapter.mp3`);
    try {
      await fs.access(endChapterFile);
    } catch {
      // Find narrator voice from segments
      const narratorSegment = segments.find(
        (s) => s.speaker_id === 'narrator' || s.speaker_name === 'narrator'
      );
      const narratorVoiceId = narratorSegment?.voice_id || 'nova';
      const narratorVoice = (await this.db.getVoice(narratorVoiceId)) || {
        id: 'nova',
        name: 'Nova (Narrator)',
        provider: 'openai',
        settings: {},
      };
      await this.generateSpeechSegment(
        'End of Chapter',
        narratorVoice,
        endChapterFile
      );
    }
    audioFiles.push(endChapterFile);

    // Add 2-second pause after "End of Chapter"
    const afterEndPauseFile = path.join(segmentsDir, `after_end_pause.mp3`);
    try {
      await fs.access(afterEndPauseFile);
    } catch {
      await this.createSilence(2000, afterEndPauseFile);
    }
    audioFiles.push(afterEndPauseFile);

    // Concatenate all audio files with progress tracking
    this.log(`Concatenating ${audioFiles.length} audio files...`);

    if (this.rebuildProgressCallback) {
      this.rebuildProgressCallback({
        status: 'concatenating',
        phase: 'ffmpeg',
        message: `Concatenating ${audioFiles.length} audio files with ffmpeg...`,
        ffmpegOutput: [],
      });
    }

    await this.concatenateAudioWithProgress(audioFiles, outputFile);

    // Get audio duration and file size
    if (this.rebuildProgressCallback) {
      this.rebuildProgressCallback({
        status: 'finalizing',
        phase: 'analyzing_output',
        message: 'Analyzing output file...',
      });
    }

    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputFile}"`
    );
    const durationSeconds = parseFloat(stdout.trim());

    const stats = await fs.stat(outputFile);
    const fileSize = stats.size;

    // Update database
    await this.db.run(
      `UPDATE chapters SET audio_duration = ?, audio_file_size = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [durationSeconds, fileSize, chapterId]
    );

    this.log(`✅ Rebuilt chapter ${chapterId}`);
    this.log(`   Duration: ${Math.round(durationSeconds)}s`);
    this.log(`   File size: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);

    if (this.rebuildProgressCallback) {
      this.rebuildProgressCallback({
        status: 'completed',
        phase: 'done',
        message: `Rebuilt chapter successfully - Duration: ${Math.round(durationSeconds)}s, Size: ${(fileSize / 1024 / 1024).toFixed(1)}MB`,
        totalDuration: durationSeconds,
        fileSize: fileSize,
      });
    }

    return outputFile;
  }

  async debugMergeChapter(chapterId) {
    this.log(`🔍 Debug merging chapter ${chapterId}...`);

    const segments = await this.db.getChapterSegments(chapterId);
    if (segments.length === 0) {
      throw new Error(`No segments found for chapter ${chapterId}`);
    }

    const segmentsDir = path.join(
      config.paths.output,
      'segments',
      chapterId.toString()
    );
    const outputFile = path.join(config.paths.output, `${chapterId}.mp3`);

    let debugOutput = '';
    debugOutput += `=== DEBUG MERGE CHAPTER ${chapterId} ===\n`;
    debugOutput += `Segments directory: ${segmentsDir}\n`;
    debugOutput += `Output file: ${outputFile}\n`;
    debugOutput += `Total segments: ${segments.length}\n\n`;

    // Build array of all audio files in order and validate each one
    const audioFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const segmentFile = path.join(
        segmentsDir,
        `segment_${i.toString().padStart(3, '0')}.mp3`
      );

      debugOutput += `--- Segment ${i} ---\n`;
      debugOutput += `File: ${path.basename(segmentFile)}\n`;
      debugOutput += `Text: "${segments[i].text.substring(0, 50)}..."\n`;
      debugOutput += `Speaker: ${segments[i].speaker_name || 'Unknown'}\n`;
      debugOutput += `Type: ${segments[i].type || 'Unknown'}\n`;

      // Check if segment exists and get detailed info
      try {
        const stats = await fs.stat(segmentFile);
        debugOutput += `Status: EXISTS\n`;
        debugOutput += `Size: ${stats.size} bytes (${(stats.size / 1024).toFixed(1)}KB)\n`;
        debugOutput += `Modified: ${stats.mtime}\n`;

        // Get audio duration and properties
        try {
          const { stdout: durationOutput } = await execAsync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${segmentFile}"`
          );
          const duration = parseFloat(durationOutput.trim());
          debugOutput += `Duration: ${duration.toFixed(2)}s\n`;

          // Get audio format info
          const { stdout: formatOutput } = await execAsync(
            `ffprobe -v quiet -show_entries format=bit_rate,size,format_name -of csv=p=0 "${segmentFile}"`
          );
          debugOutput += `Format info: ${formatOutput.trim()}\n`;

          // Check for audio issues
          const { stdout: audioCheck } = await execAsync(
            `ffprobe -v error -show_entries frame=best_effort_timestamp_time -of csv=p=0 "${segmentFile}" 2>&1 | head -5`
          );
          if (audioCheck.includes('error') || audioCheck.includes('corrupt')) {
            debugOutput += `⚠️  AUDIO ISSUES DETECTED: ${audioCheck}\n`;
          }
        } catch (probeError) {
          debugOutput += `⚠️  FFPROBE ERROR: ${probeError.message}\n`;
        }

        audioFiles.push(segmentFile);
      } catch {
        debugOutput += `❌ STATUS: MISSING\n`;
        throw new Error(
          `Missing segment file: ${path.basename(segmentFile)}. Generate segments first.`
        );
      }

      // Add pause file if not last segment
      if (i < segments.length - 1) {
        const pauseFile = path.join(
          segmentsDir,
          `pause_${i.toString().padStart(3, '0')}.mp3`
        );

        debugOutput += `Pause file: ${path.basename(pauseFile)}\n`;

        try {
          const pauseStats = await fs.stat(pauseFile);
          debugOutput += `Pause status: EXISTS (${pauseStats.size} bytes)\n`;
          audioFiles.push(pauseFile);
        } catch {
          // Pause file missing, create it
          const segment = segments[i];
          const nextSegment = segments[i + 1];
          let pauseDuration = 300;

          if (segment.speaker_id !== nextSegment.speaker_id) {
            pauseDuration = 500;
          }

          if (segment.type === 'dialogue' && nextSegment.type === 'narration') {
            pauseDuration = 750;
          }

          // Special pause for AI Announcer segments
          if (
            segment.speaker_id === 'ai_announcer' ||
            nextSegment.speaker_id === 'ai_announcer'
          ) {
            pauseDuration = 1000;
          }

          debugOutput += `Pause status: MISSING - Creating ${pauseDuration}ms pause\n`;
          await this.createSilence(pauseDuration, pauseFile);
          audioFiles.push(pauseFile);
        }
      }

      debugOutput += `\n`;
    }

    // Add "End of Chapter" announcement with 2-second pause before it
    debugOutput += `=== END OF CHAPTER FILES ===\n`;

    // Create 2-second pause before "End of Chapter"
    const endPauseFile = path.join(segmentsDir, `end_pause.mp3`);
    debugOutput += `End pause file: ${path.basename(endPauseFile)}\n`;
    try {
      const endPauseStats = await fs.stat(endPauseFile);
      debugOutput += `End pause status: EXISTS (${endPauseStats.size} bytes)\n`;
      audioFiles.push(endPauseFile);
    } catch {
      debugOutput += `End pause status: MISSING - Creating 2000ms pause\n`;
      await this.createSilence(2000, endPauseFile);
      audioFiles.push(endPauseFile);
    }

    // Use existing or generate "End of Chapter" audio
    const endChapterFile = path.join(segmentsDir, `end_chapter.mp3`);
    debugOutput += `End chapter file: ${path.basename(endChapterFile)}\n`;
    try {
      const endChapterStats = await fs.stat(endChapterFile);
      debugOutput += `End chapter status: EXISTS (${endChapterStats.size} bytes)\n`;
      audioFiles.push(endChapterFile);
    } catch {
      debugOutput += `End chapter status: MISSING - Generating...\n`;
      // Find narrator voice from segments
      const narratorSegment = segments.find(
        (s) => s.speaker_id === 'narrator' || s.speaker_name === 'narrator'
      );
      const narratorVoiceId = narratorSegment?.voice_id || 'nova';
      const narratorVoice = (await this.db.getVoice(narratorVoiceId)) || {
        id: 'nova',
        name: 'Nova (Narrator)',
        provider: 'openai',
        settings: {},
      };
      await this.generateSpeechSegment(
        'End of Chapter',
        narratorVoice,
        endChapterFile
      );
      audioFiles.push(endChapterFile);
    }

    // Add 2-second pause after "End of Chapter"
    const afterEndPauseFile = path.join(segmentsDir, `after_end_pause.mp3`);
    debugOutput += `After end pause file: ${path.basename(afterEndPauseFile)}\n`;
    try {
      const afterEndPauseStats = await fs.stat(afterEndPauseFile);
      debugOutput += `After end pause status: EXISTS (${afterEndPauseStats.size} bytes)\n`;
      audioFiles.push(afterEndPauseFile);
    } catch {
      debugOutput += `After end pause status: MISSING - Creating 2000ms pause\n`;
      await this.createSilence(2000, afterEndPauseFile);
      audioFiles.push(afterEndPauseFile);
    }

    debugOutput += `\n`;

    // Test concatenation with verbose output
    debugOutput += `=== CONCATENATION TEST ===\n`;
    debugOutput += `Total files to merge: ${audioFiles.length}\n`;
    debugOutput += `Files in order:\n`;

    for (let i = 0; i < audioFiles.length; i++) {
      debugOutput += `  ${i + 1}. ${path.basename(audioFiles[i])}\n`;
    }

    debugOutput += `\n=== FFMPEG MERGE COMMAND ===\n`;

    // Create file list for ffmpeg
    const fileListPath = path.join(segmentsDir, 'debug_filelist.txt');
    const fileListContent = audioFiles
      .map((f) => `file '${path.resolve(f)}'`)
      .join('\n');
    await fs.writeFile(fileListPath, fileListContent);

    debugOutput += `File list saved to: ${fileListPath}\n`;
    debugOutput += `File list contents:\n${fileListContent}\n\n`;

    // Run ffmpeg with forced resampling to handle format inconsistencies
    const tempFile = outputFile + '.temp.mp3';
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${fileListPath}" -ar 44100 -ac 1 -c:a libmp3lame -b:a 128k -y "${tempFile}"`;
    const normalizeCmd = `ffmpeg -i "${tempFile}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:a libmp3lame -b:a 128k -y "${outputFile}"`;

    debugOutput += `Commands:\n`;
    debugOutput += `1. Concatenate: ${concatCmd}\n`;
    debugOutput += `2. Normalize: ${normalizeCmd}\n\n`;
    debugOutput += `Note: Using two-pass approach to handle format inconsistencies\n\n`;

    try {
      // First pass
      const { stdout: stdout1, stderr: stderr1 } =
        await execAsyncLarge(concatCmd);
      debugOutput += `=== CONCATENATION OUTPUT ===\n`;
      debugOutput += `STDERR:\n${stderr1.slice(-2000)}\n\n`; // Last 2000 chars to avoid overflow

      // Second pass
      const { stdout: stdout2, stderr: stderr2 } =
        await execAsyncLarge(normalizeCmd);
      debugOutput += `=== NORMALIZATION OUTPUT ===\n`;
      debugOutput += `STDERR:\n${stderr2.slice(-2000)}\n\n`;

      // Clean up temp file
      await fs.unlink(tempFile).catch(() => {});

      // Verify output file
      const outputStats = await fs.stat(outputFile);
      debugOutput += `=== OUTPUT FILE VERIFICATION ===\n`;
      debugOutput += `Output file size: ${outputStats.size} bytes (${(outputStats.size / 1024 / 1024).toFixed(1)}MB)\n`;

      const { stdout: finalDuration } = await execAsync(
        `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputFile}"`
      );
      const duration = parseFloat(finalDuration.trim());
      debugOutput += `Final duration: ${duration.toFixed(2)}s\n`;

      // Check for gaps or issues in final file
      const { stdout: finalCheck } = await execAsync(
        `ffprobe -v error -show_entries packet=pts_time,dts_time -of csv=p=0 "${outputFile}" 2>&1 | head -10`
      );
      if (finalCheck.includes('error') || finalCheck.includes('corrupt')) {
        debugOutput += `⚠️  FINAL FILE ISSUES: ${finalCheck}\n`;
      } else {
        debugOutput += `✅ Final file appears healthy\n`;
      }

      debugOutput += `\n=== DEBUG COMPLETE ===\n`;
      debugOutput += `Chapter ${chapterId} debug merge completed successfully\n`;
    } catch (ffmpegError) {
      debugOutput += `❌ FFMPEG ERROR:\n${ffmpegError.message}\n`;
      throw new Error(`FFmpeg merge failed: ${ffmpegError.message}`);
    }

    return debugOutput;
  }

  async getChapterSegments(chapterId) {
    const segments = await this.db.getChapterSegments(chapterId);
    const segmentsDir = path.join(
      config.paths.output,
      'segments',
      chapterId.toString()
    );

    // Get chapter to check if we have a title segment
    const chapter = await this.db.getChapter(chapterId);
    const narratorSegment = segments.find(
      (s) => s.speaker_name === 'Narrator' || s.is_narrator === 1
    );

    // Check which segments exist on disk
    const segmentFiles = [];

    // If we have a narrator, check for title segment (segment_000.mp3)
    if (narratorSegment && chapter) {
      const titleSegmentFile = path.join(segmentsDir, 'segment_000.mp3');
      let titleExists = false;
      let titleStats = null;

      try {
        titleStats = await fs.stat(titleSegmentFile);
        titleExists = true;
      } catch {
        titleExists = false;
      }

      if (titleExists) {
        // Add the title segment info
        segmentFiles.push({
          index: 0,
          segment: {
            id: 0,
            chapter_id: chapterId,
            segment_index: -1,
            speaker_id: narratorSegment.speaker_id,
            speaker_name: narratorSegment.speaker_name,
            text: chapter.title,
            type: 'narration',
            voice_id: narratorSegment.voice_id,
            voice_name: narratorSegment.voice_name,
            is_narrator: narratorSegment.is_narrator,
          },
          file: titleSegmentFile,
          exists: true,
          size: titleStats ? titleStats.size : 0,
          modifiedAt: titleStats ? titleStats.mtime : null,
        });
      }
    }

    // Add all regular segments (shifted by 1 if we have a title)
    const hasTitle = segmentFiles.length > 0;
    for (let i = 0; i < segments.length; i++) {
      const fileIndex = hasTitle ? i + 1 : i;
      const segmentFile = path.join(
        segmentsDir,
        `segment_${fileIndex.toString().padStart(3, '0')}.mp3`
      );
      let exists = false;
      let stats = null;

      try {
        stats = await fs.stat(segmentFile);
        exists = true;
      } catch {
        exists = false;
      }

      segmentFiles.push({
        index: fileIndex,
        segment: segments[i],
        file: segmentFile,
        exists: exists,
        size: stats ? stats.size : 0,
        modifiedAt: stats ? stats.mtime : null,
      });
    }

    return segmentFiles;
  }

  async publishChapter(chapterId) {
    try {
      this.log(`📡 Publishing chapter ${chapterId}...`);

      // Generate updated RSS feed
      const rssGenerator = new RSSGenerator();
      await rssGenerator.generateFeed();
      await rssGenerator.generateEpisodeList();

      // Set up S3 sync
      const s3Sync = new S3Sync();
      s3Sync.server = this.server;

      // Sync the chapter's MP3 file
      const audioFile = path.join(config.paths.output, `${chapterId}.mp3`);
      const s3AudioPath = `${config.s3.prefix}audio/${chapterId}.mp3`;

      await s3Sync.copyFileToS3(audioFile, s3AudioPath);

      // Sync the updated feed files
      const feedFile = path.join(config.paths.public, 'feed.xml');
      const episodesFile = path.join(config.paths.public, 'episodes.json');

      await s3Sync.copyFileToS3(feedFile, `${config.s3.prefix}feed.xml`);
      await s3Sync.copyFileToS3(
        episodesFile,
        `${config.s3.prefix}episodes.json`
      );

      this.log(`✅ Published chapter ${chapterId} to S3`);
    } catch (error) {
      this.log(
        `❌ Failed to publish chapter ${chapterId}: ${error.message}`,
        'error'
      );
      throw error;
    }
  }

  async close() {
    await this.db.close();
  }
}

export { MultiVoiceTTSWorker };

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = new MultiVoiceTTSWorker();

  async function run() {
    try {
      await worker.init();

      if (process.argv[2]) {
        // Process specific chapter
        await worker.processChapter(process.argv[2]);
      } else {
        // Process all chapters
        await worker.processAllChapters();
      }
    } finally {
      await worker.close();
    }
  }

  run().catch(console.error);
}
