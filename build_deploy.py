from __future__ import annotations

import json
import os
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
ARCHIVE = ROOT / "雅思听读教练站.zip"
FILES = (
    "index.html",
    "styles.css",
    "app.js",
    "model.js",
    "curriculum.js",
    "cloud.js",
    "cloud-config.js",
    "manifest.webmanifest",
    "service-worker.js",
    "supabase-setup.sql",
    "README.md",
    "VALIDATION.md",
)
DIRECTORIES = ("vendor", "icons")


def ensure_inside_site(path: Path) -> None:
    resolved = path.resolve()
    if resolved == ROOT or ROOT not in resolved.parents:
        raise RuntimeError(f"Refusing to modify a path outside the standalone site: {resolved}")


def cloud_override() -> dict[str, str] | None:
    specific = (
        os.environ.get("IELTS_COACH_SUPABASE_URL", "").strip(),
        os.environ.get("IELTS_COACH_SUPABASE_ANON_KEY", "").strip(),
    )
    generic = (
        os.environ.get("SUPABASE_URL", "").strip(),
        os.environ.get("SUPABASE_ANON_KEY", "").strip(),
    )
    url, anon_key = specific if any(specific) else generic
    if not url and not anon_key:
        return None
    if not url or not anon_key:
        raise RuntimeError("Supabase URL and public client key must be supplied together.")
    if not url.startswith("https://"):
        raise RuntimeError("The production Supabase URL must use HTTPS.")
    return {"provider": "supabase", "url": url, "anonKey": anon_key}


def main() -> None:
    ensure_inside_site(DIST)
    ensure_inside_site(ARCHIVE)
    config = cloud_override()
    # Validate inputs before touching an existing build.
    for relative in FILES + DIRECTORIES:
        if not (ROOT / relative).exists():
            raise FileNotFoundError(ROOT / relative)

    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for relative in FILES:
        shutil.copy2(ROOT / relative, DIST / relative)
    for relative in DIRECTORIES:
        shutil.copytree(ROOT / relative, DIST / relative)

    if config:
        (DIST / "cloud-config.js").write_text(
            "// Generated from deployment environment; public client configuration only.\n"
            "window.IELTS_COACH_CLOUD = "
            + json.dumps(config, ensure_ascii=False, indent=2)
            + ";\n",
            encoding="utf-8",
        )
    if ARCHIVE.exists():
        ARCHIVE.unlink()
    with zipfile.ZipFile(ARCHIVE, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(DIST.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(DIST).as_posix())
    print(f"Built standalone site: {DIST}")
    print(f"Deployment archive: {ARCHIVE}")


if __name__ == "__main__":
    main()
