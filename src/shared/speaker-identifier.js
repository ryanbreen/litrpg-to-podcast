import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

/**
 * Deterministically splits prose into alternating dialogue / narration segments.
 * Dialogue is any run of text delimited by straight or curly double-quotes.
 * The function is whitespace-preserving and makes no speaker judgements.
 */
export function splitDialogueNarration(passage) {
  const segments = [];
  let start = 0;
  let inQuote = false;
  // Check for both straight quotes and curly quotes (open and close)
  // Straight quote ("), curly open ("), curly close (")
  const isQuote = c => c === '"' || c === String.fromCharCode(8220) || c === String.fromCharCode(8221);

  for (let i = 0; i < passage.length; i += 1) {
    if (isQuote(passage[i])) {
      if (!inQuote && i > start) {
        segments.push({ type: 'narration', text: passage.slice(start, i) });
        start = i;
      }
      inQuote = !inQuote;
      if (!inQuote) {
        // we just closed a quote
        segments.push({ type: 'dialogue', text: passage.slice(start, i + 1) });
        start = i + 1;
      }
    }
  }
  if (start < passage.length) {
    segments.push({ type: inQuote ? 'dialogue' : 'narration', text: passage.slice(start) });
  }
  return segments.filter(s => s.text.trim() !== '');
}

