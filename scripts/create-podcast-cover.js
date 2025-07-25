#!/usr/bin/env node

// This script creates a simple podcast cover image
console.log('📌 Podcast Cover Image Requirements:');
console.log('- Size: 3000x3000 pixels (Apple Podcasts requirement)');
console.log('- Format: JPG or PNG');
console.log('- File size: Less than 500KB');
console.log('');
console.log('You need to create a cover image with the following details:');
console.log('- Title: The Primal Hunter');
console.log('- Subtitle: LitRPG Audiobook');
console.log('- Style: Fantasy/Gaming themed');
console.log('');
console.log('Once you have the image, save it as:');
console.log('  ./public/cover.jpg');
console.log('');
console.log('Then upload it to S3:');
console.log(
  '  aws s3 cp ./public/cover.jpg s3://porivo.com/podcasts/cover.jpg --profile porivo'
);
console.log('');
console.log(
  'Alternatively, you can use an online tool like Canva or create one with DALL-E/Midjourney'
);
