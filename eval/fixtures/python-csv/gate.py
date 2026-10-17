import sys
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from row_parser import parse_row

cases = [
    (["a", "b"], '"a,b",c', {"a": "a,b", "b": "c"}),
    (["only"], '"quoted ""value"""', {"only": 'quoted "value"'}),
    (["a", "b"], "1,2,3", {"a": "1", "b": "2"}),
    ([], "x", {}),
]
for header, row, expected in cases:
    if parse_row(header, row) != expected:
        raise SystemExit(1)
