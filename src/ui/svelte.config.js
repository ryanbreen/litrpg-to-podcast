import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: '../../public',
      assets: '../../public',
      fallback: 'index.html',
      precompress: false,
      strict: true
    }),
    paths: {
      base: ''
    }
  }
};

export default config;