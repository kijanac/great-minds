"""Split Liberation Media books into per-chapter files.

Input:  corpus/liberation-media/{book}.md
Output: corpus/liberation-media/{book}/{nn}-{slug}.md

Usage:
    uv run python scrapers/split_liberation_media.py
"""

import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

CORPUS_DIR = Path("corpus/liberation-media")


def slugify(title: str) -> str:
    s = title.lower().strip()
    s = re.sub(r"[''']", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def split_book(filepath: Path, chapters: list[tuple[int, int, str]]) -> None:
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


def split_divide_and_ruin():
    filepath = CORPUS_DIR / "divide-and-ruin.md"

    chapters = [
        (130, 310, "Introduction"),
        (310, 398, "Part 1 - Imperialism in crisis"),
        (398, 505, "They actually quite enjoy it - The Afghan war"),
        (505, 708, "Arab resistance and the end of US hegemony"),
        (708, 951, "Part 2 - Privatisation and bombing"),
        (951, 1403, "The West aims to turn the global South into a failed state"),
        (1403, 1577, "Britain and the Arab Spring"),
        (1577, 1755, "Part 3 - NATOs war against Libya"),
        (1755, 2347, "Mali Algeria and the African Union"),
        (2347, 2468, "Morsi in Tehran"),
        (2468, 2707, "Part 4 - NATO has been cultivating its Libyan allies since 2007"),
        (2707, 2831, "Libya Africa and AFRICOM an ongoing disaster"),
        (2831, 2976, "The imperial agenda of AFRICOMs Africa Command"),
        (2976, 3370, "Slouching towards Sirte a review"),
        (3370, 3526, "When are humans not human"),
        (3526, 3740, "Part 5 - The Wests greatest fear is a peaceful resolution"),
        (3740, 3881, "The Syrian National Initiative"),
        (3881, 4000, "War on Syria means war on Palestine"),
        (4000, 4389, "The British parliament only likes to attack the weak"),
        (4389, 4601, "Part 6 - Reflections on rebellious media"),
        (4601, 4685, "The Dark Knight Rises"),
        (4685, 4803, "Part 7 - Wealth redistribution and police accountability"),
        (4803, 4935, "How David Starkey is right"),
        (4935, 5105, "Perry Atherton political prisoner"),
        (5105, 5693, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_socialist_reconstruction():
    filepath = CORPUS_DIR / "socialist-reconstruction.md"

    chapters = [
        (202, 540, "Preface - The thinking behind socialist reconstruction"),
        (540, 994, "Introduction"),
        (994, 1901, "Ch 1 - Socialism in the United States"),
        (1901, 2669, "Ch 2 - The socialist government"),
        (2669, 3204, "Ch 3 - An energy future for people and the planet"),
        (3204, 4098, "Ch 4 - Ending the stranglehold of debt and finance capital"),
        (4098, 4809, "Ch 5 - Reconstructing agriculture"),
        (4809, 5460, "Ch 6 - Housing and transportation"),
        (5460, 6156, "Ch 7 - Medicine for the people"),
        (6156, 6761, "Ch 8 - Socialist education"),
        (6761, 7404, "Ch 9 - Crime policing and public safety"),
        (7404, 7976, "Ch 10 - Ending imperialist wars"),
        (7976, 8079, "Conclusion"),
        (8079, 9070, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_storming_the_gates():
    filepath = CORPUS_DIR / "storming-the-gates.md"

    chapters = [
        (122, 184, "Preface"),
        (184, 919, "Introduction - The importance of the 100th anniversary"),
        (919, 1725, "The October Revolution workers take power"),
        (1725, 2624, "The early years of the Russian Revolution"),
        (2624, 2921, "Why we continue to defend the Soviet Union"),
        (2921, 3162, "Lenins April Theses"),
        (3162, 3602, "Socialism and the legacy of the Soviet Union"),
        (3602, 3841, "Lenin World War I and the social roots of opportunism"),
        (3841, 4267, "Lenin and the right of nations to self-determination"),
        (4267, 4393, "Nadezhda Krupskaya"),
        (4393, 4506, "Celebrating International Womens Day"),
        (4506, 5064, "Black Bolsheviks and white lies"),
        (5064, 6241, "How the ideas of The State and Revolution changed history"),
        (6241, 6799, "The actuality of revolution"),
        (6799, 7106, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_women_fight_back():
    filepath = CORPUS_DIR / "women-fight-back.md"

    chapters = [
        (85, 192, "Preface"),
        (192, 827, "Introduction - Women advance through struggle"),
        (827, 2003, "Ch 1 - The status of US women"),
        (2003, 2441, "Ch 2 - The origin of womens oppression"),
        (2441, 3220, "Ch 3 - Women in three socialist revolutions"),
        (3220, 4266, "Ch 4 - A new movement is born the 1800s"),
        (4266, 5454, "Ch 5 - Suffrage and social justice 1900-1940"),
        (5454, 5951, "Ch 6 - War and postwar America 1940-1960"),
        (5951, 7255, "Ch 7 - Feminism and the mass movements 1960-1990"),
        (7255, 8789, "Ch 8 - A movement that transformed society"),
        (8789, 10088, "Ch 9 - The right-wing backlash and continued attacks"),
        (10088, 12082, "Ch 10 - The womens movement today 1990-2016"),
        (12082, 13188, "Ch 11 - What kind of movement for the Trump era"),
        (13188, 15561, "Appendices"),
        (15561, 17171, "Endnotes"),
        (17171, 18836, "Bibliography"),
        (18836, 19890, "Index"),
    ]
    split_book(filepath, chapters)


def split_imperialism_21st_century():
    filepath = CORPUS_DIR / "imperialism-21st-century.md"

    chapters = [
        (97, 1105, "Ch 1 - Learning from Lenins Imperialism 100 years later"),
        (1105, 2110, "Ch 2 - From inter-imperialist war to global class war"),
        (2110, 3185, "Ch 3 - The unipolar era of imperialism"),
        (3185, 3655, "Ch 4 - The social basis for opportunism"),
        (3655, 3861, "Endnotes"),
    ]
    split_book(filepath, chapters)


def split_revolution_manifesto():
    filepath = CORPUS_DIR / "revolution-manifesto.md"

    chapters = [
        (120, 285, "Ch 1 - What is the state an overview"),
        (285, 1508, "Ch 2 - How the ideas of The State and Revolution changed history"),
        (1508, 1920, "Ch 3 - Living and cooperating without a state"),
        (1920, 2651, "Ch 4 - The US state and the US revolution"),
        (
            2651,
            3306,
            "Ch 5 - The Soviet Union why the workers state could not wither away",
        ),
        (3306, 3649, "Ch 5 addendum - Lenin the early Soviet Union and the Commune"),
        (3649, 4220, "Ch 6 - Cubas state in revolution"),
        (4220, 4526, "Endnotes"),
    ]
    split_book(filepath, chapters)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    split_divide_and_ruin()
    split_socialist_reconstruction()
    split_storming_the_gates()
    split_women_fight_back()
    split_imperialism_21st_century()
    split_revolution_manifesto()


if __name__ == "__main__":
    main()
