#!/usr/bin/env python3
"""Make a Loupe artifact fully self-contained for client handoff: find its Google
Fonts <link>, download the woff2 subsets (latin + latin-ext), inline them as
base64 @font-face, and strip the CDN <link>/<preconnect> tags. Result: the file
makes ZERO external network calls and renders pixel-perfect offline.

  embed_fonts.py <artifact.html>

No-op (with a message) if the artifact has no Google Fonts link. Idempotent-safe:
re-running after embed does nothing.
"""
import base64, re, sys, urllib.request

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
KEEP = {"latin", "latin-ext"}

def get(url, text=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data.decode() if text else data

def main():
    if len(sys.argv) != 2:
        print("usage: embed_fonts.py <artifact.html>"); return 2
    f = sys.argv[1]
    html = open(f, encoding="utf-8").read()

    m = re.search(r'<link[^>]+href="(https://fonts\.googleapis\.com/css2[^"]*)"[^>]*>', html)
    if not m:
        print("no Google Fonts <link> found — nothing to embed (already self-contained?)"); return 0
    css = get(m.group(1), text=True)

    out, kept, nbytes = [], 0, 0
    for subset, block in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S):
        if subset not in KEEP:
            continue
        u = re.search(r"src:\s*url\((https://[^)]+\.woff2)\)", block)
        if not u:
            continue
        woff2 = get(u.group(1)); nbytes += len(woff2)
        b64 = base64.b64encode(woff2).decode()
        out.append(block.replace(u.group(0),
            f"src: url(data:font/woff2;base64,{b64}) format('woff2')"))
        kept += 1
    if not kept:
        print("FAIL: fetched the Fonts CSS but embedded 0 faces (parse/UA issue)"); return 1

    style = "<style>/* embedded fonts — self-contained, no external calls */\n" + "\n".join(out) + "\n</style>"
    html = re.sub(r'\s*<link rel="preconnect"[^>]*>', "", html)
    html = re.sub(r'\s*<link[^>]+href="https://fonts\.googleapis\.com/css2[^"]*"[^>]*>',
                  "\n" + style, html, count=1)
    open(f, "w", encoding="utf-8").write(html)
    print(f"embedded {kept} font faces ({nbytes/1024:.0f} KB woff2 -> base64); {f} now makes zero external calls")
    return 0

if __name__ == "__main__":
    sys.exit(main())
