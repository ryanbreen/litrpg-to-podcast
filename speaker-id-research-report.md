# Speaker Identification Multi-Quote Parsing Research Report

## Executive Summary

This report documents extensive research and testing conducted to improve the parsing of multi-quote dialogue segments in the Patreon-to-Audio speaker identification system. Despite implementing increasingly explicit prompts and testing multiple OpenAI models, the system still struggles with a specific pattern where narration appears between two quotes from the same character.

## Problem Statement

### The Challenge
When processing dialogue like:
```
"It won't!" the mage slammed his hand on the table. "Eleven Primas are baring down on us..."
```

The system should parse this into THREE segments:
1. Character dialogue: `"It won't!"`
2. Narrator: `the mage slammed his hand on the table.`
3. Character dialogue: `"Eleven Primas are baring down on us..."`

However, all tested models consistently parse this as a single segment, causing the character's voice to narrate actions that should be in the narrator's voice.

### Impact
- Character voices inappropriately narrate action sequences
- Breaks immersion in the generated audiobook
- Requires manual correction in the UI after processing

## Research Methodology

### 1. Prompt Engineering Evolution

#### Initial Prompt (Baseline)
The original prompt included basic rules for dialogue attribution but lacked specific guidance for multi-quote scenarios.

#### Enhanced Prompt (First Iteration)
Added explicit multi-quote example:
```
CRITICAL MULTI-QUOTE EXAMPLE:
- "It won't!" the mage slammed his hand on the table. "Eleven Primas are coming!" → THREE segments:
  1) speaker: "mage" with "It won't!"
  2) speaker: "narrator" with the mage slammed his hand on the table.
  3) speaker: "mage" with "Eleven Primas are coming!"
```

#### Final Prompt (Current)
Significantly strengthened with:
- Multiple detailed examples
- "NO EXCEPTIONS" emphasis
- Explicit enforcement rules
- Pattern recognition guidance

```
CRITICAL MULTI-QUOTE EXAMPLES - THESE MUST BE SPLIT:
1. "It won't!" the mage slammed his hand on the table. "Eleven Primas are coming!" 
   MUST BE THREE SEGMENTS:
   - speaker: "mage" → "It won't!"
   - speaker: "narrator" → the mage slammed his hand on the table.
   - speaker: "mage" → "Eleven Primas are coming!"

ABSOLUTE SPLITTING RULES - NO EXCEPTIONS:
1. A character segment can contain ONLY ONE continuous quote with its attribution
2. If you see: [quote][non-quote text][quote] = ALWAYS 3+ segments
3. Split at EVERY transition between quoted and non-quoted text
```

### 2. Model Testing Results

#### gpt-4o (Original Model)
- **Performance**: Fast, reliable JSON output
- **Quote Parsing**: Failed to split multi-quotes despite explicit instructions
- **Conclusion**: Tends to group related text together

#### o1-preview
- **Performance**: Attempted to use OpenAI's reasoning model
- **Quote Parsing**: Complete failure - returned only 1 segment for entire chapter
- **Technical Issue**: Doesn't support JSON mode or structured outputs
- **Conclusion**: Not suitable for this use case

#### gpt-4o-2024-08-06
- **Performance**: Good speed, reliable JSON
- **Quote Parsing**: Same issue - doesn't split multi-quotes
- **Features**: Supports structured outputs with JSON schema
- **Conclusion**: No improvement over base gpt-4o for this specific issue

#### gpt-4-turbo-preview
- **Performance**: Very slow (>2 minutes for processing)
- **Quote Parsing**: JSON parsing errors prevented proper evaluation
- **Technical Issue**: Generated malformed JSON (unterminated strings)
- **Error**: `SyntaxError: Unterminated string in JSON at position 11977`
- **Conclusion**: Too unstable for production use

#### gpt-4-turbo-2024-04-09
- **Performance**: Moderate speed, stable JSON output
- **Quote Parsing**: Still exhibits the same multi-quote parsing issue
- **Features**: Supports vision capabilities (not needed here)
- **Conclusion**: Most stable alternative but doesn't solve core problem

## Technical Implementation Details

### Current Architecture
- Chunks text into 8KB segments for processing
- Uses streaming API for real-time progress updates
- Implements character alias resolution (e.g., "Villy" → "Vilastromoz")
- Includes special handling for system announcements and sound effects

### Code Location
- Speaker identification logic: `/src/shared/speaker-identifier.js`
- API endpoints: `/src/api/server.js`
- Test chapter: Post ID 107447290 (Chapter 946)

## Key Findings

1. **Model Consistency**: All GPT models exhibit the same behavior, suggesting this is a fundamental issue with how large language models interpret dialogue attribution rather than a model-specific limitation.

2. **Prompt Limitations**: Even extremely explicit, rule-based prompts with multiple examples fail to override the models' tendency to group related text.

3. **Context Grouping**: GPT models appear to have a strong bias toward keeping contextually related text together, even when explicitly instructed to split it.

4. **Technical Constraints**: Some advanced models (o1-preview) lack necessary features (JSON mode), while others (gpt-4-turbo-preview) have stability issues.

## Recommendations for Expert Consultation

### Questions for External Experts

1. **Alternative Approaches**: Are there preprocessing techniques or alternative parsing strategies that could help identify quote boundaries before sending to GPT?

2. **Fine-tuning**: Would fine-tuning a model specifically for dialogue parsing be more effective than prompt engineering?

3. **Two-Stage Processing**: Could we use a regex-based preprocessor to mark quote boundaries, then have GPT handle speaker attribution?

4. **Different Models**: Are there specialized models (perhaps outside OpenAI) better suited for dialogue parsing tasks?

5. **Prompt Techniques**: Are there advanced prompting techniques (e.g., chain-of-thought for JSON mode) that might help?

### Potential Solutions to Explore

1. **Hybrid Approach**: Use regex to identify quote patterns, then use GPT only for speaker attribution
2. **Multiple Passes**: First pass to identify quotes, second pass to attribute speakers
3. **Custom Model**: Train or fine-tune a model specifically for screenplay/dialogue parsing
4. **Rule-Based Fallback**: Implement deterministic parsing for common patterns

## Appendix: Test Data

### Example Input
```
"It won't!" the mage slammed his hand on the table. "Eleven Primas are baring down on us, more than ten thousand beasts at their side! The barrier will not hold for more than half a day if this keeps up."
```

### Current Output (All Models)
```json
{
  "speaker": "mage",
  "text": "\"It won't!\" the mage slammed his hand on the table. \"Eleven Primas are baring down on us, more than ten thousand beasts at their side! The barrier will not hold for more than half a day if this keeps up.\"",
  "type": "dialogue"
}
```

### Desired Output
```json
[
  {
    "speaker": "mage",
    "text": "\"It won't!\"",
    "type": "dialogue"
  },
  {
    "speaker": "narrator",
    "text": "the mage slammed his hand on the table.",
    "type": "narration"
  },
  {
    "speaker": "mage",
    "text": "\"Eleven Primas are baring down on us, more than ten thousand beasts at their side! The barrier will not hold for more than half a day if this keeps up.\"",
    "type": "dialogue"
  }
]
```

## Conclusion

Despite extensive prompt engineering and testing across multiple OpenAI models, the multi-quote parsing challenge persists. This appears to be a fundamental limitation in how current LLMs process dialogue attribution, suggesting that alternative approaches beyond prompt engineering may be necessary to achieve the desired parsing accuracy.