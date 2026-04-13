"""Split PSL publication markdown files into per-chapter files.

Each book has a different internal structure (PDF-to-markdown artifacts,
ALL-CAPS section titles, etc.), so splits are defined manually per book.

Input:  corpus/psl-publications/{book}.md
Output: corpus/psl-publications/{book}/{nn}-{slug}.md

Usage:
    uv run python scrapers/split_psl_books.py
"""

import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus/psl-publications")
CORPUS_1804 = Path("corpus/psl-1804")


def slugify(title: str) -> str:
    s = title.lower().strip()
    s = re.sub(r"[''']", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def split_book(filepath: Path, chapters: list[tuple[int, int, str]]) -> None:
    """Split a book file into chapter files.

    Args:
        filepath: Path to the source markdown file.
        chapters: List of (start_line, end_line, title) tuples.
                  Line numbers are 1-indexed. end_line is exclusive.
    """
    lines = filepath.read_text(encoding="utf-8").splitlines(keepends=True)
    book_slug = filepath.stem
    out_dir = filepath.parent / book_slug
    out_dir.mkdir(exist_ok=True)

    for i, (start, end, title) in enumerate(chapters):
        slug = slugify(title)
        filename = f"{i + 1:02d}-{slug}.md"
        content = "".join(lines[start - 1 : end - 1])
        (out_dir / filename).write_text(content, encoding="utf-8")
        log.info("  %s (%d lines)", filename, end - start)

    log.info("split %s into %d files in %s/", filepath.name, len(chapters), out_dir)


# ── Book definitions ──────────────────────────────────────────────────


def split_rule_of_the_banks():
    filepath = CORPUS_DIR / "rule-of-the-banks.md"
    lines = filepath.read_text(encoding="utf-8").splitlines()
    total = len(lines) + 1

    # Single pamphlet with ALL-CAPS subsections. Find them dynamically.
    # Running headers are spaced-out (contain triple spaces), skip those.
    sections: list[tuple[int, str]] = []
    sections.append((46, "Opening"))

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if (
            stripped
            and stripped == stripped.upper()
            and len(stripped) > 10
            and "   " not in stripped  # skip spaced-out running headers
            and not stripped.isdigit()
            and i > 46
        ):
            sections.append((i, stripped.title()))

    chapters = []
    for j in range(len(sections)):
        start = sections[j][0]
        end = sections[j + 1][0] if j + 1 < len(sections) else total
        chapters.append((start, end, sections[j][1]))

    split_book(filepath, chapters)


def split_shackled_and_chained():
    filepath = CORPUS_DIR / "shackled-and-chained.md"

    chapters = [
        (88, 176, "Introduction"),
        (176, 844, "Ch 1 - An overview of mass incarceration"),
        (844, 1615, "Ch 2 - Enter the torture chambers"),
        (1615, 2224, "Ch 3 - The history of US incarceration"),
        (2224, 2683, "Ch 4 - Revolution in the air"),
        (2683, 3076, "Ch 5 - The law-and-order response"),
        (3076, 4025, "Ch 6 - Economic and ideological restructuring"),
        (4025, 4755, "Ch 7 - The war on drugs"),
        (4755, 5375, "Ch 8 - Debunking bourgeois theories of crime"),
        (5375, 5803, "Ch 9 - What alternatives to mass incarceration"),
        (5807, 6613, "Appendix A - Free all political prisoners"),
        (6613, 6926, "Appendix B - A letter from prison"),
        (6926, 7746, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_socialism_and_war():
    filepath = CORPUS_DIR / "socialism-and-war.md"

    chapters = [
        (234, 271, "Introduction"),
        (271, 854, "When justifying imperialist intervention goes wrong"),
        (854, 1542, "Socialists and war - two opposing trends"),
        (1542, 1963, "Appendix I - Libya and the Western left"),
        (1963, 2211, "Appendix II - Manifesto of the Basel Congress"),
    ]
    split_book(filepath, chapters)


def split_supreme_court():
    filepath = CORPUS_DIR / "supreme-court-and-democracy.md"

    chapters = [
        (46, 107, "Introduction"),
        (107, 227, "The Supreme Court versus democracy"),
        (227, 322, "A new stage - the counterrevolution against democratic rights"),
        (322, 406, "Struggles inside the ruling class"),
        (406, 531, "The root cause of the modern instability"),
        (531, 663, "Social and political origins of the assault on democratic rights"),
        (663, 985, "The long-term impact of the stolen 2000 election"),
        (985, 1128, "Towards a new right-wing form of government"),
        (1128, 1243, "Democratic Party puts up no serious resistance"),
        (1243, 1292, "Where are we headed"),
        (1292, 1367, "How the people can win"),
        (1367, 1440, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_wisconsin():
    filepath = CORPUS_DIR / "wisconsin.md"

    chapters = [
        (134, 393, "Introduction - The starting point of a new struggle"),
        (393, 625, "Chronology of the Wisconsin struggle"),
        (625, 823, "No more business as usual"),
        (823, 919, "We have moved into the Capitol Building"),
        (919, 1001, "Stand with the workers and students"),
        (1001, 1351, "The billionaires vs the people"),
        (1351, 1434, "Victory to the Wisconsin workers"),
        (1434, 1590, "The truth behind Wisconsins budget crisis"),
        (1590, 1716, "Now is the time"),
        (1716, 1924, "Movement shatters myths about US workers youth"),
        (1924, 2106, "The role of students in the struggle"),
        (2106, 2258, "What is at stake in Wisconsin showdown"),
        (2258, 2618, "Growing class consciousness and the battles ahead"),
        (2618, 2865, "A general strike can lead to victory"),
        (2865, 2940, "Labor can win"),
        (2940, 3258, "Sowing the seeds of workers power"),
    ]
    split_book(filepath, chapters)


def split_china_and_the_world():
    filepath = CORPUS_1804 / "china-and-the-world.md"

    chapters = [
        (66, 292, "Foreword"),
        (292, 384, "Introduction"),
        (384, 1097, "Ch 1 - 1949-1959"),
        (1097, 1590, "Ch 2 - 1960-1965"),
        (1590, 1953, "Ch 3 - 1966-1976"),
        (1953, 2360, "Ch 4 - 1976-1989"),
        (2360, 2901, "Ch 5 - 1990-2010"),
        (2901, 3615, "Ch 6 - 2011-2020"),
        (3615, 4176, "Ch 7 - 2020-2024"),
        (4176, 4393, "Bibliography"),
    ]
    split_book(filepath, chapters)


def split_chinas_rev_quest():
    filepath = CORPUS_1804 / "chinas-rev-quest-socialist-future.md"

    chapters = [
        (78, 420, "Introduction"),
        (420, 1104, "Ch 1 - Historical background"),
        (1104, 1695, "Ch 2 - From the May Fourth Movement to liberation"),
        (1695, 2577, "Ch 3 - Building a new China and the struggle between two lines"),
        (2577, 3136, "Ch 4 - Reform and opening under Deng Xiaoping"),
        (3136, 3831, "Ch 5 - China in the twenty-first century"),
        (3831, 5346, "Reflection - The contradictions of liberation"),
        (5346, 6345, "Glossary of names"),
        (6345, 7091, "Endnotes"),
        (7091, 7757, "Index"),
    ]
    split_book(filepath, chapters)


def split_palestine():
    filepath = CORPUS_1804 / "palestine-israel-us-empire.md"

    chapters = [
        (179, 268, "Preface to second edition"),
        (268, 558, "Introduction to second edition"),
        (558, 568, "Editors note"),
        (568, 1249, "Chronology of the struggle for Palestine"),
        (1249, 1360, "Section I - Overview"),
        (1360, 1641, "Does the Israel lobby control US policy"),
        (1641, 1842, "Section II - Dividing the Middle East"),
        (1842, 2105, "Zionism a colonial project"),
        (2105, 2491, "Building a settler state American style"),
        (2491, 2646, "The revolution of 1936-1939 in Palestine"),
        (2646, 2779, "World War II anti-semitism and genocide"),
        (2779, 3031, "Illegal UN partition"),
        (3031, 3251, "Born of massacres and ethnic cleansing"),
        (3251, 3517, "Section III - Watchdog for the West"),
        (3517, 3682, "Fortifying the US-Israeli alliance"),
        (3682, 3932, "The Palestinian struggle takes center stage"),
        (3932, 4170, "Lebanon civil war and occupation"),
        (4170, 4448, "Intifada peace process intifada"),
        (4448, 4690, "Imperialist failure the new Middle East"),
        (4690, 5141, "US-Israeli relations after Bush"),
        (5141, 5590, "Section IV - Is Israel an apartheid state"),
        (5590, 5741, "The Palestinian right of return"),
        (5741, 5873, "Subsidizing occupation US aid to Israel"),
        (5873, 6160, "Palestine and the US anti-war movement"),
        (6160, 6349, "The irreconcilable conflict and the future"),
        (6349, 7280, "Appendix A - Israel base of Western imperialism"),
        (7280, 7393, "Appendix B - Auschwitz survivor Hajo Meyer"),
        (7393, 7873, "Appendix C - The US Israel and the project to end Palestine"),
        (7873, 8101, "Appendix D - Ahmed Saadat on the Palestinian struggle"),
        (8101, 8831, "Endnotes"),
        (8831, 9558, "Index"),
    ]
    split_book(filepath, chapters)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    split_rule_of_the_banks()
    split_shackled_and_chained()
    split_socialism_and_war()
    split_supreme_court()
    split_wisconsin()
    split_china_and_the_world()
    split_chinas_rev_quest()
    split_palestine()


if __name__ == "__main__":
    main()