class SpeakerIdentifier {
  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey
    });
    this.server = null; // Set by API server for logging
    
    // Special pause marker for TTS processing
    this.pauseMarker = '<pause3s>';
    
    // Initialize config - will be loaded from file
    this.pronunciationDict = {};
    this.characterAliases = {};
    
    // Load configuration
    this.loadCharacterConfig();
  }
  
  async loadCharacterConfig() {
    try {
      const configPath = path.join(process.cwd(), 'character-config.json');
      const configData = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configData);
      
      // Load pronunciations with case variations
      this.pronunciationDict = {};
      for (const [word, pronunciation] of Object.entries(config.pronunciations || {})) {
        this.pronunciationDict[word] = pronunciation;
        this.pronunciationDict[word.toLowerCase()] = pronunciation;
        this.pronunciationDict[word.toUpperCase()] = pronunciation;
        this.pronunciationDict[word.charAt(0).toUpperCase() + word.slice(1)] = pronunciation;
      }
      
      // Load character aliases
      this.characterAliases = config.characterAliases || {};
      
      this.log(`📚 Loaded character config: ${Object.keys(this.characterAliases).length} characters, ${Object.keys(config.pronunciations || {}).length} pronunciations`);
      
    } catch (error) {
      // Use fallback configuration if file doesn't exist
      this.pronunciationDict = {
        'lvl': 'level',
        'LVL': 'level',
        'Lvl': 'level',
        'malefic': 'muh-lef-ik',
        'Malefic': 'muh-lef-ik',
        'MALEFIC': 'muh-lef-ik'
      };
      
      this.characterAliases = {
        'Vilastromoz': {
          aliases: ['Villy', 'the Malefic Viper', 'Vilas', 'Malefic Viper'],
          description: 'Ancient Primordial, appears as both snake and humanoid form'
        }
      };
      
      this.log(`⚠️ Could not load character-config.json, using fallback configuration: ${error.message}`);
    }
  }
  
  log(message, level = 'info') {
    if (this.server) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }
  
  // Preprocess text for pronunciation and special markers
  preprocessText(text) {
    let processed = text;
    
    // Replace pronunciation dictionary entries
    for (const [original, replacement] of Object.entries(this.pronunciationDict)) {
      // Use word boundary regex to avoid partial replacements
      const regex = new RegExp(`\\b${original}\\b`, 'g');
      processed = processed.replace(regex, replacement);
    }
    
    // Replace standalone "--" lines with pause markers
    // Match lines that contain only "--" with optional whitespace
    processed = processed.replace(/^\s*--\s*$/gm, this.pauseMarker);
    
    return processed;
  }
  
  // Check if a line should be AI Announcer voice
  isAIAnnouncer(text) {
    const trimmed = text.trim();
    
    // Check if text is in brackets [like this]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return true;
    }
    
    // Check if text starts with DING!
    if (trimmed.startsWith('DING!')) {
      return true;
    }
    
    return false;
  }
  
  // Check if text is just "DING!" (for sound effect)
  isDingSound(text) {
    const trimmed = text.trim();
    return trimmed === 'DING!' || trimmed === 'Ding!' || trimmed === 'ding!';
  }
  
  // Generate character alias context for GPT
  generateCharacterContext() {
    let context = '';
    
    if (Object.keys(this.characterAliases).length > 0) {
      context += '\n\nIMPORTANT CHARACTER ALIASES:\n';
      
      for (const [mainName, data] of Object.entries(this.characterAliases)) {
        context += `- ${mainName} (${data.description})\n`;
        context += `  Also known as: ${data.aliases.join(', ')}\n`;
        context += `  Use "${mainName}" as the consistent speaker name for all these aliases.\n\n`;
      }
    }
    
    return context;
  }
  
  // Split text into chunks for incremental processing
  chunkText(text, maxChunkSize = 8000) {
    const chunks = [];
    const paragraphs = text.split('\n\n');
    
    let currentChunk = '';
    let currentChunkSize = 0;
    
    for (const paragraph of paragraphs) {
      const paragraphSize = paragraph.length + 2; // +2 for the \n\n
      
      // If adding this paragraph would exceed chunk size and we have content
      if (currentChunkSize + paragraphSize > maxChunkSize && currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
        currentChunkSize = paragraphSize;
      } else {
        if (currentChunk) {
          currentChunk += '\n\n' + paragraph;
          currentChunkSize += paragraphSize;
        } else {
          currentChunk = paragraph;
          currentChunkSize = paragraphSize;
        }
      }
    }
    
    // Add the last chunk if it has content
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }

  async identifySpeakers(chapterText, knownSpeakers = [], progressCallback = null) {
    // Preprocess the text before sending to OpenAI
    const preprocessedText = this.preprocessText(chapterText);
    this.log(`📝 Preprocessing applied pronunciation dictionary and pause markers`);
    
    // Split into chunks for incremental processing
    const chunks = this.chunkText(preprocessedText);
    this.log(`📦 Split text into ${chunks.length} chunks for processing`);
    
    if (progressCallback) {
      progressCallback({
        phase: 'analyzing',
        message: `Processing ${chunks.length} chunks with GPT-4...`,
        currentChunk: 0,
        totalChunks: chunks.length
      });
    }
    
    const knownCharacters = knownSpeakers
      .filter(s => !s.is_narrator)
      .map(s => s.name)
      .join(', ');

    const characterContext = this.generateCharacterContext();
    
    const systemPrompt = `You are a dialogue attribution specialist. Your task is to split a story text into segments by speaker.

Known characters from previous chapters: ${knownCharacters || 'None yet'}${characterContext}

Return JSON with this exact structure:
{
  "segments": [
    {
      "speaker": "narrator",
      "text": "exact text segment including all whitespace and newlines",
      "type": "narration"
    },
    {
      "speaker": "Jake",
      "text": "\"Hey,\" Jake said. \"How are you?\"",
      "type": "dialogue"
    }
  ]
}

CRITICAL RULES:
1. PRESERVE EVERY CHARACTER: Every single character, word, space, newline, and punctuation mark from the input must appear in exactly one segment
2. NEVER drop attribution phrases like "he said", "she replied" - include the ENTIRE sentence/paragraph with the dialogue
3. Include quotation marks with dialogue - don't separate them
4. When dialogue appears mid-sentence (like: "Hello," she said, "how are you?"), keep the ENTIRE sentence together
5. Use "narrator" for all non-dialogue text (descriptions, actions, thoughts)
6. Only use character names as speaker when they have dialogue in that segment
7. For character aliases (Villy = Vilastromoz), always use the main name
8. Types: "narration" (default), "dialogue", "thought"
9. Preserve ALL whitespace including newlines and indentation
10. CRITICAL: The character only speaks the words INSIDE quotation marks. Everything outside quotes is narration.
11. CRITICAL: When a dialogue line ends with closing quotes, the speaker STOPS speaking. Any text after quotes is narrator.

DIALOGUE ATTRIBUTION EXAMPLES:
- "Hello," Jake said. → speaker: "Jake", text includes the whole sentence
- Jake looked around. "Hello," he said. → speaker: "Jake", text includes both sentences
- "Hello," said Jake, walking in. → speaker: "Jake", text includes the whole sentence
- "Hello," Jake said. He walked away. → TWO segments: 1) speaker: "Jake" with "Hello," Jake said. 2) speaker: "narrator" with He walked away.
- Jake nodded. "Yes," he said. Then he left. → TWO segments: 1) speaker: "Jake" with Jake nodded. "Yes," he said. 2) speaker: "narrator" with Then he left.

CRITICAL MULTI-QUOTE EXAMPLES - THESE MUST BE SPLIT:
1. "It won't!" the mage slammed his hand on the table. "Eleven Primas are coming!" 
   MUST BE THREE SEGMENTS:
   - speaker: "mage" → "It won't!"
   - speaker: "narrator" → the mage slammed his hand on the table.
   - speaker: "mage" → "Eleven Primas are coming!"

2. "Hello," she said, turning away. "Goodbye."
   MUST BE THREE SEGMENTS:
   - speaker: "[character]" → "Hello," she said,
   - speaker: "narrator" → turning away.
   - speaker: "[character]" → "Goodbye."

3. "Stop!" Jake yelled. He ran forward. "Wait for me!"
   MUST BE THREE SEGMENTS:
   - speaker: "Jake" → "Stop!" Jake yelled.
   - speaker: "narrator" → He ran forward.
   - speaker: "Jake" → "Wait for me!"

ABSOLUTE SPLITTING RULES - NO EXCEPTIONS:
1. A character segment can contain ONLY ONE continuous quote with its attribution
2. If you see: [quote][non-quote text][quote] = ALWAYS 3+ segments
3. Split at EVERY transition between quoted and non-quoted text
4. "Quote 1" [any text] "Quote 2" = MINIMUM 3 segments, even if same speaker
5. The pattern "!" [action]. " is ALWAYS a segment boundary

ENFORCEMENT:
- When you encounter text like: "X" Y. "Z"
- This is NEVER one segment
- This is ALWAYS: segment 1 (X), segment 2 (Y.), segment 3 (Z)
- Even if X and Z are the same character speaking

Be conservative - when in doubt, split into more segments rather than risk wrong attribution.`;

    try {
      const allSegments = [];
      
      // Process each chunk incrementally
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        
        if (progressCallback) {
          progressCallback({
            phase: 'analyzing',
            message: `Processing chunk ${chunkIndex + 1} of ${chunks.length}...`,
            currentChunk: chunkIndex,
            totalChunks: chunks.length
          });
        }
        
        this.log(`🔄 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars)`);
        
        const response = await this.openai.chat.completions.create({
          model: "gpt-4-turbo-2024-04-09",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: chunk
            }
          ],
          temperature: 0.1, // Lower temperature for more consistent results
          stream: true // Enable streaming for real-time progress
        });

        // Handle streaming response
        let streamedContent = '';
        let segmentCount = 0;
        let lastParsedSegments = [];
        
        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta?.content || '';
          streamedContent += delta;
          
          // Try to parse complete segments as they appear in the stream
          try {
            // Look for complete segments in the streamed content
            const segmentMatches = streamedContent.match(/"speaker":\s*"[^"]*",\s*"text":\s*"[^"]*",\s*"type":\s*"[^"]*"/g);
            
            if (segmentMatches && segmentMatches.length > lastParsedSegments.length) {
              // New segments found - try to parse them
              const newSegmentCount = segmentMatches.length;
              
              // Try to extract just the new segments
              for (let i = lastParsedSegments.length; i < newSegmentCount; i++) {
                try {
                  // Build a partial JSON to parse individual segments
                  const segmentMatch = segmentMatches[i];
                  const segmentJson = `{${segmentMatch}}`;
                  const parsedSegment = JSON.parse(segmentJson);
                  
                  // Check if this should be AI Announcer
                  if (parsedSegment.speaker === 'narrator' && this.isAIAnnouncer(parsedSegment.text)) {
                    parsedSegment.speaker = 'ai_announcer';
                    parsedSegment.type = 'announcement';
                    
                    // Special case for DING! sound effect
                    if (this.isDingSound(parsedSegment.text)) {
                      parsedSegment.type = 'sound_effect';
                      parsedSegment.sound = 'ding';
                    }
                  }
                  
                  lastParsedSegments.push(parsedSegment);
                  
                  // Stream this segment back immediately
                  if (progressCallback) {
                    progressCallback({
                      phase: 'streaming',
                      message: `Chunk ${chunkIndex + 1}/${chunks.length}: Streaming segment ${i + 1}...`,
                      currentChunk: chunkIndex,
                      totalChunks: chunks.length,
                      chunkSegments: i + 1,
                      newSegment: parsedSegment
                    });
                  }
                  
                } catch (parseError) {
                  // Skip if segment isn't complete yet
                }
              }
            }
          } catch (parseError) {
            // Continue streaming - JSON might not be complete yet
          }
          
          // Update general progress
          const segmentMatches = streamedContent.match(/"speaker":/g);
          const currentSegmentCount = segmentMatches ? segmentMatches.length : 0;
          
          if (currentSegmentCount > segmentCount) {
            segmentCount = currentSegmentCount;
            if (progressCallback && lastParsedSegments.length === 0) {
              progressCallback({
                phase: 'analyzing',
                message: `Chunk ${chunkIndex + 1}/${chunks.length}: Processing segment ${segmentCount}...`,
                currentChunk: chunkIndex,
                totalChunks: chunks.length,
                chunkSegments: segmentCount
              });
            }
          }
        }
        
        const result = JSON.parse(streamedContent);
        
        // Validate the response
        if (!result.segments || !Array.isArray(result.segments)) {
          throw new Error(`Invalid response format for chunk ${chunkIndex}: missing segments array`);
        }

        // Validate each segment and check for AI Announcer
        for (let i = 0; i < result.segments.length; i++) {
          const segment = result.segments[i];
          if (!segment.speaker || !segment.text) {
            throw new Error(`Invalid segment ${i} in chunk ${chunkIndex}: missing speaker or text`);
          }
          if (!segment.type) {
            segment.type = 'narration'; // Default type
          }
          
          // Check if this should be AI Announcer
          if (segment.speaker === 'narrator' && this.isAIAnnouncer(segment.text)) {
            segment.speaker = 'ai_announcer';
            segment.type = 'announcement';
            
            // Special case for DING! sound effect
            if (this.isDingSound(segment.text)) {
              segment.type = 'sound_effect';
              segment.sound = 'ding';
              this.log(`🔔 Identified DING! sound effect`);
            } else {
              this.log(`🤖 Identified AI Announcer segment: "${segment.text.substring(0, 50)}..."`);
            }
          }
        }

        // Add chunks segments to the overall collection
        allSegments.push(...result.segments);
        
        // Brief pause between chunks to avoid rate limiting
        if (chunkIndex < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Verify all text is accounted for (compare with preprocessed text)
      const reconstructedText = allSegments.map(s => s.text).join('');
      const preprocessedNormalized = preprocessedText.replace(/\s+/g, ' ').trim();
      const reconstructedTextNormalized = reconstructedText.replace(/\s+/g, ' ').trim();
      
      if (preprocessedNormalized !== reconstructedTextNormalized) {
        console.warn('Text reconstruction mismatch - some text may be missing or altered');
        console.log('Preprocessed length:', preprocessedNormalized.length);
        console.log('Reconstructed length:', reconstructedTextNormalized.length);
      }

      return allSegments;

    } catch (error) {
      console.error('OpenAI speaker identification failed:', error);
      
      // Fallback: return entire text as narrator
      const fallbackText = this.preprocessText(chapterText);
      return [{
        speaker: 'narrator',
        text: fallbackText,
        type: 'narration'
      }];
    }
  }

  async identifySpeakersTwoStage(chapterText, knownSpeakers = [], progressCallback = null) {
    // Step 1: Preprocess the text
    const preprocessedText = this.preprocessText(chapterText);
    this.log(`📝 Preprocessing applied pronunciation dictionary and pause markers`);
    
    // Step 2: Deterministic segmentation
    this.log(`✂️ Starting deterministic quote segmentation...`);
    const rawSegments = splitDialogueNarration(preprocessedText);
    this.log(`📊 Split into ${rawSegments.length} segments (dialogue/narration)`)
    
    if (progressCallback) {
      progressCallback({
        phase: 'segmenting',
        message: `Split text into ${rawSegments.length} segments`,
        totalSegments: rawSegments.length
      });
    }
    
    // Step 3: Prepare for attribution
    const knownCharacters = knownSpeakers
      .filter(s => !s.is_narrator)
      .map(s => s.name)
      .join(', ');
    
    const characterContext = this.generateCharacterContext();
    
    // Simpler prompt for attribution only
    const systemPrompt = `You are a dialogue attribution specialist. You will be given pre-segmented text where dialogue and narration are already separated.

Known characters from previous chapters: ${knownCharacters || 'None yet'}${characterContext}

Your task is to:
1. For dialogue segments: identify the speaking character based on context
2. For narration segments: confirm they should be attributed to "narrator"
3. Identify special cases like AI announcements or sound effects

Return JSON with this structure:
{
  "segments": [
    {
      "speaker": "character_name_or_narrator",
      "text": "the exact text provided",
      "type": "dialogue/narration/announcement/thought"
    }
  ]
}

RULES:
- Use character names exactly as they appear in the known characters list
- For character aliases (e.g., Villy = Vilastromoz), use the main name
- If speaker is unclear from context, use "unknown"
- Preserve the exact text without modification`;

    try {
      const attributedSegments = [];
      const batchSize = 20; // Process segments in batches
      
      for (let i = 0; i < rawSegments.length; i += batchSize) {
        const batch = rawSegments.slice(i, Math.min(i + batchSize, rawSegments.length));
        const batchIndex = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(rawSegments.length / batchSize);
        
        if (progressCallback) {
          progressCallback({
            phase: 'attributing',
            message: `Attributing speakers for batch ${batchIndex}/${totalBatches}...`,
            currentBatch: batchIndex,
            totalBatches: totalBatches,
            progress: Math.round((i / rawSegments.length) * 100)
          });
        }
        
        this.log(`🎭 Processing attribution batch ${batchIndex}/${totalBatches}`);
        
        // Create a simplified input for GPT
        const batchInput = batch.map((seg, idx) => ({
          index: i + idx,
          type: seg.type,
          text: seg.text
        }));
        
        const response = await this.openai.chat.completions.create({
          model: "gpt-4-turbo-2024-04-09",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: `Attribute speakers to these pre-segmented texts:\n\n${JSON.stringify(batchInput, null, 2)}`
            }
          ],
          temperature: 0.1
        });
        
        const result = JSON.parse(response.choices[0].message.content);
        
        // Process each attributed segment
        for (let j = 0; j < result.segments.length; j++) {
          const segment = result.segments[j];
          
          // Check for AI announcer and sound effects
          if (segment.speaker === 'narrator' && this.isAIAnnouncer(segment.text)) {
            segment.speaker = 'ai_announcer';
            segment.type = 'announcement';
            
            if (this.isDingSound(segment.text)) {
              segment.type = 'sound_effect';
              segment.sound = 'ding';
              this.log(`🔔 Identified DING! sound effect`);
            }
          }
          
          attributedSegments.push(segment);
        }
        
        // Brief pause between batches
        if (i + batchSize < rawSegments.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      if (progressCallback) {
        progressCallback({
          phase: 'complete',
          message: `Successfully identified ${attributedSegments.length} segments`,
          segments: attributedSegments.length
        });
      }
      
      this.log(`✅ Two-stage identification complete: ${attributedSegments.length} segments`);
      return attributedSegments;
      
    } catch (error) {
      console.error('Two-stage speaker identification failed:', error);
      
      // Fallback: return segments with default attribution
      return rawSegments.map(seg => ({
        speaker: seg.type === 'dialogue' ? 'unknown' : 'narrator',
        text: seg.text,
        type: seg.type
      }));
    }
  }

}

export { SpeakerIdentifier };