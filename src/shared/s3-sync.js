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
      
      // Common sync parameters with size and timestamp checking for efficiency
      const syncParams = [
        '--delete', // Remove files from S3 that don't exist locally
        '--size-only', // Only upload if size differs (faster than checksum)
        '--exclude "*.DS_Store"', // Exclude Mac system files
        '--exclude "node_modules/*"', // Exclude node modules
        '--exclude ".git/*"', // Exclude git files
        '--exclude "segments/*"' // Don't sync individual segments
      ].join(' ');
      
      const command = `aws s3 sync ${localDir} ${s3Url} ${profileFlag} ${syncParams}`;
      
      this.log(`Syncing ${localDir} to ${s3Url} (size-only comparison for efficiency)...`);
      
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

  async syncOnlyChangedFiles(localDir, s3Path) {
    try {
      const s3Url = `s3://${config.s3.bucket}/${s3Path}`;
      const profileFlag = config.s3.profile ? `--profile ${config.s3.profile}` : '';
      
      // Get list of files modified in the last hour (for new audio files)
      const cutoffTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const files = await fs.readdir(localDir);
      const changedFiles = [];
      
      for (const file of files) {
        if (file.endsWith('.mp3') || file.endsWith('.xml') || file.endsWith('.json')) {
          const filePath = path.join(localDir, file);
          try {
            const stats = await fs.stat(filePath);
            if (stats.mtime > cutoffTime) {
              changedFiles.push(file);
            }
          } catch (err) {
            // Skip files we can't stat
            continue;
          }
        }
      }
      
      if (changedFiles.length === 0) {
        this.log('No recently changed files to sync');
        return { uploadCount: 0, output: 'No files to sync' };
      }
      
      this.log(`Found ${changedFiles.length} recently changed files: ${changedFiles.join(', ')}`);
      
      // Sync only the changed files
      let totalUploaded = 0;
      let allOutput = '';
      
      for (const file of changedFiles) {
        const localFile = path.join(localDir, file);
        const s3File = `${s3Url}/${file}`;
        
        const command = `aws s3 cp "${localFile}" "${s3File}" ${profileFlag}`;
        this.log(`Uploading ${file}...`);
        
        try {
          const { stdout, stderr } = await execAsync(command);
          
          if (stderr && !stderr.includes('upload:')) {
            this.log(`Warning for ${file}: ${stderr}`, 'warning');
          }
          
          if (stdout.includes('upload:')) {
            totalUploaded++;
            this.log(`✓ Uploaded ${file}`);
          }
          
          allOutput += stdout;
        } catch (fileError) {
          this.log(`✗ Failed to upload ${file}: ${fileError.message}`, 'error');
        }
      }
      
      this.log(`✓ Synced ${totalUploaded} changed files to S3`);
      return { uploadCount: totalUploaded, output: allOutput };
      
    } catch (error) {
      this.log(`✗ Changed files sync failed: ${error.message}`, 'error');
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
      this.log('☁️ Starting optimized podcast sync to S3...');
      
      // Try the fast approach first: sync only recently changed files
      this.log('🚀 Checking for recently changed files...');
      const quickResult = await this.syncOnlyChangedFiles(config.paths.public, config.s3.prefix);
      
      if (quickResult.uploadCount > 0) {
        this.log(`✓ Quick sync completed: ${quickResult.uploadCount} files uploaded`);
        
        // Also sync any new audio files
        this.log('🎧 Checking for new audio files...');
        const audioResult = await this.syncOnlyChangedFiles(config.paths.output, config.s3.prefix + 'audio/');
        
        if (audioResult.uploadCount > 0) {
          this.log(`✓ Audio sync completed: ${audioResult.uploadCount} files uploaded`);
        }
        
        return {
          uploadCount: quickResult.uploadCount + audioResult.uploadCount,
          method: 'incremental'
        };
      }
      
      // Fallback: full sync if no recent changes (should be rare)
      this.log('📄 No recent changes found, performing full sync...');
      const fullResult = await this.syncDirectory(config.paths.public, config.s3.prefix);
      
      // Sync audio files separately to the audio/ subdirectory
      this.log('🎧 Syncing all audio files...');
      const audioFiles = await fs.readdir(config.paths.output);
      const mp3Files = audioFiles.filter(file => file.endsWith('.mp3') && !file.startsWith('segment_'));
      
      this.log(`Found ${mp3Files.length} audio files to check`);
      
      let audioUploads = 0;
      for (const mp3File of mp3Files) {
        const localPath = path.join(config.paths.output, mp3File);
        const s3Path = config.s3.prefix + 'audio/' + mp3File;
        
        try {
          await this.copyFileToS3(localPath, s3Path);
          audioUploads++;
        } catch (error) {
          // Continue with other files if one fails
          this.log(`Warning: Failed to upload ${mp3File}: ${error.message}`, 'warning');
        }
      }
      
      return {
        uploadCount: fullResult.uploadCount + audioUploads,
        method: 'full'
      };
      
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