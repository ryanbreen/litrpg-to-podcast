import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    // Ensure database directory exists
    const dbDir = path.dirname(config.database.path);
    await fs.mkdir(dbDir, { recursive: true });

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(config.database.path, (err) => {
        if (err) {
          reject(err);
        } else {
          this.setupTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async setupTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        error_message TEXT,
        metadata TEXT
      )`,
      
      `CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        content_hash TEXT,
        scraped_at DATETIME,
        audio_duration REAL,
        audio_file_size INTEGER,
        processed_at DATETIME,
        listened_seconds REAL DEFAULT 0,
        speakers_identified_at DATETIME,
        metadata TEXT
      )`,

      `CREATE TABLE IF NOT EXISTS speakers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        voice_id TEXT,
        voice_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_narrator BOOLEAN DEFAULT 0
      )`,

      `CREATE TABLE IF NOT EXISTS chapter_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id TEXT NOT NULL,
        segment_index INTEGER NOT NULL,
        speaker_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'narration',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
        FOREIGN KEY (speaker_id) REFERENCES speakers(id)
      )`,
      
      // Voice library management
      `CREATE TABLE IF NOT EXISTS voices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'openai',
        type TEXT NOT NULL DEFAULT 'preset',
        settings TEXT,
        preview_text TEXT,
        preview_url TEXT,
        tags TEXT,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      
      `CREATE TABLE IF NOT EXISTS voice_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        voice_id TEXT NOT NULL,
        text TEXT NOT NULL,
        audio_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (voice_id) REFERENCES voices(id) ON DELETE CASCADE
      )`,
      
      `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_chapter_id ON jobs(chapter_id)`,
      `CREATE INDEX IF NOT EXISTS idx_chapters_processed ON chapters(processed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_speakers_name ON speakers(name)`,
      `CREATE INDEX IF NOT EXISTS idx_chapter_segments_chapter ON chapter_segments(chapter_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_chapter_segments_order ON chapter_segments(chapter_id, segment_index)`,
      `CREATE INDEX IF NOT EXISTS idx_voices_provider ON voices(provider)`,
      `CREATE INDEX IF NOT EXISTS idx_voices_type ON voices(type)`
    ];

    for (const sql of tables) {
      await this.run(sql);
    }
    
    // Insert default OpenAI voices if they don't exist
    const defaultVoices = [
      { id: 'alloy', name: 'Alloy', provider: 'openai', type: 'preset', tags: 'neutral,balanced' },
      { id: 'echo', name: 'Echo', provider: 'openai', type: 'preset', tags: 'male,warm' },
      { id: 'fable', name: 'Fable', provider: 'openai', type: 'preset', tags: 'male,british' },
      { id: 'onyx', name: 'Onyx', provider: 'openai', type: 'preset', tags: 'male,deep' },
      { id: 'nova', name: 'Nova', provider: 'openai', type: 'preset', tags: 'female,energetic' },
      { id: 'shimmer', name: 'Shimmer', provider: 'openai', type: 'preset', tags: 'female,soft' }
    ];
    
    for (const voice of defaultVoices) {
      await this.run(`
        INSERT OR IGNORE INTO voices (id, name, provider, type, tags)
        VALUES (?, ?, ?, ?, ?)
      `, [voice.id, voice.name, voice.provider, voice.type, voice.tags]);
    }
  }

  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }

  // Job management
  async createJob(chapterId, type, metadata = {}) {
    const sql = `
      INSERT OR REPLACE INTO jobs (chapter_id, type, status, metadata, updated_at)
      VALUES (?, ?, 'pending', ?, CURRENT_TIMESTAMP)
    `;
    
    return await this.run(sql, [chapterId, type, JSON.stringify(metadata)]);
  }

  async updateJobStatus(chapterId, type, status, errorMessage = null) {
    const sql = `
      UPDATE jobs 
      SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE chapter_id = ? AND type = ?
    `;
    
    return await this.run(sql, [status, errorMessage, chapterId, type]);
  }

  async getJob(chapterId, type) {
    const sql = `
      SELECT * FROM jobs 
      WHERE chapter_id = ? AND type = ?
    `;
    
    const job = await this.get(sql, [chapterId, type]);
    if (job && job.metadata) {
      job.metadata = JSON.parse(job.metadata);
    }
    return job;
  }

  async getJobs(status = null) {
    let sql = `SELECT * FROM jobs ORDER BY created_at DESC`;
    let params = [];
    
    if (status) {
      sql = `SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC`;
      params = [status];
    }
    
    const jobs = await this.all(sql, params);
    return jobs.map(job => {
      if (job.metadata) {
        job.metadata = JSON.parse(job.metadata);
      }
      return job;
    });
  }

  // Chapter management
  async upsertChapter(chapterData) {
    const sql = `
      INSERT OR REPLACE INTO chapters (
        id, title, url, content_hash, scraped_at, 
        audio_duration, audio_file_size, processed_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const contentHash = chapterData.content ? 
      (await import('crypto')).createHash('md5').update(chapterData.content).digest('hex') : null;
    
    return await this.run(sql, [
      chapterData.id,
      chapterData.title,
      chapterData.url,
      contentHash,
      chapterData.scrapedAt,
      chapterData.audio?.duration || null,
      chapterData.audio?.fileSize || null,
      chapterData.audio?.processedAt || null,
      JSON.stringify(chapterData)
    ]);
  }

  async getChapter(chapterId) {
    const sql = `SELECT * FROM chapters WHERE id = ?`;
    const chapter = await this.get(sql, [chapterId]);
    
    if (chapter && chapter.metadata) {
      chapter.metadata = JSON.parse(chapter.metadata);
    }
    
    return chapter;
  }

  async getChapters() {
    const sql = `SELECT * FROM chapters ORDER BY scraped_at DESC`;
    const chapters = await this.all(sql);
    
    return chapters.map(chapter => {
      if (chapter.metadata) {
        chapter.metadata = JSON.parse(chapter.metadata);
      }
      return chapter;
    });
  }

  async updateListeningPosition(chapterId, seconds) {
    const sql = `
      UPDATE chapters 
      SET listened_seconds = ?
      WHERE id = ?
    `;
    
    return await this.run(sql, [seconds, chapterId]);
  }

  // Stats and cleanup
  async getStats() {
    const stats = await Promise.all([
      this.get(`SELECT COUNT(*) as total FROM chapters`),
      this.get(`SELECT COUNT(*) as processed FROM chapters WHERE processed_at IS NOT NULL`),
      this.get(`SELECT COUNT(*) as pending FROM jobs WHERE status = 'pending'`),
      this.get(`SELECT COUNT(*) as running FROM jobs WHERE status = 'running'`),
      this.get(`SELECT SUM(audio_duration) as total_duration FROM chapters WHERE audio_duration IS NOT NULL`),
      this.get(`SELECT SUM(audio_file_size) as total_size FROM chapters WHERE audio_file_size IS NOT NULL`)
    ]);

    return {
      totalChapters: stats[0].total,
      processedChapters: stats[1].processed,
      pendingJobs: stats[2].pending,
      runningJobs: stats[3].running,
      totalDuration: stats[4].total_duration || 0,
      totalSize: stats[5].total_size || 0
    };
  }

  // Speaker management
  async getSpeaker(name) {
    const sql = `SELECT * FROM speakers WHERE name = ?`;
    return await this.get(sql, [name]);
  }

  async getAllSpeakers() {
    const sql = `SELECT * FROM speakers ORDER BY name`;
    return await this.all(sql);
  }

  async createSpeaker(name, isNarrator = false) {
    const sql = `
      INSERT INTO speakers (name, is_narrator)
      VALUES (?, ?)
    `;
    const result = await this.run(sql, [name, isNarrator ? 1 : 0]);
    return result.lastID;
  }

  async updateSpeakerVoice(speakerId, voiceId, voiceName) {
    const sql = `
      UPDATE speakers 
      SET voice_id = ?, voice_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    return await this.run(sql, [voiceId, voiceName, speakerId]);
  }

  async getOrCreateSpeaker(name, isNarrator = false) {
    let speaker = await this.getSpeaker(name);
    if (!speaker) {
      const speakerId = await this.createSpeaker(name, isNarrator);
      speaker = await this.get(`SELECT * FROM speakers WHERE id = ?`, [speakerId]);
    }
    return speaker;
  }

  // Chapter segments management
  async saveChapterSegments(chapterId, segments) {
    // Delete existing segments for this chapter
    await this.run(`DELETE FROM chapter_segments WHERE chapter_id = ?`, [chapterId]);
    
    // Insert new segments
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      // Map "unknown" speakers to "narrator"
      let speakerName = segment.speaker;
      if (speakerName === 'unknown') {
        speakerName = 'narrator';
      }
      
      // AI Announcer is a special type of narrator
      const isNarratorType = speakerName === 'narrator' || speakerName === 'ai_announcer';
      const speaker = await this.getOrCreateSpeaker(speakerName, isNarratorType);
      
      const sql = `
        INSERT INTO chapter_segments (chapter_id, segment_index, speaker_id, text, type)
        VALUES (?, ?, ?, ?, ?)
      `;
      await this.run(sql, [chapterId, i, speaker.id, segment.text, segment.type || 'narration']);
    }

    // Mark chapter as having speakers identified
    await this.run(
      `UPDATE chapters SET speakers_identified_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [chapterId]
    );
  }

  async getChapterSegments(chapterId) {
    const sql = `
      SELECT cs.*, s.name as speaker_name, s.voice_id, s.voice_name, s.is_narrator
      FROM chapter_segments cs
      JOIN speakers s ON cs.speaker_id = s.id
      WHERE cs.chapter_id = ?
      ORDER BY cs.segment_index
    `;
    return await this.all(sql, [chapterId]);
  }

  async mergeSpeakers(fromSpeakerId, toSpeakerId) {
    // Update all segments to use the target speaker
    await this.run(
      `UPDATE chapter_segments SET speaker_id = ? WHERE speaker_id = ?`,
      [toSpeakerId, fromSpeakerId]
    );
    
    // Delete the source speaker
    await this.run(`DELETE FROM speakers WHERE id = ?`, [fromSpeakerId]);
  }

  async getCharacterDashboard() {
    const sql = `
      SELECT 
        s.id as speaker_id,
        s.name as speaker_name,
        s.voice_id,
        s.voice_name,
        s.is_narrator,
        COUNT(DISTINCT cs.chapter_id) as chapter_count,
        COUNT(cs.id) as total_segments,
        GROUP_CONCAT(DISTINCT c.id) as chapter_ids,
        GROUP_CONCAT(DISTINCT c.title) as chapter_titles,
        MIN(c.scraped_at) as first_appearance,
        MAX(c.scraped_at) as last_appearance
      FROM speakers s
      LEFT JOIN chapter_segments cs ON s.id = cs.speaker_id
      LEFT JOIN chapters c ON cs.chapter_id = c.id
      GROUP BY s.id
      ORDER BY chapter_count DESC, total_segments DESC
    `;
    
    const results = await this.all(sql);
    
    return results.map(row => ({
      ...row,
      chapter_ids: row.chapter_ids ? row.chapter_ids.split(',') : [],
      chapter_titles: row.chapter_titles ? row.chapter_titles.split(',') : []
    }));
  }

  async getChaptersAffectedByVoiceChange(speakerId) {
    const sql = `
      SELECT DISTINCT c.id, c.title, c.processed_at
      FROM chapters c
      JOIN chapter_segments cs ON c.id = cs.chapter_id
      WHERE cs.speaker_id = ? AND c.processed_at IS NOT NULL
      ORDER BY c.scraped_at DESC
    `;
    
    return await this.all(sql, [speakerId]);
  }
  
  async deleteSpeaker(speakerId, force = false) {
    if (force) {
      // Delete all segments for this speaker first
      await this.run(`DELETE FROM chapter_segments WHERE speaker_id = ?`, [speakerId]);
    }
    
    // Delete the speaker
    await this.run(`DELETE FROM speakers WHERE id = ?`, [speakerId]);
  }
  
  async getSpeakerSegmentCount(speakerId) {
    const result = await this.get(
      `SELECT COUNT(*) as count FROM chapter_segments WHERE speaker_id = ?`,
      [speakerId]
    );
    return result.count;
  }

  // Voice library management
  async getAllVoices() {
    const sql = `SELECT * FROM voices WHERE is_active = 1 ORDER BY provider, name`;
    return await this.all(sql);
  }

  async getVoice(voiceId) {
    const sql = `SELECT * FROM voices WHERE id = ?`;
    const voice = await this.get(sql, [voiceId]);
    if (voice && voice.settings) {
      voice.settings = JSON.parse(voice.settings);
    }
    return voice;
  }

  async createVoice(voiceData) {
    // First check if this voice ID already exists (soft-deleted)
    const existingVoice = await this.get(
      'SELECT * FROM voices WHERE id = ?', 
      [voiceData.id]
    );
    
    if (existingVoice) {
      // Voice exists but is soft-deleted, reactivate it with new data
      const sql = `
        UPDATE voices 
        SET name = ?, provider = ?, type = ?, settings = ?, tags = ?, 
            is_active = 1, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;
      
      return await this.run(sql, [
        voiceData.name,
        voiceData.provider || 'custom',
        voiceData.type || 'custom',
        JSON.stringify(voiceData.settings || {}),
        voiceData.tags || '',
        voiceData.id
      ]);
    } else {
      // Voice doesn't exist, create new one
      const sql = `
        INSERT INTO voices (id, name, provider, type, settings, tags)
        VALUES (?, ?, ?, ?, ?, ?)
      `;
      
      return await this.run(sql, [
        voiceData.id,
        voiceData.name,
        voiceData.provider || 'custom',
        voiceData.type || 'custom',
        JSON.stringify(voiceData.settings || {}),
        voiceData.tags || ''
      ]);
    }
  }

  async updateVoice(voiceId, updates) {
    const fields = [];
    const values = [];
    
    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.settings !== undefined) {
      fields.push('settings = ?');
      values.push(JSON.stringify(updates.settings));
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      values.push(updates.tags);
    }
    if (updates.preview_url !== undefined) {
      fields.push('preview_url = ?');
      values.push(updates.preview_url);
    }
    
    values.push(voiceId);
    
    const sql = `UPDATE voices SET ${fields.join(', ')} WHERE id = ?`;
    return await this.run(sql, values);
  }

  async deleteVoice(voiceId) {
    // Don't actually delete, just deactivate
    const sql = `UPDATE voices SET is_active = 0 WHERE id = ? AND type = 'custom'`;
    return await this.run(sql, [voiceId]);
  }

  async saveVoiceSample(voiceId, text, audioUrl) {
    const sql = `
      INSERT INTO voice_samples (voice_id, text, audio_url)
      VALUES (?, ?, ?)
    `;
    return await this.run(sql, [voiceId, text, audioUrl]);
  }

  async getVoiceSamples(voiceId) {
    const sql = `
      SELECT * FROM voice_samples 
      WHERE voice_id = ? 
      ORDER BY created_at DESC
      LIMIT 10
    `;
    return await this.all(sql, [voiceId]);
  }

  async close() {
    if (this.db) {
      return new Promise((resolve) => {
        this.db.close(resolve);
      });
    }
  }
}

export { Database };