import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AppErrorBoundary } from './components/GlobalErrorBanner';
import './styles/app.css';

const mount = document.getElementById('app');
if (!mount) throw new Error('MyPath app mount is missing');
createRoot(mount).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>);
