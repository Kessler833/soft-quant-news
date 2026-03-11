# Centralized API key store — module-level, mutated at runtime.

KEYS = {
    'ollama_url':   'http://localhost:11434',
    'ollama_model': 'gemma3:4b',
}


def set_keys(keys_dict: dict) -> None:
    """Update the in-memory keys store."""
    KEYS.update(keys_dict)


def get(key_name: str, default=None):
    """Retrieve a single key value."""
    return KEYS.get(key_name, default)
