#!/usr/bin/env python3
"""Replace every published email address with a link to the contact form.

The address `clippargolf@gmail.com` appeared 17 times across the storefront's
legal pages, the two Shopify policies and the source pages they are generated
from. Publishing it invites scraping and puts a personal inbox on the public
record; a form gives the same reachability without the address, and routes the
enquiry to a topic.

Replacements are whole sentences rather than a blind swap of the anchor, because
"email <a>address</a> and we'll fix it" does not read correctly once the address
becomes a form. Every entry is asserted to apply, so a source file that drifts
fails loudly instead of silently leaving an address behind.

The link differs by host: the theme sections and Shopify policies live on the
storefront and use a root-relative path; the clippar-web source pages are also
served from their own origin, so they carry the absolute URL. gen_legal_sections.py
rewrites the absolute form back to the relative one when it regenerates.
"""

import os
import re
import sys

ROOT = "/Users/hendacow/projects/final_shipment"
WT = (
    "/private/tmp/claude-501/-Users-hendacow-projects-final-shipment-clippar-app/"
    "78487c37-83f0-472b-b890-d0290c5828d1/scratchpad/wt-policies/clippar-web/public"
)

REL = "/pages/contact"
ABS = "https://clippargolf.com/pages/contact"

MAIL = '<a href="mailto:clippargolf@gmail.com">clippargolf@gmail.com</a>'
LINK = '<a href="%%CONTACT%%">contact form</a>'

# (needle, replacement). Applied in order; a file only has to contain a subset.
EDITS = [
    # ── privacy ──
    (
        "Privacy questions, requests and complaints: " + MAIL + ". A person reads that inbox.",
        "Privacy questions, requests and complaints: use the " + LINK
        + " and choose “Privacy or data request”. A person reads those.",
    ),
    (
        "If deletion doesn't work for any reason, email " + MAIL + " and we'll do it manually.",
        "If deletion doesn't work for any reason, tell us through the " + LINK
        + " and we'll do it manually.",
    ),
    (
        "<p>Email " + MAIL + ". We aim to respond within 30 days",
        "<p>Use the " + LINK + ". We aim to respond within 30 days",
    ),
    (
        "we won't treat you differently for asking. Email " + MAIL + ".",
        "we won't treat you differently for asking. Use the " + LINK + ".",
    ),
    (
        "If you think a child has given us their information, email " + MAIL
        + " and we'll delete it.",
        "If you think a child has given us their information, tell us through the " + LINK
        + " and we'll delete it.",
    ),
    (
        "Questions, requests or complaints: " + MAIL + ".",
        "Questions, requests or complaints: use the " + LINK + ".",
    ),
    # ── terms ──
    (
        "If you think someone else has got into your account, email " + MAIL
        + " straight away.",
        "If you think someone else has got into your account, tell us through the " + LINK
        + " straight away.",
    ),
    (
        "Questions about these Terms? Email " + MAIL + " and a human will answer.",
        "Questions about these Terms? Use the " + LINK + " and a human will answer.",
    ),
    (
        "If you want a shared reel taken down, email us and we'll remove it.",
        "If you want a shared reel taken down, tell us through the " + LINK
        + " and we'll remove it.",
    ),
    # ── mount kit terms, refund and shipping ──
    (
        "Email: " + MAIL + "<br>",
        "Contact: " + LINK + "<br>",
    ),
    (
        "<br>Email: " + MAIL + "</td>",
        "<br>Contact: " + LINK + "</td>",
    ),
    (
        "<strong>If this product causes injury or property damage, contact us immediately</strong> at "
        + MAIL + ".",
        "<strong>If this product causes injury or property damage, contact us immediately</strong> "
        "through the " + LINK + ", choosing “Safety issue”.",
    ),
    (
        "<p>Email " + MAIL
        + " with your order number, what's wrong, and a photo if it helps.",
        "<p>Send us the details through the " + LINK
        + " — your order number, what's wrong, and a photo if it helps.",
    ),
    (
        "<td>Email " + MAIL
        + " with your name, order number, proof of purchase, and a description of the defect.",
        "<td>Send us your name, order number, proof of purchase and a description of the defect "
        "through the " + LINK + ".",
    ),
    (
        "<td>By email as above, or in writing to",
        "<td>Through the contact form as above, or in writing to",
    ),
    (
        "and email us first if you're unsure whether the mount will fit your bag",
        "and get in touch first if you're unsure whether the mount will fit your bag",
    ),
    (
        "If you want to cancel, email us straight away.",
        "If you want to cancel, tell us through the " + LINK + " straight away.",
    ),
    (
        "To start a change-of-mind return, email " + MAIL
        + " with your order number before sending anything back.",
        "To start a change-of-mind return, use the " + LINK
        + " and quote your order number before sending anything back.",
    ),
    (
        "Anything at all about an order, a fault, or the battery: " + MAIL
        + ". If it's a safety issue, say so in the subject line and we'll treat it as urgent.",
        "Anything at all about an order, a fault, or the battery: use the " + LINK
        + ". If it's a safety issue, choose that topic and we'll treat it as urgent.",
    ),
    (
        "Questions about an order or a delivery: " + MAIL + ".",
        "Questions about an order or a delivery: use the " + LINK + ".",
    ),
    # ── standalone page chrome (source files only; the theme drops the footer) ──
    (
        "<p>&copy; 2026 Clippar &middot; clippargolf@gmail.com</p>",
        "<p>&copy; 2026 Clippar</p>",
    ),
]

TARGETS = [
    (os.path.join(ROOT, "clippar-shop/sections/legal-privacy.liquid"), REL),
    (os.path.join(ROOT, "clippar-shop/sections/legal-terms.liquid"), REL),
    (os.path.join(ROOT, "clippar-shop/sections/legal-mount-kit-terms.liquid"), REL),
    (os.path.join(ROOT, "migration/shopify-refund-policy.html"), REL),
    (os.path.join(ROOT, "migration/shopify-shipping-policy.html"), REL),
    (os.path.join(WT, "privacy.html"), ABS),
    (os.path.join(WT, "terms.html"), ABS),
    (os.path.join(WT, "hardware-terms.html"), ABS),
]

LEFTOVER = re.compile(r"clippargolf@gmail\.com|mailto:", re.I)


def main():
    unused = set(range(len(EDITS)))
    failed = False

    for path, link in TARGETS:
        text = open(path).read()
        before = text
        applied = 0

        for i, (needle, replacement) in enumerate(EDITS):
            if needle in text:
                text = text.replace(needle, replacement.replace("%%CONTACT%%", link))
                unused.discard(i)
                applied += 1

        leftovers = LEFTOVER.findall(text)
        status = "ok" if not leftovers else "LEFTOVER x%d" % len(leftovers)
        if leftovers:
            failed = True
            for m in re.finditer(r"^.*(clippargolf@gmail\.com|mailto:).*$", text, re.M):
                print("      ! %s" % m.group(0).strip()[:120])

        print("  %-52s %2d edits  %s" % (os.path.relpath(path, ROOT), applied, status))

        if text != before:
            open(path, "w").write(text)

    if unused:
        failed = True
        print("\nEdits that matched nothing (source drifted?):")
        for i in sorted(unused):
            print("  [%d] %s" % (i, EDITS[i][0][:100]))

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
