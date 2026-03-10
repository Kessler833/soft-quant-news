# Centralized API key store — module-level, mutated at runtime.

KEYS = {}


def set_keys(keys_dict: dict) -> None:
    """Update the in-memory keys store."""
    KEYS.update(keys_dict)


def get(key_name: str, default=None):
    """Retrieve a single key value."""
    return KEYS.get(key_name, default)
