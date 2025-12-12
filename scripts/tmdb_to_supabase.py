import os
import sys
import time
from datetime import datetime

import requests

TMDB_API_KEY = os.environ.get("TMDB_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not TMDB_API_KEY or not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
  print("Missing TMDB_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars", file=sys.stderr)
  sys.exit(1)

SESSION = requests.Session()
SESSION.headers.update({
  "apikey": SUPABASE_SERVICE_ROLE_KEY,
  "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
  "Content-Type": "application/json",
})


def fetch_tmdb_popular(page: int = 1) -> dict:
  """
  Scarica una pagina di film popolari da TMDb.
  """
  url = "https://api.themoviedb.org/3/movie/popular"
  params = {
    "api_key": TMDB_API_KEY,
    "page": page,
    "language": "en-US",
  }
  resp = requests.get(url, params=params, timeout=30)
  resp.raise_for_status()
  return resp.json()


def normalize_movie(raw: dict) -> dict:
  """
  Mappa un oggetto film di TMDb ai campi della tabella public.movies.
  Non tocchiamo i campi normalizzati / tsvector: per ora li aggiorniamo
  con una query SQL a parte quando serve.
  """
  release_date = raw.get("release_date") or None
  release_year = None
  if release_date:
    try:
      release_year = datetime.strptime(release_date, "%Y-%m-%d").year
    except Exception:
      release_year = None

  return {
    "id": raw["id"],
    "title": raw.get("title"),
    "original_title": raw.get("original_title"),
    "overview": raw.get("overview"),
    "release_date": release_date,
    "release_year": release_year,
    "popularity": raw.get("popularity"),
    "vote_average": raw.get("vote_average"),
    "vote_count": raw.get("vote_count"),
    "original_language": raw.get("original_language"),
    "genre_ids": raw.get("genre_ids") or [],
    "poster_path": raw.get("poster_path"),
  }


def upsert_movies(movies: list[dict]) -> None:
  """
  Esegue un upsert bulk sulla tabella public.movies via Supabase REST.
  """
  if not movies:
    return

  url = f"{SUPABASE_URL}/rest/v1/movies"
  params = {"on_conflict": "id"}
  headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",
  }

  resp = SESSION.post(url, params=params, json=movies, headers=headers, timeout=60)
  if not resp.ok:
    print("Supabase upsert error:", resp.status_code, resp.text, file=sys.stderr)
    resp.raise_for_status()


def main():
  # Quante pagine scaricare: ogni pagina ~20 film
  total_pages = int(os.environ.get("TMDB_PAGES", "30"))

  print(f"Starting TMDb → Supabase ingest for {total_pages} pages of 'popular'...")
  for page in range(1, total_pages + 1):
    try:
      data = fetch_tmdb_popular(page)
    except Exception as e:
      print(f"Error fetching TMDb popular page {page}: {e}", file=sys.stderr)
      break

    results = data.get("results") or []
    movies = [normalize_movie(m) for m in results]
    try:
      upsert_movies(movies)
    except Exception as e:
      print(f"Error upserting page {page}: {e}", file=sys.stderr)
      break

    print(f"Upserted page {page}/{total_pages} ({len(movies)} movies).")
    # piccolo sleep per non stressare TMDb
    time.sleep(0.5)

  print("Done.")


if __name__ == "__main__":
  main()
