# Editing the guide — a few steps

This is for the original author of *“Training vocal removers locally and on the
cloud”*. The guide was rewritten as a website, and you can change its **words**
yourself, in a browser, without touching any code. Nothing to install.

If something below does not work, it is almost always the one-time setup on the
site owner's side rather than something you did — tell him rather than fight it.

## What you need

1. **Accept the invitation.** The site owner adds your GitHub account to the
   site's repository, and GitHub emails you. Open that email and accept, or use
   <https://github.com/bascurtiz/msst-guide/invitations>. Two things go wrong if
   you skip this: the editor may sign you in and then fail — on the first save, or
   earlier, when it reads the content — and the invitation quietly **expires after
   seven days**. If no email arrives (check your spam folder), ask him to send you
   the invitation link instead; he can copy it from the repository's
   *Collaborators* page.
2. A **GitHub account** — which the invitation needs and which you may already
   have. If you do not, creating one is free: <https://github.com/signup>. It is
   needed because each change you save is stored as a commit, which is what keeps
   a full history of who changed what.
3. A **browser** (Chrome, Edge, Firefox or Safari). The editor works on a phone
   but it is far easier on a computer.

## 1. Open the editor

<https://msst-guide.pages.dev/admin/>

If you see the guide itself instead of a sign-in screen, the editor is not
published yet — tell the site owner.

## 2. Sign in

Click **Sign in with GitHub**, then approve what GitHub asks you for. It will
introduce the request as coming from *Sveltia CMS Authenticator* and ask for
access to your **public** repositories and your basic profile — which is all this
needs, since the site is a public repository. GitHub may ask for your password or
a two-factor code; that is GitHub checking it is really you, and it never reaches
the editor.

You do this once. The sign-in then keeps working until you sign out.

### If that button does not work

It needs a piece on the site owner's side that he may not have finished setting
up, and a button that is not set up shows an error rather than an explanation. In
that case use **Sign in with a token** instead — it always works, and needs
nothing from him:

1. In the dialog, follow the link to GitHub's token page. It opens the *new
   token* form with two things already filled in: the name (`Sveltia CMS`) and
   **Contents: Read and write**.
2. Fill in the two boxes it leaves you:

   - **Repository access** → *Only select repositories* → **`msst-guide`**. Do not
     pick “All repositories” — this token only ever needs this one project.
   - **Expiration** → 90 days is fine. GitHub requires a date.

3. Press **Generate token**, copy the value it shows you — that is the only time
   it is visible — and paste it into the editor's box.

The token is a password: do not share it, and do not paste it anywhere else. The
editor remembers it, so you only do this once; when it expires the editor stops
saving and you repeat these three steps with a new one.

## 3. Find the text you want to change

The left-hand list holds five chapters: the home page, **Before you train**,
**Setup & configuration**, **Training runs**, and **Reference**.

Open one and you get its **sections** — the headings you see on the page, in
order. Inside a section is the list of **text blocks**: every paragraph, list
item, small heading and label, again in page order.

The label on each block (“Paragraph · The dataset is the part that takes
longest…”) is only there to help you find your way around the editor. It is never
shown on the site.

## 4. Edit

Type in the block. The toolbar covers **bold**, *italic*, `code`, links and
images. To add a picture, use the image button or simply drag it in — it is
uploaded to the site automatically and referenced where you dropped it.

There is a **raw** mode you can switch to at the top of a block if you want to see
or edit the underlying markdown. A handful of spots contain a raw HTML fragment
(usually a small `<i>` or `<span>`); leave those tags alone unless you know what
you are doing, or ask.

## 5. Save

Press **Save**. That stores your change, and the site rebuilds itself and is live
a minute or two later. Reload the page you edited to see it.

Small, separate saves are better than one big one — a change is easier to check
and easier to undo when it stands alone.

## What you can change, and what you cannot

**Yours:** every paragraph, bullet, small sub-heading, card title, figure caption
and label, on all five pages — plus the command, config and error blocks, and
images you want to add.

**Not editable here, on purpose:** the diagrams, the tables, the chunk-size
calculator, the sidebar, the on-page contents, the “next chapter” links and the
footer. Those carry layout and data that a text editor cannot safely express, so
they live in the site's template files. Ask the site owner for a change there.

Two consequences worth knowing:

- **Renaming a chapter does not rename it in the sidebar** or in the “next”
  link at the bottom of a page. Those are template files: if a chapter really
  needs a new name, ask for it.
- **A paragraph keeps its styling.** Each block is tied to a styled place on the
  page, so an intro line stays an intro line. You cannot invent new styling from
  the editor.
- **A code block comes with its colouring markup still in it.** You edit the
  whole block — the `<pre>` tag, the words, and the little `<span>` wrappers in
  between. Those wrappers are what colour it: `<span class="cmd">` is a command,
  `<span class="f">` a flag, `<span class="ph">` a placeholder to replace, and a
  line starting with `#` is a comment. So change the words and leave the tags
  alone. If you want a block with no colour in it, paste the plain text and ask
  the site owner to run it through the highlighter.

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

- **You saved, but the page still shows the old text.** The editor accepts a save
  because a save is only text; the checking happens afterwards, when the site
  rebuilds. Two causes, and the site owner can tell which one from the rebuild
  that failed:
  - **An image path pointing at nothing** — usually a picture that was not
    uploaded, or a filename that was typed rather than inserted. Re-insert the
    picture with the image button, save again, and reload the page.
  - **Publishing not wired up yet** — his side, not yours.
- **Save refused with a permissions error**: your invitation has not been
  accepted yet, or it was sent as *read* rather than *write*. Tell the site
  owner — nothing you can do in the editor fixes that one.
- **The token stopped working**: it expired. Repeat step 2.

Your credit as the original author is on the site's **Reference** page, under
*Credits*; if the wording there should change, that is an edit you can make.
