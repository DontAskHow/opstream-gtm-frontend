#!/usr/bin/env python3
"""Write a synthetic brain.db from scripts/synthetic-data.cjs's fixture JSON (tests only).

    python3 scripts/fixture-db.py <fixture.json> <out.db>
"""
import json
import os
import sqlite3
import sys


def write(fixture, out):
    if os.path.exists(out):
        os.remove(out)
    con = sqlite3.connect(out)
    for name, t in fixture['tables'].items():
        con.execute('CREATE TABLE %s (%s)' % (name, ', '.join('"%s"' % c for c in t['columns'])))
        rows = [[json.dumps(v) if isinstance(v, (dict, list)) else v for v in r] for r in t['rows']]
        if rows:
            con.executemany('INSERT INTO %s VALUES (%s)' % (name, ','.join('?' * len(t['columns']))), rows)
    con.commit()
    con.close()


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as f:
        write(json.load(f), sys.argv[2])
