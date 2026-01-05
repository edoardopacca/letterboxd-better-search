# Letterboxd Better Search

Letterboxd Better Search is a browser extension that improves Letterboxd’s search experience by adding fuzzy, typo-tolerant suggestions ranked by popularity.

It helps you find the right movie even when you mistype, without replacing or breaking Letterboxd’s native search.

![Letterboxd-better-search demo](github-image/letterboxd-search.png)

✨ Features

- 🔍 Fuzzy search (e.g. incepton → Inception)
- ⭐ Popularity-aware ranking (famous movies first)
- 🧠 Dynamic ranking based on query length
- ⌨️ Keyboard navigation (↑ ↓ Enter)
- 🪄 Clean dropdown UI directly under the search bar
- 🚫 Disables browser autocomplete only on Letterboxd search

🧩 How it works

1. You type in the Letterboxd search bar
2. The extension intercepts the input
3. A Supabase-hosted dataset (ingested nightly from TMDb) is queried via RPC
4. Results are ranked using:
   - fuzzy matching
   - vote count / popularity thresholds based on query length
5. Suggestions appear in a dropdown under the search bar
6. Selecting a suggestion redirects to the standard Letterboxd search page

➡️ No Letterboxd API, no scraping, no UI replacement

## 🚀 Installation (Chrome / Brave / Edge)

The extension is not published yet — install it as an unpacked extension.

Clone this repository:

```bash
git clone https://github.com/edoardopacca/letterboxd-better-search.git
```

Open Chrome and go to:

```
chrome://extensions
```

1. Enable Developer mode
2. Click Load unpacked
3. Select the `extension/` folder

Done ✅

Go to https://letterboxd.com and start typing in the search bar.

## 🧭 Safari support

Safari is supported via a separate wrapper located in:

```
safari-extension/
```

You must:

- Open it with Xcode
- Build & enable the extension manually

(Chrome-compatible browsers are recommended for development.)

## 🔐 Configuration & Keys (important)

✅ Users do NOT need any API keys

- TMDb is used only server-side (GitHub Actions)
- Supabase anon key is public-safe and read-only
- Everything works out of the box

### config.js

The extension expects a `config.js` file:

```js
window.LBS_SUPABASE_URL = 'https://<your-project>.supabase.co';
window.LBS_SUPABASE_ANON_KEY = '<public anon key>';

// Optional — NOT required for users
window.LBS_TMDB_API_KEY = 'OPTIONAL_DEV_KEY';
```

⚠️ Regular users do not need a TMDb key.

## 🗃 Dataset & Ingestion

The movie/person dataset is ingested nightly from TMDb → Supabase using GitHub Actions.

Workflow:

```
.github/workflows/tmdb_ingest.yml 
```

### tmdb_ingest

Script:

```
scripts/tmdb_to_supabase.py
```

The ingest:

- Fetches movies + people from TMDb
- Applies filtering (years, pages, popularity)
- Stores everything in Supabase
- Exposes a `search_all` RPC used by the extension

No manual setup required unless you are modifying the dataset.

## 🧾 Supabase SQL (transparency)

For reproducibility, the SQL used on the Supabase side (RPC functions + indexes) is included here:

- `supabase/search_functions.sql`

This is **not required** to use the extension, but documents the database-side search logic (`search_movies`, `search_people`, `search_all`) and the related Postgres indexes/extensions.

## 🧪 Development notes

- Manifest: V3
- Content script runs on:
  - `https://letterboxd.com/*`
- Main logic:
  - `extension/content.js` 
- UI:
  - injected overlay (`overlay.css`)
- Debounce: ~300ms
- Browser autocomplete is disabled only on Letterboxd search inputs

## 🛣 Roadmap

- Better semantic ranking
- People vs movies visual distinction
- Settings toggle
- Public store release

## 📄 License

MIT License
