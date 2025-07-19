#!/bin/bash

echo "Starting simple concatenation test for chapter 107800562..."

# Define paths
INPUT_LIST="/Users/wrb/fun/code/patreon-to-audio/public/audio/segments/107800562/debug_filelist.txt"
OUTPUT_FILE="/tmp/test_full_concat.mp3"

# Remove output file if it exists
rm -f "$OUTPUT_FILE"

# Simple concatenation with copy codec (no re-encoding)
echo "Concatenating audio files..."
ffmpeg -f concat -safe 0 -i "$INPUT_LIST" -c copy "$OUTPUT_FILE" -loglevel warning

if [ $? -eq 0 ]; then
    echo "Concatenation successful!"
    
    # Get duration
    echo -e "\nChecking output file duration:"
    duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUTPUT_FILE")
    echo "Total duration: ${duration} seconds"
    
    # Convert to minutes:seconds
    minutes=$(echo "$duration / 60" | bc)
    seconds=$(echo "$duration % 60" | bc)
    echo "Total duration: ${minutes}m ${seconds}s"
    
    # Extract last 5 seconds of audio
    echo -e "\nExtracting last 5 seconds..."
    start_time=$(echo "$duration - 5" | bc)
    ffmpeg -ss "$start_time" -i "$OUTPUT_FILE" -t 5 -c copy "/tmp/last_5_seconds.mp3" -loglevel warning
    
    echo "Last 5 seconds saved to: /tmp/last_5_seconds.mp3"
    
    # Check if the file ends with the "End of Chapter" announcement
    echo -e "\nChecking file properties:"
    ffprobe -v error -show_format -show_streams "$OUTPUT_FILE" | grep -E "(codec_name|sample_rate|channels|bit_rate)"
    
    # Also save first 5 seconds for comparison
    echo -e "\nExtracting first 5 seconds for comparison..."
    ffmpeg -i "$OUTPUT_FILE" -t 5 -c copy "/tmp/first_5_seconds.mp3" -loglevel warning
    echo "First 5 seconds saved to: /tmp/first_5_seconds.mp3"
    
else
    echo "Error: Concatenation failed!"
    exit 1
fi

echo -e "\nTest complete!"
echo "Full concatenated file: $OUTPUT_FILE"
echo "You can listen to the last 5 seconds at: /tmp/last_5_seconds.mp3"
echo "You can listen to the first 5 seconds at: /tmp/first_5_seconds.mp3"