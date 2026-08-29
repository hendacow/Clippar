#!/usr/bin/env python3
"""Port the standalone legal pages from clippar-web into Shopify theme sections.

The source pages are complete HTML documents with their own chrome and a global
stylesheet. Two things have to happen for them to live inside the storefront theme:

  * the page chrome (header/footer/body resets) is dropped — the theme supplies it
  * every remaining selector is scoped under .legal-page, because the source styles
    target bare h1/h2/p/ul/table and :root custom properties that collide with the
    theme's own tokens

Content is otherwise carried across verbatim, so the published policy text stays
identical to what was reviewed.
"""

import os
import re
import sys

SRC = os.path.expanduser(
    "/private/tmp/claude-501/-Users-hendacow-projects-final-shipment-clippar-app/"
    "78487c37-83f0-472b-b890-d0290c5828d1/scratchpad/wt-policies/clippar-web/public"
)
DEST = "/Users/hendacow/projects/final_shipment/clippar-shop"

# handle -> (source file, section name, page title)
PAGES = {
    "privacy": ("privacy.html", "Privacy Policy"),
    "terms": ("terms.html", "Terms of Service"),
    "mount-kit-terms": ("hardware-terms.html", "Mount Kit Terms of Sale"),
}

# Selectors that belong to the standalone page's own chrome. The theme provides
# these, so carrying them over would fight it.
DROP_SELECTOR = re.compile(
    r"^\s*(\*|\*::before|\*::after|body|html|header|footer|:root)\b", re.I
)


def split_rules(css):
    """Yield (selector, body) pairs, keeping @media blocks intact."""
    out, i, n = [], 0, len(css)
    while i < n:
        # Skip whitespace first, or an at-rule preceded by a newline is missed
        # and leaks through as a selector like `.legal-page @media (...)`.
        while i < n and css[i].isspace():
            i += 1
        if i >= n:
            break
        if css[i] == "@":
            depth, j = 0, i
            while j < n:
                if css[j] == "{":
                    depth += 1
                elif css[j] == "}":
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
                j += 1
            out.append(("@", css[i:j]))
            i = j
            continue
        brace = css.find("{", i)
        if brace == -1:
            break
        close = css.find("}", brace)
        if close == -1:
            break
        out.append((css[i:brace].strip(), css[brace + 1 : close].strip()))
        i = close + 1
    return out


def scope(selector):
    """Prefix a selector list with .legal-page, dropping page-chrome rules."""
    parts = []
    for sel in selector.split(","):
        sel = sel.strip()
        if not sel or DROP_SELECTOR.match(sel):
            continue
        if sel == "main":
            parts.append(".legal-page")
        else:
            parts.append(".legal-page %s" % sel)
    return ", ".join(parts)


def scope_css(css):
    lines = []
    for sel, body in split_rules(css):
        if sel == "@":
            # Recurse into @media so its inner selectors get scoped too.
            m = re.match(r"(@[^{]+)\{(.*)\}\s*$", body, re.S)
            if not m:
                continue
            inner = scope_css(m.group(2))
            if inner.strip():
                lines.append("%s{\n%s\n}" % (m.group(1).strip(), inner))
            continue
        scoped = scope(sel)
        if scoped and body:
            lines.append("%s { %s }" % (scoped, body))
    return "\n".join(lines)


def main():
    src_style = None
    written = []

    for handle, (filename, title) in PAGES.items():
        raw = open(os.path.join(SRC, filename)).read()

        if src_style is None:
            src_style = re.search(r"<style>(.*?)</style>", raw, re.S).group(1)
            # Two fixes for the wrapper, appended after the scoped rules so they
            # win on source order:
            #
            #  * box-sizing — the source reset is `*, *::before, *::after`, which
            #    scopes to .legal-page's descendants and leaves the wrapper on
            #    content-box, so its own 28px padding added to the width.
            #  * max-width/min-width — the theme renders sections as a CSS grid
            #    with side gutters. A grid item defaults to min-width:auto and so
            #    refuses to shrink below its content, overflowing the cell and
            #    scrolling the whole page sideways on a phone. Capping at the
            #    container keeps the 760px reading measure on desktop.
            scoped_style = scope_css(src_style) + (
                "\n.legal-page {"
                " box-sizing: border-box;"
                " min-width: 0;"
                " max-width: min(760px, 100%);"
                " }"
            )

        main_html = re.search(r"<main[^>]*>(.*)</main>", raw, re.S).group(1)

        # The source pages cross-link with absolute paths that no longer exist on
        # the storefront; point them at the real page handles. These must match
        # the handles in admin exactly — an earlier guess at /pages/privacy and
        # /pages/terms 404'd, so every cross-link between the legal pages was
        # dead until this was checked against the live store.
        main_html = main_html.replace('href="/privacy"', 'href="/pages/privacy-policy"')
        main_html = main_html.replace('href="/terms"', 'href="/pages/terms-of-service"')
        main_html = main_html.replace(
            'href="/hardware-terms"', 'href="/pages/mount-kit-terms-of-sale"'
        )
        # The source pages carry the absolute contact URL so the link still works
        # if they are served from their own origin; on the storefront it should
        # stay relative.
        main_html = main_html.replace(
            'href="https://clippargolf.com/pages/contact"', 'href="/pages/contact"'
        )

        section = "\n".join(
            [
                "{% comment %}",
                "  " + title + " — ported verbatim from clippar-web/public/" + filename + ".",
                "",
                "  Generated by scratchpad/gen_legal_sections.py. The prose is the reviewed",
                "  legal text and should not be hand-edited here: change the source page on",
                "  main and regenerate, so the app and the storefront never drift apart.",
                "",
                "  Styles are scoped under .legal-page because the source targets bare",
                "  h1/h2/p/table and :root custom properties that would otherwise collide",
                "  with the theme.",
                "{% endcomment %}",
                "",
                '<div class="legal-page">',
                main_html.strip(),
                "</div>",
                "",
                "{% stylesheet %}",
                scoped_style,
                "{% endstylesheet %}",
                "",
                "{% schema %}",
                "{",
                '  "name": "' + title[:25] + '",',
                '  "settings": []',
                "}",
                "{% endschema %}",
                "",
            ]
        )

        path = os.path.join(DEST, "sections", "legal-%s.liquid" % handle)
        with open(path, "w") as fh:
            fh.write(section)

        tmpl = (
            '{\n  "sections": {\n    "main": {\n      "type": "legal-%s",\n'
            '      "settings": {}\n    }\n  },\n  "order": ["main"]\n}\n' % handle
        )
        tpath = os.path.join(DEST, "templates", "page.%s.json" % handle)
        with open(tpath, "w") as fh:
            fh.write(tmpl)

        written.append((handle, title, len(main_html), path, tpath))

    print("scoped stylesheet: %d bytes -> %d bytes" % (len(src_style), len(scoped_style)))
    for handle, title, size, p, t in written:
        print("  %-16s %-26s %6d bytes content" % (handle, title, size))
        print("      %s" % os.path.relpath(p, DEST))
        print("      %s" % os.path.relpath(t, DEST))


if __name__ == "__main__":
    main()
