import { writable } from 'svelte/store';

// Create reactive stores for shared data
export const voicesStore = writable([]);
export const chaptersStore = writable([]);

// Helper functions to update stores
export const updateVoices = (newVoices) => {
  voicesStore.set(newVoices);
};

export const updateChapters = (newChapters) => {
  chaptersStore.set(newChapters);
};

// Function to refresh voices from API
export const refreshVoices = async () => {
  try {
    const response = await fetch('http://localhost:8383/api/voices');
    if (!response.ok) throw new Error('Failed to load voices');
    const voices = await response.json();
    updateVoices(voices);
    return voices;
  } catch (error) {
    console.error('Error refreshing voices:', error);
    throw error;
  }
};

// Function to refresh chapters from API
export const refreshChapters = async () => {
  try {
    const response = await fetch('http://localhost:8383/api/chapters');
    if (!response.ok) throw new Error('Failed to load chapters');
    const chapters = await response.json();
    updateChapters(chapters);
    return chapters;
  } catch (error) {
    console.error('Error refreshing chapters:', error);
    throw error;
  }
};