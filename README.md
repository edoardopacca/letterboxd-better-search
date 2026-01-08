# Letterboxd Better Search

Letterboxd Better Search is a browser extension that improves Letterboxd’s search experience by adding a live suggestion panel that uses a smarter ranking than Letterboxd’s default search.

It helps you find the right movie even when you mistype, without replacing or breaking Letterboxd’s native search.

![Letterboxd-better-search demo](github-image/letterboxd-search.png)


🧩 How it works

1. You type in the Letterboxd search bar
2. The extension intercepts the input
3. There is a Supabase-hosted dataset which has currently ~ 140k movies.
4. The dataset is ingested nightly from TMDb (which Letterboxd publicly mentions as its movie database). 
5. Results are ranked using:
   - fuzzy matching
   - vote count / popularity 
   - year bonus (more recent, higher score)
6. Suggestions appear in a dropdown under the search bar
7. Selecting a suggestion redirects to the standard Letterboxd search page

## 🚀 Installation (Chrome / Brave / Edge)

The extension is not published yet — install it as an unpacked extension.

Clone this repository:

```bash
git clone https://github.com/edoardopacca/letterboxd-better-search.git
```

Open Chrome / Brave / Edge and go to:

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


## 🔐 Configuration & Keys


✅ Users do NOT need any API keys

- TMDb is used only server-side (GitHub Actions)
- Supabase anon key is public-safe and read-only
  

### config.js

The extension **needs** a `config.js` file:

```js
window.LBS_SUPABASE_URL = 'https://<your-project>.supabase.co';
window.LBS_SUPABASE_ANON_KEY = '<public anon key>';

// Optional — NOT required 
window.LBS_TMDB_API_KEY = 'OPTIONAL_DEV_KEY';
```

⚠️ Do NOT modify this file, unless you are modifying the dataset and the PostgreSQL queries. In that case you need your Supabase URL and ANON key, and to set your ingestion path. 


## 🗃 Dataset & Ingestion

The movie/person dataset is ingested nightly from TMDb → Supabase using GitHub Actions.

Workflow:

```
.github/workflows/tmdb_ingest.yml 
```

Script:

```
scripts/tmdb_to_supabase.py
```

The ingest:

- Fetches movies + people from TMDb
- Applies filtering (years, pages, popularity)
- Stores everything in Supabase

⚠️ Regular users do not need to modify these files, unless you are modifying the dataset as before. 

⚠️ These are **not required** for you to use the extension, but document the ingestion. Therefore, nothing happens if you modify or cancel them. 

## 🧾 Supabase SQL (transparency)

For reproducibility, the SQL used on the Supabase side (RPC functions + indexes) is included here:

- `supabase/search_functions.sql`

⚠️ This is **not required** to use the extension, but documents the database-side search logic (`search_movies`, `search_people`, `search_all`) and the related Postgres indexes/extensions.

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


## 📄 License

MIT License
