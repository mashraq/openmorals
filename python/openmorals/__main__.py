"""``openmorals`` and ``python -m openmorals``: run the openmorals binary with these arguments."""

import sys
from typing import List, Optional

from ._binary import run


def main(argv: Optional[List[str]] = None) -> int:
    return run(list(sys.argv[1:] if argv is None else argv))


def entry() -> None:
    sys.exit(main())


if __name__ == "__main__":
    entry()
