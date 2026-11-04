import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppBoundary } from './components/PanelBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root 容器缺失，无法挂载应用。');
}

createRoot(container).render(
  <StrictMode>
    <AppBoundary>
      <App />
    </AppBoundary>
  </StrictMode>,
);
