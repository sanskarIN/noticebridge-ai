import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import BatchReview from './BatchReview';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{new URLSearchParams(window.location.search).get('view') === 'batch'
    ? <BatchReview /> : <App />}</React.StrictMode>
);
