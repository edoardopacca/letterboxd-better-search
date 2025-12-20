// content.js 
console.log('[lbs] content.js VERSION 9 - safari debug');

console.log('[letterboxd-better-search] Content script loaded on:', window.location.href);

// === TMDb configuration ===
// TMDB_API_KEY viene fornita da config.js (che NON è committato).
// Se non è definita, usiamo un placeholder e ci affidiamo ai dummy suggestions.
// TMDb config...
const TMDB_API_KEY =
  (typeof window !== 'undefined' && window.LBS_TMDB_API_KEY) || 'YOUR_TMDB_API_KEY_HERE';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

// === Supabase configuration ===
const SUPABASE_URL =
  (typeof window !== 'undefined' && window.LBS_SUPABASE_URL) || null;
const SUPABASE_ANON_KEY =
  (typeof window !== 'undefined' && window.LBS_SUPABASE_ANON_KEY) || null;

// Riferimenti globali (per questa pagina)
let lbsSearchInput = null;
let lbsOverlay = null;
let lbsOverlayList = null;
let lbsSelectedIndex = -1;
let lbsCurrentSuggestions = [];


// Per gestire il debounce delle richieste TMDb
let tmdbTimeoutId = null;
let lastRequestedQuery = '';


async function searchAllSupabase(query, limit = 10) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[letterboxd-better-search] Supabase config missing');
    return [];
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        q: query,
        limit_count: limit,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[letterboxd-better-search] Supabase RPC error', response.status, text);
      return [];
    }

    const data = await response.json();
    console.log('[letterboxd-better-search] Supabase search_all results for', query, data);
    return data;
  } catch (err) {
    console.error('[letterboxd-better-search] fetch error:', err);
    return [];
  }
}


function buildLetterboxdSearchUrl(query) {
  const origin = window.location.origin || 'https://letterboxd.com';
  const trimmed = (query || '').trim();

  if (!trimmed) {
    return null;
  }

  // encodeURIComponent gestisce i caratteri strani;
  // poi sostituiamo gli spazi con '+' e teniamo le parentesi "belle"
  const encoded = encodeURIComponent(trimmed)
    .replace(/%20/g, '+')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');

  return `${origin}/search/${encoded}/`;
}

function goToLetterboxdSearch(query) {
  const url = buildLetterboxdSearchUrl(query);
  if (!url) return;
  window.location.href = url;
}



async function fetchSupabaseSuggestions(query, limit = 10) {
  if (!query || !query.trim()) {
    return [];
  }

  console.log(
    '[letterboxd-better-search] Fetching Supabase suggestions (search_all) for:',
    query
  );

  const results = await searchAllSupabase(query, limit);

  const suggestions = results.map((row) => {
    if (row.result_type === 'movie') {
      const title = row.title || 'Untitled';
      const year = row.release_year;

      return {
        type: 'movie',
        label: year ? `${title} (${year})` : title,  // puoi togliere l'anno se vuoi
        searchQuery: title,                           // per la ricerca Letterboxd
      };
    }

    if (row.result_type === 'person') {
      const name = row.name || 'Unknown person';

      return {
        type: 'person',
        label: name,
        searchQuery: name,                            // per ora mandiamo alla search generale
      };
    }

    // fallback (non dovrebbe succedere)
    return {
      type: 'unknown',
      label: row.title || row.name || 'Unknown',
      searchQuery: row.title || row.name || '',
    };
  });

  return suggestions;
}

/* ========================================================================== */
/* OVERLAY & TMDb FETCHING                                                    */
/* ========================================================================== */

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
  header.textContent = 'Letterboxd Better Search (Supabase demo)';
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

function renderLoadingSuggestion(query) {
  if (!lbsOverlay || !lbsOverlayList) return;

  lbsCurrentSuggestions = [];
  lbsSelectedIndex = -1;
  lbsOverlayList.innerHTML = '';

  const li = document.createElement('li');
  li.textContent = `Searching Supabase for "${query}"...`;
  li.classList.add('lbs-loading'); // opzionale, per uno stile diverso
  // NIENTE click handler: non dev'essere cliccabile

  lbsOverlayList.appendChild(li);
  showOverlay();
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
  lbsCurrentSuggestions = suggestions || [];
  lbsSelectedIndex = -1;


  // Svuota lista
  lbsOverlayList.innerHTML = '';

  suggestions.forEach((item) => {
    // Supporta sia stringhe (vecchio formato) sia oggetti (nuovo formato)
    let label;
    let searchQuery;

    if (typeof item === 'string') {
      label = item;
      searchQuery = item;
    } else if (item && typeof item === 'object') {
      label = item.label || item.searchQuery || '';
      searchQuery = item.searchQuery || item.label || '';
    } else {
      return; // salta item strani
    }

    if (!label) return;

    const li = document.createElement('li');
    li.textContent = label;

    // Evitiamo che il blur sull'input annulli il click
    li.addEventListener('mousedown', (event) => {
      event.preventDefault();

      // Vai alla pagina di ricerca Letterboxd basata su searchQuery
      goToLetterboxdSearch(searchQuery);

      hideOverlay();
    });

    lbsOverlayList.appendChild(li);
  });

  showOverlay();
}

