import os
import math
import re
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import meilisearch
from rapidfuzz import fuzz

# Load environment variables from .env
load_dotenv()

MEILI_HOST = os.getenv("MEILI_HOST", "http://127.0.0.1:7700")
MEILI_MASTER_KEY = os.getenv("MEILI_MASTER_KEY")
MEILI_INDEX_NAME = "movies"

if not MEILI_MASTER_KEY:
    raise RuntimeError("MEILI_MASTER_KEY is not set. Check your .env file.")

# Create Meilisearch client
meili_client = meilisearch.Client(MEILI_HOST, MEILI_MASTER_KEY)

app = FastAPI(title="Letterboxd Better Search Backend")

# Allow the extension (and browser) to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # possiamo restringere più avanti
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class MovieResult(BaseModel):
    id: int
    title: str
    overview: Optional[str] = None
    release_date: Optional[str] = None
    popularity: Optional[float] = None
    vote_average: Optional[float] = None
    vote_count: Optional[int] = None
    poster_path: Optional[str] = None


class SearchResponse(BaseModel):
    query: str
    total_hits: int
    results: List[MovieResult]


# ---------- Helper per ranking ----------

YEAR_REGEX = re.compile(r"(19|20)\d{2}")


def extract_year_from_query(q: str) -> Optional[int]:
    match = YEAR_REGEX.search(q)
    if not match:
        return None
    try:
        return int(match.group(0))
    except ValueError:
        return None


def normalize_text(s: Optional[str]) -> str:
    if not s:
        return ""
    return s.strip().lower()


def tokenize(s: str) -> List[str]:
    # split molto semplice su spazi e punteggiatura
    return re.findall(r"\w+", s.lower())


def compute_movie_score(
    movie: dict,
    query_text: str,
    query_year: Optional[int],
) -> float:
    """
    Calcola uno score custom per ogni film, combinando:
    - similarità titolo/query (Levenshtein via rapidfuzz)
    - match di parole nel titolo (fortemente pesato)
    - match parziale nell'overview (peso minore)
    - popolarità (peso ridotto)
    - voto medio
    - vicinanza di anno (se presente nella query)
    """

    title = normalize_text(movie.get("title") or movie.get("original_title"))
    original_title = normalize_text(movie.get("original_title"))
    overview = normalize_text(movie.get("overview"))

    core_query = query_text or ""
    core_query = core_query.strip()
    if not core_query:
        return 0.0

    # Similarità titolo-query (0..1)
    title_similarity = fuzz.ratio(core_query, title) / 100.0 if title else 0.0
    original_title_similarity = (
        fuzz.ratio(core_query, original_title) / 100.0 if original_title else 0.0
    )
    best_title_similarity = max(title_similarity, original_title_similarity)

    # Token overlap
    query_tokens = set(tokenize(core_query))
    title_tokens = set(tokenize(title))

    token_overlap = 0.0
    if query_tokens:
        token_overlap = len(query_tokens & title_tokens) / len(query_tokens)

    # Match forti sul titolo (per query con più parole)
    has_any_query_token = len(query_tokens & title_tokens) > 0
    has_all_query_tokens = bool(query_tokens) and query_tokens.issubset(title_tokens)
    title_equals_query = title == core_query
    title_starts_with_query = title.startswith(core_query)

    strong_title_bonus = 0.0
    if title_equals_query:
        strong_title_bonus += 2.0
    elif has_all_query_tokens:
        strong_title_bonus += 1.5
    elif has_any_query_token:
        strong_title_bonus += 0.7

    if title_starts_with_query:
        strong_title_bonus += 0.5

    # Match parziale nell'overview (peso ridotto)
    overview_partial = (
        fuzz.partial_ratio(core_query, overview) / 100.0 if overview else 0.0
    )

    # Popolarità (peso ridotto)
    popularity = movie.get("popularity") or 0.0
    pop_component = math.log1p(popularity) / 10.0  # 0..1 circa

    # Voto medio
    vote_avg = movie.get("vote_average") or 0.0
    vote_component = (vote_avg / 10.0) * 0.3  # 0..0.3

    # Anno
    movie_year = movie.get("release_year")
    year_component = 0.0
    if query_year and movie_year:
        diff = abs(query_year - movie_year)
        if diff == 0:
            year_component = 0.3
        elif diff == 1:
            year_component = 0.15
        elif diff == 2:
            year_component = 0.05

    # Combiniamo tutto in un unico score
    score = 0.0
    score += best_title_similarity * 1.5    # titolo importante
    score += token_overlap * 0.8            # parole in comune importanti
    score += strong_title_bonus             # bonus grosso se il titolo matcha forte
    score += overview_partial * 0.05         # overview aiuta ma poco
    score += pop_component * 0.5           # popolarità aiuta ma non domina
    score += vote_component                 # qualità percepita
    score += year_component                 # anno se specificato

    return score


# ---------- Endpoints ----------


@app.get("/health")
def health_check():
    """Simple health endpoint to check if backend is running."""
    try:
        # Ping Meilisearch
        meili_client.health()
        return {"status": "ok", "meilisearch": "ok"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Meilisearch error: {e}")


@app.get("/search", response_model=SearchResponse)
def search_movies(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=50),
):
    """
    Search movies in the local Meilisearch index with custom re-ranking.
    """
    raw_query = q.strip()
    if not raw_query:
        raise HTTPException(status_code=400, detail="Empty query")

    # Estraiamo eventuale anno dalla query (es: "inception 2010")
    query_year = extract_year_from_query(raw_query)
    core_query = raw_query
    if query_year is not None:
        # togliamo l'anno dalla query per il matching di testo
        core_query = YEAR_REGEX.sub("", raw_query).strip()

    core_query_norm = normalize_text(core_query)

    try:
        index = meili_client.index(MEILI_INDEX_NAME)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Index error: {e}")

    # Chiediamo a Meilisearch un po' più risultati di quelli che ci servono,
    # così possiamo fare re-ranking lato Python.
    CANDIDATE_LIMIT = max(limit * 10, 100)   # es: se limit=10 → 100 candidati

    try:
        search_result = index.search(
            core_query_norm or raw_query,
            {
                "limit": CANDIDATE_LIMIT,
            },
        )
    except meilisearch.errors.MeilisearchApiError as e:
        raise HTTPException(status_code=500, detail=f"Search error: {e}")

    hits = search_result.get("hits", [])
    total_hits = search_result.get("estimatedTotalHits", len(hits))

    # Re-ranking custom
    scored_hits = []
    for h in hits:
        score = compute_movie_score(h, core_query_norm or raw_query, query_year)
        h["_custom_score"] = score
        scored_hits.append(h)

    scored_hits.sort(key=lambda x: x.get("_custom_score", 0.0), reverse=True)

    top_hits = scored_hits[:limit]

    movies: List[MovieResult] = []
    for h in top_hits:
        movies.append(
            MovieResult(
                id=h.get("id"),
                title=h.get("title") or h.get("original_title") or "",
                overview=h.get("overview"),
                release_date=h.get("release_date"),
                popularity=h.get("popularity"),
                vote_average=h.get("vote_average"),
                vote_count=h.get("vote_count"),
                poster_path=h.get("poster_path"),
            )
        )

    return SearchResponse(
        query=q,
        total_hits=total_hits,
        results=movies,
    )
