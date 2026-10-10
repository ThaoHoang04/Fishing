"""Download the free / name-your-own-price ($0) asset packs listed in credits/ASSET_LICENSES.md.

Usage:  python tools/fetch_assets.py [A1 A2 ...]
Raw archives go to vendor/<ID>/ (git-ignored; packs forbid redistribution of source assets).
Also saves each store page HTML as a snapshot of the terms at download time.
"""
import http.cookiejar
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

PACKS = {
    "A1": "https://pinksamurai.itch.io/assets",
    "A2": "https://vryell.itch.io/tiny-coast-pack",
    "A3": "https://benvoide.itch.io/fishing-game",
    "A4": "https://agdawkwardgamedev.itch.io/free-fish-assets",
    "A5": "https://free-game-assets.itch.io/free-fishing-pixel-art-pack",
    "A6": "https://rio1222.itch.io/top-down-fishing-interaction-vfx",
    "A7": "https://mutterpixel-studio.itch.io/free-fishing-boats-pack-animated-pixel-art-assets",
    "A8": "https://dardasaba.itch.io/pixel-islands-free-seafaring-character-pack",
}
ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
TERMS = ROOT / "credits" / "terms"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.addheaders = [("User-Agent", "Mozilla/5.0")]


def get(url):
    with opener.open(url, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def post_json(url, data):
    body = urllib.parse.urlencode(data).encode()
    with opener.open(urllib.request.Request(url, data=body), timeout=60) as r:
        return json.loads(r.read())


def csrf(html):
    m = re.search(r'name="csrf_token" value="([^"]+)"', html) or re.search(r'csrf_token" value="([^"]+)"', html)
    if not m:
        raise RuntimeError("csrf_token not found")
    return m.group(1)


def uploads(html):
    """[(upload_id, filename)] from a game page or download page."""
    out = []
    for m in re.finditer(r'data-upload_id="(\d+)".*?class="name"[^>]*>([^<]+)<', html, re.S):
        if m.group(1) not in [u for u, _ in out]:
            out.append((m.group(1), m.group(2).strip()))
    return out


def fetch(pack_id, page_url):
    dest = VENDOR / pack_id
    dest.mkdir(parents=True, exist_ok=True)
    html = get(page_url)
    TERMS.mkdir(parents=True, exist_ok=True)
    (TERMS / f"{pack_id}_{date.today().isoformat()}.html").write_text(html, encoding="utf-8")

    base = page_url.rstrip("/")
    token = csrf(html)
    files = uploads(html)
    params = {"source": "view_game", "as_props": "1", "after_download_lightbox": "true"}
    if f"{base}/purchase" in html:
        # Name-your-own-price: ask for the $0 download page, which carries a key.
        dl_page = post_json(base + "/download_url", {"csrf_token": token})["url"]
        key = urllib.parse.unquote(re.search(r"/download/([^/?#]+)", dl_page).group(1))
        html = get(dl_page)
        token = csrf(html)
        files = uploads(html)
        params = {"source": "game_download", "download_key": key}
    if not files:
        raise RuntimeError("no downloadable uploads found")

    for upload_id, name in files:
        target = dest / name
        if target.exists() and target.stat().st_size > 0:
            print(f"  = {name} (cached)")
            continue
        url = f"{base}/file/{upload_id}?{urllib.parse.urlencode(params)}"
        resp = post_json(url, {"csrf_token": token})
        if "url" not in resp:
            raise RuntimeError(f"{name}: no signed url in response: {str(resp)[:200]}")
        signed = resp["url"]
        with opener.open(signed, timeout=300) as r:
            target.write_bytes(r.read())
        print(f"  + {name} ({target.stat().st_size // 1024} KB)")


def main():
    ids = sys.argv[1:] or list(PACKS)
    failed = []
    for pid in ids:
        print(f"[{pid}] {PACKS[pid]}")
        try:
            fetch(pid, PACKS[pid])
        except Exception as e:  # keep going; report at the end
            print(f"  ! {e}")
            failed.append(pid)
    if failed:
        print("FAILED:", " ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
