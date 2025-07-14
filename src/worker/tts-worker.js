import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import config from '../shared/config.js';

const execAsync = promisify(exec);

class TTSWorker {
  constructor() {
    if (config.tts.provider === 'elevenlabs') {
      this.elevenlabs = new ElevenLabsClient({
        apiKey: config.elevenlabs.apiKey
      });
    } else {
      this.openai = new OpenAI({
        apiKey: config.openai.apiKey
      });
    }
  }

  chunkText(text, maxLength = config.tts.chunkSize) {
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length + 2 <= maxLength) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        
        if (paragraph.length <= maxLength) {
          currentChunk = paragraph;
        } else {
          // Split long paragraphs by sentences
          const sentences = paragraph.split(/[.!?]+\s/);
          currentChunk = '';
          
          for (const sentence of sentences) {
            if (currentChunk.length + sentence.length + 2 <= maxLength) {
              currentChunk += (currentChunk ? '. ' : '') + sentence;
            } else {
              if (currentChunk) {
                chunks.push(currentChunk + '.');
              }
              currentChunk = sentence;
            }
          }
        }
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  async generateSpeech(text, outputPath) {
    console.log(`Generating speech for chunk (${text.length} chars) using ${config.tts.provider}...`);
    
    if (config.tts.provider === 'elevenlabs') {
      const audio = await this.elevenlabs.generate({
        voice: config.elevenlabs.voiceId,
        text: text,
        model_id: "eleven_multilingual_v2"
      });
      
      const chunks = [];
      for await (const chunk of audio) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      await fs.writeFile(outputPath, buffer);
      
    } else {
      const mp3 = await this.openai.audio.speech.create({
        model: config.openai.model,
        voice: config.openai.voice,
        input: text,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      await fs.writeFile(outputPath, buffer);
    }
    
    return outputPath;
  }

  async createSilence(durationMs, outputPath) {
    const durationSec = durationMs / 1000;
    const command = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec} -q:a 9 -acodec libmp3lame "${outputPath}"`;
    
    await execAsync(command);
    return outputPath;
  }

  async concatenateAudio(inputFiles, outputPath) {
    // Create concat file list
    const concatFile = outputPath + '.concat.txt';
    const fileList = inputFiles.map(file => `file '${path.resolve(file)}'`).join('\n');
    await fs.writeFile(concatFile, fileList);

    try {
      const command = `ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`;
      await execAsync(command);
    } finally {
      // Clean up concat file
      await fs.unlink(concatFile).catch(() => {});
    }

    return outputPath;
  }

  async processChapter(chapterId) {
    const dataFile = path.join(config.paths.data, `${chapterId}.json`);
    const outputFile = path.join(config.paths.output, `${chapterId}.mp3`);
    
    // Check if already processed
    try {
      await fs.access(outputFile);
      console.log(`Audio already exists for chapter ${chapterId}`);
      return outputFile;
    } catch {
      // File doesn't exist, continue processing
    }

    // Load chapter data
    let chapterData;
    try {
      const data = await fs.readFile(dataFile, 'utf-8');
      chapterData = JSON.parse(data);
    } catch (error) {
      throw new Error(`Could not load chapter data: ${error.message}`);
    }

    console.log(`Processing TTS for: ${chapterData.title}`);
    
    // Create temporary directory for chunks
    const tempDir = path.join(config.paths.output, `temp_${chapterId}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const chunks = this.chunkText(chapterData.content);
      console.log(`Split into ${chunks.length} chunks`);

      const audioFiles = [];
      
      // Generate speech for each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunkFile = path.join(tempDir, `chunk_${i}.mp3`);
        await this.generateSpeech(chunks[i], chunkFile);
        audioFiles.push(chunkFile);

        // Add pause between chunks (except after last chunk)
        if (i < chunks.length - 1) {
          const pauseFile = path.join(tempDir, `pause_${i}.mp3`);
          await this.createSilence(config.tts.pauseMs, pauseFile);
          audioFiles.push(pauseFile);
        }

        console.log(`Completed chunk ${i + 1}/${chunks.length}`);
      }

      // Concatenate all audio files
      console.log('Concatenating audio files...');
      await this.concatenateAudio(audioFiles, outputFile);

      // Get audio duration for metadata
      const { stdout } = await execAsync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputFile}"`);
      const durationSeconds = parseFloat(stdout.trim());
      
      // Update chapter data with audio info
      chapterData.audio = {
        file: path.basename(outputFile),
        duration: durationSeconds,
        processedAt: new Date().toISOString()
      };
      
      await fs.writeFile(dataFile, JSON.stringify(chapterData, null, 2));
      
      console.log(`Completed TTS for ${chapterData.title} (${Math.round(durationSeconds)}s)`);
      
      return outputFile;

    } finally {
      // Clean up temporary files
      try {
        const tempFiles = await fs.readdir(tempDir);
        await Promise.all(tempFiles.map(file => 
          fs.unlink(path.join(tempDir, file)).catch(() => {})
        ));
        await fs.rmdir(tempDir);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async processAllChapters() {
    try {
      const dataFiles = await fs.readdir(config.paths.data);
      const jsonFiles = dataFiles.filter(file => file.endsWith('.json'));
      
      console.log(`Found ${jsonFiles.length} chapters to process`);
      
      for (const file of jsonFiles) {
        const chapterId = path.basename(file, '.json');
        try {
          await this.processChapter(chapterId);
        } catch (error) {
          console.error(`Failed to process chapter ${chapterId}:`, error.message);
        }
      }
      
      console.log('TTS processing complete');
      
    } catch (error) {
      console.error('Failed to process chapters:', error);
      throw error;
    }
  }
}

export { TTSWorker };

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = new TTSWorker();
  
  if (process.argv[2]) {
    // Process specific chapter
    worker.processChapter(process.argv[2]).catch(console.error);
  } else {
    // Process all chapters
    worker.processAllChapters().catch(console.error);
  }
}