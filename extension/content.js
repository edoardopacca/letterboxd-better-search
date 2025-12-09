// content.js - Phase 2: detect search bar and log user input

console.log('[letterboxd-better-search] Content script loaded on:', window.location.href);

/**
 * Trova il campo di ricerca principale di Letterboxd.
 * Usiamo più selettori per essere robusti a piccoli cambiamenti del DOM.
 */
function findSearchInput() {
  const selectors = [
    'input[type="search"]',                         // campo search "classico"
    'input#search-q',                               // ID usato spesso nei siti
    'form[action*="/search/"] input[name="q"]',     // input dentro il form di ricerca
    'input[name="q"][placeholder*="Search"]'        // fallback generico
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      console.log('[letterboxd-better-search] Search input found with selector:', selector);
      return el;
    }
  }

  console.log('[letterboxd-better-search] Search input NOT found on this page.');
  return null;
}

/**
 * Attacca un listener all’input di ricerca per loggare il testo digitato.
 * NON modifica in alcun modo il comportamento nativo del sito.
 */
function attachSearchListener() {
  const searchInput = findSearchInput();
  if (!searchInput) return;

  // Evitiamo di aggiungere più volte lo stesso listener
  if (searchInput._lbsListenerAttached) {
    console.log('[letterboxd-better-search] Listener already attached to search input.');
    return;
  }

  searchInput._lbsListenerAttached = true;

  searchInput.addEventListener('input', (event) => {
    const value = event.target.value;
    console.log('[letterboxd-better-search] User typed in search bar:', value);
  });

  console.log('[letterboxd-better-search] Search input listener attached.');
}

// Esegui appena il DOM è pronto (in MV3 il content script parte a document_idle)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachSearchListener);
} else {
  attachSearchListener();
}
