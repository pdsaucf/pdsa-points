#!/usr/bin/env python3
"""Turn a roster CSV into idempotent SQL that loads members and enrolls them.

Officers need a bulk path before the first event of the year. Starting from an
empty roster, the first GBM would otherwise produce a review queue full of
"add as a new member" decisions, one per attendee, which is not a reasonable
way to spend an evening. The CSV import UI is a later phase; this script is
the stopgap, and it is deliberately generic: it takes whatever roster source
the officers actually have, not any particular spreadsheet.

Input
    A CSV with a header row. Required columns: first_name, last_name.
    Optional: email. Extra columns are ignored. Column names are matched
    case-insensitively and tolerate spaces or hyphens instead of underscores,
    so "First Name" and "first-name" both work.

Output
    SQL on stdout, or to --out. Every statement is idempotent, so running the
    generated file twice inserts nothing the second time.

Privacy
    A real roster is student PII. It does not belong in this repository, and
    neither does the SQL generated from it. Both patterns are gitignored.
    Write the output somewhere local and apply it directly.

Usage
    python3 scripts/import_roster.py roster.csv --year 2026-2027 --out local/roster.sql
    python3 scripts/import_roster.py roster.csv --year 2026-2027 --dry-run
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from dataclasses import dataclass


REQUIRED_COLUMNS = ("first_name", "last_name")
OPTIONAL_COLUMNS = ("email",)

# Deliberately loose. The job here is to catch a column of phone numbers or a
# stray header row, not to adjudicate RFC 5322.
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RosterError(Exception):
    """Anything that should stop the run with a message naming the row."""


@dataclass
class Person:
    first_name: str
    last_name: str
    email: str | None
    source_row: int

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def name_key(self) -> str:
        """Normalised full name, matching fn_normalise_name() in migration 03.

        Lowercased, punctuation replaced with spaces, whitespace collapsed. So
        "O'Brien" and "OBrien" collide, which for duplicate detection is the
        behaviour we want.
        """
        return re.sub(r"[^a-z0-9]+", " ", self.full_name.lower()).strip()

    @property
    def email_key(self) -> str | None:
        return self.email.lower() if self.email else None


def normalise_header(name: str) -> str:
    return re.sub(r"[\s\-]+", "_", (name or "").strip().lower())


def read_roster(path: str) -> list[Person]:
    try:
        handle = open(path, newline="", encoding="utf-8-sig")
    except OSError as exc:
        raise RosterError(f"could not open {path}: {exc}") from exc

    with handle:
        reader = csv.reader(handle)

        try:
            raw_header = next(reader)
        except StopIteration:
            raise RosterError(f"{path} is empty. A header row is required.") from None

        header = [normalise_header(c) for c in raw_header]
        missing = [c for c in REQUIRED_COLUMNS if c not in header]
        if missing:
            raise RosterError(
                f"{path} is missing required column(s): {', '.join(missing)}. "
                f"Found: {', '.join(h for h in header if h) or '(nothing)'}. "
                "A header row naming first_name and last_name is required."
            )

        index = {name: i for i, name in enumerate(header) if name}
        people: list[Person] = []

        for row_number, row in enumerate(reader, start=2):
            if not any((cell or "").strip() for cell in row):
                continue  # a blank line is not an error

            def cell(column: str) -> str:
                position = index.get(column)
                if position is None or position >= len(row):
                    return ""
                return (row[position] or "").strip()

            first = cell("first_name")
            last = cell("last_name")
            email = cell("email") or None

            if not first or not last:
                raise RosterError(
                    f"row {row_number}: both first_name and last_name are required, "
                    f"got first_name={first!r} last_name={last!r}. "
                    "Fix the file and run again."
                )

            if email and not EMAIL_RE.match(email):
                raise RosterError(
                    f"row {row_number}: {email!r} does not look like an email address. "
                    "Correct it, or leave the cell empty."
                )

            people.append(
                Person(first_name=first, last_name=last, email=email, source_row=row_number)
            )

    if not people:
        raise RosterError(f"{path} has a header but no data rows.")

    return people


def dedupe(people: list[Person]) -> tuple[list[Person], list[str]]:
    """Drop within-file duplicates, by email when there is one and by
    normalised name otherwise. Returns the survivors and a report."""
    kept: list[Person] = []
    notes: list[str] = []
    seen_email: dict[str, Person] = {}
    seen_name: dict[str, Person] = {}

    for person in people:
        if person.email_key and person.email_key in seen_email:
            first = seen_email[person.email_key]
            notes.append(
                f"row {person.source_row}: skipped, same email as row "
                f"{first.source_row} ({person.email})"
            )
            continue

        if not person.email_key and person.name_key in seen_name:
            first = seen_name[person.name_key]
            notes.append(
                f"row {person.source_row}: skipped, same name as row "
                f"{first.source_row} ({person.full_name}) and no email to tell them apart"
            )
            continue

        if person.email_key:
            seen_email[person.email_key] = person
        seen_name.setdefault(person.name_key, person)
        kept.append(person)

    return kept, notes


def quote(value: str | None) -> str:
    if value is None:
        return "null"
    return "'" + value.replace("'", "''") + "'"


def generate_sql(people: list[Person], year_label: str, source: str) -> str:
    lines: list[str] = []
    add = lines.append

    add("-- Generated by scripts/import_roster.py. Do not commit this file:")
    add("-- it contains real names and email addresses.")
    add(f"-- Source: {source}")
    add(f"-- Academic year: {year_label}")
    add(f"-- Members in this file: {len(people)}")
    add("--")
    add("-- Idempotent. Running it twice inserts nothing the second time.")
    add("")
    add("begin;")
    add("")
    add("-- Fail loudly rather than silently enrolling nobody.")
    add("do $$")
    add("begin")
    add("  if not exists (select 1 from academic_years where label = "
        f"{quote(year_label)}) then")
    add(f"    raise exception 'Academic year % does not exist. Create it first.', "
        f"{quote(year_label)};")
    add("  end if;")
    add("end")
    add("$$;")
    add("")
    add("create temporary table _incoming_roster (")
    add("  first_name text not null,")
    add("  last_name  text not null,")
    add("  email      citext")
    add(") on commit drop;")
    add("")
    add("insert into _incoming_roster (first_name, last_name, email) values")

    values = [
        f"  ({quote(p.first_name)}, {quote(p.last_name)}, {quote(p.email)})" for p in people
    ]
    add(",\n".join(values) + ";")
    add("")
    add("-- Insert only the people who are not already on the roster. A match is")
    add("-- by email when the incoming row has one, and by normalised full name")
    add("-- otherwise, which is the same rule the within-file dedupe used.")
    add("insert into members (first_name, last_name, email)")
    add("select i.first_name, i.last_name, i.email")
    add("from _incoming_roster i")
    add("where not exists (")
    add("  select 1 from members m")
    add("  where (i.email is not null and m.email = i.email)")
    add("     or (i.email is null and fn_normalise_name(m.display_name)")
    add("         = fn_normalise_name(i.first_name || ' ' || i.last_name))")
    add(");")
    add("")
    add("-- Enroll everyone in the file, whether they were just created or were")
    add("-- already on the roster from a previous year.")
    add("insert into member_enrollments (member_id, academic_year_id)")
    add("select m.id, ay.id")
    add("from _incoming_roster i")
    add("join members m")
    add("  on (i.email is not null and m.email = i.email)")
    add("  or (i.email is null and fn_normalise_name(m.display_name)")
    add("      = fn_normalise_name(i.first_name || ' ' || i.last_name))")
    add(f"cross join (select id from academic_years where label = {quote(year_label)}) ay")
    add("where m.archived_at is null and m.merged_into_id is null")
    add("on conflict (member_id, academic_year_id) do nothing;")
    add("")
    add("commit;")
    add("")

    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Turn a roster CSV into idempotent SQL loading members and enrollments.",
    )
    parser.add_argument("csv_path", help="path to the roster CSV")
    parser.add_argument(
        "--year",
        required=True,
        help="academic year label the members are enrolled into, for example 2026-2027",
    )
    parser.add_argument(
        "--out",
        help="write SQL here instead of stdout. Use a gitignored path such as local/roster.sql",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print a summary of what would happen and write no SQL",
    )
    args = parser.parse_args(argv)

    try:
        people = read_roster(args.csv_path)
        kept, notes = dedupe(people)
    except RosterError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Read {len(people)} data row(s) from {args.csv_path}.", file=sys.stderr)
    print(f"  with an email address: {sum(1 for p in kept if p.email)}", file=sys.stderr)
    print(f"  without one:           {sum(1 for p in kept if not p.email)}", file=sys.stderr)

    if notes:
        print(f"Skipped {len(notes)} duplicate row(s) within the file:", file=sys.stderr)
        for note in notes:
            print(f"  {note}", file=sys.stderr)
    else:
        print("No duplicates within the file.", file=sys.stderr)

    print(
        f"Would load {len(kept)} member(s) and enroll them in {args.year}.",
        file=sys.stderr,
    )
    print(
        "Anyone already on the roster (matched by email, or by normalised name "
        "when there is no email) is skipped by the generated SQL and only enrolled.",
        file=sys.stderr,
    )

    if args.dry_run:
        print("Dry run: no SQL written.", file=sys.stderr)
        return 0

    sql = generate_sql(kept, args.year, args.csv_path)

    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(sql)
        except OSError as exc:
            print(f"error: could not write {args.out}: {exc}", file=sys.stderr)
            return 1
        print(f"Wrote {args.out}. This file contains real names: do not commit it.",
              file=sys.stderr)
    else:
        sys.stdout.write(sql)

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
