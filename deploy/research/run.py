#!/usr/bin/env python3
"""Start existing Hermes only after verifying the research dispatch boundary."""
import os
from pathlib import Path
import runpy
import sys

# Do not inherit Work integration credentials or project/plugin environment.
allowed = {'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'INVOCATION_ID', 'JOURNAL_STREAM',
           'HERMES_HOME', 'HERMES_RESEARCH_SOURCE', 'HERMES_LIVE_REPOSITORY_REGISTRY',
           'API_SERVER_KEY', 'API_SERVER_HOST', 'API_SERVER_PORT'}
for name in list(os.environ):
    if name not in allowed:
        del os.environ[name]
profile = Path(os.environ['HERMES_HOME']).resolve()
if profile == (Path.home() / '.hermes').resolve():
    raise SystemExit('Refusing to run the research restriction in the Work profile')
os.chdir(profile)
sys.path.insert(0, os.environ.get('HERMES_RESEARCH_SOURCE', str(Path.home() / '.hermes/hermes-agent')))
os.environ['HERMES_ENABLE_PROJECT_PLUGINS'] = '0'
from hermes_cli.plugins import discover_plugins, invoke_hook
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
from model_tools import get_tool_definitions, handle_function_call
from agent.agent_runtime_helpers import invoke_tool
from types import SimpleNamespace

discover_plugins(force=True)
allowed_tools = {'repo_list', 'repo_read', 'repo_search'}
config = load_config()
if config.get('plugins', {}).get('enabled') != ['monte-research'] or config.get('mcp_servers'):
    raise SystemExit('Research profile contains unexpected plugins or integrations')
if set(_get_platform_tools(config, 'api_server')) != {'monte_research'}:
    raise SystemExit('Research toolset is not exclusively enabled')
definitions = get_tool_definitions(enabled_toolsets=['monte_research'], quiet_mode=True, skip_tool_search_assembly=True)
actual = {d.get('function', d).get('name') for d in definitions}
if actual != allowed_tools:
    raise SystemExit('Research tool definitions do not match the dispatch allowlist')
for name in ['terminal', 'write_file', 'delegate_task', 'send_message', 'tool_search', 'tool_call', 'execute_code', 'hidden_tool']:
    result = invoke_tool(SimpleNamespace(session_id='research-preflight'), name, {}, 'research-preflight')
    if 'Research profile permits only' not in result:
        raise SystemExit('Research tool-call hook did not block a forbidden operation')
if not any(v and v.get('action') == 'block' for v in invoke_hook('pre_tool_call', tool_name='terminal', args={})):
    raise SystemExit('Research enforcement hook is missing')
if '--check' in sys.argv:
    print('Research profile verified: isolated home, three repository tools, forbidden dispatch blocked.')
    raise SystemExit(0)
sys.argv = ['hermes', 'gateway', 'run']
runpy.run_module('hermes_cli.main', run_name='__main__')
