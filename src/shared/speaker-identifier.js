import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import config from './config.js';

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

  async identifySpeakers(chapterText, knownSpeakers = []) {
    // Preprocess the text before sending to OpenAI
    const preprocessedText = this.preprocessText(chapterText);
    this.log(`📝 Preprocessing applied pronunciation dictionary and pause markers`);
    
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
      "text": "exact text segment",
      "type": "narration"
    },
    {
      "speaker": "Jake",
      "text": "exact dialogue text",
      "type": "dialogue"
    }
  ]
}

CRITICAL RULES:
1. Every single word from the input must appear in exactly one segment
2. Preserve exact text, punctuation, and order
3. Use "narrator" for all non-dialogue text (descriptions, actions, thoughts)
4. Only use character names when you're certain they are speaking dialogue
5. For new characters not in the known list, use their name if clearly identified
6. Split at natural breaks between speakers
7. Types: "narration" (default), "dialogue", "thought"
8. IMPORTANT: Use the main character name (not aliases) for consistency

Be conservative - when in doubt, attribute to "narrator".`;

    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: preprocessedText
          }
        ],
        temperature: 0.1 // Lower temperature for more consistent results
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      // Validate the response
      if (!result.segments || !Array.isArray(result.segments)) {
        throw new Error('Invalid response format: missing segments array');
      }

      // Validate each segment and check for AI Announcer
      for (let i = 0; i < result.segments.length; i++) {
        const segment = result.segments[i];
        if (!segment.speaker || !segment.text) {
          throw new Error(`Invalid segment ${i}: missing speaker or text`);
        }
        if (!segment.type) {
          segment.type = 'narration'; // Default type
        }
        
        // Check if this should be AI Announcer
        if (segment.speaker === 'narrator' && this.isAIAnnouncer(segment.text)) {
          segment.speaker = 'ai_announcer';
          segment.type = 'announcement';
          this.log(`🤖 Identified AI Announcer segment: "${segment.text.substring(0, 50)}..."`);
        }
      }

      // Verify all text is accounted for (compare with preprocessed text)
      const reconstructedText = result.segments.map(s => s.text).join('');
      const preprocessedNormalized = preprocessedText.replace(/\s+/g, ' ').trim();
      const reconstructedTextNormalized = reconstructedText.replace(/\s+/g, ' ').trim();
      
      if (preprocessedNormalized !== reconstructedTextNormalized) {
        console.warn('Text reconstruction mismatch - some text may be missing or altered');
        console.log('Preprocessed length:', preprocessedNormalized.length);
        console.log('Reconstructed length:', reconstructedTextNormalized.length);
      }

      return result.segments;

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

}

export { SpeakerIdentifier };