function moveSelection(delta) {
  if (!lbsOverlayList) return;
  const items = Array.from(lbsOverlayList.querySelectorAll('li'));
  if (!items.length) return;

  // aggiorna indice (con wrap-around)
  lbsSelectedIndex += delta;
  if (lbsSelectedIndex < 0) lbsSelectedIndex = items.length - 1;
  if (lbsSelectedIndex >= items.length) lbsSelectedIndex = 0;

  items.forEach((el, i) => {
    if (i === lbsSelectedIndex) {
      el.classList.add('lbs-selected');
      el.scrollIntoView({ block: 'nearest' });
    } else {
      el.classList.remove('lbs-selected');
    }
  });
}

function activateSelectedSuggestion() {
  if (!lbsCurrentSuggestions || lbsSelectedIndex < 0) return;
  const item = lbsCurrentSuggestions[lbsSelectedIndex];
  if (!item) return;

  const searchQuery =
    typeof item === 'string'
      ? item
      : item.searchQuery || item.label || '';

  if (searchQuery) {
    goToLetterboxdSearch(searchQuery);
    hideOverlay();
  }
}


/**
 * Suggerimenti dummy di fallback (usati se fallisce).
 */
function getDummySuggestions(query) {
  if (!query || query.trim() === '') return [];

  const base = [
    'Inception',
    'La La Land',
    'The Godfather',
    'Avatar',
    'The Dark Knight'
  ];

  // Filtra / adatta come fai ora...
  const filtered = base.filter((title) =>
    title.toLowerCase().includes(query.toLowerCase())
  );

  // Torna oggetti con label+searchQuery uguali
  return filtered.map((title) => ({
    label: title,
    searchQuery: title
  }));
}


/**
 * Debounce: aspetta un attimo dopo che l’utente smette di scrivere
 */
function scheduleSupabaseFetch(query) {
  lastRequestedQuery = query;

  if (tmdbTimeoutId) {
    clearTimeout(tmdbTimeoutId);
  }

  tmdbTimeoutId = setTimeout(async () => {
    const currentQuery = lastRequestedQuery;

    try {
      const suggestions = await fetchSupabaseSuggestions(currentQuery);

      // Se nel frattempo il testo è cambiato, ignora questi risultati
      if (
        !lbsSearchInput ||
        lbsSearchInput.value.trim() !== currentQuery.trim()
      ) {
        console.log(
          '[letterboxd-better-search] Ignoring outdated result for:',
          currentQuery
        );
        return;
      }

      renderSuggestions(suggestions);
    } catch (err) {
      console.error(
        '[letterboxd-better-search] Supabase error, falling back to dummy suggestions:',
        err
      );
      const fallback = getDummySuggestions(lastRequestedQuery);
      renderSuggestions(fallback);
    }
  }, 100); // 100ms 
}


/**
 * Attacca listener alla search bar + setup overlay.
 */
function attachSearchListener(retryCount = 0) {
  const input = findSearchInput();
  if (!input) {
    // se il campo non è ancora nel DOM, riprova qualche volta
    if (retryCount < 10) {
      setTimeout(() => attachSearchListener(retryCount + 1), 300);
    }
    return;
  }
  if (input._lbsListenerAttached) {
    console.log('[letterboxd-better-search] Listener already attached to search input.');
    return;
  }
  input._lbsListenerAttached = true;
  lbsSearchInput = input;
  // Disattiva cronologia/autocomplete del browser su questo input
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');


  createOverlay();
  positionOverlay();

  // Listener sull’input: aggiorna i suggerimenti 
  input.addEventListener('input', (event) => {
    const value = event.target.value;
    console.log('[letterboxd-better-search] User typed in search bar:', value);

    if (!value || value.trim() === '') {
      renderSuggestions([]);
      return;
    }

    // Mostriamo subito un messaggio di "loading" non cliccabile
    renderLoadingSuggestion(value);
    scheduleSupabaseFetch(value);
  });

  // Focus: se c’è già testo, ricarichiamo i suggerimenti per quella query
  input.addEventListener('focus', () => {
    const value = input.value;
    if (value && value.trim() !== '') {
      renderLoadingSuggestion(value);
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

  // ... gli addEventListener che già hai ...
  // Gestione frecce e Invio sulla nostra lista
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === 'Enter') {
      // Se c'è un elemento selezionato, usiamo quello
      if (lbsSelectedIndex >= 0) {
        event.preventDefault();
        activateSelectedSuggestion();
      }
      // altrimenti lasciamo comportamento normale (search di Letterboxd)
    }
  });

  // Se c'è già del testo (es. l'utente ha scritto "mar" prima che ci attaccassimo),
  // lancia subito la ricerca
  const initialValue = input.value;
  if (initialValue && initialValue.trim() !== '') {
    renderLoadingSuggestion(initialValue);
    scheduleSupabaseFetch(initialValue); // o scheduleSupabaseFetch se l'hai rinominata
  }


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
