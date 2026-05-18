import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Apply persisted theme synchronously before render to avoid a flash of
// unstyled content (FOUC) when the user previously selected dark mode.
try {
  if (localStorage.getItem('tamaya-theme') === 'dark') {
    document.documentElement.classList.add('dark');
  }
} catch {
  // ignore storage access errors
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
