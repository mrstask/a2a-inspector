import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import get_card_resolver  # noqa: E402


@pytest.fixture
def client():
    return httpx.AsyncClient()


def _target(resolver) -> str:
    return f'{resolver.base_url}/{resolver.agent_card_path}'


def test_bare_host_uses_well_known(client):
    resolver = get_card_resolver(client, 'https://example.com')
    assert _target(resolver) == 'https://example.com/.well-known/agent-card.json'


def test_trailing_slash_uses_well_known(client):
    resolver = get_card_resolver(client, 'https://example.com/')
    assert _target(resolver) == 'https://example.com/.well-known/agent-card.json'


def test_sub_path_mount_uses_well_known(client):
    resolver = get_card_resolver(
        client, 'https://example.com/agents/nav/'
    )
    assert (
        _target(resolver)
        == 'https://example.com/agents/nav/.well-known/agent-card.json'
    )


def test_explicit_card_json_path_preserved(client):
    url = 'https://example.com/agents/nav/.well-known/agent-card.json'
    resolver = get_card_resolver(client, url)
    assert _target(resolver) == url


def test_explicit_legacy_card_json_path_preserved(client):
    url = 'https://example.com/.well-known/agent.json'
    resolver = get_card_resolver(client, url)
    assert _target(resolver) == url


def test_custom_json_path_preserved(client):
    url = 'https://example.com/custom/card.json'
    resolver = get_card_resolver(client, url)
    assert _target(resolver) == url
