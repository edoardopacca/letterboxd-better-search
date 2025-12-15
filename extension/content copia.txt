// content.js - Phase 5: TMDb-backed suggestions overlay + fuzzy/semantic ranking

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

/* ========================================================================== */
/* PHASE 5: FUZZY + SEMANTIC RANKING HELPERS                                   */
/* ========================================================================== */

/**
 * Estrae informazioni utili dalla query:
 * - raw: stringa originale
 * - cleanText: testo "pulito" senza l'eventuale anno
 * - year: anno (se presente nella query, tipo 1999, 2010, ecc.)
 * - tokens: parole significative (lunghezza >= 2)
 */

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





function extractQueryInfo(rawQuery) {
  const info = {
    raw: rawQuery || '',
    cleanText: '',
    year: null,
    tokens: []
  };

  if (!rawQuery || typeof rawQuery !== 'string') {
    return info;
  }

  let text = rawQuery.toLowerCase().trim();

  // Cerca un anno plausibile (1900–2099)
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    info.year = parseInt(yearMatch[1], 10);
    // Rimuove l'anno dal testo
    text = text.replace(yearMatch[0], '').trim();
  }

  const tokens = text.split(/\s+/).filter((t) => t.length >= 2);
  info.tokens = tokens;
  info.cleanText = tokens.join(' ').trim();

  return info;
}

/**
 * Distanza di Levenshtein classica, O(m*n).
 */
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const aLen = a.length;
  const bLen = b.length;

  const dp = new Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) {
    dp[j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    let prev = i;
    for (let j = 1; j <= bLen; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
    dp[0] = i;
  }

  return dp[bLen];
}

/**
 * Similarità fuzzy normalizzata in [0, 1] a partire dalla distanza di Levenshtein.
 */
function fuzzySimilarity(a, b) {
  if (!a || !b) return 0;
  const aNorm = a.toLowerCase().trim();
  const bNorm = b.toLowerCase().trim();
  if (!aNorm || !bNorm) return 0;

  const maxLen = Math.max(aNorm.length, bNorm.length);
  if (maxLen === 0) return 0;

  const dist = levenshteinDistance(aNorm, bNorm);
  const similarity = 1 - dist / maxLen;
  return Math.max(0, Math.min(1, similarity));
}

/**
 * Score basato sull'overview: quante parole della query compaiono nella trama.
 * Risultato in [0, 1].
 */
function computeOverviewScore(movie, queryInfo) {
  const overview = (movie.overview || '').toLowerCase();
  if (!overview || !queryInfo.tokens || queryInfo.tokens.length === 0) {
    return 0;
  }

  let matched = 0;
  for (const token of queryInfo.tokens) {
    if (overview.includes(token)) {
      matched++;
    }
  }

  if (queryInfo.tokens.length === 0) return 0;
  return matched / queryInfo.tokens.length;
}

/**
 * Score di anno:
 * - Se l'utente specifica l'anno, premiamo match esatti e vicini.
 * - Se non lo specifica, usiamo un leggero bias verso i film più recenti.
 */
function computeYearScore(movie, queryInfo) {
  const releaseDate = movie.release_date || movie.first_air_date || '';
  const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;
  if (!releaseYear || Number.isNaN(releaseYear)) {
    return 0;
  }

  const currentYear = new Date().getFullYear();

  if (queryInfo.year) {
    const diff = Math.abs(releaseYear - queryInfo.year);
    if (diff === 0) return 1;
    // Decade di tolleranza: a 10 anni di distanza lo score va verso 0
    const score = 1 - diff / 10;
    return Math.max(0, Math.min(1, score));
  } else {
    // Leggero bias di recency: film recenti ~1, molto vecchi ~0
    const age = currentYear - releaseYear;
    const score = 1 - age / 50; // 50 anni -> 0
    return Math.max(0, Math.min(1, score));
  }
}

/**
 * Normalizza popolarità nel range [0, 1] rispetto al min/max dei risultati correnti.
 */
function computePopularityNorm(popularity, popStats) {
  const pop = typeof popularity === 'number' ? popularity : 0;
  const { min, max } = popStats;
  if (max <= min) {
    return 0.5; // tutti uguali: valore medio
  }
  return (pop - min) / (max - min);
}
// prova
/**
 * Calcola il punteggio finale per un film dato la query e le statistiche di popolarità.
 */
function computeMovieScore(movie, queryInfo, popStats) {
  const title =
    (movie.title || movie.name || movie.original_title || movie.original_name || '').toLowerCase();
  const origTitle = (movie.original_title || movie.original_name || '').toLowerCase();

  const queryText =
    queryInfo.cleanText ||
    queryInfo.raw.toLowerCase().trim(); // fallback alla query raw se cleanText è vuoto

  let titleScore = 0;

  if (queryText) {
    const simTitle = fuzzySimilarity(queryText, title);
    const simOrig = fuzzySimilarity(queryText, origTitle || title);
    titleScore = Math.max(simTitle, simOrig);

    // Bonus se la query è substring del titolo (match "quasi-esatto")
    if (title && queryText && title.includes(queryText)) {
      titleScore = Math.min(1, titleScore + 0.1);
    }
  }

  const overviewScore = computeOverviewScore(movie, queryInfo);
  const yearScore = computeYearScore(movie, queryInfo);
  const popNorm = computePopularityNorm(movie.popularity, popStats);

  // Pesi: titolo dominante, poi overview/popolarità, poi anno
  const finalScore =
    0.6 * titleScore + 0.15 * overviewScore + 0.15 * popNorm + 0.1 * yearScore;

  return finalScore;
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
 * Suggerimenti dummy di fallback (usati se TMDb fallisce).
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
 * Chiama TMDb /search/movie per ottenere suggerimenti reali.
 * Ora:
 *  - prende i risultati grezzi,
 *  - calcola uno score fuzzy/semantico,
 *  - ordina per score,
 *  - restituisce un array di stringhe tipo "Titolo (Anno)".
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

  if (results.length === 0) {
    return [];
  }

  const queryInfo = extractQueryInfo(query);

  // Statistiche di popolarità per normalizzare in [0, 1]
  const popularityValues = results.map((m) =>
    typeof m.popularity === 'number' ? m.popularity : 0
  );
  const popStats = {
    min: Math.min(...popularityValues),
    max: Math.max(...popularityValues)
  };

  const scored = results.map((movie) => {
    const score = computeMovieScore(movie, queryInfo, popStats);
    return { movie, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, 5);

  const suggestions = top.map(({ movie }) => {
  const rawTitle = movie.title || movie.name || 'Untitled';
  const year = movie.release_date ? movie.release_date.slice(0, 4) : '';

  const label = rawTitle;
  const searchQuery = year ? `${rawTitle} (${year})` : rawTitle;

  return { label, searchQuery };
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
  // Disattiva cronologia/autocomplete del browser su questo input
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');


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
    renderSuggestions([`Searching Supabase for "${value}"...`]);
    scheduleTmdbFetch(value);
  });

  // Focus: se c’è già testo, ricarichiamo i suggerimenti per quella query
  input.addEventListener('focus', () => {
    const value = input.value;
    if (value && value.trim() !== '') {
      renderSuggestions([`Searching Supabase for "${value}"...`]);
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