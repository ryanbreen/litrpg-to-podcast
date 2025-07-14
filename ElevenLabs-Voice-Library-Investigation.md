# ElevenLabs Voice Library Metadata Investigation

## Problem Statement
We need to fetch metadata (name, tags, description, etc.) for ElevenLabs Voice Library voices using only their voice IDs. While these voices work perfectly for TTS generation, we cannot retrieve their published metadata through the API.

## Voice ID Examples Tested
- `kPzsL2i3teMYv0FxEYQ6` 
- `NFG5qt843uXKj4pFvR7C`
- `tnSpp4vdxKPjI9w0GnoV`

All of these IDs work for TTS generation via `/v1/text-to-speech/{voice_id}` but metadata retrieval fails.

## API Endpoints Attempted

### 1. Direct Voice Lookup (User Voices)
**Endpoint:** `GET /v1/voices/{voice_id}`
**Result:** ❌ 404 Not Found
**Reason:** Voice Library voices are not in user's personal voice collection

```javascript
const response = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'xi-api-key': config.elevenlabs.apiKey
  }
});
// Returns 404 for Voice Library voices
```

### 2. Shared Voices Endpoint
**Endpoint:** `GET /v1/shared-voices`
**Result:** ❌ Voice not found in results
**Details:** Returns 30 shared voices but test voices are not included

```javascript
const libraryResponse = await fetch(`https://api.elevenlabs.io/v1/shared-voices`, {
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'xi-api-key': config.elevenlabs.apiKey
  }
});
// Returns 30 voices but our test IDs are not included
```

### 3. Temporary Voice Addition (Add/Get/Delete)
**Endpoint:** `POST /v1/voices/add/{voice_id}`
**Result:** ❌ 405 Method Not Allowed
**Error:** `{"detail":"Method Not Allowed"}`

```javascript
const addResponse = await fetch(`https://api.elevenlabs.io/v1/voices/add/${voiceId}`, {
  method: 'POST',
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'xi-api-key': config.elevenlabs.apiKey
  },
  body: JSON.stringify({
    new_name: `temp_${voiceId}`
  })
});
// Returns 405 Method Not Allowed
```

### 4. All User Voices Endpoint
**Endpoint:** `GET /v1/voices`
**Result:** ❌ Only returns user's personal voices
**Details:** Does not include Voice Library voices

```javascript
const response = await fetch(`https://api.elevenlabs.io/v1/voices`, {
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'xi-api-key': config.elevenlabs.apiKey
  }
});
// Only returns personally owned/cloned voices
```

## Current API Key Permissions
Our API key has the following permissions:
- ✅ TTS generation works (`/v1/text-to-speech/{voice_id}`)
- ✅ Voice reading works for personal voices
- ❌ Voice Library metadata access fails

## Working Functionality
Despite metadata retrieval failures, the following works perfectly:

```javascript
// TTS Generation with Voice Library voices works fine
const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
  method: 'POST',
  headers: {
    'Accept': 'audio/mpeg',
    'Content-Type': 'application/json',
    'xi-api-key': config.elevenlabs.apiKey
  },
  body: JSON.stringify({
    text: "Sample text for voice generation",
    model_id: "eleven_monolingual_v1"
  })
});
// This works and generates audio successfully
```

## Current Fallback Implementation
When metadata retrieval fails, we return:

```javascript
{
  id: `elevenlabs_${voiceId}`,
  name: `Voice Library: ${voiceId}`,  // Generic placeholder
  provider: 'elevenlabs',
  type: 'custom',
  settings: {
    voice_id: voiceId,
    model_id: 'eleven_monolingual_v1',
    is_voice_library: true
  },
  tags: 'voice-library'  // Generic tag
}
```

## Questions for ElevenLabs Support

1. **Voice Library Access:** Is there a specific endpoint to get metadata for Voice Library voices by ID?

2. **API Permissions:** Do we need special permissions beyond standard API access to read Voice Library metadata?

3. **Voice Discovery:** How can we programmatically discover Voice Library voices and their metadata?

4. **Shared Voices vs Voice Library:** What's the difference between `/v1/shared-voices` and the main Voice Library?

5. **Alternative Endpoints:** Are there any undocumented or beta endpoints for Voice Library metadata?

6. **Voice Addition:** Why does `/v1/voices/add/{voice_id}` return 405 Method Not Allowed?

## Desired Outcome
We want to automatically populate voice metadata when a user enters a Voice Library voice ID:

**Instead of:**
- Name: "Voice Library: kPzsL2i3teMYv0FxEYQ6"
- Tags: "voice-library"

**We want:**
- Name: "Marcus" (actual voice name)
- Tags: "male, middle-aged, american, professional, narrator"

## Technical Context
- **Language:** Node.js with Fastify
- **Use Case:** Voice library management for audiobook TTS generation
- **API Key Type:** Standard ElevenLabs API key with TTS permissions
- **Current Status:** Voice IDs work for generation but metadata retrieval fails

## Code Repository
The full implementation can be found in our voice metadata fetching logic at:
`/Users/wrb/fun/code/patreon-to-audio/src/api/server.js` lines 881-1024