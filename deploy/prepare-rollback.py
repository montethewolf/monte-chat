#!/usr/bin/env python3
"""Prepare v7 state for an older gateway after both voice services are stopped.
Research must be terminal. Preserve every Work task and current session selection.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--tasks', type=Path, required=True)
parser.add_argument('--selection', type=Path, required=True)
args = parser.parse_args()
tasks = json.loads(args.tasks.read_text()) if args.tasks.exists() else None
selection = json.loads(args.selection.read_text()) if args.selection.exists() else None
if tasks:
    for task in tasks['tasks']:
        if task.get('backend') == 'research' and task['status'] not in ('completed', 'failed', 'cancelled'):
            raise SystemExit('Finish or cancel outstanding research with the v7 gateway before rollback; no state changed.')
suffix = datetime.now(timezone.utc).strftime('.v7-%Y%m%dT%H%M%SZ')
for path, value in [(args.tasks, tasks), (args.selection, selection)]:
    if value is None:
        continue
    backup = Path(str(path) + suffix)
    backup.write_bytes(path.read_bytes()); os.chmod(backup, 0o600)
    if path == args.tasks:
        value['tasks'] = [task for task in value['tasks'] if task.get('backend') != 'research']
        for task in value['tasks']:
            task.pop('backend', None); task.pop('research', None)
    elif value.get('version') == 3:
        value = {'version': 2, 'defaultSessionId': value['defaultSessionId'], 'focus': value['focus']}
    temporary = Path(str(path) + '.rollback-tmp')
    temporary.write_text(json.dumps(value)); os.chmod(temporary, 0o600); temporary.replace(path)
print('Rollback state prepared. Work tasks and current selections retained; v7 snapshots preserved alongside them.')
