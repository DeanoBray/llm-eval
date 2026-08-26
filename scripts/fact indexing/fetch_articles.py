#!/usr/bin/env python3
"""
Fetch and extract Wikipedia articles from Mímir based on semantic search.

Workflow:
  1. Search for articles matching the query
  2. Filter to top N results (ordered by relevance)
  3. Extract full text for each article
  4. Return JSON list ordered by relevance

See: docs/wikipedia-semantic-search.md for Mímir API details.
"""

import requests
import json
import sys
import argparse
from pathlib import Path
from typing import Optional, List, Dict, Any

# Load configuration
CONFIG_FILE = Path(__file__).parent / "indexing_config.json"
DEFAULT_CONFIG = {
    "host": "localhost",
    "port": 21500,
    "timeout": {"search": 5, "extract": 8}
}


def load_config() -> Dict[str, Any]:
    """Load configuration from indexing_config.json."""
    config = DEFAULT_CONFIG.copy()
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                config.update(json.load(f))
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Could not load config file {CONFIG_FILE}: {e}", file=sys.stderr)
    return config


def fetch_articles(
    query: str,
    count: int = 3,
    lang: str = "en"
) -> List[Dict[str, Any]]:
    """
    Fetch and extract Wikipedia articles from Mímir.

    Workflow:
      1. Search Mímir for articles matching the query
      2. Filter to top `count` results by relevance (score ascending)
      3. Extract full text for each article
      4. Return as JSON list ordered by relevance

    Args:
        query: Search query string (1-500 chars)
        count: Number of top articles to return (default: 3)
        lang: Language code - "en" (English) or "zh" (Chinese) (default: "en")

    Returns:
        List of articles ordered by relevance:
        [
            {
                "title": "...",
                "score": 0.3586,
                "intro": "...",
                "extract": "... (full article text) ...",
                "paragraphs": ["paragraph 1", "paragraph 2", ...],
                "wikipedia_url": "https://en.wikipedia.org/wiki/...",
                "lang": "en"
            },
            ...
        ]

    Raises:
        ValueError: If query is empty, count is invalid, or lang is not "en" or "zh"
        requests.RequestException: If Mímir service is unavailable
    """

    # Validate inputs
    if not query or len(query) == 0:
        raise ValueError("query cannot be empty")
    if not 1 <= count <= 20:
        raise ValueError(f"count must be between 1 and 20, got {count}")
    if lang not in ("en", "zh"):
        raise ValueError(f"lang must be 'en' or 'zh', got '{lang}'")

    config = load_config()
    mimir_url = f"http://{config['host']}:{config['port']}"
    search_timeout = config["timeout"]["search"]
    extract_timeout = config["timeout"]["extract"]

    # Step 1: Search
    print(f"[1/2] Searching for '{query}' ({lang})...", file=sys.stderr)
    try:
        search_response = requests.post(
            f"{mimir_url}/search",
            json={
                "query": query,
                "lang": lang,
                "mode": "text",
                "top_k": count,
                "constrain": []
            },
            timeout=search_timeout
        )
        search_response.raise_for_status()
        search_data = search_response.json()
    except requests.exceptions.RequestException as e:
        raise requests.RequestException(f"Search failed: {e}")

    results = search_data.get("results", [])
    if not results:
        print(f"[1/2] No results found for query: {query}", file=sys.stderr)
        return []

    print(f"[1/2] Found {len(results)} articles (top {count})", file=sys.stderr)

    # Step 2: Extract full text for each article
    print(f"[2/2] Extracting full text for {len(results)} articles...", file=sys.stderr)
    titles = [r["title"] for r in results]

    try:
        extract_response = requests.post(
            f"{mimir_url}/extract",
            json={
                "titles": titles,
                "lang": lang,
                "max_chars": 12000
            },
            timeout=extract_timeout
        )
        extract_response.raise_for_status()
        extract_data = extract_response.json()
    except requests.exceptions.RequestException as e:
        raise requests.RequestException(f"Extract failed: {e}")

    articles_by_title = {}
    for article in extract_data.get("articles", []):
        articles_by_title[article["title"]] = article

    # Step 3: Combine search results with extracts, maintaining relevance order
    collated = []
    wikipedia_host = "en.wikipedia.org" if lang == "en" else "zh.wikipedia.org"

    for search_result in results:
        title = search_result["title"]
        extract = articles_by_title.get(title, {})

        # Construct Wikipedia URL (URL-encoded title with underscores instead of spaces)
        url_title = title.replace(" ", "_")
        wikipedia_url = f"https://{wikipedia_host}/wiki/{url_title}"

        collated.append({
            "title": title,
            "score": search_result["score"],
            "intro": search_result.get("intro", ""),
            "extract": extract.get("extract", ""),
            "wikipedia_url": wikipedia_url,
            "lang": lang
        })

    print(f"[2/2] Done. {len(collated)} articles extracted.", file=sys.stderr)
    return collated


def main():
    """Command-line interface for fetching and extracting Wikipedia articles."""
    parser = argparse.ArgumentParser(
        description="Fetch and extract Wikipedia articles from Mímir semantic search",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python fetch_articles.py "Mobile payments in China"
  python fetch_articles.py "Taiwan election" --count 5
  python fetch_articles.py "台灣選舉" --count 3 --lang zh
  python fetch_articles.py "QR code" -c 10 -l en
        """
    )

    parser.add_argument(
        "query",
        help="Search query string (1-500 characters)"
    )
    parser.add_argument(
        "--count", "-c",
        type=int,
        default=3,
        help="Number of articles to return (default: 3, max: 20)"
    )
    parser.add_argument(
        "--lang", "-l",
        choices=["en", "zh"],
        default="en",
        help="Language code: 'en' (English) or 'zh' (Chinese) (default: en)"
    )

    args = parser.parse_args()

    try:
        articles = fetch_articles(query=args.query, count=args.count, lang=args.lang)
        print(json.dumps(articles, indent=2, ensure_ascii=False))
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except requests.RequestException as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
