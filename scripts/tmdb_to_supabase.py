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

def fetch_tmdb_discover(page: int = 1, year: int | None = None) -> dict:
    """
    Scarica una pagina di film da /discover/movie.
    Se year è valorizzato, filtra per quell'anno (range di date).
    """
    url = "https://api.themoviedb.org/3/discover/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "page": page,
        "language": "en-US",
        "sort_by": "vote_count.desc",
        "include_adult": "false",
        "include_video": "false",
    }

    if year is not None:
        # Limitiamo a film con data di uscita nell'anno specificato
        params["primary_release_date.gte"] = f"{year}-01-01"
        params["primary_release_date.lte"] = f"{year}-12-31"

    resp = requests.get(url, params=params, timeout=30)
    resp.raise_for_status()
    return resp.json()



def get_italian_title(raw):
    translations = raw.get("translations", {}).get("translations", [])
    for t in translations:
        if t.get("iso_639_1") == "it":
            return t.get("data", {}).get("title")
    return None

def should_keep_movie(raw: dict) -> bool:
    vote_count = raw.get("vote_count") or 0
    popularity = raw.get("popularity") or 0

    return vote_count >= 10 or popularity > 2


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
  
  title_it = get_italian_title(raw)

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
    "title_it": title_it,
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

def ingest_discover_by_year(start_year: int, end_year: int, max_pages_per_year: int):
  """
  Usa /discover/movie per ogni anno nel range [start_year, end_year],
  fino a max_pages_per_year (ma mai oltre 500, limite TMDb).
  """
  print(
      f"Starting TMDb → Supabase ingest for discover(movie) by year "
      f"{start_year}-{end_year}, up to {max_pages_per_year} pages/year..."
  )

  for year in range(start_year, end_year + 1):
    try:
      # Prima pagina, per capire quante pagine esistono davvero
      first_page_data = fetch_tmdb_discover(page=1, year=year)
    except Exception as e:
      print(f"[{year}] Error fetching TMDb discover page 1: {e}", file=sys.stderr)
      continue  # passo all'anno successivo

    total_pages_tmdb = int(first_page_data.get("total_pages", 1))
    # Non andiamo oltre il limite TMDb (500) né oltre il nostro limite per anno
    pages_to_fetch = min(total_pages_tmdb, max_pages_per_year, 500)

    # Ingest pagina 1
    results = first_page_data.get("results") or []

    kept = []
    discarded = 0

    for m in results:
        if should_keep_movie(m):
            kept.append(normalize_movie(m))
        else:
            discarded += 1

    movies = kept
    print(f"[{year}] Scartati {discarded} film (vote/pop troppo bassi)")

    try:
      upsert_movies(movies)
    except Exception as e:
      print(f"[{year}] Error upserting discover page 1: {e}", file=sys.stderr)
      continue

    print(
      f"[{year}] Upserted discover page 1/{pages_to_fetch} "
      f"({len(movies)} movies)."
    )
    time.sleep(0.5)

    # Ingest pagine 2..N
    for page in range(2, pages_to_fetch + 1):
      try:
        data = fetch_tmdb_discover(page=page, year=year)
      except Exception as e:
        print(
            f"[{year}] Error fetching TMDb discover page {page}: {e}",
            file=sys.stderr,
        )
        break

      results = data.get("results") or []

      kept = []
      discarded = 0

      for m in results:
          if should_keep_movie(m):
              kept.append(normalize_movie(m))
          else:
              discarded += 1

      movies = kept
      print(f"[{year}] Scartati {discarded} film (vote/pop troppo bassi)")


      try:
        upsert_movies(movies)
      except Exception as e:
        print(
          f"[{year}] Error upserting discover page {page}: {e}",
          file=sys.stderr,
        )
        break

      print(
        f"[{year}] Upserted discover page {page}/{pages_to_fetch} "
        f"({len(movies)} movies)."
      )
      time.sleep(0.5)

