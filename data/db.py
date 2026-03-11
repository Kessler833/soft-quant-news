import sqlite3
import threading
import json
from datetime import datetime, timezone, timedelta

DB_PATH = 'data/news.db'
_lock = threading.Lock()


def get_conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH, check_same_thread=False)


def init_db() -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS articles (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                summary       TEXT,
                source        TEXT,
                url           TEXT,
                tickers       TEXT,
                sentiment     TEXT,
                relevance     TEXT,
                impact_score  INTEGER,
                catalyst_type TEXT,
                published_at  TEXT,
                processed_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS sentiment_scores (
                ticker     TEXT PRIMARY KEY,
                score      REAL,
                source     TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS polymarket_markets (
                id               TEXT PRIMARY KEY,
                question         TEXT,
                probability      REAL,
                volume           REAL,
                prev_probability REAL,
                updated_at       TEXT
            );

            CREATE TABLE IF NOT EXISTS watchlist (
                ticker   TEXT PRIMARY KEY,
                added_at TEXT
            );

            CREATE TABLE IF NOT EXISTS ai_cache (
                key          TEXT PRIMARY KEY,
                content      TEXT,
                generated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS drift_tracking (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id    TEXT,
                ticker        TEXT,
                price_at_news REAL,
                price_5min    REAL,
                price_15min   REAL,
                price_30min   REAL,
                tracked_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS keyword_cache (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                high_kw      TEXT,
                medium_kw    TEXT,
                low_kw       TEXT,
                context_note TEXT,
                generated_at TEXT
            );
        """)
        conn.commit()
        conn.close()


def save_article(article: dict) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        # Insert new row; if id already exists the INSERT is skipped.
        cur.execute(
            """
            INSERT OR IGNORE INTO articles
              (id, title, summary, source, url, tickers, sentiment,
               relevance, impact_score, catalyst_type, published_at, processed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                article.get('id'),
                article.get('title'),
                article.get('summary', ''),
                article.get('source'),
                article.get('url', ''),
                article.get('tickers', '[]'),
                article.get('sentiment', 'Neutral'),
                article.get('relevance', 'MEDIUM'),
                article.get('impact_score', 5),
                article.get('catalyst_type', 'Other'),
                article.get('published_at'),
                article.get('processed_at', datetime.now(timezone.utc).isoformat()),
            )
        )
        # Always refresh scoring fields so re-runs update stale rows.
        cur.execute(
            """
            UPDATE articles
               SET sentiment     = ?,
                   relevance     = ?,
                   impact_score  = ?,
                   catalyst_type = ?,
                   processed_at  = ?
             WHERE id = ?
            """,
            (
                article.get('sentiment', 'Neutral'),
                article.get('relevance', 'MEDIUM'),
                article.get('impact_score', 5),
                article.get('catalyst_type', 'Other'),
                article.get('processed_at', datetime.now(timezone.utc).isoformat()),
                article.get('id'),
            )
        )
        conn.commit()
        conn.close()


def save_drift(article_id: str, ticker: str, minutes: int, price: float) -> None:
    col_map = {5: 'price_5min', 15: 'price_15min', 30: 'price_30min'}
    col = col_map.get(minutes)
    if col is None:
        return
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT id FROM drift_tracking WHERE article_id=? AND ticker=?', (article_id, ticker))
        row = cur.fetchone()
        if row:
            cur.execute(f'UPDATE drift_tracking SET {col}=? WHERE article_id=? AND ticker=?', (price, article_id, ticker))
        else:
            # First price snapshot becomes price_at_news as well as the timed column.
            cur.execute(
                f'INSERT INTO drift_tracking (article_id, ticker, price_at_news, {col}, tracked_at) VALUES (?,?,?,?,?)',
                (article_id, ticker, price, price, datetime.now(timezone.utc).isoformat())
            )
        conn.commit()
        conn.close()


def _row_to_article(row, columns) -> dict:
    d = dict(zip(columns, row))
    tickers_raw = d.get('tickers', '[]')
    if isinstance(tickers_raw, list):
        d['tickers'] = tickers_raw
    else:
        try:
            d['tickers'] = json.loads(tickers_raw or '[]')
        except Exception:
            d['tickers'] = []
    return d


ARTICLE_COLUMNS = [
    'id', 'title', 'summary', 'source', 'url', 'tickers',
    'sentiment', 'relevance', 'impact_score', 'catalyst_type',
    'published_at', 'processed_at'
]


def get_latest_articles(
    limit: int = 50,
    relevance_filter: str = None,
    sentiment_filter: str = None,
    catalyst_filter: str = None,
    ticker_filter: str = None,
) -> list:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        query = 'SELECT * FROM articles'
        conditions = []
        params = []
        if relevance_filter:
            conditions.append('relevance = ?')
            params.append(relevance_filter.upper())
        if sentiment_filter:
            conditions.append('sentiment = ?')
            params.append(sentiment_filter)
        if catalyst_filter:
            conditions.append('catalyst_type = ?')
            params.append(catalyst_filter)
        if ticker_filter:
            conditions.append("tickers LIKE ?")
            params.append(f'%{ticker_filter.upper()}%')
        if conditions:
            query += ' WHERE ' + ' AND '.join(conditions)
        query += ' ORDER BY published_at DESC LIMIT ?'
        params.append(limit)
        cur.execute(query, params)
        rows = cur.fetchall()
        conn.close()
        return [_row_to_article(row, ARTICLE_COLUMNS) for row in rows]


def get_articles_since(hours: int = 4) -> list:
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT * FROM articles WHERE published_at >= ? ORDER BY published_at DESC', (since,))
        rows = cur.fetchall()
        conn.close()
        return [_row_to_article(row, ARTICLE_COLUMNS) for row in rows]


def get_articles_for_ticker(ticker: str) -> list:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT * FROM articles WHERE tickers LIKE ? ORDER BY published_at DESC LIMIT 50", (f'%{ticker.upper()}%',))
        rows = cur.fetchall()
        conn.close()
        return [_row_to_article(row, ARTICLE_COLUMNS) for row in rows]


def get_ai_cache(key: str):
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT content FROM ai_cache WHERE key = ?', (key,))
        row = cur.fetchone()
        conn.close()
        return row[0] if row else None


def set_ai_cache(key: str, content: str) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('INSERT OR REPLACE INTO ai_cache (key, content, generated_at) VALUES (?,?,?)', (key, content, datetime.now(timezone.utc).isoformat()))
        conn.commit()
        conn.close()


def get_watchlist() -> list:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT ticker FROM watchlist ORDER BY added_at DESC')
        rows = cur.fetchall()
        conn.close()
        return [r[0] for r in rows]


def add_to_watchlist(ticker: str) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('INSERT OR IGNORE INTO watchlist (ticker, added_at) VALUES (?,?)', (ticker.upper(), datetime.now(timezone.utc).isoformat()))
        conn.commit()
        conn.close()


def remove_from_watchlist(ticker: str) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('DELETE FROM watchlist WHERE ticker = ?', (ticker.upper(),))
        conn.commit()
        conn.close()


def save_polymarket_markets(markets: list) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        for m in markets:
            cur.execute(
                "INSERT OR REPLACE INTO polymarket_markets (id, question, probability, volume, prev_probability, updated_at) VALUES (?,?,?,?,?,?)",
                (m.get('id'), m.get('question'), m.get('probability', 0.0), m.get('volume', 0.0), m.get('prev_probability', m.get('probability', 0.0)), datetime.now(timezone.utc).isoformat())
            )
        conn.commit()
        conn.close()


def get_polymarket_markets() -> list:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT id, question, probability, volume, prev_probability, updated_at FROM polymarket_markets ORDER BY volume DESC')
        rows = cur.fetchall()
        conn.close()
        columns = ['id', 'question', 'probability', 'volume', 'prev_probability', 'updated_at']
        return [dict(zip(columns, row)) for row in rows]


def get_polymarket_alerts(threshold: float = 0.05) -> list:
    markets = get_polymarket_markets()
    return [m for m in markets if m['prev_probability'] is not None and abs(m['probability'] - m['prev_probability']) > threshold]


def get_latest_keywords():
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute('SELECT high_kw, medium_kw, low_kw, context_note, generated_at FROM keyword_cache ORDER BY id DESC LIMIT 1')
        row = cur.fetchone()
        conn.close()
    if not row:
        return None
    try:
        return {
            'high_kw':      json.loads(row[0] or '[]'),
            'medium_kw':    json.loads(row[1] or '[]'),
            'low_kw':       json.loads(row[2] or '[]'),
            'context_note': row[3] or '',
            'generated_at': row[4] or '',
        }
    except Exception:
        return None


def save_keywords(high: list, medium: list, low: list, context_note: str) -> None:
    with _lock:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO keyword_cache (high_kw, medium_kw, low_kw, context_note, generated_at) VALUES (?,?,?,?,?)',
            (json.dumps(high), json.dumps(medium), json.dumps(low), context_note, datetime.now(timezone.utc).isoformat())
        )
        conn.commit()
        conn.close()
