import OpenAI from 'openai';
import config from './config.js';

class SpeakerIdentifier {
  constructor() {
    this.openai = new OpenAI({
      apiKey: config.openai.apiKey
    });
  }

  async identifySpeakers(chapterText, knownSpeakers = []) {
    const knownCharacters = knownSpeakers
      .filter(s => !s.is_narrator)
      .map(s => s.name)
      .join(', ');

    const systemPrompt = `You are a dialogue attribution specialist. Your task is to split a story text into segments by speaker.

Known characters from previous chapters: ${knownCharacters || 'None yet'}

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
            content: chapterText
          }
        ],
        temperature: 0.1 // Lower temperature for more consistent results
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      // Validate the response
      if (!result.segments || !Array.isArray(result.segments)) {
        throw new Error('Invalid response format: missing segments array');
      }

      // Validate each segment
      for (let i = 0; i < result.segments.length; i++) {
        const segment = result.segments[i];
        if (!segment.speaker || !segment.text) {
          throw new Error(`Invalid segment ${i}: missing speaker or text`);
        }
        if (!segment.type) {
          segment.type = 'narration'; // Default type
        }
      }

      // Verify all text is accounted for
      const reconstructedText = result.segments.map(s => s.text).join('');
      const originalTextNormalized = chapterText.replace(/\s+/g, ' ').trim();
      const reconstructedTextNormalized = reconstructedText.replace(/\s+/g, ' ').trim();
      
      if (originalTextNormalized !== reconstructedTextNormalized) {
        console.warn('Text reconstruction mismatch - some text may be missing or altered');
        console.log('Original length:', originalTextNormalized.length);
        console.log('Reconstructed length:', reconstructedTextNormalized.length);
      }

      return result.segments;

    } catch (error) {
      console.error('OpenAI speaker identification failed:', error);
      
      // Fallback: return entire text as narrator
      return [{
        speaker: 'narrator',
        text: chapterText,
        type: 'narration'
      }];
    }
  }

  log(message, level = 'info') {
    if (this.server && this.server.log) {
      this.server.log(message, level);
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`);
    }
  }
}

export { SpeakerIdentifier };