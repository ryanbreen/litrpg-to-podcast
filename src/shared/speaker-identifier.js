import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

/**
 * Deterministically splits prose into alternating dialogue / narration segments.
 * Dialogue is any run of text delimited by straight or curly double-quotes.
 * The function is whitespace-preserving and makes no speaker judgements.
 * Attempts to detect "air quotes" and single-word quotes that are likely not dialogue.
 * Special quoted names (like monster "I") are kept in narration to avoid unnatural pauses.
 */
export function splitDialogueNarration(passage, specialQuotedNames = []) {
  const segments = [];
  let start = 0;
  let inQuote = false;
  // Check for both straight quotes and curly quotes (open and close)
  // Straight quote ("), curly open ("), curly close (")
  const isQuote = (c) =>
    c === '"' ||
    c === String.fromCharCode(8220) ||
    c === String.fromCharCode(8221);

  // First, split out any lines that start with 'DING!' or variations
  const lines = passage.split('\n');
  const processedLines = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Check if this line is a DING! notification
    if (
      trimmedLine.startsWith("'DING!'") ||
      trimmedLine.startsWith('DING!') ||
      trimmedLine.startsWith("'Ding!'") ||
      trimmedLine.startsWith('Ding!') ||
      trimmedLine.startsWith("'ding!'") ||
      trimmedLine.startsWith('ding!')
    ) {
      // Add what we have so far as a segment
      if (processedLines.length > 0) {
        const textSoFar = processedLines.join('\n');
        if (textSoFar.trim()) {
          // Process the text before the DING! line
          const beforeSegments = splitText(textSoFar);
          segments.push(...beforeSegments);
        }
        processedLines.length = 0;
      }
      // Add the DING! line as its own segment
      segments.push({ type: 'narration', text: line });
    } else {
      processedLines.push(line);
    }
  }

  // Process any remaining lines
  if (processedLines.length > 0) {
    const remainingText = processedLines.join('\n');
    if (remainingText.trim()) {
      const remainingSegments = splitText(remainingText);
      segments.push(...remainingSegments);
    }
  }

  // Check if a quoted segment contains only a special quoted name
  function isSpecialQuotedName(quotedText) {
    if (!specialQuotedNames || specialQuotedNames.length === 0) return false;

    // Remove surrounding quotes (straight and curly) and trim
    const innerText = quotedText
      .replace(/^["""]/, '') // Remove opening quote
      .replace(/["""]$/, '') // Remove closing quote
      .trim();

    // Check if this matches any special quoted names
    return specialQuotedNames.some((special) => special.name === innerText);
  }

  // Helper function to split text by quotes
  function splitText(text) {
    const textSegments = [];
    let textStart = 0;
    let textInQuote = false;

    for (let i = 0; i < text.length; i += 1) {
      if (isQuote(text[i])) {
        if (!textInQuote && i > textStart) {
          textSegments.push({
            type: 'narration',
            text: text.slice(textStart, i),
          });
          textStart = i;
        }
        textInQuote = !textInQuote;
        if (!textInQuote) {
          // we just closed a quote - check if it's a special quoted name
          const quotedSegment = text.slice(textStart, i + 1);

          if (isSpecialQuotedName(quotedSegment)) {
            // This is a special quoted name - merge it with the previous narration segment
            if (
              textSegments.length > 0 &&
              textSegments[textSegments.length - 1].type === 'narration'
            ) {
              // Append to previous narration segment
              textSegments[textSegments.length - 1].text += quotedSegment;
            } else {
              // Create new narration segment
              textSegments.push({
                type: 'narration',
                text: quotedSegment,
              });
            }
          } else {
            // Regular dialogue
            textSegments.push({
              type: 'dialogue',
              text: quotedSegment,
            });
          }
          textStart = i + 1;
        }
      }
    }
    if (textStart < text.length) {
      const remainingText = text.slice(textStart);
      if (textInQuote) {
        // Unclosed quote - treat as dialogue
        textSegments.push({
          type: 'dialogue',
          text: remainingText,
        });
      } else {
        // Regular narration
        if (
          textSegments.length > 0 &&
          textSegments[textSegments.length - 1].type === 'narration'
        ) {
          // Append to previous narration segment
          textSegments[textSegments.length - 1].text += remainingText;
        } else {
          textSegments.push({
            type: 'narration',
            text: remainingText,
          });
        }
      }
    }
    return textSegments;
  }

  return segments.filter((s) => s.text.trim() !== '');
}

