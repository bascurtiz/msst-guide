# Editing the guide — a few steps

This is for the original author of *“Training vocal removers locally and on the
cloud”*. The guide was rewritten as a website, and you can change it yourself, in
a browser, without touching any code. Nothing to install.

If something below does not work, it is almost always a setting on the site
owner's side rather than something you did — tell him rather than fight it.

## What you need

1. **Your account on the site's editor.** The site owner creates it and sends you
   the address and a password. There is no GitHub account, no invitation and no
   token any more — the editor is part of the site itself.
2. A **browser** (Chrome, Edge, Firefox or Safari). It works on a phone, but it is
   far easier on a computer.

## 1. Open the editor

The site owner will give you the address; it looks like
`https://<the site's own address>/admin`. Reaching `/admin` on the guide's public
address also ends up there — it redirects.

## 2. Sign in

Enter the email and password he set up for you, and press **Sign in**. If he
switched on two-factor authentication, it will then ask for the six-digit code
from your authenticator app.

You stay signed in afterwards, so this is a once-a-session step.

### If you are locked out

- **Wrong password, or five tries and it locks.** It locks deliberately and backs
  off, so wait a few minutes rather than trying again immediately. If it still
  refuses, ask him to reset it — nothing you can do from your side fixes it.
- **The code is rejected.** The code changes every thirty seconds; wait for the
  next one and check your device's clock is set automatically.

## 3. Find the text you want to change

The editor opens on the site as a canvas, one page at a time, and the whole admin
has a command palette: press **⌘K** (or **Ctrl+K**) and start typing — a page
name, a chapter title, a phrase you remember. It jumps you there without hunting
through menus.

The guide has five pages: the home page, **Before you train**, **Setup &
configuration**, **Training runs** and **Reference**.

## 4. Edit

Click the text you want to change and type. **Live mode** works on the real
full-size page, which is the best way to change words: you see the page as a
reader does rather than as a document. The toolbar covers **bold**, *italic*,
`code`, links and images.

To add a picture, use the image button, or drag it in. It is uploaded to the site
automatically, resized for phones and laptops from that one file, and referenced
where you dropped it.

## 5. Publish

Two different things, and the difference matters:

- **Saving** stores your edit as a draft. Readers cannot see a draft — what you
  have not published, nobody sees.
- **Publishing** makes it live. It goes live immediately: there is no rebuild to
  wait for and no "check back in a minute".

Small, separate publishes are better than one big one — a change is easier to
check and easier to undo when it stands alone.

## What you can change, and what to ask about

Almost everything is yours now — prose, headings, lists, images, the order of
sections, and the layout around them.

Two things are worth a note rather than a guess:

- **The interactive parts** — the chunk-size and VRAM calculator, the search
  panel, the dark/light switch, the copy buttons on command blocks. They are
  built pieces of the site, not text. If one of them looks or behaves wrong, say
  so rather than editing around it.
- **Command and config blocks** keep their colouring, which is markup rather than
  plain text. Change the words freely; if you need a block to look structurally
  different, ask, because that part is not a text edit.

## House style

The rewritten guide is written in the second person and kept deliberately plain.
Matching it makes an edit look native:

- Say **you**, not “we” or “one”; keep sentences short.
- Headings are sentence case: “Building a dataset”, not “Building A Dataset”.
- Technical names in `code` styling, exactly as the tools spell them:
  `--model_type`, `dim_t`, `chunk_size`, `hop_length`.
- Metric names in lower case: `sdr`, `fullness`, `bleedless`.
- Prefer concrete numbers (VRAM, hours, file counts) to adjectives like “fast”.
- American or British spelling, but be consistent within a page — the site
  currently uses British spelling (“licence”, “behaviour”).

## If something goes wrong

- **You published, but the page still shows the old text.** Reload the page in a
  new tab first — a cached copy is the usual answer. If it is genuinely unchanged,
  check you pressed **Publish** and not only **Save**; a draft looks exactly like a
  published page while you are signed in.
- **An image does not appear.** It was probably not uploaded — the file was
  referenced rather than added. Insert it again with the image button and publish
  the page again.
- **You changed something and want it back.** Ask the site owner: every edit is
  logged with who made it and when, and an earlier version can be restored.

Your credit as the original author is on the site's **Reference** page, under
*Credits*; if the wording there should change, that is an edit you can make.