def fetch_popular_people_page(page: int):
  """Scarica una pagina di persone popolari da TMDb."""
  url = f"https://api.themoviedb.org/3/person/popular"
  params = {
    "api_key": TMDB_API_KEY,
    "page": page,
    "language": "en-US",
  }

  resp = SESSION.get(url, params=params, timeout=30)
  if not resp.ok:
    print("TMDb /person/popular error:", resp.status_code, resp.text, file=sys.stderr)
    resp.raise_for_status()

  data = resp.json()
  return data.get("results", [])

def fetch_person_credits(person_id: int) -> int:
    """
    Ritorna il numero totale di credits (cast + crew) di una persona TMDb.
    Usa /person/{id}/combined_credits.
    """
    url = f"https://api.themoviedb.org/3/person/{person_id}/combined_credits"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
    }
    resp = SESSION.get(url, params=params, timeout=30)
    if not resp.ok:
        print(f"TMDb combined_credits error for person {person_id}:",
              resp.status_code, resp.text, file=sys.stderr)
        return 0

    data = resp.json()
    cast = data.get("cast") or []
    crew = data.get("crew") or []
    return len(cast) + len(crew)


def normalize_person(raw: dict) -> dict:
    """Prende un record TMDb person e lo mappa al nostro schema Supabase."""
    person_id = raw["id"]

    credits_count = fetch_person_credits(person_id)

    return {
        "id": person_id,
        "name": raw.get("name") or "",
        "original_name": raw.get("original_name"),
        "known_for_department": raw.get("known_for_department"),
        "profile_path": raw.get("profile_path"),
        "popularity": raw.get("popularity"),
        "gender": raw.get("gender"),
        "adult": raw.get("adult"),
        "also_known_as": raw.get("also_known_as") or [],
        "credits_count": credits_count,
    }



def upsert_people(people: list[dict]):
  """Fa upsert in Supabase sulla tabella public.people."""
  if not people:
    return

  url = f"{SUPABASE_URL}/rest/v1/people"
  params = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
  }
  headers = {
    "apikey": SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates",
  }

  resp = SESSION.post(url, params=params, json=people, headers=headers, timeout=60)
  if not resp.ok:
    print("Supabase upsert people error:", resp.status_code, resp.text, file=sys.stderr)
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

    kept = []
    discarded = 0

    for m in results:
        if should_keep_movie(m):
            kept.append(normalize_movie(m))
        else:
            discarded += 1

    movies = kept
    print(f"[popular page {page}] Scartati {discarded} film (vote/pop troppo bassi)")

    try:
      upsert_movies(movies)
    except Exception as e:
      print(f"Error upserting page {page}: {e}", file=sys.stderr)
      break

    print(f"Upserted page {page}/{total_pages} ({len(movies)} movies).")
    # piccolo sleep per non stressare TMDb
    time.sleep(0.5)
  

  # --- DISCOVER (vote_count.desc) PER ANNO ---
  discover_start_year = int(os.environ.get("TMDB_DISCOVER_START_YEAR", "1950"))
  discover_end_year = int(os.environ.get("TMDB_DISCOVER_END_YEAR", "2024"))
  discover_max_pages_per_year = int(
      os.environ.get("TMDB_DISCOVER_MAX_PAGES_PER_YEAR", "50")
  )
  # 50 pagine/anno = 1000 film/anno; su 75 anni ~75k film.

  if discover_max_pages_per_year > 0:
      ingest_discover_by_year(
          discover_start_year,
          discover_end_year,
          discover_max_pages_per_year,
      )


  # --- Ingest persone popolari TMDb ---
  people_pages = int(os.environ.get("TMDB_PEOPLE_PAGES", "50"))

  print(f"Starting TMDb → Supabase ingest for {people_pages} pages of 'popular people'")

  for page in range(1, people_pages + 1):
    try:
      results = fetch_popular_people_page(page)
      people = [normalize_person(p) for p in results]
      upsert_people(people)
    except Exception as e:
      print(f"Error upserting people page {page}: {e}", file=sys.stderr)
      break

    print(f"Upserted people page {page}/{people_pages} ({len(people)} people).")
    time.sleep(0.5)

  print("Done.")


  print("Done.")


if __name__ == "__main__":
  main()
