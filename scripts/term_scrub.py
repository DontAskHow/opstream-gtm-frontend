"""Terms that must never reach the page, and the words shown instead.

Collected calls mention a third-party AI product by name. The dashboard
does not show it: GrokBot becomes "the assistant", any other Grok word "the AI model".
The same rules are in scripts/term-scrub.mjs for the server.
"""
import os
import re
import sys

RULES = [
    (re.compile(r"grok[\s\-_]*bot", re.I), "the assistant"),
    (re.compile(r"grok\w*", re.I), "the AI model"),
]


def scrub_text(text):
    for pattern, word in RULES:
        text = pattern.sub(word, text)
    return text


def scrub_dir(root):
    """Rewrite every text file under root in place. Returns the files changed."""
    changed = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            if not name.endswith((".json", ".txt", ".html", ".md")):
                continue
            path = os.path.join(base, name)
            with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
                text = f.read()
            new = scrub_text(text)
            if new != text:
                with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
                    f.write(new)
                changed.append(path)
    return changed


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OUT_DATA") or "out/data"
    done = scrub_dir(target)
    print("term scrub: %d file(s) rewritten under %s" % (len(done), target))
