#!/usr/bin/env python3
"""Install a separate local Hermes profile; never modify the Work profile."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import yaml

parser = argparse.ArgumentParser()
parser.add_argument('--work-home', type=Path, default=Path.home() / '.hermes')
parser.add_argument('--research-home', type=Path, default=Path.home() / '.hermes-research')
parser.add_argument('--plugin', type=Path, required=True)
parser.add_argument('--registry', type=Path, default=Path.home() / '.hermes/hermes-live/repositories.json')
parser.add_argument('--port', type=int, default=8643)
args = parser.parse_args()
work, profile = args.work_home.resolve(), args.research_home.resolve()
if work == profile or profile in work.parents or work in profile.parents:
    raise SystemExit('Research and Work must have independent state directories')
if not args.plugin.joinpath('plugin.yaml').is_file():
    raise SystemExit('Research plugin is missing')
if profile.exists() and any(profile.iterdir()):
    raise SystemExit('Research profile already exists; retain its credentials and sessions and upgrade only its plugin')
profile.mkdir(parents=True, mode=0o700, exist_ok=True)
os.chmod(profile, 0o700)
work_config = yaml.safe_load((work / 'config.yaml').read_text())
model = work_config.get('model')
if not isinstance(model, dict) or not model.get('default') or not model.get('provider'):
    raise SystemExit('Configure an explicit Hermes model/provider before installing research')
config = {'model': model, 'fallback_providers': [], 'toolsets': ['monte_research'],
          'platform_toolsets': {'api_server': ['monte_research']},
          'agent': {'max_turns': 20}, 'plugins': {'enabled': ['monte-research'], 'disabled': []},
          'kanban': {'dispatch_in_gateway': False}, 'mcp_servers': {}, 'tools': {'tool_search': {'enabled': 'off'}},
          'memory': {'memory_enabled': False, 'user_profile_enabled': False},
          'gateway': {'platforms': {'api_server': {'enabled': True}}}}

def private_write(path, text):
    path.write_text(text)
    os.chmod(path, 0o600)

private_write(profile / 'config.yaml', yaml.safe_dump(config, sort_keys=False))
# Copy only the chosen model provider's credentials to an independent private file.
# Hermes can refresh them in this profile without writing Work's auth store.
if (work / 'auth.json').exists():
    auth = json.loads((work / 'auth.json').read_text())
    provider = model['provider']
    isolated = {k: v for k, v in auth.items() if k not in ('providers', 'credential_pool')}
    isolated['providers'] = {provider: auth.get('providers', {})[provider]} if provider in auth.get('providers', {}) else {}
    isolated['credential_pool'] = {provider: auth.get('credential_pool', {})[provider]} if provider in auth.get('credential_pool', {}) else {}
    private_write(profile / 'auth.json', json.dumps(isolated))
# Static model API keys, if used, must be provisioned into this profile's .env.
# Do not copy Discord, messaging, shell integration, or unrelated provider secrets.
key = secrets.token_urlsafe(48)
private_write(profile / '.env', f'API_SERVER_KEY={key}\nAPI_SERVER_HOST=127.0.0.1\nAPI_SERVER_PORT={args.port}\n')
private_write(profile / 'gateway.env', f'HERMES_LIVE_RESEARCH_URL=http://127.0.0.1:{args.port}\nHERMES_LIVE_RESEARCH_API_KEY={key}\nHERMES_LIVE_REPOSITORY_REGISTRY={args.registry.resolve()}\n')
shutil.copytree(args.plugin, profile / 'plugins/monte-research', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
print(f'Created private research profile at {profile}; model {model["default"]} via {model["provider"]}.')
