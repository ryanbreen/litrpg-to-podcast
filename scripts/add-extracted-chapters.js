#!/usr/bin/env node

import { Database } from '../src/shared/database.js';
import fs from 'fs';

async function addExistingChapters() {
  const db = new Database();
  await db.init();

  for (let i = 971; i <= 985; i++) {
    try {
      const data = JSON.parse(
        fs.readFileSync(`./public/data/chapter_${i}.json`, 'utf8')
      );
      await db.upsertChapter(data);
      console.log(`✅ Added chapter ${i} to database: ${data.title}`);
    } catch (error) {
      console.log(`❌ Chapter ${i} not found or error: ${error.message}`);
    }
  }

  await db.close();
  console.log('🎉 Finished adding extracted chapters to database');
}

addExistingChapters();
