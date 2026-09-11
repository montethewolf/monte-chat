#!/usr/bin/env python3
"""Convert inactive v8 task extensions for the monte.2 gateway; retain all tasks."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def prepare(path):
    path = Path(path)
    data = json.loads(path.read_text())
    if data.get('schemaVersion') not in (1, 2) or not isinstance(data.get('tasks'), list):
        raise ValueError('Unsupported task document; state unchanged')
    extensions = ('purpose', 'interactiveApprovals', 'selectedSessionId', 'origin', 'approval', 'approvalQueue')
    for task in data['tasks']:
        if any(key in task for key in extensions) and task.get('status') not in ('completed', 'failed', 'cancelled'):
            raise ValueError('Finish or stop all v8 tasks before rollback; state unchanged')
    backup = path.with_name(path.name + '.v8-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    with backup.open('xb') as file:
        os.chmod(backup, 0o600)
        file.write(path.read_bytes())
    data['schemaVersion'] = 1
    for task in data['tasks']:
        task['schemaVersion'] = 1
        for key in extensions:
            task.pop(key, None)
        if task.get('backend') != 'research':
            task.pop('research', None)
    temporary = path.with_name(path.name + '.rollback.tmp')
    with temporary.open('x') as file:
        os.chmod(temporary, 0o600)
        json.dump(data, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)
    return backup


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tasks', type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.tasks))
