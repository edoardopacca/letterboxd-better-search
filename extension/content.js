// content.js - Phase 3: search bar + custom suggestion overlay

console.log('[letterboxd-better-search] Content script loaded on:', window.location.href);

// Riferimenti globali (per questa pagina)
let lbsSearchInput = null;
let lbsOverlay = null;
let lbsOverlayList = null;

/**
 * Trova il campo di ricerca principale di Letterboxd.
 */
function findSearchInput() {
  const selectors = [
    'input[type="search"]',
    'input#search-q',
    'form[action*="/search/"] input[name="q"]',
    'input[name="q"][placeholder*="Search"]'
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
 * Crea il div dell’overlay e lo aggiunge al DOM.
 * Rimane nascosto fino a quando abbiamo suggerimenti da mostrare.
 */
function createOverlay() {
  if (lbsOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'lbs-suggestion-overlay';

  // Header opzionale (per branding/debug)
  const header = document.createElement('div');
  header.className = 'lbs-suggestion-header';
  header.textContent = 'Letterboxd Better Search (dummy suggestions)';
  overlay.appendChild(header);

  // Lista dei suggerimenti
  const list = document.createElement('ul');
  overlay.appendChild(list);

  document.body.appendChild(overlay);

  lbsOverlay = overlay;
  lbsOverlayList = list;

  console.log('[letterboxd-better-search] Overlay created.');
}

/**
 * Posiziona l’overlay sotto la search bar, allineato in larghezza.
 */
function positionOverlay() {
  if (!lbsSearchInput || !lbsOverlay) return;

  const rect = lbsSearchInput.getBoundingClientRect(); 
  // restituisce le coordinate dell’input nel viewport (cioè nella finestra visibile).
  // siccome la pagina può essere scrollata :
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  
  lbsOverlay.style.left = `${rect.left + scrollX}px`;
  lbsOverlay.style.top = `${rect.bottom + scrollY + 2}px`; // 2px di margine
  lbsOverlay.style.width = `${rect.width}px`;
}

/**
 * Mostra l’overlay.
 */
function showOverlay() {
  if (!lbsOverlay) return;
  positionOverlay();
  lbsOverlay.style.display = 'block';
}

/**
 * Nasconde l’overlay.
 */
function hideOverlay() {
  if (!lbsOverlay) return;
  lbsOverlay.style.display = 'none';
}

/**
 * Renderizza una lista di suggerimenti (stringhe) nell’overlay.
 */
function renderSuggestions(suggestions) {
  if (!lbsOverlay || !lbsOverlayList) return;

  // Se non ci sono suggerimenti, nascondiamo l’overlay
  if (!suggestions || suggestions.length === 0) {
    hideOverlay();
    return;
  }

  // Svuota la lista
  lbsOverlayList.innerHTML = '';

  suggestions.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;

    li.addEventListener('mousedown', (event) => {
      // mousedown invece di click per evitare che il blur sulla input nasconda l’overlay troppo presto
      event.preventDefault();
      if (lbsSearchInput) {
        lbsSearchInput.value = text;
        console.log('[letterboxd-better-search] Suggestion clicked:', text);
        // manteniamo comunque il comportamento nativo: l’utente può ancora premere Enter ecc.
        lbsSearchInput.focus();
      }
      hideOverlay();
    });

    lbsOverlayList.appendChild(li);
  });

  showOverlay();
}

/**
 * Genera suggerimenti "dummy" a partire dal testo digitato.
 * Per ora è solo una demo. Più avanti useremo TMDb + fuzzy search.
 */
function getDummySuggestions(query) {
  if (!query || query.trim() === '') return [];

  const base = [
    'The Godfather',
    'The Godfather: Part II',
    'The Dark Knight',
    'Pulp Fiction',
    'Inception',
    'La La Land',
    'Spirited Away',
    'Parasite',
    'Fight Club',
    'Interstellar'
  ];

  const q = query.toLowerCase();
  // Filtrino banalissimo: titoli che contengono la substring
  const filtered = base.filter((title) => title.toLowerCase().includes(q));

  // Se il filtro è vuoto, proponiamo comunque i primi 5, giusto per avere sempre qualcosa
  return (filtered.length > 0 ? filtered : base).slice(0, 5);
}

/**
 * Attacca listener alla search bar + setup overlay.
 */
function attachSearchListener() {
  const input = findSearchInput();
  if (!input) return;

  // Evitiamo duplicazioni
  if (input._lbsListenerAttached) {
    console.log('[letterboxd-better-search] Listener already attached to search input.');
    return;
  }
  input._lbsListenerAttached = true;
  lbsSearchInput = input;

  // Crea l’overlay una volta sola
  createOverlay();
  positionOverlay();

  // Listener sull’input: aggiorna suggerimenti a ogni digitazione
  input.addEventListener('input', (event) => {
    const value = event.target.value;
    console.log('[letterboxd-better-search] User typed in search bar:', value);

    const suggestions = getDummySuggestions(value);
    renderSuggestions(suggestions);
  });

  // Quando la input riceve focus, se c’è testo mostriamo i suggerimenti
  input.addEventListener('focus', () => {
    if (input.value) {
      const suggestions = getDummySuggestions(input.value);
      renderSuggestions(suggestions);
    }
  });

  // Quando perde il focus, nascondiamo l’overlay dopo un piccolo delay
  // per permettere i click sui suggerimenti
  input.addEventListener('blur', () => {
    setTimeout(() => {
      hideOverlay();
    }, 150);
  });

  // Reposizioniamo l’overlay su resize/scroll
  window.addEventListener('resize', positionOverlay);
  window.addEventListener('scroll', positionOverlay);

  console.log('[letterboxd-better-search] Search input listener and overlay attached.');
}

// Esegui appena il DOM è pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachSearchListener);
} else {
  attachSearchListener();
}

window.addEventListener("lbs-reload", attachSearchListener);
