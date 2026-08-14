"""Allow ``python -m sfo_deploy`` to use the generic CLI."""

from .cli import main


if __name__ == "__main__":
    raise SystemExit(main())
