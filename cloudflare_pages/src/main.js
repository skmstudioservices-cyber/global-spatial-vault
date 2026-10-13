// src/main.js
import { renderGrid } from './grid.js';

// Load data for a given table (niche) from the repo's /data folder
async function loadData(table) {
  const resp = await fetch(`/data/${table}.json`);
  if (!resp.ok) throw new Error(`Failed to load ${table}.json`);
  return await resp.json();
}

async function init() {
  // Theme handling (simple)
  const themeSelect = document.getElementById('themeSelect');
  const themes = ['light', 'dark', 'midnight'];
  themes.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
    themeSelect.appendChild(opt);
  });
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.dataset.theme = savedTheme;
  themeSelect.value = savedTheme;
  themeSelect.addEventListener('change', e => {
    document.documentElement.dataset.theme = e.target.value;
    localStorage.setItem('theme', e.target.value);
  });

  // Zoom handling
  const zoomSlider = document.getElementById('zoomSlider');
  const wrapper = document.getElementById('app');
  const savedZoom = localStorage.getItem('zoom') || '100';
  wrapper.style.transform = `scale(${savedZoom / 100})`;
  zoomSlider.value = savedZoom;
  zoomSlider.addEventListener('input', e => {
    const val = e.target.value;
    wrapper.style.transform = `scale(${val / 100})`;
    localStorage.setItem('zoom', val);
  });

  // Example: load & render the "places" table
  const data = await loadData('places');
  renderGrid(data);
}

init().catch(console.error);
