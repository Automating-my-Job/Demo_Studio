import React from 'react';
import { createRoot } from 'react-dom/client';
import '@material/web/all.js';
import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';
import './theme.css';
import { installMockBridge } from './mockBridge.js';
import { StoreProvider } from './state/store.jsx';
import App from './App.jsx';

// Running in a plain browser (vite dev preview outside Electron) there is no
// preload bridge — install a simulated one so the UI stays explorable.
if (!window.demoStudio) installMockBridge();

if (typescaleStyles.styleSheet) {
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, typescaleStyles.styleSheet];
}

createRoot(document.getElementById('root')).render(
  <StoreProvider>
    <App />
  </StoreProvider>
);
