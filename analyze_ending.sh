#!/bin/bash

echo "Analyzing the ending structure of the concatenated audio..."

# Calculate where each component starts
TOTAL_DURATION=967.209796

# The ending components total: 2.037551 + 1.149375 + 2.037551 = 5.224477 seconds
END_COMPONENTS_DURATION=5.224477

# Start time of end_pause.mp3
END_PAUSE_START=$(echo "$TOTAL_DURATION - $END_COMPONENTS_DURATION" | bc)
echo "end_pause.mp3 starts at: ${END_PAUSE_START}s"

# Start time of end_chapter.mp3
END_CHAPTER_START=$(echo "$END_PAUSE_START + 2.037551" | bc)
echo "end_chapter.mp3 starts at: ${END_CHAPTER_START}s"

# Start time of after_end_pause.mp3
AFTER_END_START=$(echo "$END_CHAPTER_START + 1.149375" | bc)
echo "after_end_pause.mp3 starts at: ${AFTER_END_START}s"

echo -e "\nExtracting different sections..."

# Extract just the "End of Chapter" announcement
ffmpeg -ss "$END_CHAPTER_START" -i /tmp/test_full_concat.mp3 -t 1.149375 -c copy /tmp/just_end_chapter.mp3 -loglevel warning
echo "Extracted 'End of Chapter' announcement to: /tmp/just_end_chapter.mp3"

# Extract from end of segment_023 to end (should include all ending components)
LAST_SEGMENT_END=$(echo "$TOTAL_DURATION - $END_COMPONENTS_DURATION - 0.994297" | bc) # minus pause_022
ffmpeg -ss "$LAST_SEGMENT_END" -i /tmp/test_full_concat.mp3 -c copy /tmp/from_last_segment_end.mp3 -loglevel warning
echo "Extracted from end of last segment to end: /tmp/from_last_segment_end.mp3"

# Extract last 10 seconds for broader context
ffmpeg -sseof -10 -i /tmp/test_full_concat.mp3 -c copy /tmp/last_10_seconds.mp3 -loglevel warning
echo "Extracted last 10 seconds: /tmp/last_10_seconds.mp3"

echo -e "\nDone! You can now listen to:"
echo "- /tmp/just_end_chapter.mp3 (should be the 'End of Chapter' announcement)"
echo "- /tmp/from_last_segment_end.mp3 (everything after the last segment)"
echo "- /tmp/last_10_seconds.mp3 (broader context of the ending)"