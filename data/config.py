# Centralized API key store — module-level, mutated at runtime.

import json
import logging
import os

logger = logging.getLogger(__name__)

KEYS = {}

_KEYS_PATH = os.path.join(os.path.dirname(__file__), 'keys.json')


def save_keys_to_disk() -> None:
    """Persist current keys to data/keys.json."""
    try:
        with open(_KEYS_PATH, 'w') as f:
            json.dump(KEYS, f)
    except Exception as e:
        logger.warning(f'[config] Failed to save keys to disk: {e}')


def load_keys_from_disk() -> None:
    """Load keys from data/keys.json into memory."""
    if not os.path.exists(_KEYS_PATH):
        return
    try:
        with open(_KEYS_PATH, 'r') as f:
            data = json.load(f)
        if isinstance(data, dict):
            KEYS.update(data)
            logger.info(f'[config] Loaded {len(data)} keys from disk.')
    except Exception as e:
        logger.warning(f'[config] Failed to load keys from disk: {e}')


def set_keys(keys_dict: dict) -> None:
    """Update the in-memory keys store and persist to disk."""
    KEYS.update(keys_dict)
    save_keys_to_disk()


def get(key_name: str, default=None):
    """Retrieve a single key value."""
    return KEYS.get(key_name, default)
