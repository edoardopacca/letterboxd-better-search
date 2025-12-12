import os
import time
from typing import Dict, Any, List, Tuple

import requests
from dotenv import load_dotenv
import meilisearch

# Load env vars from ../.env
load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")
MEILI_HOST = os.getenv("MEILI_HOST", "http://127.0.0.1:7700")
MEILI_MASTER_KEY = os.getenv("MEILI_MASTER_KEY")
MEILI_INDEX_NAME = "movies"


def ensure_env():
    if not TMDB_API_KEY:
        raise RuntimeError("TMDB_API_KEY is not set. Add it to backend/.env")
    if not MEILI_MASTER_KEY:
        raise RuntimeError("MEILI_MASTER_KEY is not set. Add it to backend/.env")


def create_meili_client() -> meilisearch.Client:
    return meilisearch.Client(MEILI_HOST, MEILI_MASTER_KEY)


def ensure_index(client: meilisearch.Client) -> meilisearch.index.Index:
    """
    Ensure the 'movies' index exists with proper settings.
    """
    from meilisearch.errors import MeilisearchApiError

    try:
        # Try to fetch the index from the server.
        index = client.get_index(MEILI_INDEX_NAME)
        print(f"Using existing Meilisearch index '{MEILI_INDEX_NAME}'")
    except MeilisearchApiError:
        # If it doesn't exist, create it.
        print(f"Index '{MEILI_INDEX_NAME}' not found. Creating it...")
        # This returns a TaskInfo, not an Index
        client.create_index(MEILI_INDEX_NAME, {"primaryKey": "id"})
        # Now get the actual Index object
        index = client.index(MEILI_INDEX_NAME)

    # Basic settings: which fields are searchable, filterable, sortable, etc.
    settings = {
        "searchableAttributes": [
            "title",
            "original_title",
            "overview",
        ],
        "displayedAttributes": [
            "id",
            "title",
            "original_title",
            "overview",
            "release_date",
            "release_year",
            "popularity",
            "vote_average",
            "vote_count",
            "original_language",
            "genre_ids",
            "poster_path",
        ],
        "filterableAttributes": [
            "release_year",
            "original_language",
            "genre_ids",
        ],
        "sortableAttributes": [
            "popularity",
            "vote_count",
            "release_date",
        ],
    }

    # This returns a TaskInfo, but we don't need it right now
    index.update_settings(settings)
    return index



def fetch_tmdb_page(page: int) -> Tuple[List[Dict[str, Any]], int]:
    """
    Fetch one page of movies from TMDb using the /discover/movie endpoint,
    sorted by popularity.
    """
    url = "https://api.themoviedb.org/3/discover/movie"
    params = {
        "api_key": TMDB_API_KEY,
        "language": "en-US",
        "sort_by": "popularity.desc",
        "include_adult": False,
        "include_video": False,
        "page": page,
    }

    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    results = data.get("results", [])
    total_pages = data.get("total_pages", 1)
    return results, total_pages


def normalize_movie(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize the TMDb movie object into the structure we'll store in Meilisearch.
    """
    release_date = raw.get("release_date") or None
    release_year = None
    if release_date and len(release_date) >= 4:
        try:
            release_year = int(release_date[:4])
        except ValueError:
            release_year = None

    return {
        "id": raw["id"],  # TMDb movie id, used as primary key
        "title": raw.get("title") or raw.get("original_title") or "",
        "original_title": raw.get("original_title"),
        "overview": raw.get("overview") or "",
        "release_date": release_date,
        "release_year": release_year,
        "popularity": raw.get("popularity"),
        "vote_average": raw.get("vote_average"),
        "vote_count": raw.get("vote_count"),
        "original_language": raw.get("original_language"),
        "genre_ids": raw.get("genre_ids", []),
        "poster_path": raw.get("poster_path"),
    }


def ingest_movies(max_pages: int = 200, sleep_seconds: float = 0.2):
    """
    Ingest movies from TMDb into Meilisearch.

    max_pages: how many pages of /discover/movie to fetch.
               Each page has 20 movies. 50 pages ≈ 1000 movies.
               You can increase later (up to 500 max allowed by TMDb for this endpoint).
    """
    ensure_env()
    client = create_meili_client()
    index = ensure_index(client)
    print("Clearing existing documents in 'movies' index...")
    index.delete_all_documents()


    print(f"Starting TMDb ingestion: up to {max_pages} pages")
    all_count = 0

    for page in range(1, max_pages + 1):
        print(f"Fetching page {page}/{max_pages}...")
        try:
            results, total_pages = fetch_tmdb_page(page)
        except Exception as e:
            print(f"Error fetching page {page}: {e}")
            break

        if not results:
            print("No more results or empty page. Stopping.")
            break

        docs = [normalize_movie(m) for m in results]

        # Insert into Meilisearch
        try:
            task = index.add_documents(docs)
            # task è un TaskInfo; non lo indicizziamo, ci basta sapere che è andato
            print(f"  Added {len(docs)} documents to Meilisearch")
        except Exception as e:
            print(f"Error adding documents to Meilisearch: {e}")
            break


        all_count += len(docs)

        # Respectful pause to not hammer TMDb
        time.sleep(sleep_seconds)

        # Stop if TMDb says there are no more pages
        if page >= total_pages:
            print(f"Reached TMDb total_pages={total_pages}. Stopping.")
            break

    print(f"Done. Total ingested movies: {all_count}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Ingest TMDb movies into Meilisearch.")
    parser.add_argument(
        "--pages",
        type=int,
        default=50,
        help="Number of pages to fetch from TMDb (each page ≈ 20 movies). Max 500.",
    )
    args = parser.parse_args()

    ingest_movies(max_pages=args.pages)
