import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

const execAsync = promisify(exec);

class S3Sync {
  constructor() {
    this.server = null; // Set by API server for logging
  }
  
  log(message, level = 'info') {
    if (this.server) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }

  async syncDirectory(localDir, s3Path) {
    try {
      // Build the aws s3 sync command
      const s3Url = `s3://${config.s3.bucket}/${s3Path}`;
      const profileFlag = config.s3.profile ? `--profile ${config.s3.profile}` : '';
      
      // Common sync parameters
      const syncParams = [
        '--delete', // Remove files from S3 that don't exist locally
        '--exclude "*.DS_Store"', // Exclude Mac system files
        '--exclude "node_modules/*"', // Exclude node modules
        '--exclude ".git/*"', // Exclude git files
        '--exclude "segments/*"' // Don't sync individual segments
      ].join(' ');
      
      const command = `aws s3 sync ${localDir} ${s3Url} ${profileFlag} ${syncParams}`;
      
      this.log(`Syncing ${localDir} to ${s3Url}...`);
      
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('upload:')) {
        throw new Error(stderr);
      }
      
      // Count uploaded files from output
      const uploadCount = (stdout.match(/upload:/g) || []).length;
      this.log(`✓ Synced ${uploadCount} files to S3`);
      
      return { uploadCount, output: stdout };
      
    } catch (error) {
      this.log(`✗ S3 sync failed: ${error.message}`, 'error');
      throw error;
    }
  }

  async copyFileToS3(localFile, s3Path) {
    try {
      const s3Url = `s3://${config.s3.bucket}/${s3Path}`;
      const profileFlag = config.s3.profile ? `--profile ${config.s3.profile}` : '';
      
      const command = `aws s3 cp "${localFile}" "${s3Url}" ${profileFlag}`;
      
      this.log(`Copying ${path.basename(localFile)} to ${s3Path}...`);
      
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('upload:')) {
        throw new Error(stderr);
      }
      
      this.log(`✓ Uploaded: ${s3Path}`);
      
      return { output: stdout };
      
    } catch (error) {
      this.log(`✗ Failed to upload ${s3Path}: ${error.message}`, 'error');
      throw error;
    }
  }

  async syncPodcastFiles() {
    try {
      this.log('☁️ Starting podcast sync to S3...');
      
      // Sync the public directory (feed.xml, episodes.json, etc)
      this.log('📄 Syncing public files...');
      await this.syncDirectory(config.paths.public, config.s3.prefix);
      
      // Sync audio files separately to the audio/ subdirectory
      this.log('🎧 Syncing audio files...');
      const audioFiles = await fs.readdir(config.paths.output);
      const mp3Files = audioFiles.filter(file => file.endsWith('.mp3') && !file.startsWith('segment_'));
      
      this.log(`Found ${mp3Files.length} audio files to sync`);
      
      for (const mp3File of mp3Files) {
        const localPath = path.join(config.paths.output, mp3File);
        const s3Path = config.s3.prefix + 'audio/' + mp3File;
        
        await this.copyFileToS3(localPath, s3Path);
      }
      
      this.log(`✅ Podcast sync complete!`);
      this.log(`📡 Feed available at: https://www.porivo.com/${config.s3.prefix}feed.xml`);
      
    } catch (error) {
      this.log(`Failed to sync podcast files: ${error.message}`, 'error');
      throw error;
    }
  }

  async getPublicUrl(s3Key) {
    return `https://${config.s3.bucket}/${s3Key}`;
  }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const sync = new S3Sync();
  
  const command = process.argv[2] || 'sync';
  
  switch (command) {
    case 'sync':
      console.log('Starting S3 sync...');
      sync.syncPodcastFiles()
        .then(() => {
          console.log('✓ Podcast files synced to S3');
          console.log(`Feed URL: https://www.porivo.com/${config.s3.prefix}feed.xml`);
        })
        .catch(console.error);
      break;
      
    default:
      console.log('Usage: node s3-sync.js [sync]');
      break;
  }
}

export { S3Sync };