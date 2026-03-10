import asyncio
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from data import db

logger = logging.getLogger(__name__)
router = APIRouter()

connected_clients: set = set()


async def broadcast(article_dict: dict) -> None:
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_json(article_dict)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


@router.websocket('/ws/feed')
async def ws_feed(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info(f'[ws] Client connected. Total: {len(connected_clients)}')

    # Send last 10 articles as initial payload
    try:
        recent = db.get_latest_articles(limit=10)
        for article in recent:
            await websocket.send_json(article)
    except Exception as e:
        logger.warning(f'[ws] Failed to send initial articles: {e}')

    try:
        while True:
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                await websocket.send_json({'type': 'ping'})
            except WebSocketDisconnect:
                break
    except Exception as e:
        logger.warning(f'[ws] Client error: {e}')
    finally:
        connected_clients.discard(websocket)
        logger.info(f'[ws] Client disconnected. Total: {len(connected_clients)}')
