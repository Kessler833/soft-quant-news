import logging
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter

logger = logging.getLogger(__name__)
router = APIRouter()

# 2026 US Economic Calendar — all times UTC
# FOMC: Jan 28-29, Mar 18-19, May 6-7, Jun 17-18, Jul 29-30, Sep 16-17, Nov 4-5, Dec 16-17
# CPI: 2nd or 3rd Wed/Thu each month, typically 08:30 ET = 13:30 UTC
# NFP: First Friday each month, 08:30 ET = 13:30 UTC
# PPI: ~2 weeks after CPI, 08:30 ET
# GDP: Quarterly advance/prelim/final
# PCE: End of month, 08:30 ET
# ISM Manufacturing: First business day of month, 10:00 ET = 15:00 UTC
# Retail Sales: Mid-month, 08:30 ET

EVENTS_2026 = [
    # ── JANUARY ──────────────────────────────────────────────────────────────
    {'name': 'NFP (Jan)',            'datetime_utc': '2026-01-02T13:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '227K', 'expected': '170K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-01-02T15:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '48.4', 'expected': '48.8'},
    {'name': 'CPI (Jan)',            'datetime_utc': '2026-01-14T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.7%', 'expected': '2.8%'},
    {'name': 'PPI (Jan)',            'datetime_utc': '2026-01-15T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '3.0%', 'expected': '3.1%'},
    {'name': 'Retail Sales (Jan)',   'datetime_utc': '2026-01-16T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.7%', 'expected': '0.4%'},
    {'name': 'PCE (Dec)',            'datetime_utc': '2026-01-30T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.4%', 'expected': '2.5%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-01-29T19:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.50%','expected': '4.50%'},
    # ── FEBRUARY ─────────────────────────────────────────────────────────────
    {'name': 'NFP (Feb)',            'datetime_utc': '2026-02-06T13:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '256K', 'expected': '160K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-02-02T15:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '49.3', 'expected': '49.5'},
    {'name': 'CPI (Feb)',            'datetime_utc': '2026-02-11T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.9%', 'expected': '2.9%'},
    {'name': 'PPI (Feb)',            'datetime_utc': '2026-02-12T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '3.3%', 'expected': '3.2%'},
    {'name': 'Retail Sales (Feb)',   'datetime_utc': '2026-02-18T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '-0.9%','expected': '0.2%'},
    {'name': 'PCE (Jan)',            'datetime_utc': '2026-02-27T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.6%', 'expected': '2.5%'},
    {'name': 'GDP Q4 Advance',       'datetime_utc': '2026-02-26T13:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '3.1%', 'expected': '2.6%'},
    # ── MARCH ────────────────────────────────────────────────────────────────
    {'name': 'NFP (Mar)',            'datetime_utc': '2026-03-06T13:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '143K', 'expected': '160K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-03-02T15:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '50.9', 'expected': '51.0'},
    {'name': 'CPI (Mar)',            'datetime_utc': '2026-03-11T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '3.0%', 'expected': '2.9%'},
    {'name': 'PPI (Mar)',            'datetime_utc': '2026-03-12T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '3.5%', 'expected': '3.3%'},
    {'name': 'Retail Sales (Mar)',   'datetime_utc': '2026-03-17T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.2%', 'expected': '0.5%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-03-19T18:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.50%','expected': '4.50%'},
    {'name': 'PCE (Feb)',            'datetime_utc': '2026-03-27T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.5%', 'expected': '2.5%'},
    # ── APRIL ────────────────────────────────────────────────────────────────
    {'name': 'NFP (Apr)',            'datetime_utc': '2026-04-03T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '160K', 'expected': '165K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-04-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.0', 'expected': '51.2'},
    {'name': 'CPI (Apr)',            'datetime_utc': '2026-04-10T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.9%', 'expected': '2.8%'},
    {'name': 'PPI (Apr)',            'datetime_utc': '2026-04-11T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '3.3%', 'expected': '3.1%'},
    {'name': 'Retail Sales (Apr)',   'datetime_utc': '2026-04-15T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.5%', 'expected': '0.4%'},
    {'name': 'GDP Q1 Advance',       'datetime_utc': '2026-04-29T12:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.4%', 'expected': '2.1%'},
    {'name': 'PCE (Mar)',            'datetime_utc': '2026-04-30T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.5%', 'expected': '2.4%'},
    # ── MAY ──────────────────────────────────────────────────────────────────
    {'name': 'FOMC Decision',        'datetime_utc': '2026-05-07T18:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.50%','expected': '4.25%'},
    {'name': 'NFP (May)',            'datetime_utc': '2026-05-08T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '165K', 'expected': '158K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-05-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.2', 'expected': '51.0'},
    {'name': 'CPI (May)',            'datetime_utc': '2026-05-13T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.8%', 'expected': '2.7%'},
    {'name': 'PPI (May)',            'datetime_utc': '2026-05-14T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '3.1%', 'expected': '2.9%'},
    {'name': 'Retail Sales (May)',   'datetime_utc': '2026-05-15T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.4%', 'expected': '0.3%'},
    {'name': 'PCE (Apr)',            'datetime_utc': '2026-05-29T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.4%', 'expected': '2.3%'},
    # ── JUNE ─────────────────────────────────────────────────────────────────
    {'name': 'NFP (Jun)',            'datetime_utc': '2026-06-05T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '158K', 'expected': '160K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-06-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.0', 'expected': '51.5'},
    {'name': 'CPI (Jun)',            'datetime_utc': '2026-06-10T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.7%', 'expected': '2.6%'},
    {'name': 'PPI (Jun)',            'datetime_utc': '2026-06-11T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.9%', 'expected': '2.8%'},
    {'name': 'Retail Sales (Jun)',   'datetime_utc': '2026-06-16T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.3%', 'expected': '0.4%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-06-18T18:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.25%','expected': '4.00%'},
    {'name': 'GDP Q1 Final',         'datetime_utc': '2026-06-25T12:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.1%', 'expected': '2.2%'},
    {'name': 'PCE (May)',            'datetime_utc': '2026-06-26T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.3%', 'expected': '2.2%'},
    # ── JULY ─────────────────────────────────────────────────────────────────
    {'name': 'NFP (Jul)',            'datetime_utc': '2026-07-02T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '160K', 'expected': '155K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-07-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.5', 'expected': '51.3'},
    {'name': 'CPI (Jul)',            'datetime_utc': '2026-07-15T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.6%', 'expected': '2.5%'},
    {'name': 'PPI (Jul)',            'datetime_utc': '2026-07-16T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.8%', 'expected': '2.6%'},
    {'name': 'Retail Sales (Jul)',   'datetime_utc': '2026-07-17T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.4%', 'expected': '0.3%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-07-30T18:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.00%','expected': '4.00%'},
    {'name': 'PCE (Jun)',            'datetime_utc': '2026-07-31T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.2%', 'expected': '2.2%'},
    # ── AUGUST ───────────────────────────────────────────────────────────────
    {'name': 'NFP (Aug)',            'datetime_utc': '2026-08-07T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '155K', 'expected': '158K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-08-03T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.3', 'expected': '51.4'},
    {'name': 'CPI (Aug)',            'datetime_utc': '2026-08-12T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.5%', 'expected': '2.4%'},
    {'name': 'PPI (Aug)',            'datetime_utc': '2026-08-13T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.6%', 'expected': '2.5%'},
    {'name': 'Retail Sales (Aug)',   'datetime_utc': '2026-08-14T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.3%', 'expected': '0.4%'},
    {'name': 'GDP Q2 Advance',       'datetime_utc': '2026-08-26T12:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.2%', 'expected': '2.0%'},
    {'name': 'PCE (Jul)',            'datetime_utc': '2026-08-28T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.2%', 'expected': '2.1%'},
    # ── SEPTEMBER ────────────────────────────────────────────────────────────
    {'name': 'NFP (Sep)',            'datetime_utc': '2026-09-04T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '158K', 'expected': '155K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-09-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.4', 'expected': '51.5'},
    {'name': 'CPI (Sep)',            'datetime_utc': '2026-09-09T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.4%', 'expected': '2.3%'},
    {'name': 'PPI (Sep)',            'datetime_utc': '2026-09-10T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.5%', 'expected': '2.4%'},
    {'name': 'Retail Sales (Sep)',   'datetime_utc': '2026-09-15T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.4%', 'expected': '0.3%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-09-17T18:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '4.00%','expected': '3.75%'},
    {'name': 'PCE (Aug)',            'datetime_utc': '2026-09-25T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.1%', 'expected': '2.1%'},
    # ── OCTOBER ──────────────────────────────────────────────────────────────
    {'name': 'NFP (Oct)',            'datetime_utc': '2026-10-02T12:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '155K', 'expected': '158K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-10-01T14:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.5', 'expected': '51.6'},
    {'name': 'CPI (Oct)',            'datetime_utc': '2026-10-14T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.3%', 'expected': '2.2%'},
    {'name': 'PPI (Oct)',            'datetime_utc': '2026-10-15T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.4%', 'expected': '2.3%'},
    {'name': 'Retail Sales (Oct)',   'datetime_utc': '2026-10-15T12:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.3%', 'expected': '0.4%'},
    {'name': 'GDP Q2 Final',         'datetime_utc': '2026-10-29T12:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.0%', 'expected': '2.1%'},
    {'name': 'PCE (Sep)',            'datetime_utc': '2026-10-30T12:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.1%', 'expected': '2.0%'},
    # ── NOVEMBER ─────────────────────────────────────────────────────────────
    {'name': 'FOMC Decision',        'datetime_utc': '2026-11-05T19:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '3.75%','expected': '3.75%'},
    {'name': 'NFP (Nov)',            'datetime_utc': '2026-11-06T13:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '158K', 'expected': '155K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-11-02T15:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.6', 'expected': '51.5'},
    {'name': 'CPI (Nov)',            'datetime_utc': '2026-11-12T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.2%', 'expected': '2.1%'},
    {'name': 'PPI (Nov)',            'datetime_utc': '2026-11-13T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.3%', 'expected': '2.2%'},
    {'name': 'Retail Sales (Nov)',   'datetime_utc': '2026-11-17T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.4%', 'expected': '0.5%'},
    {'name': 'PCE (Oct)',            'datetime_utc': '2026-11-25T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.0%', 'expected': '2.0%'},
    {'name': 'GDP Q3 Advance',       'datetime_utc': '2026-11-25T13:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.1%', 'expected': '2.0%'},
    # ── DECEMBER ─────────────────────────────────────────────────────────────
    {'name': 'NFP (Dec)',            'datetime_utc': '2026-12-04T13:30:00Z', 'importance': 'HIGH',   'category': 'Employment',   'previous': '155K', 'expected': '158K'},
    {'name': 'ISM Manufacturing',    'datetime_utc': '2026-12-01T15:00:00Z', 'importance': 'MEDIUM', 'category': 'Manufacturing','previous': '51.5', 'expected': '51.7'},
    {'name': 'CPI (Dec)',            'datetime_utc': '2026-12-09T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.1%', 'expected': '2.1%'},
    {'name': 'PPI (Dec)',            'datetime_utc': '2026-12-10T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Inflation',    'previous': '2.2%', 'expected': '2.1%'},
    {'name': 'Retail Sales (Dec)',   'datetime_utc': '2026-12-15T13:30:00Z', 'importance': 'MEDIUM', 'category': 'Consumer',     'previous': '0.5%', 'expected': '0.4%'},
    {'name': 'FOMC Decision',        'datetime_utc': '2026-12-17T19:00:00Z', 'importance': 'HIGH',   'category': 'Fed',          'previous': '3.75%','expected': '3.50%'},
    {'name': 'PCE (Nov)',            'datetime_utc': '2026-12-23T13:30:00Z', 'importance': 'HIGH',   'category': 'Inflation',    'previous': '2.0%', 'expected': '2.0%'},
    {'name': 'GDP Q3 Final',         'datetime_utc': '2026-12-23T13:30:00Z', 'importance': 'HIGH',   'category': 'GDP',          'previous': '2.0%', 'expected': '2.0%'},
]

# Patch all events with default 'actual': None
for _e in EVENTS_2026:
    _e.setdefault('actual', None)


@router.get('/events')
async def get_events():
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    window_end  = today_start + timedelta(days=8)  # today + next 7 days

    results = []
    for event in EVENTS_2026:
        dt_utc = datetime.fromisoformat(event['datetime_utc'].replace('Z', '+00:00'))
        if today_start <= dt_utc < window_end:
            seconds_until = int((dt_utc - now).total_seconds())
            dt_cet = dt_utc + timedelta(hours=1)
            results.append({
                **event,
                'datetime_utc': dt_utc.isoformat(),
                'datetime_cet': dt_cet.isoformat(),
                'seconds_until': seconds_until,
            })

    results.sort(key=lambda e: e['datetime_utc'])
    return results
