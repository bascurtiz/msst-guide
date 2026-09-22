/* MSST Guide — shared behaviour: reading progress, TOC spy, copy buttons,
   mobile drawer, back-to-top, print. No dependencies. */
(function () {
  "use strict";

  var bar = document.getElementById("bar");
  var backtop = document.getElementById("backtop");
  var drawer = document.getElementById("drawer");
  var menuBtn = document.getElementById("menuBtn");
  var links = Array.prototype.slice.call(document.querySelectorAll(".toc ol a"));
  var targets = links.map(function (a) {
    return document.querySelector(a.getAttribute("href"));
  });

  function scrollTop() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  /* reading progress + back-to-top */
  function progress() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    if (bar) bar.style.width = (max > 0 ? (scrollTop() / max) * 100 : 0).toFixed(2) + "%";
    if (backtop) backtop.classList.toggle("on", scrollTop() > 700);
  }

  /* highlight the section you are reading */
  var current = -1;
  function spy() {
    if (!links.length) return;
    var y = scrollTop() + 150;
    var idx = -1;
    for (var i = 0; i < targets.length; i++) {
      if (targets[i] && targets[i].offsetTop <= y) idx = i;
    }
    if (idx !== current) {
      current = idx;
      links.forEach(function (a, i) {
        a.classList.toggle("active", i === idx);
      });
    }
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      progress();
      spy();
      ticking = false;
    });
  }

  /* ---------- clipboard, with a fallback for insecure origins ---------------
     The site is meant to work from file:// as well, where navigator.clipboard
     may be unavailable, so every copy path can fall back to a selection. */
  function copyText(text, done) {
    function legacyCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(legacyCopy()); }
      );
    } else {
      done(legacyCopy());
    }
  }

  /* copy-to-clipboard for every code block */
  Array.prototype.forEach.call(document.querySelectorAll(".copy"), function (btn) {
    btn.addEventListener("click", function () {
      var box = btn.closest(".code");
      var pre = box ? box.querySelector("pre") : null;
      if (!pre) return;
      copyText(pre.innerText, function (ok) {
        btn.textContent = ok ? "Copied" : "Press Ctrl+C";
        btn.classList.add("done");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("done");
        }, 1700);
      });
    });
  });

  /* ---------- share a section ---------------------------------------------
     Every h2/h3 in the content gets a button that copies a link to its own
     anchor — or opens the system share sheet where that is the better answer
     (touch devices). "main" rather than "article" because the home page has no
     article element: its sections live directly in main. Nothing else inside
     main carries an h2/h3, so nothing else picks up a button.
     tools/add-heading-ids.py puts the anchors in the HTML; the slug here is only
     a fallback for a heading added without running the tool. */
  (function () {
    var headings = document.querySelectorAll("main h2, main h3");
    if (!headings.length) return;

    var status = document.createElement("p");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.body.appendChild(status);

    var canShare = !!(navigator.share && window.matchMedia && window.matchMedia("(hover: none)").matches);

    function slug(text) {
      return text.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/[-\s]+/g, "-").slice(0, 48).replace(/-$/, "") || "section";
    }

    Array.prototype.forEach.call(headings, function (h) {
      var label = h.textContent.trim();
      if (!h.id) h.id = slug(label);

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "h-share";
      btn.title = canShare ? "Share a link to this section" : "Copy a link to this section";
      btn.setAttribute("aria-label", btn.title + ": “" + label + "”");

      btn.addEventListener("click", function () {
        /* path, not query: the fragment is what identifies the section */
        var link = location.origin + location.pathname + "#" + h.id;
        if (canShare) {
          try {
            navigator.share({ title: label, url: link })["catch"](function () {});
            return;
          } catch (e) { /* fall through to copying */ }
        }
        copyText(link, function (ok) {
          btn.classList.toggle("done", ok);
          status.textContent = ok ? "Link copied: " + label : "Could not copy the link to " + label;
          setTimeout(function () {
            btn.classList.remove("done");
            status.textContent = "";
          }, 1700);
        });
      });

      h.appendChild(btn);
    });
  })();

  /* hide the flow connector on cards that sit at the end of a grid row */
  function markFlowRowEnds() {
    Array.prototype.forEach.call(document.querySelectorAll(".flow"), function (flow) {
      var items = Array.prototype.slice.call(flow.children);
      items.forEach(function (li, i) { li.classList.remove("row-end"); });
      items.forEach(function (li, i) {
        var next = items[i + 1];
        if (next && next.offsetTop > li.offsetTop) li.classList.add("row-end");
      });
    });
  }

  /* mobile drawer */
  function closeDrawer() {
    if (drawer) drawer.classList.remove("open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }
  if (menuBtn && drawer) {
    menuBtn.addEventListener("click", function () {
      var open = drawer.classList.toggle("open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });
  }

  /* ---------- chunk size + VRAM calculator ---------- */
  (function () {
    var calc = document.getElementById("calc");
    if (!calc) return;

    /* The single documented data point this estimate is anchored on: a
       STEREO Roformer (audio.num_channels 2, model.stereo true, like every
       checkpoint in this ecosystem) at batch_size 4 and dim_t 1333 — a
       13.32 s window at hop_length 441 — filling a 140 GB H200. Anchored on
       FRAMES and batch rather than on samples, because the model sees a
       dim_f x dim_t spectrogram at any sample rate: halving the rate
       shortens the audio, not the graph. */
    var REF = { gb: 140, batch: 4, dimt: 1333 };
    /* Mono: the band-split front end folds the two channels into one
       sequence, so a 1-channel model attends over half as many tokens. */
    var MONO_FACTOR = 0.5;
    var HEADROOM = 0.85; /* leave room for the validation pass + context */

    /* hop_length is a property of the model's STFT, not of the sample rate.
       Two conventions cover every config in this ecosystem: a tenth of the
       rate (441 at 44.1 kHz, with 10 ms frames — every published Roformer)
       and a quarter or eighth of n_fft (512 / 1024 — the MSST templates,
       DTTNet and mdx23c). */
    var FRAME_DIV = 100;
    var HALF_RATES = { 22050: true, 24000: true };
    /* the rates the guide actually documents; anything else is a custom rate */
    var KNOWN_RATES = { 44100: true, 48000: true, 22050: true, 24000: true };
    var KNOWN_DIMTS = [1333, 1101, 801, 256]; /* the dropdown's values, widest first */

    /* What each target can afford. The rate a stem tolerates follows from the
       band its energy occupies; the ones that need the full band are labelled
       as such rather than quietly given a shorter window. */
    var TARGETS = {
      vocals: {
        sr: 44100,
        title: "Vocals · full band · 44 100 Hz",
        text: "Sibilance sits at 5–10 kHz and breath above 10 kHz, so a halved rate takes away exactly the consonants that make a vocal sound natural. Every published Roformer is 44 100 Hz: keep the full band."
      },
      bass: {
        sr: 44100,
        title: "Bass · full band · 44 100 Hz",
        text: "Bass fundamentals run about 40–400 Hz and the harmonics that give the instrument its tone stay under roughly 4 kHz, so this is the one target a halved rate genuinely suits: 22 050 Hz keeps 0–11 025 Hz and holds everything the stem needs, with the same mel bands spread over half the spectrum — finer resolution exactly where the bass lives. It is not the default, because no model in this ecosystem is published below 44.1 kHz and the mel filterbank is built from model.sample_rate: a halved run means training from scratch, judged against an untouched 44 100 Hz baseline. Tick user-defined under sample rate and type 22 050 if you want to test it."
      },
      drums: {
        sr: 44100,
        title: "Drums · full band · 44 100 Hz",
        text: "Hi-hats, ride and crash cymbals live almost entirely above 5 kHz, so halving the rate deletes most of the kit you are asking the model to reproduce. A kick-only model could survive it; a drum model cannot."
      },
      guitar: {
        sr: 44100,
        title: "Guitar DI · full band · 44 100 Hz",
        text: "A DI is the target with the strongest case for half the rate: what you want is the pickup's raw output, whose body sits under 2 kHz and whose detail is mostly under 8 kHz, while the amp and cabinet that would normally follow it are rolled off above about 5–6 kHz — so an 11 025 Hz ceiling trims the top of the pick scrape and nothing structural. That argument only covers the DI itself: a mic'd amp track brings its own air and cymbal bleed. And nothing here is published at 22 050 Hz, so the default stays the full band. Train a 44 100 Hz baseline first, then tick user-defined under sample rate, type 22 050, and compare the SDR metrics before trusting the narrower run."
      },
      other: {
        sr: 44100,
        title: "Other · full band · 44 100 Hz",
        text: "“Other” is the catch-all a 4-stem model puts everything else into — keys, synths, strings, percussion, effects. It is the brightest and least predictable stem on this row: synth harmonics, cymbal wash and vocal-adjacent air all live above the cut, so it keeps the full band. Halving the rate here is the worst bet of the five."
      }
    };

    /* Which block owns the STFT, per architecture family. This is the mistake
       this calculator exists to catch: for a Roformer the STFT belongs to
       `model`, and the audio.n_fft / audio.hop_length / audio.dim_f /
       audio.dim_t sitting next to it in the same file are ignored — viperx's
       shipped config annotates them "# don't work (use in model)". mdx23c and
       DTTNet are handed the whole audio block instead (STFT(config.audio)), so
       for them those keys are the real ones. audio.chunk_size is the one key
       every family reads (MSSDataset.__init__), which is why the window is
       always the audio block's business. */
    var ARCHS = {
      roformer: {
        name: "Roformer",
        nfft: 2048,
        rule: "rate100",
        chunk: 352800,
        nkey: "model.stft_n_fft",
        hkey: "model.stft_hop_length",
        text: "<b>Roformer — the STFT lives in <code>model</code>.</b> BS-Roformer, Mel-Band Roformer, BS-Conformer and " +
          "BS-Mamba2 read <code>model.stft_n_fft</code>, <code>model.stft_hop_length</code> and " +
          "<code>model.stft_win_length</code>, and their mel bands from <code>model.freqs_per_bands</code> (or " +
          "<code>model.num_bands</code>) measured at <code>model.sample_rate</code>. The <code>audio.dim_f</code>, " +
          "<code>audio.dim_t</code>, <code>audio.n_fft</code> and <code>audio.hop_length</code> in the same file are " +
          "decoration. Defaults here are the published ones: <code>n_fft: 2048</code>, <code>hop_length: 441</code>, " +
          "and Kimberley Jensen's <code>chunk_size: 352800</code> (8.00 s, 801 frames)."
      },
      mdx: {
        name: "MDX-Net (mdx23c / DTTNet)",
        nfft: 4096,
        rule: "fft4",
        chunk: 261120,
        nkey: "audio.n_fft",
        hkey: "audio.hop_length",
        text: "<b>MDX-Net — the STFT lives in <code>audio</code>.</b> mdx23c and DTTNet are constructed with the whole " +
          "audio block (<code>STFT(config.audio)</code>), so <code>audio.n_fft</code>, <code>audio.hop_length</code> and " +
          "<code>audio.dim_f</code> are the real ones, and the model crops the spectrogram to <code>audio.dim_f</code>. " +
          "The templates differ: mdx23c ships <code>n_fft: 8192</code>, <code>hop_length: 1024</code>, " +
          "<code>dim_f: 4096</code>; DTTNet <code>4096 / 1024 / 2048</code>. Both use the window " +
          "<code>261120 = 1024 × (256 − 1)</code>, which is the default here. <code>dim_t</code> and " +
          "<code>chunk_size</code> are genuinely the same setting in two units for this family."
      },
      scnet: {
        name: "SCNet",
        nfft: 4096,
        rule: "fft4",
        chunk: 485100,
        nkey: "model.nfft",
        hkey: "model.hop_size",
        text: "<b>SCNet — the STFT lives in <code>model</code>, under its own names.</b> <code>model.nfft</code>, " +
          "<code>model.hop_size</code> and <code>model.win_size</code> (4096 / 1024 / 4096 in both shipped configs) " +
          "build the spectrogram, and the only window setting it takes from <code>audio</code> is " +
          "<code>chunk_size: 485100</code> — 44 100 × 11, which is <em>not</em> a whole number of hops " +
          "(473.7). So the frame count is not required to divide evenly; the tidy choice is still " +
          "<code>(dim_t − 1) × hop_size</code>."
      }
    };

    function halfRateText(nyquist) {
      return "Everything above " + fmt(Math.round(nyquist)) + " Hz is gone before the model ever sees it: cymbals, sibilance, guitar harmonics. That is a fair trade for a bass or kick-drum target and a poor one for a full-band stem. It saves the loader and the STFT half their work — and whether it saves memory depends on the hop: frames come from chunk_size ÷ hop_length, so at this chunk_size the window is now " + "twice as long and the frame count has doubled. Halve chunk_size too and the frame count returns to where it was, which is what hop_length = rate ÷ 100 arranges for free.";
    }

    function customRateText(nyquist) {
      return "No model in this guide's ecosystem is published at this rate, and the mel filterbank is built from it. Change it in every place it appears — audio.sample_rate, model.sample_rate (that is the one a Roformer's mel bank actually reads) and the sample_rate in the loss_multistft block — then let the auto hop follow (it derives from the rate) and expect to train from scratch rather than fine-tune a checkpoint. Everything above " + fmt(Math.round(nyquist)) + " Hz is discarded before training starts, and the frame count follows the rate ÷ hop ratio, so watch what this does to the window above.";
    }

    var activeTarget = null;

    var dimt = document.getElementById("c-dimt");
    var dimtFree = document.getElementById("c-dimtfree");
    var dimtUser = document.getElementById("c-dimtuser");
    var chunkField = document.getElementById("c-chunk");
    var arch = document.getElementById("c-arch");
    var keyNfft = document.getElementById("k-nfft");
    var keyHop = document.getElementById("k-hop");
    var archText = document.getElementById("o-arch-text");
    var archLbl = document.getElementById("o-arch-lbl");
    var hop = document.getElementById("c-hop");
    var sr = document.getElementById("c-sr");
    var batch = document.getElementById("c-batch");
    var acc = document.getElementById("c-acc");
    var vram = document.getElementById("c-vram");
    var srFree = document.getElementById("c-srfree");
    var srUser = document.getElementById("c-sruser");
    var chans = document.getElementById("c-ch");
    var vramLbl = document.getElementById("o-vram-lbl");
    var hopAuto = document.getElementById("c-hopauto");
    var hopRule = document.getElementById("c-hoprule");
    var nfft = document.getElementById("c-nfft");
    var tgtBox = document.getElementById("o-target");
    var tgtTitle = document.getElementById("o-target-title");
    var tgtText = document.getElementById("o-target-text");
    var out = {
      chunk: document.getElementById("o-chunk"),
      frames: document.getElementById("o-frames"),
      win: document.getElementById("o-window"),
      step: document.getElementById("o-step"),
      fps: document.getElementById("o-fps"),
      band: document.getElementById("o-band"),
      eff: document.getElementById("o-eff"),
      vram: document.getElementById("o-vram"),
      flag: document.getElementById("o-flag"),
      box: document.getElementById("o-verdict"),
      status: document.getElementById("o-status"),
      advice: document.getElementById("o-advice")
    };

    function num(input, fallback, min, max) {
      var v = parseFloat(input && input.value);
      if (!isFinite(v)) v = fallback;
      return Math.min(Math.max(v, min), max);
    }
    function fmt(n, decimals) {
      return n.toLocaleString("en-US", {
        minimumFractionDigits: decimals || 0,
        maximumFractionDigits: decimals || 0
      });
    }

    /* the hop the auto rule resolves to at the current rate and n_fft */
    function hopValue() {
      return Math.round(num(hop, hopFromRule(currentRate(), Math.round(num(nfft, 2048, 128, 16384))), 1, 8192));
    }

    /* dim_t is the frame count the current window works out to, so the control
       mirrors it: a documented value selects that dropdown entry, anything else
       goes into the user-defined field. Round-tripping through chunk_size is
       exact — floor((frames - 1) * hop / hop) + 1 is the same frame count. */
    function setDimT(v) {
      if (KNOWN_DIMTS.indexOf(v) > -1) {
        if (!dimtUser.checked) dimt.value = String(v);
      } else {
        dimtUser.checked = true;
        /* never rewrite the field the reader is typing in: a half-typed 194
           passes through 1 and 19, and snapping it would eat the keystrokes */
        if (document.activeElement !== dimtFree && dimtFree.value !== String(v)) dimtFree.value = String(v);
      }
      syncDimTControl();
    }
    function readFrames() {
      return parseInt(dimtUser.checked ? dimtFree.value : dimt.value, 10) || 1333;
    }
    /* choosing a frame count writes the window it implies */
    function writeChunkFromFrames(frames) {
      chunkField.value = String(Math.max(1, (frames - 1) * hopValue()));
      update();
    }
    function syncDimTControl() {
      dimt.hidden = dimtUser.checked;
      dimtFree.hidden = !dimtUser.checked;
    }

    /* the rate comes from the dropdown, or from the free field when the reader
       has asked for their own */
    function currentRate() {
      if (!srUser.checked) return parseFloat(sr.value) || 44100;
      return Math.round(num(srFree, 44100, 1000, 192000));
    }
    function syncRateControl() {
      sr.hidden = srUser.checked;
      srFree.hidden = !srUser.checked;
    }

    /* the hop the chosen rule resolves to, given the current rate and n_fft */
    function hopFromRule(rate, nf) {
      if (hopRule.value === "fft4") return Math.round(nf / 4);
      if (hopRule.value === "fft8") return Math.round(nf / 8);
      return Math.round(rate / FRAME_DIV);
    }
    function syncHopControl() {
      hop.readOnly = hopAuto.checked;
      hopRule.hidden = !hopAuto.checked;
    }

    /* a target only reads as selected while it is the one chosen */
    function syncTargets() {
      Array.prototype.forEach.call(calc.querySelectorAll("[data-target]"), function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-target") === activeTarget ? "true" : "false");
      });
    }

    function update() {
      var rate = currentRate();

      /* the hop follows whichever STFT convention the reader's config uses */
      var nf = Math.round(num(nfft, 2048, 128, 16384));
      if (hopAuto.checked) {
        var want = hopFromRule(rate, nf);
        if (hop.value !== String(want)) hop.value = String(want);
      }
      var hl = Math.round(num(hop, hopFromRule(rate, nf), 1, 8192));

      /* The window is chunk_size — the key every family reads, and the number
         the YAML itself holds. Every STFT here runs with center=True, so a
         window of chunk_size samples becomes floor(chunk_size / hop_length) + 1
         frames, and the frames are what the model is asked to attend over. Hold
         the window and halve the hop and you have twice the frames, which is
         why the hop moves this estimate. */
      var chunk = Math.round(num(chunkField, 587412, 2048, 40000000));
      var dt = Math.floor(chunk / hl) + 1;
      /* the frame count is derived, so the control has to show it */
      setDimT(dt);
      var bs = Math.round(num(batch, 4, 1, 256));
      var ga = Math.round(num(acc, 1, 1, 512));
      var cap = parseFloat(vram.value) || 24;
      var mono = parseFloat(chans.value) === 1;
      var cf = mono ? MONO_FACTOR : 1;

      var seconds = chunk / rate;
      var est = cf * REF.gb * (bs * dt) / (REF.batch * REF.dimt);
      var ratio = est / cap;
      var eff = bs * ga;
      var nyquist = rate / 2;

      syncTargets();
      out.chunk.textContent = fmt(chunk) + " samples";
      out.frames.textContent = fmt(dt);
      out.win.textContent = seconds.toFixed(2) + " s";
      out.step.textContent = fmt(hl) + " · " + (hl / rate * 1000).toFixed(1) + " ms";
      out.fps.textContent = (rate / hl).toFixed(1) + " /s";

      /* a chunk that is not a whole number of hops still works — PyTorch pads
         with center=True — but the frame count stops being "window ÷ hop + 1" */
      if (chunk % hl === 0) {
        out.flag.hidden = true;
      } else {
        out.flag.hidden = false;
        out.flag.textContent = "chunk_size ÷ hop_length is not whole (" + fmt(chunk) + " ÷ " + fmt(hl) + " = " +
          (chunk / hl).toFixed(2) + "). A center=True STFT pads the ends, so you still get " + fmt(dt) +
          " frames with the last one short — MSST tolerates this, and its own SCNet config is 485 100 ÷ 1 024 = 473.7 — but " +
          fmt((dt - 1) * hl) + " = (dim_t − 1) × hop_length is the tidy value.";
      }
      out.band.textContent = "0 – " + fmt(Math.round(nyquist)) + " Hz";
      out.eff.textContent = fmt(eff);
      out.vram.textContent = "~" + fmt(est, est < 10 ? 1 : 0) + " GB";
      vramLbl.textContent = "estimated VRAM · " + (mono ? "mono" : "stereo") +
        (arch.value === "roformer" ? " model" : " · extrapolated");

      /* largest window that still fits, and largest batch, from the same estimate */
      var maxDimT = Math.max(16, Math.floor(cap * HEADROOM * REF.batch * REF.dimt / (cf * REF.gb * bs)));
      var maxSeconds = ((maxDimT - 1) * hl / rate).toFixed(2);
      var bsFit = Math.max(1, Math.floor(cap * HEADROOM * REF.batch * REF.dimt / (cf * REF.gb * dt)));

      out.box.querySelectorAll("p.extra").forEach(function (p) { p.remove(); });

      var cls = "calc-verdict";
      if (ratio <= 0.6) {
        out.status.textContent = "Fits · " + Math.round(ratio * 100) + "% of " + cap + " GB";
        out.advice.textContent = "This should run, with room for the validation pass. Training at a smaller window first is still the faster way to find out whether the configuration works at all.";
      } else if (ratio <= 0.9) {
        cls += " tight";
        out.status.textContent = "Tight · " + Math.round(ratio * 100) + "% of " + cap + " GB";
        out.advice.textContent = "Close to the limit: expect CUDA_OutOfMemory as soon as validation runs, another process touches the GPU, or anything is left in memory. Enabling use_torch_checkpoint is the cheapest way to buy headroom.";
      } else {
        cls += " over";
        out.status.textContent = "Likely out of memory · " + Math.round(ratio * 100) + "% of " + cap + " GB";
        out.advice.textContent = "As configured, this does not fit in " + cap + " GB.";
        var keepBatch = Math.max(1, Math.min(bs, bsFit));
        var parts = [];
        if (maxDimT < dt) {
          /* the field to touch is chunk_size; prefer a documented frame count
             where one fits, and only fall back to an arbitrary window */
          var preset = KNOWN_DIMTS.filter(function (v) { return v <= maxDimT && v < dt; })[0];
          if (preset) {
            parts.push("use the " + fmt(preset) + " dim_t preset — " + fmt((preset - 1) * hl) + " samples, a " +
              ((preset - 1) * hl / rate).toFixed(2) + " s window — and keep the current batch");
          } else {
            parts.push("lower chunk_size to about " + fmt((maxDimT - 1) * hl) + " — " + fmt(maxDimT) +
              " frames, a " + maxSeconds + " s window — keeping the current batch");
          }
        }
        if (keepBatch < bs) {
          parts.push("drop batch_size to " + fmt(keepBatch) + " and raise gradient_accumulation_steps to " +
            fmt(Math.ceil(eff / keepBatch)) + " — the same effective batch of " + fmt(eff) + " for a fraction of the memory");
        }
        var fallback = document.createElement("p");
        fallback.textContent = parts.length
          ? "Two ways down: " + parts.join(", or ") + "."
          : "Nothing fits at this window on this card: use a shorter window or a larger GPU.";
        fallback.className = "extra";
        out.box.appendChild(fallback);
      }
      out.box.className = cls;

      /* the band note: a chosen target, a custom rate, or a halved rate on its own */
      var target = activeTarget ? TARGETS[activeTarget] : null;
      var halved = HALF_RATES[rate] === true;
      var custom = srUser.checked && KNOWN_RATES[rate] !== true;
      if (target) {
        tgtTitle.textContent = target.title;
        tgtText.textContent = target.text;
      } else if (custom) {
        tgtTitle.textContent = "Custom rate · Nyquist " + fmt(Math.round(nyquist)) + " Hz";
        tgtText.textContent = customRateText(nyquist);
      } else if (halved) {
        tgtTitle.textContent = "Halved rate · Nyquist " + fmt(Math.round(nyquist)) + " Hz";
        tgtText.textContent = halfRateText(nyquist);
      }
      tgtBox.hidden = !target && !halved && !custom;
      tgtBox.className = "calc-target" + (halved || custom ? " half" : "");
    }

    /* the controls with a behaviour of their own */
    var managed = [dimt, dimtFree, dimtUser, sr, srFree, chunkField, arch];
    Array.prototype.forEach.call(calc.querySelectorAll("input, select"), function (el) {
      if (managed.indexOf(el) > -1) return;
      el.addEventListener("input", update);
      el.addEventListener("change", update);
    });

    /* chunk_size is the window itself: the YAML's own number, and the one the
       hop is measured against. Edit it and the frame count follows. */
    chunkField.addEventListener("input", update);
    chunkField.addEventListener("change", function () {
      var v = num(chunkField, 587412, 2048, 40000000);
      if (String(v) !== chunkField.value) chunkField.value = String(v);
      update();
    });

    /* dim_t: the dropdown carries the documented frame counts and writes the
       window they imply; user-defined frees the number for anything else */
    dimt.addEventListener("change", function () {
      dimtUser.checked = false;
      syncDimTControl();
      writeChunkFromFrames(parseInt(dimt.value, 10) || 1333);
    });
    dimtUser.addEventListener("change", function () {
      /* start the free field from the frame count currently on screen */
      if (dimtUser.checked) dimtFree.value = String(readFrames());
      syncDimTControl();
      update();
    });
    dimtFree.addEventListener("input", function () {
      writeChunkFromFrames(parseInt(dimtFree.value, 10) || 1333);
    });
    dimtFree.addEventListener("change", function () {
      var v = num(dimtFree, 1333, 16, 32768);
      if (String(v) !== dimtFree.value) dimtFree.value = String(v);
      writeChunkFromFrames(v);
    });

    /* the architecture decides which block owns the STFT, what the templates in
       that family ship with, and therefore which defaults are honest */
    arch.addEventListener("change", function () {
      var a = ARCHS[arch.value];
      if (!a) return;
      nfft.value = String(a.nfft);
      if (hopRule.value !== a.rule) hopRule.value = a.rule;
      chunkField.value = String(a.chunk);
      hop.value = String(hopFromRule(currentRate(), a.nfft));
      keyNfft.textContent = a.nkey;
      keyHop.textContent = a.hkey;
      archText.innerHTML = a.text;
      archLbl.textContent = "where these settings live · " + a.name;
      update();
    });

    /* choosing a rate by hand is not a target choice any more */
    function manualRate() {
      activeTarget = null;
      update();
    }
    sr.addEventListener("change", manualRate);
    srFree.addEventListener("input", manualRate);
    srFree.addEventListener("change", function () {
      /* on blur, pull an out-of-range entry back into range (never mid-typing) */
      var v = num(srFree, 44100, 1000, 192000);
      if (String(v) !== srFree.value) srFree.value = String(v);
      manualRate();
    });

    srUser.addEventListener("change", function () {
      if (srUser.checked) {
        /* start the free field from the preset that was showing */
        srFree.value = String(parseInt(sr.value, 10) || 44100);
      } else if (KNOWN_RATES[parseInt(srFree.value, 10)]) {
        /* a custom value that happens to be one of the four presets: keep it */
        sr.value = String(parseInt(srFree.value, 10));
      }
      activeTarget = null;
      syncRateControl();
      update();
    });

    hopAuto.addEventListener("change", function () {
      syncHopControl();
      update();
    });

    Array.prototype.forEach.call(calc.querySelectorAll("[data-target]"), function (btn) {
      btn.addEventListener("click", function () {
        var t = TARGETS[btn.getAttribute("data-target")];
        if (!t) return;
        activeTarget = btn.getAttribute("data-target");
        /* a preset rate is a preset rate: leave the free field */
        srUser.checked = false;
        syncRateControl();
        sr.value = String(t.sr);
        update();
      });
    });

    syncHopControl();
    syncRateControl();
    syncDimTControl();
    update();
  })();

  /* ---------- site-wide search --------------------------------------------
     The index is a generated script (tools/build-search-index.py), so search
     works over http:// and from a file:// path alike, with no build step at
     runtime and no network request. */
  (function () {
    var openBtn = document.getElementById("searchBtn");
    var idx = window.MSST_INDEX;
    if (!openBtn) return;

    var MAX_RESULTS = 14;
    var SUGGESTIONS = ["bleedless", "chunk_size", "dim_t", "CUDA_OutOfMemory", "pin_memory", "dataset type 2", "vast.ai", "SDR"];

    var panel = document.createElement("div");
    panel.className = "search-overlay";
    panel.id = "searchOverlay";
    panel.hidden = true;
    panel.innerHTML =
      '<div class="search-box" role="dialog" aria-modal="true" aria-labelledby="searchInput" tabindex="-1">' +
        '<div class="search-field">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.4 16.4L21 21"/></svg>' +
          '<input id="searchInput" type="search" autocomplete="off" spellcheck="false" enterkeyhint="search" ' +
          'placeholder="Search all pages — chunk size, bleedless, CUDA_OutOfMemory…" aria-controls="searchResults" ' +
          'aria-describedby="searchStatus">' +
          '<button class="search-x" id="searchClose" type="button" aria-label="Close search">Esc</button>' +
        '</div>' +
        '<p class="search-status" id="searchStatus" role="status" aria-live="polite"></p>' +
        '<div class="search-results" id="searchResults"></div>' +
        '<div class="search-hints">' +
          '<span class="keys"><kbd class="kbd">/</kbd> or <kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">K</kbd> to open' +
          ' · <kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> to move · <kbd class="kbd">Enter</kbd> to open · <kbd class="kbd">Esc</kbd> to close</span>' +
          '<span class="idx" id="searchIdx"></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    var box = panel.querySelector(".search-box");
    var input = panel.querySelector("#searchInput");
    var results = panel.querySelector("#searchResults");
    var status = panel.querySelector("#searchStatus");
    var idxNote = panel.querySelector("#searchIdx");
    var closeBtn = panel.querySelector("#searchClose");

    if (!idx || !idx.blocks || !idx.pages) {
      results.innerHTML = '<p class="search-empty">The search index is not loaded.<br>' +
        'Run <b>python tools/build-search-index.py</b> and reload.</p>';
      idxNote.textContent = "no index";
    } else {
      idxNote.textContent = "index · " + idx.blocks.length + " blocks · " + idx.generated;
    }

    /* The index stores repository filenames (`data.html`). That is right for a
       host that serves the files themselves, and wrong for one that serves
       clean routes — the published page links already follow whichever it is,
       so the search results ask the page rather than assume. */
    var linksAsFiles = null;
    function usesFileNames() {
      if (linksAsFiles !== null) return linksAsFiles;
      /* Every link the page came with — but not the ones this overlay renders,
         since those are the thing being decided here. */
      var links = document.querySelectorAll("a[href]");
      linksAsFiles = false;
      for (var i = 0; i < links.length; i++) {
        if (panel.contains(links[i])) continue;
        if (/^[^:]*\.html?(#|$)/.test(links[i].getAttribute("href") || "")) { linksAsFiles = true; break; }
      }
      return linksAsFiles;
    }
    function hitHref(file, id) {
      var base = file;
      if (!usesFileNames()) {
        var dir = window.location.pathname.replace(/[^/]*$/, "") || "/";
        base = /^index\.html$/.test(file) ? dir : dir + file.replace(/\.html$/, "");
      }
      return base + (id ? "#" + id : "");
    }

    /* flat, lower-cased copy of the index, built on first open */
    var flat = null;
    function prepare() {
      if (flat || !idx || !idx.blocks) return;
      flat = idx.blocks.map(function (b) {
        return {
          p: b[0], sec: b[1], id: b[2], ctx: b[3] || "", head: b[4] === "head", x: b[5],
          lx: b[5].toLowerCase(), ls: (b[1] + " " + (b[3] || "")).toLowerCase()
        };
      });
    }

    function esc(s) {
      return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
    }
    function countIn(hay, needle) {
      var n = 0, i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
      return n;
    }
    function highlight(text, terms) {
      var lower = text.toLowerCase(), ranges = [], i, t, j;
      for (i = 0; i < terms.length; i++) {
        t = terms[i]; j = 0;
        while ((j = lower.indexOf(t, j)) !== -1) { ranges.push([j, j + t.length]); j += t.length; }
      }
      if (!ranges.length) return esc(text);
      ranges.sort(function (a, b) { return a[0] - b[0] || b[1] - a[1]; });
      var out = "", pos = 0, end = 0;
      for (i = 0; i < ranges.length; i++) {
        if (ranges[i][0] < end) { end = Math.max(end, ranges[i][1]); continue; }
        out += esc(text.slice(pos, ranges[i][0])) + "<mark>" + esc(text.slice(ranges[i][0], ranges[i][1])) + "</mark>";
        pos = end = ranges[i][1];
      }
      return out + esc(text.slice(pos));
    }
    /* command lines and console transcript look like matches but read badly as
       an excerpt — a sentence above them usually explains the same thing */
    function codeish(text) {
      return /(^|\s)--[a-z]/.test(text) || /^[>$]/.test(text) || text.length > 420;
    }
    function firstHit(block, terms) {
      var at = -1;
      for (var i = 0; i < terms.length; i++) {
        var p = block.lx.indexOf(terms[i]);
        if (p !== -1 && (at === -1 || p < at)) at = p;
      }
      return at;
    }
    function excerpt(block, terms) {
      var at = Math.max(0, firstHit(block, terms));
      var text = block.x, start = Math.max(0, at - 90), end = Math.min(text.length, start + 250);
      if (end - start < 250) start = Math.max(0, end - 250);
      var s = text.slice(start, end);
      if (start > 0) s = s.replace(/^\S*\s/, "");
      if (end < text.length) s = s.replace(/\s\S*$/, "");
      return (start > 0 ? "… " : "") + highlight(s, terms) + (end < text.length ? " …" : "");
    }

    function run() {
      prepare();
      if (!flat) {
        status.innerHTML = "No index on this page";
        results.innerHTML = '<p class="search-empty">The search index did not load.</p>';
        return;
      }
      var raw = input.value.trim();
      var terms = raw.toLowerCase().split(/\s+/).filter(function (t) { return t.length > 0; });

      if (!terms.length) {
        status.innerHTML = "Type to search <b>" + idx.pages.length + " pages</b> · or start from one of these";
        results.innerHTML = '<div class="search-sug"><span class="lbl">Common questions</span>' +
          SUGGESTIONS.map(function (s) { return '<button type="button" data-q="' + s + '">' + esc(s) + "</button>"; }).join("") +
          "</div>";
        Array.prototype.forEach.call(results.querySelectorAll("[data-q]"), function (b) {
          b.addEventListener("click", function () {
            input.value = b.getAttribute("data-q");
            run();
            input.focus();
          });
        });
        return;
      }

      var phrase = terms.length > 1 ? raw.toLowerCase() : "";
      var groups = {}, order = [], hits = 0;

      for (var i = 0; i < flat.length; i++) {
        var b = flat[i], score = 0, count = 0, ok = true;
        for (var t = 0; t < terms.length; t++) {
          var c = countIn(b.lx, terms[t]);
          if (!c) { ok = false; break; }
          count += c;
          score += Math.min(c, 4);
          if (b.ls.indexOf(terms[t]) !== -1) score += 7;
          if (b.head) score += 2;
        }
        if (!ok) continue;
        if (phrase && b.lx.indexOf(phrase) !== -1) score += 5;
        hits += Math.min(count, 25);
        var key = b.p + "|" + b.sec + "|" + b.id;
        if (!groups[key]) {
          groups[key] = { p: b.p, sec: b.sec, id: b.id, score: 0, hits: 0, best: null, bestText: null, bestProse: null };
          order.push(key);
        }
        var g = groups[key];
        g.score += score;
        g.hits += count;
        if (!g.best || score > g.best.score) g.best = { score: score, b: b };
        if (!b.head && (!g.bestText || score > g.bestText.score)) g.bestText = { score: score, b: b };
        if (!b.head && !codeish(b.x) && (!g.bestProse || score > g.bestProse.score)) g.bestProse = { score: score, b: b };
      }

      var ranked = order.map(function (k) { return groups[k]; })
        .sort(function (a, b) { return b.score - a.score || b.hits - a.hits; });

      if (!ranked.length) {
        status.innerHTML = "No hits for <span class=\"q\">" + esc(raw) + "</span>";
        results.innerHTML = '<p class="search-empty">Nothing matched <b>' + esc(raw) + '</b>.<br>' +
          "Try a shorter phrase, an argument name such as <b>--num_workers</b>, or an error such as <b>CUDA_OutOfMemory</b>.</p>";
        return;
      }

      var shown = ranked.slice(0, MAX_RESULTS);
      status.innerHTML = "<b>" + hits + "</b> hits in <b>" + ranked.length + "</b> sections" +
        (ranked.length > shown.length ? " · showing the top " + shown.length : "") +
        ' <span class="q">' + esc(raw) + "</span>";

      results.innerHTML = shown.map(function (g) {
        var page = idx.pages[g.p];
        /* a heading or a command line can win on score alone, but a sentence
           explains more — unless the query itself is a flag */
        var pick = g.best;
        if (raw.indexOf("--") === -1) {
          if (g.bestProse) pick = g.bestProse;
          else if (g.bestText) pick = g.bestText;
        }
        var b = pick.b;
        var title = g.sec || page.title;
        var ctx = b.ctx && b.ctx.toLowerCase() !== title.toLowerCase()
          ? '<span class="hit-ctx">' + esc(b.ctx) + "</span>" : "";
        return '<a class="hit" href="' + hitHref(page.file, g.id) + '">' +
          '<span class="hit-top"><span class="hit-title">' + highlight(title, terms) + "</span>" +
          '<span class="hit-meta">' + esc(page.short) + "<b>" + g.hits + (g.hits === 1 ? " hit" : " hits") + "</b></span></span>" +
          ctx + '<span class="hit-snip">' + excerpt(b, terms) + "</span></a>";
      }).join("");
    }

    var timer = null;
    input.addEventListener("input", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 90);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        var first = results.querySelector(".hit");
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
    results.addEventListener("keydown", function (e) {
      var hits = Array.prototype.slice.call(results.querySelectorAll(".hit"));
      var i = hits.indexOf(document.activeElement);
      if (e.key === "ArrowDown" && i > -1 && i < hits.length - 1) { e.preventDefault(); hits[i + 1].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); if (i > 0) hits[i - 1].focus(); else input.focus(); }
    });
    results.addEventListener("click", function (e) {
      if (e.target.closest(".hit")) closeSearch(false);
    });

    function openSearch(prefill) {
      panel.hidden = false;
      document.documentElement.classList.add("search-open");
      openBtn.setAttribute("aria-expanded", "true");
      if (prefill) input.value = prefill;
      run();
      input.focus();
      input.select();
    }
    function closeSearch(refocus) {
      if (panel.hidden) return;
      panel.hidden = true;
      document.documentElement.classList.remove("search-open");
      openBtn.setAttribute("aria-expanded", "false");
      if (refocus !== false) openBtn.focus();
    }

    openBtn.addEventListener("click", function () {
      if (panel.hidden) openSearch(); else closeSearch();
    });
    closeBtn.addEventListener("click", function () { closeSearch(); });
    panel.addEventListener("mousedown", function (e) {
      if (!box.contains(e.target)) closeSearch();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeSearch(); return; }
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || "")) || e.target.isContentEditable;
      if (typing) return;
      if (e.key === "/" || ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K"))) {
        e.preventDefault();
        openSearch();
      }
    });
  })();

  /* ---------- theme switch (dark / light) ---------- */
  var root = document.documentElement;
  var toggle = document.getElementById("themeToggle");
  var themeMeta = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme, persist) {
    var dark = theme !== "light";
    root.setAttribute("data-theme", dark ? "dark" : "light");
    if (themeMeta) themeMeta.setAttribute("content", dark ? "#0e1013" : "#f5f8fb");
    if (toggle) {
      toggle.setAttribute("aria-checked", dark ? "true" : "false");
      toggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      toggle.setAttribute("title", dark ? "Switch to light theme" : "Switch to dark theme");
    }
    if (persist) {
      try { localStorage.setItem("msst-theme", theme); } catch (e) { /* private mode */ }
    }
  }

  if (toggle) {
    toggle.addEventListener("click", function () {
      applyTheme(root.getAttribute("data-theme") === "light" ? "dark" : "light", true);
    });
  }
  /* sync icon state + browser chrome colour with the bootstrapped attribute */
  applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark", false);

  /* print / save as PDF */
  Array.prototype.forEach.call(document.querySelectorAll("[data-print]"), function (el) {
    el.addEventListener("click", function () { window.print(); });
  });

  if (backtop) {
    backtop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () { onScroll(); markFlowRowEnds(); });
  progress();
  spy();
  markFlowRowEnds();
})();
