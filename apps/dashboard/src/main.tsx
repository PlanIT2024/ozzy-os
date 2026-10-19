import { BitLab } from './BitPresence';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{(import.meta as unknown as {env:{DEV:boolean}}).env.DEV && location.pathname === '/bit-lab' ? <BitLab /> : <App />}</React.StrictMode>);
