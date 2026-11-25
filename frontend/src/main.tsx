import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import PdfChat from './PdfChat';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{new URLSearchParams(window.location.search).get('view') === 'chat' ? <PdfChat /> : <App />}</React.StrictMode>
);
