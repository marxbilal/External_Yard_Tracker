"""Convert the stock report Excel into data/seed.json.

The server loads seed.json only when its database has no vehicles yet.
Usage:  python scripts/excel_to_seed.py "C:\\path\\STOCK REPORT.xlsx" data\\seed.json
"""
import json
import sys
from datetime import date, datetime

import openpyxl

COLUMNS = {
    "CUSTOMER NAME": "customer_name", "VIN": "vin", "5 DIGIT": "five_digit", "MAKE": "make",
    "MODEL": "model", "COLOR": "color", "YARD": "yard", "BL": "bl", "IN": "in_date", "OUT": "out_date",
}


def cell(v):
    if v is None:
        return ""
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def main(src, dst):
    ws = openpyxl.load_workbook(src, read_only=True, data_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    header = [str(h or "").strip().upper() for h in next(rows)]
    idx = {COLUMNS[h]: i for i, h in enumerate(header) if h in COLUMNS}
    missing = set(COLUMNS.values()) - set(idx)
    if missing:
        sys.exit(f"Missing columns in Excel: {sorted(missing)}")
    out, mismatch = [], 0
    for r in rows:
        rec = {k: cell(r[i]) for k, i in idx.items()}
        if not rec["vin"]:
            continue
        rec["five_digit"] = rec["five_digit"].zfill(5) if rec["five_digit"].isdigit() else rec["five_digit"]
        if rec["five_digit"].upper() != rec["vin"][-5:].upper():
            mismatch += 1
        out.append(rec)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"{len(out)} rows written; 5-digit differs from VIN ending on {mismatch} rows; "
          f"VIN lengths: {sorted({len(r['vin']) for r in out})}; "
          f"5-digit lengths: {sorted({len(r['five_digit']) for r in out})}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
