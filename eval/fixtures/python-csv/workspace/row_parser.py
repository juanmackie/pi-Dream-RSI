import csv
from io import StringIO


def parse_row(header, row):
    values = next(csv.reader(StringIO(row)))
    return dict(zip(header, values))