class SpeakerIdentifier {
  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey,
    });
    this.server = null; // Set by API server for logging

    // Special pause marker for TTS processing
    this.pauseMarker = '<pause3s>';

    // Initialize config - will be loaded from file
    this.pronunciationDict = {};
    this.characterAliases = {};
    this.specialCases = {};

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
      for (const [word, pronunciation] of Object.entries(
        config.pronunciations || {}
      )) {
        this.pronunciationDict[word] = pronunciation;
        this.pronunciationDict[word.toLowerCase()] = pronunciation;
        this.pronunciationDict[word.toUpperCase()] = pronunciation;
        this.pronunciationDict[word.charAt(0).toUpperCase() + word.slice(1)] =
          pronunciation;
      }

      // Load character aliases
      this.characterAliases = config.characterAliases || {};

      // Load special cases
      this.specialCases = config.specialCases || {};

      this.log(
        `📚 Loaded character config: ${Object.keys(this.characterAliases).length} characters, ${Object.keys(config.pronunciations || {}).length} pronunciations, ${(this.specialCases.quotedNames || []).length} special cases`
      );
    } catch (error) {
      // Use fallback configuration if file doesn't exist
      this.pronunciationDict = {
        lvl: 'level',
        LVL: 'level',
        Lvl: 'level',
        malefic: 'muh-lef-ik',
        Malefic: 'muh-lef-ik',
        MALEFIC: 'muh-lef-ik',
      };

      this.characterAliases = {
        Vilastromoz: {
          aliases: ['Villy', 'the Malefic Viper', 'Vilas', 'Malefic Viper'],
          description:
            'Ancient Primordial, appears as both snake and humanoid form',
        },
      };

      this.log(
        `⚠️ Could not load character-config.json, using fallback configuration: ${error.message}`
      );
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
    for (const [original, replacement] of Object.entries(
      this.pronunciationDict
    )) {
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

  // Merge special quoted names with adjacent narration segments
  mergeSpecialQuotedNames(segments, specialQuotedNames) {
    if (!specialQuotedNames || specialQuotedNames.length === 0) {
      return segments;
    }

    const merged = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      // Check if this segment contains only a special quoted name
      if (this.isSpecialQuotedNameSegment(segment, specialQuotedNames)) {
        this.log(
          `🔗 Found special quoted name segment: "${segment.text.trim()}"`
        );

        // Try to merge with previous narration segment
        if (
          merged.length > 0 &&
          merged[merged.length - 1].type === 'narration'
        ) {
          merged[merged.length - 1].text += segment.text;
          this.log(`🔗 Merged with previous narration segment`);
          continue;
        }

        // Try to merge with next narration segment
        if (i + 1 < segments.length && segments[i + 1].type === 'narration') {
          const nextSegment = segments[i + 1];
          merged.push({
            type: 'narration',
            text: segment.text + nextSegment.text,
          });
          i++; // Skip the next segment since we merged it
          this.log(`🔗 Merged with next narration segment`);
          continue;
        }

        // If can't merge with adjacent narration, convert to narration
        merged.push({
          type: 'narration',
          text: segment.text,
        });
        this.log(`🔗 Converted to standalone narration segment`);
      } else {
        // Regular segment, add as-is
        merged.push(segment);
      }
    }

    return merged;
  }

  // Check if a segment contains only a special quoted name
  isSpecialQuotedNameSegment(segment, specialQuotedNames) {
    if (!segment) return false;

    // Remove surrounding quotes (straight and curly) and trim
    const innerText = segment.text
      .replace(/^["""]/, '') // Remove opening quote
      .replace(/["""]$/, '') // Remove closing quote
      .trim();

    // Check if this matches any special quoted names exactly
    const isSpecialName = specialQuotedNames.some(
      (special) => special.name === innerText
    );

    // Also check if the entire text (including quotes) is just a special quoted name
    const wholeText = segment.text.trim();
    const isQuotedSpecialName = specialQuotedNames.some(
      (special) =>
        wholeText === `"${special.name}"` || // Straight quotes
        wholeText === `"${special.name}"` || // Curly open/close quotes
        wholeText === `"${special.name}"` || // Mixed quotes
        wholeText === `"${special.name}"` // Other mixed quotes
    );

    // Debug logging
    if (wholeText === `"I"`) {
      this.log(`🐛 DEBUG: Found segment with text "${wholeText}"`);
      this.log(`🐛 DEBUG: innerText = "${innerText}"`);
      this.log(`🐛 DEBUG: isSpecialName = ${isSpecialName}`);
      this.log(`🐛 DEBUG: isQuotedSpecialName = ${isQuotedSpecialName}`);
      this.log(
        `🐛 DEBUG: specialQuotedNames = ${JSON.stringify(specialQuotedNames)}`
      );
    }

    return isSpecialName || isQuotedSpecialName;
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

    // Add special cases context
    if (
      this.specialCases.quotedNames &&
      this.specialCases.quotedNames.length > 0
    ) {
      context += '\n\nSPECIAL QUOTED NAMES:\n';

      for (const specialCase of this.specialCases.quotedNames) {
        context += `- "${specialCase.name}" is a being/monster name that always appears in quotes\n`;
        context += `  ${specialCase.note}\n`;
        context += `  When you see "${specialCase.name}" it should NOT be split as a separate dialogue segment\n\n`;
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
      if (
        currentChunkSize + paragraphSize > maxChunkSize &&
        currentChunk.trim()
      ) {
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

  async identifySpeakers(
    chapterText,
    knownSpeakers = [],
    progressCallback = null
  ) {
    // Preprocess the text before sending to OpenAI
    const preprocessedText = this.preprocessText(chapterText);
    this.log(
      `📝 Preprocessing applied pronunciation dictionary and pause markers`
    );

    // Split into chunks for incremental processing
    const chunks = this.chunkText(preprocessedText);
    this.log(`📦 Split text into ${chunks.length} chunks for processing`);

    if (progressCallback) {
      progressCallback({
        phase: 'analyzing',
        message: `Processing ${chunks.length} chunks with GPT-4...`,
        currentChunk: 0,
        totalChunks: chunks.length,
      });
    }

    const knownCharacters = knownSpeakers
      .filter((s) => !s.is_narrator)
      .map((s) => s.name)
      .join(', ');

    const characterContext = this.generateCharacterContext();

    const systemPrompt = `You are a dialogue attribution specialist analyzing fantasy/sci-fi literature.

Known characters from previous chapters: ${knownCharacters || 'None yet'}${characterContext}

Your task is to split text into speaker segments, identifying who speaks each piece of dialogue.

CRITICAL: Not all quoted text is dialogue! Watch for:
- Air quotes: when narration describes someone making "air quotes" or gesturing quotes
- Sarcastic/emphasis quotes: "expert", "special", "danger zone" etc. used for emphasis
- Sign/label text: signs that say "No Entry", labels reading "Danger", etc.
- Single quoted words or short phrases in narration are usually NOT dialogue
- Special named entities: Some beings have names that always appear in quotes (see SPECIAL QUOTED NAMES section)

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
      "text": "dialogue text",
      "type": "dialogue"
    }
  ]
}

CRITICAL PATTERN RECOGNITION:

1. ATTRIBUTION AFTER DIALOGUE (MOST COMMON):
   "Dialogue text," [Character] said/spoke/replied/asked/nodded/etc.
   → ONE segment with the character as speaker, including the attribution
   → The ENTIRE sentence belongs to that character

2. ATTRIBUTION BEFORE DIALOGUE:
   [Character] spoke/said/replied. "Dialogue"
   → Split into TWO segments: narrator action + character dialogue

3. MULTIPLE QUOTES IN ONE ATTRIBUTION:
   "First quote," [Character] said. "Second quote."
   → ONE segment with all text belonging to that character
   → Do NOT split between quotes if they share the same attribution

4. CONTEXTUAL CLUES:
   - Track conversation flow - speakers typically alternate
   - Look for attribution verbs: said, spoke, replied, asked, nodded, confirmed, etc.

EXAMPLES:

Input: "We know this is true," Eversmile spoke. "You are aware?"
Output:
- Segment 1: Eversmile ""We know this is true," Eversmile spoke. "You are aware?""

Input: "Fangs of Man," Yip nodded. "Seen it myself."
Output:
- Segment 1: Yip ""Fangs of Man," Yip nodded. "Seen it myself.""

Input: Eversmile spoke. "You are aware?"
Output:
- Segment 1: narrator "Eversmile spoke."
- Segment 2: Eversmile ""You are aware?""

Input: "Yes," Eversmile confirmed. "That's correct."
Output:
- Segment 1: Eversmile ""Yes," Eversmile confirmed. "That's correct.""

CRITICAL: When dialogue ends with attribution (comma + character + verb), the ENTIRE sentence including ALL quotes belongs to that character.

AIR QUOTES AND EMPHASIS EXAMPLES:

Input: He looked at the "danger" sign and laughed.
Output:
- Segment 1: narrator "He looked at the "danger" sign and laughed."

Input: She made air quotes as she said "special mission" sarcastically.
Output:
- Segment 1: narrator "She made air quotes as she said "special mission" sarcastically."

Input: The so-called "expert" had no clue. "I know everything," he said.
Output:
- Segment 1: narrator "The so-called "expert" had no clue."
- Segment 2: unknown ""I know everything," he said."

Input: The monster "I" attacked the village.
Output:
- Segment 1: narrator "The monster "I" attacked the village."

Input: Jake faced "I" in battle. "You cannot defeat me," Jake said.
Output:
- Segment 1: narrator "Jake faced "I" in battle."
- Segment 2: Jake ""You cannot defeat me," Jake said."

IMPORTANT RULES:
- Single words or short phrases in quotes within narration are usually emphasis, not dialogue
- Look for attribution verbs (said, spoke, etc.) to identify actual dialogue
- Air quotes, sarcasm quotes, and label quotes stay in narration
- Dialogue without clear attribution → use "unknown" as speaker
- For unnamed speakers (the dwarf, the guard, etc.) use that descriptor as the speaker name
- Character aliases should use the main character name
- Types: "narration" (default), "dialogue", "thought" (for italicized internal monologue)
- When in doubt about air quotes vs dialogue, check if there's an attribution verb`;

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
            totalChunks: chunks.length,
          });
        }

        this.log(
          `🔄 Processing chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars)`
        );

        const response = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-2024-04-09',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: chunk,
            },
          ],
          temperature: 0.1, // Lower temperature for more consistent results
          stream: true, // Enable streaming for real-time progress
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
            const segmentMatches = streamedContent.match(
              /"speaker":\s*"[^"]*",\s*"text":\s*"[^"]*",\s*"type":\s*"[^"]*"/g
            );

            if (
              segmentMatches &&
              segmentMatches.length > lastParsedSegments.length
            ) {
              // New segments found - try to parse them
              const newSegmentCount = segmentMatches.length;

              // Try to extract just the new segments
              for (
                let i = lastParsedSegments.length;
                i < newSegmentCount;
                i++
              ) {
                try {
                  // Build a partial JSON to parse individual segments
                  const segmentMatch = segmentMatches[i];
                  const segmentJson = `{${segmentMatch}}`;
                  const parsedSegment = JSON.parse(segmentJson);

                  // Check if this should be AI Announcer
                  if (
                    parsedSegment.speaker === 'narrator' &&
                    this.isAIAnnouncer(parsedSegment.text)
                  ) {
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
                      newSegment: parsedSegment,
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
          const currentSegmentCount = segmentMatches
            ? segmentMatches.length
            : 0;

          if (currentSegmentCount > segmentCount) {
            segmentCount = currentSegmentCount;
            if (progressCallback && lastParsedSegments.length === 0) {
              progressCallback({
                phase: 'analyzing',
                message: `Chunk ${chunkIndex + 1}/${chunks.length}: Processing segment ${segmentCount}...`,
                currentChunk: chunkIndex,
                totalChunks: chunks.length,
                chunkSegments: segmentCount,
              });
            }
          }
        }

        const result = JSON.parse(streamedContent);

        // Validate the response
        if (!result.segments || !Array.isArray(result.segments)) {
          throw new Error(
            `Invalid response format for chunk ${chunkIndex}: missing segments array`
          );
        }

        // Validate each segment and check for AI Announcer
        for (let i = 0; i < result.segments.length; i++) {
          const segment = result.segments[i];
          if (!segment.speaker || !segment.text) {
            throw new Error(
              `Invalid segment ${i} in chunk ${chunkIndex}: missing speaker or text`
            );
          }
          if (!segment.type) {
            segment.type = 'narration'; // Default type
          }

          // Check if this should be AI Announcer
          if (
            segment.speaker === 'narrator' &&
            this.isAIAnnouncer(segment.text)
          ) {
            segment.speaker = 'ai_announcer';
            segment.type = 'announcement';

            // Special case for DING! sound effect
            if (this.isDingSound(segment.text)) {
              segment.type = 'sound_effect';
              segment.sound = 'ding';
              this.log(`🔔 Identified DING! sound effect`);
            } else {
              this.log(
                `🤖 Identified AI Announcer segment: "${segment.text.substring(0, 50)}..."`
              );
            }
          }
        }

        // Add chunks segments to the overall collection
        allSegments.push(...result.segments);

        // Brief pause between chunks to avoid rate limiting
        if (chunkIndex < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      // Verify all text is accounted for (compare with preprocessed text)
      const reconstructedText = allSegments.map((s) => s.text).join('');
      const preprocessedNormalized = preprocessedText
        .replace(/\s+/g, ' ')
        .trim();
      const reconstructedTextNormalized = reconstructedText
        .replace(/\s+/g, ' ')
        .trim();

      if (preprocessedNormalized !== reconstructedTextNormalized) {
        console.warn(
          'Text reconstruction mismatch - some text may be missing or altered'
        );
        console.log('Preprocessed length:', preprocessedNormalized.length);
        console.log(
          'Reconstructed length:',
          reconstructedTextNormalized.length
        );
      }

      return allSegments;
    } catch (error) {
      console.error('OpenAI speaker identification failed:', error);

      // Fallback: return entire text as narrator
      const fallbackText = this.preprocessText(chapterText);
      return [
        {
          speaker: 'narrator',
          text: fallbackText,
          type: 'narration',
        },
      ];
    }
  }

  async identifySpeakersTwoStage(
    chapterText,
    knownSpeakers = [],
    progressCallback = null
  ) {
    // Step 1: Preprocess the text
    const preprocessedText = this.preprocessText(chapterText);
    this.log(
      `📝 Preprocessing applied pronunciation dictionary and pause markers`
    );

    // Step 2: Deterministic segmentation
    this.log(`✂️ Starting deterministic quote segmentation...`);
    const specialQuotedNames = this.specialCases?.quotedNames || [];
    const rawSegments = splitDialogueNarration(
      preprocessedText,
      specialQuotedNames
    );

    // Step 2.5: Post-process to merge special quoted names with adjacent narration
    const mergedSegments = this.mergeSpecialQuotedNames(
      rawSegments,
      specialQuotedNames
    );

    this.log(
      `📊 Split into ${rawSegments.length} segments, merged to ${mergedSegments.length} segments`
    );

    if (progressCallback) {
      progressCallback({
        phase: 'segmenting',
        message: `Split text into ${mergedSegments.length} segments`,
        totalSegments: mergedSegments.length,
      });
    }

    // Step 3: Prepare for attribution
    const knownCharacters = knownSpeakers
      .filter((s) => !s.is_narrator)
      .map((s) => s.name)
      .join(', ');

    const characterContext = this.generateCharacterContext();

    // Simpler prompt for attribution only
    const systemPrompt = `You are a dialogue attribution specialist. You will be given pre-segmented text where dialogue and narration are already separated.

Known characters from previous chapters: ${knownCharacters || 'None yet'}${characterContext}

Your task is to:
1. For dialogue segments: identify the speaking character based on context clues from surrounding segments
2. For narration segments: confirm they should be attributed to "narrator"
3. CRITICAL: Some "dialogue" segments may actually be air quotes or emphasis - these should be merged back into narration
4. Identify special cases like AI announcements or sound effects
5. Use the beforeContext and afterContext fields to understand who is speaking

AIR QUOTES DETECTION:
- If a "dialogue" segment is a single word or short phrase like "expert", "special", "danger zone"
- AND the context shows no attribution verbs (said, spoke, replied, etc.)
- AND it appears to be emphasis or sarcasm in narration
- THEN mark it as narrator/narration, not dialogue

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

ATTRIBUTION TIPS:
- Look for attribution phrases like "X said", "X replied", "X asked" in nearby narration segments
- If dialogue follows "the dwarf said" in context, attribute to "dwarf"
- If dialogue follows "the Fallen King added" in context, attribute to "Fallen King"
- Track conversation flow - responses usually alternate between speakers
- Pay attention to pronouns and descriptors in surrounding narration

RULES:
- Use character names exactly as they appear in the known characters list OR context
- For character aliases (e.g., Villy = Vilastromoz), use the main name
- Common unnamed speakers: "dwarf", "elf", "guard", "merchant", etc. are valid speaker names
- If speaker is unclear from context, use "unknown"
- Preserve the exact text without modification`;

    try {
      // Pre-allocate array with correct size to maintain order
      const attributedSegments = new Array(mergedSegments.length);
      const batchSize = 20; // Process segments in batches

      for (let i = 0; i < mergedSegments.length; i += batchSize) {
        const batch = mergedSegments.slice(
          i,
          Math.min(i + batchSize, mergedSegments.length)
        );
        const batchIndex = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(mergedSegments.length / batchSize);

        if (progressCallback) {
          progressCallback({
            phase: 'attributing',
            message: `Attributing speakers for batch ${batchIndex}/${totalBatches}...`,
            currentBatch: batchIndex,
            totalBatches: totalBatches,
            progress: Math.round((i / mergedSegments.length) * 100),
          });
        }

        this.log(
          `🎭 Processing attribution batch ${batchIndex}/${totalBatches}`
        );

        // Create a simplified input for GPT with indices
        // Include context from surrounding segments for better attribution
        const contextWindow = 5; // Look at 5 segments before and after
        const batchWithContext = batch.map((seg, idx) => {
          const globalIdx = i + idx;
          const contextStart = Math.max(0, globalIdx - contextWindow);
          const contextEnd = Math.min(
            mergedSegments.length,
            globalIdx + contextWindow + 1
          );

          const beforeContext = mergedSegments
            .slice(contextStart, globalIdx)
            .map((s) => `[${s.type}] ${s.text.substring(0, 100)}...`)
            .join('\n');

          const afterContext = mergedSegments
            .slice(globalIdx + 1, contextEnd)
            .map((s) => `[${s.type}] ${s.text.substring(0, 100)}...`)
            .join('\n');

          return {
            index: globalIdx,
            type: seg.type,
            text: seg.text,
            beforeContext: beforeContext || 'START OF TEXT',
            afterContext: afterContext || 'END OF TEXT',
          };
        });

        const batchInput = batchWithContext;

        const response = await this.openai.chat.completions.create({
          model: 'gpt-4-turbo-2024-04-09',
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: `Attribute speakers to these pre-segmented texts:\n\n${JSON.stringify(batchInput, null, 2)}`,
            },
          ],
          temperature: 0.1,
        });

        const result = JSON.parse(response.choices[0].message.content);

        // Process each attributed segment and place in correct position
        for (let j = 0; j < result.segments.length; j++) {
          const segment = result.segments[j];
          const originalIndex = i + j; // Calculate original position

          // Check for AI announcer and sound effects
          if (
            segment.speaker === 'narrator' &&
            this.isAIAnnouncer(segment.text)
          ) {
            segment.speaker = 'ai_announcer';
            segment.type = 'announcement';

            if (this.isDingSound(segment.text)) {
              segment.type = 'sound_effect';
              segment.sound = 'ding';
              this.log(`🔔 Identified DING! sound effect`);
            }
          }

          // Place segment in correct position
          attributedSegments[originalIndex] = segment;
        }

        // Brief pause between batches
        if (i + batchSize < mergedSegments.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      if (progressCallback) {
        progressCallback({
          phase: 'complete',
          message: `Successfully identified ${attributedSegments.length} segments`,
          segments: attributedSegments.length,
        });
      }

      this.log(
        `✅ Two-stage identification complete: ${attributedSegments.length} segments`
      );
      return attributedSegments;
    } catch (error) {
      console.error('Two-stage speaker identification failed:', error);

      // Fallback: return segments with default attribution
      return mergedSegments.map((seg) => ({
        speaker: seg.type === 'dialogue' ? 'unknown' : 'narrator',
        text: seg.text,
        type: seg.type,
      }));
    }
  }
}

export { SpeakerIdentifier };
