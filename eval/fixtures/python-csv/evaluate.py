import json
import statistics
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path.cwd()))
from row_parser import parse_row

header = [f"column_{index}" for index in range(24)]
rows = [",".join(f"value_{row}_{column}" for column in range(24)) for row in range(1200)]
expected = dict(zip(header, rows[0].split(",")))
samples = []
valid = True
for _ in range(3):
    started = time.perf_counter()
    parsed = [parse_row(header, row) for row in rows]
    samples.append((time.perf_counter() - started) * 1000)
    valid = valid and parsed[0] == expected and parsed[-1]["column_23"] == "value_1199_23"
result = {"score": statistics.median(samples), "valid": valid, "fail_class": "ok" if valid else "wrong_answer", "error": None if valid else "CSV parse mismatch", "samples": samples}
Path("eval").mkdir(exist_ok=True)
Path("eval/score.json").write_text(json.dumps(result), encoding="utf-8")
