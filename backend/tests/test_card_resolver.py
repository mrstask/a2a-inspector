import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import get_card_resolver, rewrite_card_urls  # noqa: E402


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


# ---------------------------------------------------------------------------
# rewrite_card_urls
# ---------------------------------------------------------------------------


class _Iface:
    def __init__(self, url):
        self.url = url


class _Card:
    def __init__(self, url, additional_interfaces=None):
        self.url = url
        self.additional_interfaces = additional_interfaces


def test_rewrite_swaps_host_and_preserves_mount_path():
    card = _Card(url='http://internal-svc/request')
    rewrite_card_urls(
        card, 'https://ingress.example.com/api-nav-agent/'
    )
    assert card.url == 'https://ingress.example.com/api-nav-agent/request'


def test_rewrite_handles_full_card_url_as_input():
    card = _Card(url='http://internal-svc/request')
    rewrite_card_urls(
        card,
        'https://ingress.example.com/api-nav-agent/.well-known/agent-card.json',
    )
    assert card.url == 'https://ingress.example.com/api-nav-agent/request'


def test_rewrite_handles_bare_origin():
    card = _Card(url='http://internal-svc/request')
    rewrite_card_urls(card, 'https://example.com')
    assert card.url == 'https://example.com/request'


def test_rewrite_rewrites_additional_interfaces():
    card = _Card(
        url='http://internal-svc/request',
        additional_interfaces=[
            _Iface(url='http://internal-svc/grpc'),
            _Iface(url='http://other-host/http+json'),
        ],
    )
    rewrite_card_urls(card, 'https://ingress.example.com/api-nav-agent/')
    assert card.url == 'https://ingress.example.com/api-nav-agent/request'
    assert (
        card.additional_interfaces[0].url
        == 'https://ingress.example.com/api-nav-agent/grpc'
    )
    assert (
        card.additional_interfaces[1].url
        == 'https://ingress.example.com/api-nav-agent/http+json'
    )


def test_rewrite_preserves_query_and_fragment():
    card = _Card(url='http://internal-svc/request?x=1#frag')
    rewrite_card_urls(card, 'https://ingress.example.com/api-nav-agent/')
    assert (
        card.url
        == 'https://ingress.example.com/api-nav-agent/request?x=1#frag'
    )
