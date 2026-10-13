#!/usr/bin/env python
"""
make-test-xlsx.py — generate a REAL .xlsx for verifying the zero-dependency
XLSX reader in vault/lib/xlsx.js.

openpyxl writes genuine shared strings, numeric cells, booleans, dates and a
second worksheet, which is exactly the mix the reader has to survive. The
Coordinates sheet deliberately starts with a blank column and a blank row to
prove cell-reference handling (gaps) works.

Usage:
    python tools/make-test-xlsx.py data/sample-businesses.xlsx
"""
import datetime
import sys
from openpyxl import Workbook


def main(path: str) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Businesses"

    ws.append([
        "Business ID", "Business Name", "Category", "City", "Area / Locality",
        "PIN Code", "Full Address", "Are you the business owner?",
        "Rating", "Verified", "Listed On", "Notes",
    ])

    ws.append([
        "XLS-3001", "Agarwal Sweets", "Bakery", "Gorakhpur", "Golghar",
        "273001", '12, "Main" Bazaar Road', "Yes, I own it",
        4.5, True, datetime.date(2026, 1, 15), "Best in town",
    ])
    ws.append([
        "XLS-3002", "Noida Auto Works", "Car Repair", "Noida", "Sector 63",
        "201301", "Plot 9 & 10, Sector 63", "No, submitting for them",
        3.75, False, datetime.date(2026, 2, 1), "Line one\nline two",
    ])
    ws.append([
        "XLS-3003", "Blue Bottle Bakery", "Bakery", "Ghaziabad", "Vaishali",
        "201010", "Shop 2, Vaishali", "Yes, I own it",
        4.0, True, datetime.date(2026, 3, 9), None,
    ])
    ws.append([
        "XLS-3004", None, "Restaurant", "Delhi", "Rohini",
        "110085", "Sector 7, Rohini", "Yes, I own it",
        None, None, None, "no name on purpose — must be rejected",
    ])

    # A second sheet, with a blank leading column and a blank leading row.
    ws2 = wb.create_sheet("Coordinates")
    ws2.append([])
    ws2.append([None, "Business ID", "Latitude", "Longitude", "DIGIPIN"])
    ws2.append([None, "XLS-3001", 26.7600, 83.3730, "2F2JTFVG33"])
    ws2.append([None, "XLS-3002", 28.6200, 77.3800, "2G7UZTMHTT"])

    wb.save(path)
    print(f"wrote {path}")
    print(f"  sheets      : {wb.sheetnames}")
    print(f"  Businesses  : {ws.max_row - 1} data rows x {ws.max_column} columns")
    print(f"  Coordinates : {ws2.max_row - 1} data rows")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/sample-businesses.xlsx")
