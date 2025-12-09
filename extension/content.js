// content.js - Phase 4: TMDb-backed suggestions overlay

console.log('[letterboxd-better-search] Content script loaded on:', window.location.href);

// === TMDb configuration ===
// === TMDb configuration ===
// TMDB_API_KEY viene fornita da config.js (che NON è committato).
// Se non è definita, usiamo un placeholder e ci affidiamo ai dummy suggestions.
const TMDB_API_KEY =
  (typeof window !== 'undefined' && window.LBS_TMDB_API_KEY) || 'YOUR_TMDB_API_KEY_HERE';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// Riferimenti globali (per questa pagina)
let lbsSearchInput = null;
let lbsOverlay = null;
let lbsOverlayList = null;

// Per gestire il debounce delle richieste TMDb
let tmdbTimeoutId = null;
let lastRequestedQuery = '';

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
 */
function createOverlay() {
  if (lbsOverlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'lbs-suggestion-overlay';

  const header = document.createElement('div');
  header.className = 'lbs-suggestion-header';
  header.textContent = 'Letterboxd Better Search (TMDb demo)';
  overlay.appendChild(header);

  const list = document.createElement('ul');
  overlay.appendChild(list);

  document.body.appendChild(overlay);

  lbsOverlay = overlay;
  lbsOverlayList = list;

  console.log('[letterboxd-better-search] Overlay created.');
}

/**
 * Posiziona l’overlay sotto la search bar.
 */
function positionOverlay() {
  if (!lbsSearchInput || !lbsOverlay) return;

  const rect = lbsSearchInput.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  lbsOverlay.style.left = `${rect.left + scrollX}px`;
  lbsOverlay.style.top = `${rect.bottom + scrollY + 2}px`;
  lbsOverlay.style.width = `${rect.width}px`;
}

/**
 * Mostra/nasconde l’overlay.
 */
function showOverlay() {
  if (!lbsOverlay) return;
  positionOverlay();
  lbsOverlay.style.display = 'block';
}

function hideOverlay() {
  if (!lbsOverlay) return;
  lbsOverlay.style.display = 'none';
}

/**
 * Renderizza una lista di suggerimenti (stringhe) nell’overlay.
 */
function renderSuggestions(suggestions) {
  if (!lbsOverlay || !lbsOverlayList) return;

  if (!suggestions || suggestions.length === 0) {
    hideOverlay();
    return;
  }

  lbsOverlayList.innerHTML = '';

  suggestions.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;

    li.addEventListener('mousedown', (event) => {
      event.preventDefault();
      if (lbsSearchInput) {
        lbsSearchInput.value = text;
        console.log('[letterboxd-better-search] Suggestion clicked:', text);
        lbsSearchInput.focus();
      }
      hideOverlay();
    });

    lbsOverlayList.appendChild(li);
  });

  showOverlay();
}

/**
 * Suggerimenti dummy di fallback (usati se TMDb fallisce).
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
  const filtered = base.filter((title) => title.toLowerCase().includes(q));

  return (filtered.length > 0 ? filtered : base).slice(0, 5);
}

/**
 * Chiama TMDb /search/movie per ottenere suggerimenti reali.
 * Restituisce un array di stringhe tipo "Titolo (Anno)".
 */
async function fetchTmdbSuggestions(query) {
  if (!query || query.trim() === '') return [];

  if (!TMDB_API_KEY || TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
    console.warn('[letterboxd-better-search] TMDb API key not set. Using dummy suggestions.');
    return getDummySuggestions(query);
  }

  const url = `${TMDB_BASE_URL}/search/movie?api_key=${encodeURIComponent(
    TMDB_API_KEY
  )}&query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`;

  console.log('[letterboxd-better-search] Fetching TMDb suggestions for:', query);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMDb HTTP error: ${response.status}`);
  }

  const data = await response.json();
  const results = Array.isArray(data.results) ? data.results : [];

  const suggestions = results.slice(0, 5).map((movie) => {
    const title = movie.title || movie.name || 'Untitled';
    const year = movie.release_date ? movie.release_date.slice(0, 4) : '';
    return year ? `${title} (${year})` : title;
  });

  return suggestions;
}

/**
 * Debounce: aspetta un attimo dopo che l’utente smette di scrivere
 * prima di chiamare TMDb, per evitare una richiesta a tasto.
 */
function scheduleTmdbFetch(query) {
  lastRequestedQuery = query;

  if (tmdbTimeoutId) {
    clearTimeout(tmdbTimeoutId);
  }

  tmdbTimeoutId = setTimeout(async () => {
    try {
      const currentQuery = lastRequestedQuery;
      const suggestions = await fetchTmdbSuggestions(currentQuery);

      // Se nel frattempo il testo nella search bar è cambiato, ignoriamo questi risultati
      if (!lbsSearchInput || lbsSearchInput.value.trim() !== currentQuery.trim()) {
        console.log('[letterboxd-better-search] Ignoring outdated TMDb result for:', currentQuery);
        return;
      }

      renderSuggestions(suggestions);
    } catch (err) {
      console.error('[letterboxd-better-search] TMDb error, falling back to dummy suggestions:', err);
      const fallback = getDummySuggestions(lastRequestedQuery);
      renderSuggestions(fallback);
    }
  }, 300); // 300ms = abbastanza reattivo ma non troppo aggressivo
}

/**
 * Attacca listener alla search bar + setup overlay.
 */
function attachSearchListener() {
  const input = findSearchInput();
  if (!input) return;

  if (input._lbsListenerAttached) {
    console.log('[letterboxd-better-search] Listener already attached to search input.');
    return;
  }
  input._lbsListenerAttached = true;
  lbsSearchInput = input;

  createOverlay();
  positionOverlay();

  // Listener sull’input: aggiorna i suggerimenti TMDb (con debounce)
  input.addEventListener('input', (event) => {
    const value = event.target.value;
    console.log('[letterboxd-better-search] User typed in search bar:', value);

    if (!value || value.trim() === '') {
      renderSuggestions([]);
      return;
    }

    // Mostriamo subito un messaggio di "loading"
    renderSuggestions([`Searching TMDb for "${value}"...`]);
    scheduleTmdbFetch(value);
  });

  // Focus: se c’è già testo, ricarichiamo i suggerimenti per quella query
  input.addEventListener('focus', () => {
    const value = input.value;
    if (value && value.trim() !== '') {
      renderSuggestions([`Searching TMDb for "${value}"...`]);
      scheduleTmdbFetch(value);
    }
  });

  // Blur: nascondiamo l’overlay dopo un piccolo delay per permettere click sui suggerimenti
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

/**
 * Hook di debug: permette di riattaccare i listener dall’esterno
 * dispatchando l’evento "lbs-reload" sulla window.
 */
window.addEventListener('lbs-reload', attachSearchListener);

// Esegui appena il DOM è pronto
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachSearchListener);
} else {
  attachSearchListener();
}
